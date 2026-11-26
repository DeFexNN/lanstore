import fsp from 'node:fs/promises';
import path from 'node:path';

import { HubError, randomId } from './util.mjs';

const ID_RE = /^up_[a-f0-9]{18}$/;

/**
 * Resumable upload sessions for big files (tens of GB).
 * The write guard runs twice: once at `begin` (cheap rejection before any
 * bytes are sent) and once at `commit` (authoritative, under a path lock).
 */
export class Uploads {
  constructor({ store, cfg }) {
    this.store = store;
    this.cfg = cfg;
    this.dir = store.uploadDir;
    this.sessions = new Map();
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
    const names = await fsp.readdir(this.dir).catch(() => []);
    const now = Date.now();
    for (const name of names) {
      if (!ID_RE.test(name)) {
        await this.drop(name);
        continue;
      }
      const meta = await this._read(name).catch(() => null);
      if (!meta) {
        await this.drop(name);
        continue;
      }
      if (now - meta.createdAt > this.cfg.uploads.ttlMs) {
        await this.drop(name);
        continue;
      }
      this.sessions.set(name, meta);
    }
  }

  async _read(id) {
    if (!ID_RE.test(id)) return null;
    const raw = await fsp.readFile(path.join(this.dir, id, 'meta.json'), 'utf8');
    const meta = JSON.parse(raw);
    if (!meta || meta.id !== id) return null;
    return meta;
  }

  async get(id) {
    if (!ID_RE.test(id)) return null;
    return this.sessions.get(id) || (await this._read(id).catch(() => null));
  }

  async _save(meta) {
    await fsp.writeFile(path.join(this.dir, meta.id, 'meta.json'), JSON.stringify(meta, null, 2));
    this.sessions.set(meta.id, meta);
  }

  async drop(id) {
    this.sessions.delete(id);
    await fsp.rm(path.join(this.dir, id), { recursive: true, force: true }).catch(() => {});
  }

  _public(meta) {
    return {
      uploadId: meta.id,
      path: meta.path,
      mode: meta.mode,
      totalBytes: meta.totalBytes,
      received: meta.received,
      createdBy: meta.createdBy,
      createdAt: new Date(meta.createdAt).toISOString(),
      nextOffset: meta.received,
      readyToCommit: meta.totalBytes !== null && meta.totalBytes !== undefined && meta.received >= meta.totalBytes,
      chunkPath: `/v1/uploads/${meta.id}`,
      commitPath: `/v1/uploads/${meta.id}/commit`
    };
  }

  async begin({ rel, totalBytes = null, mode = 'overwrite', expectedVersion = null, createParents = true, agentId = 'anonymous' } = {}) {
    const pre = await this.store.precheck(rel, { agentId, expectedVersion, consume: false });
    if (!pre.allowed) return pre.conflict;

    const id = randomId('up_');
    const meta = {
      id,
      path: pre.rel,
      totalBytes: totalBytes === null || totalBytes === undefined ? null : Number(totalBytes),
      mode: mode === 'create' ? 'create' : mode === 'append' ? 'append' : 'overwrite',
      expectedVersion: expectedVersion || null,
      createParents: createParents !== false,
      createdBy: agentId,
      createdAt: Date.now(),
      received: 0,
      versionAtBegin: pre.version
    };
    if (meta.totalBytes !== null && (!Number.isFinite(meta.totalBytes) || meta.totalBytes < 0)) {
      throw new HubError('bad_request', 'totalBytes must be a non-negative number', 400);
    }

    await fsp.mkdir(path.join(this.dir, id), { recursive: true });
    await fsp.writeFile(path.join(this.dir, id, 'part'), Buffer.alloc(0));
    await this._save(meta);

    return {
      ok: true,
      code: 'OK',
      action: 'upload_started',
      ...this._public(meta),
      chunkHint: this.cfg.uploads.chunkHint,
      note: 'Надсилайте частини поспіль: PUT chunkPath?offset=<nextOffset> з тілом-байтами. Потім POST commitPath.'
    };
  }

  async chunk(id, { offset = 0, buffer, agentId = 'anonymous' } = {}) {
    const meta = await this.get(id);
    if (!meta) throw new HubError('upload_not_found', `unknown upload id: ${id}`, 404);
    if (meta.createdBy && meta.createdBy !== 'anonymous' && meta.createdBy !== agentId) {
      throw new HubError('forbidden', 'this upload session belongs to another agent', 403);
    }
    if (offset !== meta.received) {
      throw new HubError('offset_mismatch', `expected offset ${meta.received}, got ${offset}`, 409, {
        uploadId: id,
        nextOffset: meta.received
      });
    }
    if (!buffer?.length) throw new HubError('bad_request', 'empty chunk', 400);
    if (meta.totalBytes !== null && meta.received + buffer.length > meta.totalBytes) {
      throw new HubError('too_large', `chunk exceeds declared totalBytes (${meta.totalBytes})`, 409, { uploadId: id });
    }

    await fsp.appendFile(path.join(this.dir, id, 'part'), buffer);
    meta.received += buffer.length;
    await this._save(meta);
    return { ok: true, code: 'OK', action: 'chunk_received', ...this._public(meta) };
  }

  async commit(id, { agentId = 'anonymous', expectedVersion = null, mode = null } = {}) {
    const meta = await this.get(id);
    if (!meta) throw new HubError('upload_not_found', `unknown upload id: ${id}`, 404);
    if (meta.createdBy && meta.createdBy !== 'anonymous' && meta.createdBy !== agentId) {
      throw new HubError('forbidden', 'this upload session belongs to another agent', 403);
    }
    if (meta.totalBytes !== null && meta.received < meta.totalBytes) {
      throw new HubError('incomplete', `received ${meta.received} of ${meta.totalBytes} bytes`, 409, {
        uploadId: id,
        nextOffset: meta.received
      });
    }

    const partAbs = path.join(this.dir, id, 'part');
    const result = await this.store.commitTemp(meta.path, partAbs, {
      agentId,
      mode: mode || meta.mode,
      expectedVersion: expectedVersion ?? meta.expectedVersion,
      createParents: meta.createParents !== false,
      bytes: meta.received,
      op: 'upload',
      keepTempOnReject: true
    });

    if (result.ok) {
      await this.drop(id);
      return result;
    }

    result.uploadId = id;
    result.retry = { ...(result.retry || {}), commit: true, uploadId: id };
    return result;
  }

  async abort(id, { agentId = 'anonymous' } = {}) {
    const meta = await this.get(id);
    if (!meta) throw new HubError('upload_not_found', `unknown upload id: ${id}`, 404);
    if (meta.createdBy && meta.createdBy !== 'anonymous' && meta.createdBy !== agentId) {
      throw new HubError('forbidden', 'this upload session belongs to another agent', 403);
    }
    await this.drop(id);
    return { ok: true, code: 'OK', action: 'upload_aborted', uploadId: id };
  }

  list({ agentId = null } = {}) {
    return [...this.sessions.values()]
      .filter((meta) => !agentId || !meta.createdBy || meta.createdBy === 'anonymous' || meta.createdBy === agentId)
      .map((meta) => this._public(meta));
  }
}
