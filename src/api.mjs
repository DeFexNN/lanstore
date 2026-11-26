import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { HubError, APP_VERSION, formatAgo } from './util.mjs';
import { sendJson, readJson, writeReqToFile, headerValue } from './http.mjs';

const UPLOAD_RE = /^\/v1\/uploads\/(up_[a-f0-9]{18})(\/commit)?$/;

function reply(res, result, extraHeaders = null) {
  const status = result && result.ok === false ? 409 : 200;
  sendJson(res, status, result, extraHeaders);
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

function asInt(value, fallback = undefined) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function createApi({ store, uploads, cfg, audit, guard, startedAt, identity }) {
  return async function handleApi(req, res, url, agent) {
    const method = req.method || 'GET';
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    if (pathname === '/v1/health' || pathname === '/health') {
      const restricted = agent?.unauthenticated === true;
      const payload = {
        ok: true,
        name: cfg.name,
        version: APP_VERSION,
        now: new Date().toISOString(),
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        cooldownSec: Math.round(cfg.cooldownMs / 1000),
        guard: guard.status(),
        authEnabled: cfg.auth.enabled,
        hubId: identity?.hubId ?? null,
        port: cfg.port,
        discovery: {
          enabled: cfg.discovery?.enabled !== false,
          udpPort: cfg.discovery?.port ?? 8788
        }
      };
      if (!restricted) {
        Object.assign(payload, {
          platform: process.platform,
          publicUrl: cfg.publicUrl,
          root: store.root,
          storage: await store.diskInfo(),
          uploads: uploads.list({ agentId: agent.id }).length
        });
      }
      return sendJson(res, 200, payload);
    }

    if (pathname === '/v1/discover') {
      return sendJson(res, 200, {
        ok: true,
        magic: 'LANSTORE_HUB',
        protocol: 1,
        name: cfg.name,
        hubId: identity?.hubId ?? null,
        port: cfg.port,
        version: APP_VERSION,
        authEnabled: cfg.auth.enabled,
        cooldownSec: Math.round(cfg.cooldownMs / 1000),
        discovery: {
          enabled: cfg.discovery?.enabled !== false,
          udpPort: cfg.discovery?.port ?? 8788
        }
      });
    }

    if (pathname === '/v1/whoami' || pathname === '/v1/me') {
      return sendJson(res, 200, {
        ok: true,
        agent: agent.id,
        ip: agent.ip,
        anonymous: agent.anonymous,
        root: store.root,
        baseUrl: cfg.publicUrl || `http://${headerValue(req, 'host')}`
      });
    }

    if (pathname === '/v1/info') {
      return sendJson(res, 200, {
        ok: true,
        ...store.info(),
        version: APP_VERSION,
        hubId: identity?.hubId ?? null,
        authEnabled: cfg.auth.enabled,
        discovery: { enabled: cfg.discovery?.enabled !== false, udpPort: cfg.discovery?.port ?? 8788 },
        disk: await store.diskInfo(),
        uploads: { chunkHint: cfg.uploads.chunkHint, active: uploads.list({ agentId: agent.id }).length }
      });
    }

    if (pathname === '/v1/list') {
      const result = await store.list(q.get('path') || '', {
        pattern: q.get('pattern'),
        recursive: asBool(q.get('recursive')),
        depth: asInt(q.get('depth')),
        max: asInt(q.get('max')),
        includeHidden: asBool(q.get('hidden')),
        versions: asBool(q.get('versions'))
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/stat') {
      const result = await store.stat(q.get('path') || '', { withVersion: !asBool(q.get('noversion')) });
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/mkdir') {
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const result = await store.mkdir(body.path, {
        recursive: body.recursive !== false,
        agentId: agent.id,
        ip: agent.ip
      });
      return reply(res, result);
    }

    if (pathname === '/v1/write' || pathname === '/v1/append') {
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const content = body.contentB64 ?? body.contentBase64 ?? body.content ?? '';
      if (typeof content !== 'string') throw new HubError('bad_request', 'content must be a string', 400);
      const encoding = body.contentB64 || body.contentBase64 ? 'base64' : body.encoding === 'base64' ? 'base64' : 'utf8';
      const result = await store.write(body.path, content, {
        agentId: agent.id,
        encoding,
        mode: pathname === '/v1/append' ? 'append' : body.mode || 'overwrite',
        expectedVersion: body.expectedVersion || null,
        createParents: body.parents !== false,
        op: pathname === '/v1/append' ? 'append' : 'write',
        ip: agent.ip
      });
      return reply(res, result);
    }

    if (pathname === '/v1/move' || pathname === '/v1/copy') {
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const fn = pathname === '/v1/move' ? store.move.bind(store) : store.copy.bind(store);
      const result = await fn(body.from ?? body.path, body.to ?? body.dest, {
        agentId: agent.id,
        overwrite: body.overwrite === true,
        ip: agent.ip
      });
      return reply(res, result);
    }

    if (pathname === '/v1/delete' || pathname === '/v1/remove') {
      if (method !== 'POST' && method !== 'DELETE') throw new HubError('method_not_allowed', 'use POST or DELETE', 405);
      let body = {};
      if (method === 'POST') body = await readJson(req, cfg.maxJsonBodyBytes);
      const target = method === 'DELETE' ? q.get('path') : body.path;
      const result = await store.remove(target, {
        agentId: agent.id,
        recursive: method === 'DELETE' ? asBool(q.get('recursive')) : body.recursive === true,
        permanent: method === 'DELETE' ? asBool(q.get('permanent')) : body.permanent === true,
        ip: agent.ip
      });
      return reply(res, result);
    }

    if (pathname === '/v1/trash') {
      if (method === 'GET') {
        return sendJson(res, 200, await store.listTrash({ limit: asInt(q.get('limit'), 200) }));
      }
      if (method === 'POST') {
        const body = await readJson(req, cfg.maxJsonBodyBytes);
        const result = await store.emptyTrash({
          all: body.all === true,
          olderThanDays: body.olderThanDays ?? 0,
          agentId: agent.id,
          ip: agent.ip
        });
        return sendJson(res, 200, result);
      }
      throw new HubError('method_not_allowed', 'use GET /v1/trash or POST /v1/trash {all|olderThanDays}', 405);
    }

    if (pathname === '/v1/restore') {
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const result = await store.restore(body.trashId, {
        to: body.to || null,
        overwrite: body.overwrite === true,
        agentId: agent.id,
        ip: agent.ip
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/read') {
      const result = await store.readText(q.get('path') || '', {
        offset: asInt(q.get('offset'), 0),
        maxBytes: asInt(q.get('maxBytes'), 64 * 1024),
        encoding: q.get('encoding') || 'auto'
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/search') {
      const result = await store.search(q.get('path') || '', {
        name: q.get('name'),
        content: q.get('content') ?? q.get('q'),
        max: asInt(q.get('max'), 100),
        maxDepth: asInt(q.get('depth'), 16),
        includeHidden: asBool(q.get('hidden'))
      });
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/usage') {
      const result = await store.usage(q.get('path') || '');
      return sendJson(res, 200, result);
    }

    if (pathname === '/v1/activity' || pathname === '/v1/audit' || pathname === '/v1/journal') {
      const events = await audit.tail(asInt(q.get('limit'), 50), {
        path: q.get('path') || undefined,
        agent: q.get('agent') || undefined,
        op: q.get('op') || undefined,
        onlyWrites: asBool(q.get('writes'))
      });
      return sendJson(res, 200, { ok: true, count: events.length, events });
    }

    if (pathname === '/v1/precheck') {
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const pre = await store.precheck(body.path, {
        agentId: agent.id,
        expectedVersion: body.expectedVersion || null,
        consume: false
      });
      if (pre.allowed) {
        return sendJson(res, 200, {
          ok: true,
          action: 'WRITE_ALLOWED',
          path: pre.rel,
          exists: pre.exists,
          version: pre.version,
          reason: pre.decision?.reason,
          modifiedAgo: pre.decision?.ageMs !== null && pre.decision?.ageMs !== undefined ? formatAgo(pre.decision.ageMs) : null
        });
      }
      return sendJson(res, 409, pre.conflict);
    }

    if (pathname === '/v1/uploads') {
      if (method === 'GET') {
        return sendJson(res, 200, { ok: true, count: uploads.list({ agentId: agent.id }).length, uploads: uploads.list({ agentId: agent.id }) });
      }
      if (method !== 'POST') throw new HubError('method_not_allowed', 'use GET or POST', 405);
      const body = await readJson(req, cfg.maxJsonBodyBytes);
      const result = await uploads.begin({
        rel: body.path,
        totalBytes: body.totalBytes ?? body.size ?? null,
        mode: body.mode || 'overwrite',
        expectedVersion: body.expectedVersion || null,
        createParents: body.parents !== false,
        agentId: agent.id
      });
      return reply(res, result);
    }

    const uploadMatch = UPLOAD_RE.exec(pathname);
    if (uploadMatch) {
      const id = uploadMatch[1];
      const isCommit = !!uploadMatch[2];

      if (isCommit && method === 'POST') {
        const body = await readJson(req, cfg.maxJsonBodyBytes);
        const result = await uploads.commit(id, {
          agentId: agent.id,
          expectedVersion: body.expectedVersion || null,
          mode: body.mode || null
        });
        return reply(res, result);
      }

      if (!isCommit && method === 'PUT') {
        const offset = asInt(headerValue(req, 'x-offset') ?? q.get('offset'), 0);
        const result = await uploads.chunkStream(id, { offset, req, agentId: agent.id });
        return sendJson(res, 200, result);
      }

      if (!isCommit && method === 'DELETE') {
        const result = await uploads.abort(id, { agentId: agent.id });
        return sendJson(res, 200, result);
      }

      if (!isCommit && method === 'GET') {
        const meta = await uploads.get(id);
        if (!meta) throw new HubError('upload_not_found', `unknown upload id: ${id}`, 404);
        return sendJson(res, 200, { ok: true, ...uploads._public(meta) });
      }

      throw new HubError('method_not_allowed', `method ${method} is not allowed here`, 405);
    }

    if (pathname === '/v1/file') {
      if (method === 'PUT') {
        return putFile({ req, res, url, store, cfg, agent });
      }
      if (method !== 'GET' && method !== 'HEAD') {
        throw new HubError('method_not_allowed', 'use GET, HEAD or PUT on /v1/file?path=...', 405);
      }
      return serveFile({ req, res, url, store });
    }

    throw new HubError('not_found', `no such endpoint: ${pathname}`, 404);
  };
}

async function serveFile({ req, res, url, store }) {
  const opened = await store.openRead(url.searchParams.get('path') || '', headerValue(req, 'range'));
  const etag = `"${opened.version}"`;
  const headers = {
    'Content-Type': opened.contentType,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': opened.st.mtime.toUTCString(),
    'Cache-Control': 'no-cache',
    'X-Content-Version': opened.version
  };
  if (url.searchParams.get('download') === '1' || url.searchParams.get('name') === '1') {
    headers['Content-Disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(opened.norm))}`;
  }

  const inm = headerValue(req, 'if-none-match');
  if (inm && inm.split(',').map((s) => s.trim()).includes(etag)) {
    res.writeHead(304, headers);
    res.end();
    return;
  }

  const length = opened.status === 206 ? opened.end - opened.start + 1 : opened.st.size;
  headers['Content-Length'] = length;
  if (opened.status === 206) headers['Content-Range'] = `bytes ${opened.start}-${opened.end}/${opened.st.size}`;
  res.writeHead(opened.status, headers);

  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  const stream = fs.createReadStream(opened.abs, { start: opened.start, end: opened.end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/**
 * Raw upload endpoint: PUT /v1/file?path=... streams the body to a temp file,
 * then the write guard decides. For >64 MB prefer the session flow.
 */
export async function putFile({ req, res, url, store, cfg, agent }) {
  const tmp = store.newTempPath('put');
  let written = 0;
  try {
    written = await writeReqToFile(req, tmp, { limit: cfg.maxPutBytes });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  const result = await store.commitTemp(url.searchParams.get('path') || '', tmp, {
    agentId: agent.id,
    mode: url.searchParams.get('mode') || 'overwrite',
    expectedVersion: url.searchParams.get('expectedVersion') || null,
    createParents: url.searchParams.get('parents') !== '0',
    bytes: written,
    op: 'put',
    ip: agent.ip
  });
  reply(res, result);
}
