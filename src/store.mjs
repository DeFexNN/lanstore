import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import {
  HubError,
  INTERNAL_DIR,
  normalizeRel,
  resolveInside,
  assertNoSymlinkEscape,
  renameWithRetry,
  fileVersion,
  looksBinary,
  makeMatcher,
  formatAgo,
  humanBytes,
  contentTypeFor,
  parentRel,
  baseName
} from './util.mjs';

export class Store {
  constructor({ root, config, guard, audit }) {
    this.root = path.resolve(root);
    this.cfg = config;
    this.guard = guard;
    this.audit = audit || { log: async () => {}, tail: async () => [] };
    this.internal = path.join(this.root, INTERNAL_DIR);
    this.trashDir = path.join(this.internal, 'trash');
    this.tmpDir = path.join(this.internal, 'tmp');
    this.uploadDir = path.join(this.internal, 'uploads');
    this.versionCache = new Map();
  }

  async init() {
    await fsp.mkdir(this.root, { recursive: true });
    for (const dir of [this.trashDir, this.tmpDir, this.uploadDir]) {
      await fsp.mkdir(dir, { recursive: true });
    }
    await this._cleanTmp();
    await this._cleanTrash();
  }

  /** Stable hub identity, persisted with the storage so the IP can change freely. */
  async getIdentity() {
    const file = path.join(this.internal, 'hub.json');
    try {
      const raw = await fsp.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.hubId) return parsed;
    } catch {
      /* create below */
    }
    const identity = {
      hubId: `hub_${crypto.randomBytes(8).toString('hex')}`,
      name: this.cfg.name,
      createdAt: new Date().toISOString()
    };
    await fsp.writeFile(file, JSON.stringify(identity, null, 2)).catch(() => {});
    return identity;
  }

  async _cleanTrash() {
    const days = Number(this.cfg.trash?.retentionDays ?? 30);
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = Date.now() - days * 86_400_000;
    try {
      const names = await fsp.readdir(this.trashDir);
      for (const name of names) {
        const target = path.join(this.trashDir, name);
        const st = await fsp.stat(target).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  async _cleanTmp() {
    try {
      const names = await fsp.readdir(this.tmpDir);
      await Promise.all(
        names.map((name) => fsp.rm(path.join(this.tmpDir, name), { recursive: true, force: true }).catch(() => {}))
      );
    } catch {
      /* ignore */
    }
  }

  absOfSync(rel) {
    return resolveInside(this.root, rel);
  }

  async absOf(rel) {
    const abs = resolveInside(this.root, rel);
    await assertNoSymlinkEscape(this.root, abs);
    return abs;
  }

  newTempPath(tag = 'w') {
    return path.join(this.tmpDir, `${tag}_${Date.now()}_${crypto.randomBytes(8).toString('hex')}.part`);
  }

  async versionOf(abs, st) {
    const key = `${abs}|${st.size}|${Math.round(st.mtimeMs)}`;
    if (st.size <= this.cfg.hashLimitBytes) {
      const cached = this.versionCache.get(key);
      if (cached) return cached;
    }
    const version = await fileVersion(abs, st, this.cfg);
    if (st.size <= this.cfg.hashLimitBytes) {
      if (this.versionCache.size > 2000) this.versionCache.clear();
      this.versionCache.set(key, version);
    }
    return version;
  }

  describe(rel, st) {
    const type = st.isDirectory() ? 'dir' : st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other';
    return {
      path: rel,
      name: baseName(rel) || '.',
      type,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      mtimeMs: Math.round(st.mtimeMs)
    };
  }

  async stat(rel, { withVersion = true } = {}) {
    const norm = normalizeRel(rel, { allowRoot: true });
    const abs = await this.absOf(norm);
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${norm || '/'}`, 404);
      throw err;
    }
    const info = this.describe(norm, st);
    if (info.type === 'file' && withVersion) info.version = await this.versionOf(abs, st);
    if (info.type === 'symlink') info.target = await fsp.readlink(abs).catch(() => null);
    return { ok: true, ...info };
  }

  async list(rel, options = {}) {
    const norm = normalizeRel(rel ?? '', { allowRoot: true });
    const abs = await this.absOf(norm);
    const showHidden = options.includeHidden === true;
    const recursive = options.recursive === true;
    const maxEntries = Math.max(1, Math.min(Number(options.max) || this.cfg.listDefaultMax, this.cfg.listHardMax));
    const maxDepth = Math.max(1, Math.min(Number(options.depth) || (recursive ? 32 : 1), 64));
    const matcher = makeMatcher(options.pattern || null);
    const withVersions = options.versions === true && maxEntries <= 200;

    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${norm || '/'}`, 404);
      throw err;
    }
    if (!st.isDirectory()) throw new HubError('not_a_directory', `not a directory: ${norm || '/'}`, 409);

    const entries = [];
    let truncated = false;

    const walk = async (dirAbs, dirRel, level) => {
      let dirents;
      try {
        dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      dirents.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of dirents) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (!showHidden && dirent.name.startsWith('.')) continue;
        const childRel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
        const childAbs = path.join(dirAbs, dirent.name);

        if (dirent.isSymbolicLink()) {
          if (matcher(childRel, dirent.name)) entries.push({ path: childRel, name: dirent.name, type: 'symlink' });
          continue;
        }

        let childStat;
        try {
          childStat = await fsp.stat(childAbs);
        } catch {
          continue;
        }
        const isDir = childStat.isDirectory();
        if (matcher(childRel, dirent.name)) {
          const item = {
            path: childRel,
            name: dirent.name,
            type: isDir ? 'dir' : 'file',
            size: childStat.size,
            mtime: new Date(childStat.mtimeMs).toISOString()
          };
          if (withVersions && !isDir) item.version = await this.versionOf(childAbs, childStat);
          entries.push(item);
        }
        if (recursive && isDir && level < maxDepth) {
          await walk(childAbs, childRel, level + 1);
          if (truncated) return;
        }
      }
    };

    await walk(abs, norm, 1);

    return {
      ok: true,
      path: norm || '/',
      pattern: options.pattern || null,
      recursive,
      count: entries.length,
      truncated: truncated || entries.length >= maxEntries,
      entries
    };
  }

  async mkdir(rel, { recursive = true, agentId = null, ip = null } = {}) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    try {
      const st = await fsp.stat(abs);
      if (!st.isDirectory()) throw new HubError('already_exists', `a file with this name already exists: ${norm}`, 409);
      return { ok: true, code: 'OK', action: 'exists', path: norm, type: 'dir' };
    } catch (err) {
      if (err instanceof HubError) throw err;
      if (err.code !== 'ENOENT') throw err;
    }
    if (!recursive) {
      const parent = path.dirname(abs);
      try {
        const pst = await fsp.stat(parent);
        if (!pst.isDirectory()) throw new Error('parent is not a directory');
      } catch {
        throw new HubError('parent_missing', `parent directory does not exist: ${parentRel(norm) || '/'}`, 409);
      }
    }
    await fsp.mkdir(abs, { recursive });
    await this.audit.log({ agent: agentId, op: 'mkdir', path: norm, ok: true, code: 'OK', ip });
    return { ok: true, code: 'OK', action: 'created', path: norm, type: 'dir' };
  }

  async readText(rel, { offset = 0, maxBytes = 64 * 1024, encoding = 'auto' } = {}) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${norm}`, 404);
      throw err;
    }
    if (!st.isFile()) throw new HubError('not_a_file', `not a file: ${norm}`, 409);

    const limit = Math.max(1, Math.min(Number(maxBytes) || 64 * 1024, 4 * 1024 * 1024));
    const start = Math.max(0, Math.min(Number(offset) || 0, st.size));
    const want = Math.min(limit + 4, st.size - start);

    let raw = Buffer.alloc(0);
    if (want > 0) {
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(want);
        const { bytesRead } = await fh.read(buf, 0, want, start);
        raw = buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }

    let lead = 0;
    if (start > 0) while (lead < raw.length && (raw[lead] & 0xc0) === 0x80) lead++;
    let end = raw.length;
    const truncated = start + raw.length < st.size;
    if (truncated) {
      for (let i = 1; i <= 4 && end - i >= lead; i++) {
        const b = raw[end - i];
        if ((b & 0x80) === 0) break;
        if ((b & 0xc0) === 0xc0) {
          const need = (b & 0xe0) === 0xc0 ? 2 : (b & 0xf0) === 0xe0 ? 3 : 4;
          if (i < need) end -= i;
          break;
        }
      }
    }
    const body = raw.subarray(lead, Math.max(lead, end));
    const binary = encoding === 'base64' || (encoding !== 'utf8' && looksBinary(body));

    return {
      ok: true,
      path: norm,
      type: 'file',
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      version: await this.versionOf(abs, st),
      offset: start + lead,
      nextOffset: start + lead + body.length,
      truncated,
      encoding: binary ? 'base64' : 'utf8',
      bytes: body.length,
      content: binary ? body.toString('base64') : body.toString('utf8')
    };
  }

  async readPreview(rel, abs, st) {
    const take = Math.min(st.size, this.cfg.inlinePreviewBytes);
    let buf = Buffer.alloc(0);
    if (take > 0) {
      const fh = await fsp.open(abs, 'r');
      try {
        const tmp = Buffer.alloc(take);
        const { bytesRead } = await fh.read(tmp, 0, take, 0);
        buf = tmp.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    }
    const binary = looksBinary(buf);
    return {
      size: st.size,
      bytes: buf.length,
      truncated: buf.length < st.size,
      binary,
      encoding: binary ? 'base64' : 'utf8',
      content: binary ? buf.toString('base64') : buf.toString('utf8')
    };
  }

  async buildConflict(rel, abs, st, version, { code, agentId = null, ageMs = null, lastAgent = null, expectedVersion = null, op = 'write' } = {}) {
    const preview = await this.readPreview(rel, abs, st);
    const isRecent = (code || 'RECENTLY_MODIFIED') === 'RECENTLY_MODIFIED';
    const ago = ageMs !== null ? formatAgo(ageMs) : null;

    const conflict = {
      ok: false,
      code: code || 'RECENTLY_MODIFIED',
      action: 'READ_NEW_CONTENT_AND_RETRY',
      message: isRecent
        ? `Файл "${rel}" був відредагований ${ago} тому (${humanBytes(st.size)}). Ознайомтеся з новим вмістом нижче — повторний запис із тим самим вмістом буде прийнятий.`
        : `Файл "${rel}" уже змінився після вашого читання. Ознайомтеся з новим вмістом нижче — повторний запис буде прийнятий.`,
      path: rel,
      op,
      version,
      yourVersion: expectedVersion || null,
      size: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
      modifiedAgoMs: ageMs,
      modifiedAgo: ago,
      lastWriter: lastAgent || null,
      encoding: preview.encoding,
      content: preview.content,
      contentBytes: preview.bytes,
      truncated: preview.truncated,
      downloadPath: `/v1/file?path=${encodeURIComponent(rel)}`,
      retry: {
        sameContent: true,
        expectedVersion: version,
        hint: 'Повторіть той самий запис (можна з expectedVersion = version) — цей запис пройде без блокування.'
      }
    };
    if (isRecent && lastAgent && lastAgent !== agentId) conflict.lastWriter = lastAgent;
    if (preview.truncated) {
      conflict.readHint = `Показано перші ${humanBytes(preview.bytes)} з ${humanBytes(st.size)}. Решту читайте через fs_read (offset=${preview.bytes}) або GET /v1/file?path=${encodeURIComponent(rel)}.`;
    }
    if (op === 'upload' || op === 'commit') {
      conflict.uploadRetry = 'Частини вже на диску: після ознайомлення повторіть commit цієї upload-сесії.';
    }
    return conflict;
  }

  async precheck(rel, { agentId = null, expectedVersion = null, consume = false } = {}) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    let st = null;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (st?.isDirectory()) throw new HubError('is_directory', `target is a directory: ${norm}`, 409);
    if (st?.isSymbolicLink()) throw new HubError('symlink_not_allowed', `target is a symlink: ${norm}`, 403);

    const exists = !!st;
    const version = exists ? await this.versionOf(abs, st) : null;
    const decision = this.guard.evaluate(norm, {
      agentId,
      exists,
      version,
      mtimeMs: st?.mtimeMs,
      expectedVersion,
      consume
    });
    if (decision.allow) return { allowed: true, rel: norm, exists, version, decision };
    const conflict = await this.buildConflict(norm, abs, st, version, {
      code: decision.code,
      agentId,
      ageMs: decision.ageMs,
      lastAgent: decision.lastAgent,
      expectedVersion,
      op: 'upload'
    });
    return { allowed: false, rel: norm, exists, version, conflict };
  }

  /**
   * Move a fully prepared temp file into place, applying the write guard.
   * Rejected writes return a conflict object (ok:false) instead of throwing.
   */
  async commitTemp(rel, tmpAbs, { agentId = 'anonymous', mode = 'overwrite', expectedVersion = null, createParents = true, bytes = null, op = 'write', keepTempOnReject = false, ip = null } = {}) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    const parentAbs = path.dirname(abs);

    if (createParents) {
      await fsp.mkdir(parentAbs, { recursive: true });
    } else {
      try {
        const pst = await fsp.stat(parentAbs);
        if (!pst.isDirectory()) throw new Error('not a dir');
      } catch {
        throw new HubError('parent_missing', `parent directory does not exist: ${parentRel(norm) || '/'}`, 409);
      }
    }

    return this.guard.withLock(norm, async () => {
      let st = null;
      try {
        st = await fsp.lstat(abs);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (st?.isDirectory()) throw new HubError('is_directory', `target is a directory: ${norm}`, 409);
      if (st?.isSymbolicLink()) throw new HubError('symlink_not_allowed', `target is a symlink: ${norm}`, 403);

      const exists = !!st;
      if (exists && mode === 'create') {
        if (!keepTempOnReject) await fsp.rm(tmpAbs, { force: true }).catch(() => {});
        throw new HubError('already_exists', `file already exists: ${norm}`, 409);
      }

      const version = exists ? await this.versionOf(abs, st) : null;
      const decision = this.guard.evaluate(norm, {
        agentId,
        exists,
        version,
        mtimeMs: st?.mtimeMs,
        expectedVersion
      });

      if (!decision.allow) {
        if (!keepTempOnReject) await fsp.rm(tmpAbs, { force: true }).catch(() => {});
        const conflict = await this.buildConflict(norm, abs, st, version, {
          code: decision.code,
          agentId,
          ageMs: decision.ageMs,
          lastAgent: decision.lastAgent,
          expectedVersion,
          op
        });
        await this.audit.log({ agent: agentId, op, path: norm, ok: false, code: decision.code, bytes, ip });
        return conflict;
      }

      let written = bytes;
      if (mode === 'append' && exists) {
        await pipeline(fs.createReadStream(tmpAbs), fs.createWriteStream(abs, { flags: 'a' }));
        await fsp.rm(tmpAbs, { force: true }).catch(() => {});
      } else {
        await renameWithRetry(tmpAbs, abs);
      }

      const after = await fsp.stat(abs);
      if (written === null || written === undefined) written = after.size;
      const newVersion = await this.versionOf(abs, after);
      this.guard.recordWrite(norm, agentId, newVersion, after.mtimeMs);

      const result = {
        ok: true,
        code: 'OK',
        action: mode === 'append' ? 'appended' : 'written',
        path: norm,
        mode,
        created: !exists,
        bytes: after.size,
        previousVersion: version,
        version: newVersion,
        mtime: new Date(after.mtimeMs).toISOString(),
        mtimeMs: Math.round(after.mtimeMs),
        agent: agentId,
        guard: decision.reason
      };
      if (decision.reason === 'second_attempt') {
        result.note = 'Запис прийнято після ознайомлення з новим вмістом.';
      }
      await this.audit.log({ agent: agentId, op, path: norm, ok: true, code: 'OK', bytes: after.size, version: newVersion, ip });
      return result;
    });
  }

  async write(rel, data, opts = {}) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data ?? ''), opts.encoding === 'base64' ? 'base64' : 'utf8');
    const tmp = this.newTempPath('write');
    await fsp.writeFile(tmp, buf);
    return this.commitTemp(rel, tmp, { ...opts, bytes: buf.length });
  }

  async append(rel, data, opts = {}) {
    return this.write(rel, data, { ...opts, mode: 'append' });
  }

  async move(fromRel, toRel, { agentId = 'anonymous', overwrite = false, ip = null } = {}) {
    const from = normalizeRel(fromRel, { allowRoot: false });
    const to = normalizeRel(toRel, { allowRoot: false });
    if (from === to) return { ok: true, code: 'OK', action: 'noop', path: to };

    const fromAbs = await this.absOf(from);
    let fromStat;
    try {
      fromStat = await fsp.lstat(fromAbs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${from}`, 404);
      throw err;
    }
    if (fromStat.isSymbolicLink()) throw new HubError('symlink_not_allowed', `source is a symlink: ${from}`, 403);
    if (from.startsWith(to + '/')) throw new HubError('bad_request', 'cannot move a directory into itself', 400);

    const toAbs = await this.absOf(to);
    await fsp.mkdir(path.dirname(toAbs), { recursive: true });

    return this.guard.withLock(to, async () => {
      let toStat = null;
      try {
        toStat = await fsp.lstat(toAbs);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      if (toStat && !overwrite) throw new HubError('already_exists', `target already exists: ${to}`, 409);
      if (toStat?.isSymbolicLink()) throw new HubError('symlink_not_allowed', `target is a symlink: ${to}`, 403);

      if (toStat) {
        const version = await this.versionOf(toAbs, toStat);
        const decision = this.guard.evaluate(to, { agentId, exists: true, version, mtimeMs: toStat.mtimeMs });
        if (!decision.allow) {
          const conflict = await this.buildConflict(to, toAbs, toStat, version, {
            code: decision.code,
            agentId,
            ageMs: decision.ageMs,
            lastAgent: decision.lastAgent,
            op: 'move'
          });
          conflict.from = from;
          await this.audit.log({ agent: agentId, op: 'move', path: to, ok: false, code: decision.code, ip });
          return conflict;
        }
        await fsp.rm(toAbs, { recursive: true, force: true });
      }

      await renameWithRetry(fromAbs, toAbs);
      const after = await fsp.stat(toAbs);
      const newVersion = after.isFile() ? await this.versionOf(toAbs, after) : null;
      if (after.isFile()) this.guard.recordWrite(to, agentId, newVersion, after.mtimeMs);
      this.guard.forget(from);
      await this.audit.log({ agent: agentId, op: 'move', path: to, from, ok: true, code: 'OK', ip });
      return {
        ok: true,
        code: 'OK',
        action: 'moved',
        from,
        to,
        type: after.isDirectory() ? 'dir' : 'file',
        size: after.size,
        version: newVersion
      };
    });
  }

  async copy(fromRel, toRel, { agentId = 'anonymous', overwrite = false, ip = null } = {}) {
    const from = normalizeRel(fromRel, { allowRoot: false });
    const to = normalizeRel(toRel, { allowRoot: false });
    if (from === to) throw new HubError('bad_request', 'source and target are the same path', 400);
    if (to.startsWith(from + '/')) throw new HubError('bad_request', 'cannot copy a directory into itself', 400);

    const fromAbs = await this.absOf(from);
    let fromStat;
    try {
      fromStat = await fsp.lstat(fromAbs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${from}`, 404);
      throw err;
    }
    if (fromStat.isSymbolicLink()) throw new HubError('symlink_not_allowed', `source is a symlink: ${from}`, 403);

    if (fromStat.isDirectory()) {
      await this.mkdir(to, { recursive: true, agentId, ip });
      const copied = [];
      const failed = [];
      const entries = await fsp.readdir(fromAbs, { withFileTypes: true });
      for (const entry of entries) {
        const childFrom = `${from}/${entry.name}`;
        const childTo = `${to}/${entry.name}`;
        try {
          const res = await this.copy(childFrom, childTo, { agentId, overwrite, ip });
          if (res.ok) copied.push(childTo);
          else failed.push(res);
        } catch (err) {
          if (err instanceof HubError) failed.push({ ok: false, code: err.code, path: childTo, message: err.message });
          else throw err;
        }
      }
      if (failed.length) {
        const first = failed[0];
        return {
          ...first,
          ok: false,
          action: 'copy_partial',
          from,
          to,
          copiedFiles: copied.length,
          failedFiles: failed.length,
          failures: failed.slice(0, 20)
        };
      }
      await this.audit.log({ agent: agentId, op: 'copy', path: to, from, ok: true, code: 'OK', ip });
      return { ok: true, code: 'OK', action: 'copied', from, to, type: 'dir', copiedFiles: copied.length };
    }

    const tmp = this.newTempPath('copy');
    try {
      await pipeline(fs.createReadStream(fromAbs), fs.createWriteStream(tmp));
      const result = await this.commitTemp(to, tmp, {
        agentId,
        mode: overwrite ? 'overwrite' : 'create',
        createParents: true,
        op: 'copy',
        ip
      });
      if (result.ok) result.action = 'copied';
      return result;
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async remove(rel, { agentId = 'anonymous', recursive = false, permanent = false, ip = null } = {}) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    let st;
    try {
      st = await fsp.lstat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${norm}`, 404);
      throw err;
    }
    if (st.isSymbolicLink()) throw new HubError('symlink_not_allowed', `refusing to delete a symlink: ${norm}`, 403);

    if (st.isDirectory() && !recursive) {
      const entries = await fsp.readdir(abs);
      if (entries.length > 0) throw new HubError('not_empty', `directory is not empty: ${norm} (use recursive=true)`, 409);
    }

    const useTrash = !permanent && this.cfg.trash?.enabled !== false;
    let trashId = null;
    if (useTrash) {
      trashId = new Date().toISOString().replace(/[:.]/g, '-');
      const target = path.join(this.trashDir, trashId, ...norm.split('/'));
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await renameWithRetry(abs, target);
    } else {
      await fsp.rm(abs, { recursive: true, force: false });
    }

    this.guard.forget(norm);
    await this.audit.log({ agent: agentId, op: 'delete', path: norm, ok: true, code: 'OK', permanent: !useTrash, ip });
    return {
      ok: true,
      code: 'OK',
      action: useTrash ? 'trashed' : 'deleted',
      path: norm,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.size,
      trashId
    };
  }

  async openRead(rel, rangeHeader = null) {
    const norm = normalizeRel(rel, { allowRoot: false });
    const abs = await this.absOf(norm);
    let st;
    try {
      st = await fsp.stat(abs);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HubError('not_found', `not found: ${norm}`, 404);
      throw err;
    }
    if (!st.isFile()) throw new HubError('not_a_file', `not a file: ${norm}`, 409);

    const version = await this.versionOf(abs, st);
    let start = 0;
    let end = st.size - 1;
    let status = 200;
    if (rangeHeader) {
      const parsed = parseRangeSafe(rangeHeader, st.size);
      if (!parsed) {
        throw new HubError('range_not_satisfiable', 'requested range is not satisfiable', 416, { size: st.size });
      }
      start = parsed.start;
      end = parsed.end;
      status = 206;
    }
    return { norm, abs, st, version, start, end, status, contentType: contentTypeFor(norm) };
  }

  async search(baseRel, { name = null, content = null, max = 100, maxDepth = 16, includeHidden = false } = {}) {
    const norm = normalizeRel(baseRel ?? '', { allowRoot: true });
    const baseAbs = await this.absOf(norm);
    const limit = Math.max(1, Math.min(Number(max) || 100, 2000));
    const nameMatch = name ? makeMatcher(name) : null;
    let contentRe = null;
    if (content) {
      try {
        contentRe = new RegExp(content, 'i');
      } catch {
        contentRe = null;
      }
    }

    const results = [];
    let scanned = 0;
    let truncated = false;

    const inspectFile = async (abs, rel) => {
      let st;
      try {
        st = await fsp.stat(abs);
      } catch {
        return;
      }
      if (!content) {
        results.push({ path: rel, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
        return;
      }
      if (st.size > this.cfg.searchMaxFileBytes) return;
      const buf = await fsp.readFile(abs).catch(() => null);
      if (!buf || looksBinary(buf)) return;
      const text = buf.toString('utf8');
      const idx = contentRe ? text.search(contentRe) : text.indexOf(content);
      if (idx < 0) return;
      const line = text.slice(0, idx).split('\n').length;
      const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
      const lineEnd = text.indexOf('\n', idx);
      results.push({ path: rel, line, snippet: text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd).slice(0, 400) });
    };

    const walk = async (dirAbs, dirRel, depth) => {
      if (results.length >= limit || depth > maxDepth) {
        if (results.length >= limit) truncated = true;
        return;
      }
      let dirents;
      try {
        dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (results.length >= limit) {
          truncated = true;
          return;
        }
        if (!includeHidden && dirent.name.startsWith('.')) continue;
        if (++scanned > 50_000) {
          truncated = true;
          return;
        }
        const childRel = dirRel ? `${dirRel}/${dirent.name}` : dirent.name;
        const childAbs = path.join(dirAbs, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          await walk(childAbs, childRel, depth + 1);
          continue;
        }
        if (!dirent.isFile()) continue;
        if (name && !nameMatch(childRel, dirent.name)) continue;
        await inspectFile(childAbs, childRel);
      }
    };

    const baseStat = await fsp.stat(baseAbs);
    if (baseStat.isFile()) {
      if (!name || nameMatch(norm, baseName(norm))) await inspectFile(baseAbs, norm);
    } else {
      await walk(baseAbs, norm, 0);
    }

    return {
      ok: true,
      base: norm || '/',
      query: { name, content },
      count: results.length,
      truncated,
      results
    };
  }

  async usage(rel, { maxEntries = 200_000, includeHidden = true } = {}) {
    const norm = normalizeRel(rel ?? '', { allowRoot: true });
    const abs = await this.absOf(norm);
    let totalBytes = 0;
    let files = 0;
    let dirs = 0;
    let scanned = 0;
    let truncated = false;

    const walk = async (dirAbs) => {
      let dirents;
      try {
        dirents = await fsp.readdir(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        if (++scanned > maxEntries) {
          truncated = true;
          return;
        }
        if (!includeHidden && dirent.name.startsWith('.')) continue;
        const childAbs = path.join(dirAbs, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          dirs++;
          await walk(childAbs);
          if (truncated) return;
        } else if (dirent.isFile()) {
          let st;
          try {
            st = await fsp.stat(childAbs);
          } catch {
            continue;
          }
          files++;
          totalBytes += st.size;
        }
      }
    };

    const st = await fsp.stat(abs);
    if (st.isFile()) {
      files = 1;
      totalBytes = st.size;
    } else {
      await walk(abs);
    }

    return {
      ok: true,
      path: norm || '/',
      bytes: totalBytes,
      human: humanBytes(totalBytes),
      files,
      dirs,
      truncated
    };
  }

  async diskInfo() {
    try {
      const s = await fsp.statfs(this.root);
      return {
        freeBytes: Number(s.bavail) * Number(s.bsize),
        freeHuman: humanBytes(Number(s.bavail) * Number(s.bsize)),
        totalBytes: Number(s.blocks) * Number(s.bsize),
        totalHuman: humanBytes(Number(s.blocks) * Number(s.bsize))
      };
    } catch {
      return null;
    }
  }

  info() {
    return {
      name: this.cfg.name,
      root: this.root,
      guard: this.guard.status(),
      limits: {
        inlinePreviewBytes: this.cfg.inlinePreviewBytes,
        maxInlineWriteBytes: this.cfg.maxInlineWriteBytes,
        hashLimitBytes: this.cfg.hashLimitBytes
      }
    };
  }
}

function parseRangeSafe(header, size) {
  if (!header || !header.startsWith('bytes=')) return null;
  const spec = header.slice(6).split(',')[0].trim();
  const m = /^(\d*)-(\d*)$/.exec(spec);
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  if (size === 0) return null;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return null;
  let end = rawEnd === '' ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(end)) end = size - 1;
  end = Math.min(end, size - 1);
  if (end < start) return null;
  return { start, end };
}
