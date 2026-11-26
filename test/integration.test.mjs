import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../src/server.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanstore-it-'));
const dataRoot = path.join(tmpRoot, 'data');

const hub = await createHub({
  argv: ['--config', path.join(tmpRoot, 'no-such-config.json')],
  overrides: {
    root: dataRoot,
    port: 0,
    host: '127.0.0.1',
    cooldownMs: 60_000,
    auth: { enabled: false },
    audit: { enabled: false },
    discovery: { enabled: false }
  }
});

const base = () => `http://127.0.0.1:${hub.cfg.port}`;

after(async () => {
  await hub.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

async function req(pathname, { method = 'GET', body, agent, headers = {} } = {}) {
  const h = { ...headers };
  if (agent) h['X-Agent-Id'] = agent;
  let payload;
  if (body !== undefined) {
    if (body instanceof Uint8Array) {
      payload = body;
    } else {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(`${base()}${pathname}`, { method, headers: h, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch {
    data = buf;
  }
  return { status: res.status, data, headers: res.headers, buf };
}

test('health reports the guard policy', async () => {
  const res = await req('/v1/health');
  assert.equal(res.status, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.guard.cooldownMs, 60_000);
  assert.ok(res.data.storage === null || typeof res.data.storage.freeBytes === 'number');
});

test('mkdir, write, stat and list work end to end', async () => {
  const mk = await req('/v1/mkdir', { method: 'POST', agent: 'agent-a', body: { path: 'askue/raw' } });
  assert.equal(mk.status, 200);
  assert.equal(mk.data.action, 'created');

  const wr = await req('/v1/write', {
    method: 'POST',
    agent: 'agent-a',
    body: { path: 'askue/raw/readme.md', content: 'hello askue' }
  });
  assert.equal(wr.status, 200);
  assert.equal(wr.data.ok, true);
  assert.equal(wr.data.bytes, 11);
  assert.match(wr.data.version, /^sha256:/);

  const st = await req(`/v1/stat?path=${encodeURIComponent('askue/raw/readme.md')}`);
  assert.equal(st.status, 200);
  assert.equal(st.data.size, 11);
  assert.equal(st.data.version, wr.data.version);

  const ls = await req(`/v1/list?path=${encodeURIComponent('askue')}`);
  assert.equal(ls.status, 200);
  assert.deepEqual(ls.data.entries.map((e) => e.path), ['askue/raw']);

  const rd = await req(`/v1/read?path=${encodeURIComponent('askue/raw/readme.md')}`);
  assert.equal(rd.data.content, 'hello askue');
  assert.equal(rd.data.truncated, false);
});

test('write guard: blocked once with new content, second write passes', async () => {
  const p = 'askue/raw/shared.csv';
  const first = await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'v1;1\n' } });
  assert.equal(first.status, 200);

  const blocked = await req('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: p, content: 'v2;2\n' } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.ok, false);
  assert.equal(blocked.data.code, 'RECENTLY_MODIFIED');
  assert.equal(blocked.data.content, 'v1;1\n');
  assert.equal(blocked.data.version, first.data.version);
  assert.equal(blocked.data.retry.sameContent, true);
  assert.match(blocked.data.message, /був відредагований/);

  const retry = await req('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: p, content: 'v2;2\n' } });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.ok, true);
  assert.equal(retry.data.guard, 'second_attempt');
  assert.equal(retry.data.note, 'Запис прийнято після ознайомлення з новим вмістом.');

  const readBack = await req(`/v1/read?path=${encodeURIComponent(p)}`);
  assert.equal(readBack.data.content, 'v2;2\n');
});

test('the writer can overwrite its own fresh file without a round trip', async () => {
  const p = 'askue/raw/own.txt';
  assert.equal((await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'one' } })).status, 200);
  const second = await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'two' } });
  assert.equal(second.status, 200);
  assert.equal(second.data.guard, 'own_write');
});

test('append works and preserves content', async () => {
  const p = 'askue/raw/log.txt';
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'a\n' } });
  const app = await req('/v1/append', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'b\n' } });
  assert.equal(app.status, 200);
  const readBack = await req(`/v1/read?path=${encodeURIComponent(p)}`);
  assert.equal(readBack.data.content, 'a\nb\n');
});

test('stale expectedVersion is rejected with the fresh content', async () => {
  const p = 'askue/raw/versioned.txt';
  const created = await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: '001' } });
  await fsp.utimes(path.join(dataRoot, 'askue', 'raw', 'versioned.txt'), new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));

  const blocked = await req('/v1/write', {
    method: 'POST',
    agent: 'agent-b',
    body: { path: p, content: '002', expectedVersion: 'sha256:deadbeef' }
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'VERSION_MISMATCH');
  assert.equal(blocked.data.content, '001');
  assert.equal(blocked.data.version, created.data.version);

  const retry = await req('/v1/write', {
    method: 'POST',
    agent: 'agent-b',
    body: { path: p, content: '002', expectedVersion: created.data.version }
  });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.ok, true);
});

test('range requests and HEAD are supported', async () => {
  const p = 'askue/raw/binary.bin';
  const payload = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  const put = await req(`/v1/file?path=${encodeURIComponent(p)}`, { method: 'PUT', agent: 'agent-a', body: payload });
  assert.equal(put.status, 200);
  assert.equal(put.data.bytes, 1000);

  const ranged = await req(`/v1/file?path=${encodeURIComponent(p)}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.buf.length, 10);
  assert.deepEqual([...ranged.buf], [...payload.subarray(10, 20)]);
  assert.match(ranged.headers.get('content-range'), /^bytes 10-19\/1000$/);

  const head = await req(`/v1/file?path=${encodeURIComponent(p)}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('content-length'), '1000');

  const etag = ranged.headers.get('etag');
  const notModified = await req(`/v1/file?path=${encodeURIComponent(p)}`, { headers: { 'If-None-Match': etag } });
  assert.equal(notModified.status, 304);
});

test('resumable upload sessions commit through the guard', async () => {
  const p = 'askue/raw/chunks.dat';
  const payload = Buffer.from('0123456789');

  const begin = await req('/v1/uploads', { method: 'POST', agent: 'agent-a', body: { path: p, totalBytes: payload.length } });
  assert.equal(begin.status, 200);
  const id = begin.data.uploadId;
  assert.match(id, /^up_[a-f0-9]{18}$/);

  const c1 = await req(`/v1/uploads/${id}?offset=0`, { method: 'PUT', agent: 'agent-a', body: payload.subarray(0, 4) });
  assert.equal(c1.status, 200);
  assert.equal(c1.data.nextOffset, 4);

  const wrongOffset = await req(`/v1/uploads/${id}?offset=0`, { method: 'PUT', agent: 'agent-a', body: payload.subarray(4) });
  assert.equal(wrongOffset.status, 409);
  assert.equal(wrongOffset.data.code, 'offset_mismatch');
  assert.equal(wrongOffset.data.nextOffset, 4);

  const c2 = await req(`/v1/uploads/${id}?offset=4`, { method: 'PUT', agent: 'agent-a', body: payload.subarray(4) });
  assert.equal(c2.status, 200);
  assert.equal(c2.data.readyToCommit, true);

  const commit = await req(`/v1/uploads/${id}/commit`, { method: 'POST', agent: 'agent-a', body: {} });
  assert.equal(commit.status, 200);
  assert.equal(commit.data.ok, true);

  const dl = await req(`/v1/file?path=${encodeURIComponent(p)}`);
  assert.equal(dl.buf.toString(), '0123456789');
});

test('upload begin is rejected early when the file is too fresh', async () => {
  const p = 'askue/raw/locked.bin';
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'x' } });

  const begin = await req('/v1/uploads', { method: 'POST', agent: 'agent-b', body: { path: p, totalBytes: 10 } });
  assert.equal(begin.status, 409);
  assert.equal(begin.data.code, 'RECENTLY_MODIFIED');
  assert.equal(begin.data.uploadId, undefined);

  const retry = await req('/v1/uploads', { method: 'POST', agent: 'agent-b', body: { path: p, totalBytes: 10 } });
  assert.equal(retry.status, 200);
  assert.ok(retry.data.uploadId);
});

test('path traversal and hub-internal paths are rejected', async () => {
  const bad = await req(`/v1/file?path=${encodeURIComponent('../outside.txt')}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.data.ok, false);

  const absolute = await req(`/v1/file?path=${encodeURIComponent('C:\\Windows\\win.ini')}`);
  assert.notEqual(absolute.status, 200);

  const reserved = await req('/v1/mkdir', { method: 'POST', body: { path: '.lanstore/hack' } });
  assert.equal(reserved.status, 403);
  assert.equal(reserved.data.code, 'reserved_path');
});

test('search and usage work', async () => {
  const s = await req(`/v1/search?content=${encodeURIComponent('hello askue')}`);
  assert.equal(s.status, 200);
  assert.ok(s.data.results.some((r) => r.path === 'askue/raw/readme.md'));

  const u = await req(`/v1/usage?path=askue`);
  assert.equal(u.status, 200);
  assert.ok(u.data.bytes >= 11);
});

test('precheck reports the guard decision without writing', async () => {
  const p = 'askue/raw/pre.txt';
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'v1' } });

  const blocked = await req('/v1/precheck', { method: 'POST', agent: 'agent-b', body: { path: p } });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.code, 'RECENTLY_MODIFIED');

  const allowed = await req('/v1/precheck', { method: 'POST', agent: 'agent-b', body: { path: p } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.data.action, 'WRITE_ALLOWED');

  const stillIntact = await req(`/v1/read?path=${encodeURIComponent(p)}`);
  assert.equal(stillIntact.data.content, 'v1');
});

test('move, copy and trash-based delete', async () => {
  await req('/v1/mkdir', { method: 'POST', agent: 'agent-a', body: { path: 'proj/bin' } });
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: 'proj/bin/a.txt', content: 'A' } });

  const cp = await req('/v1/copy', { method: 'POST', agent: 'agent-a', body: { from: 'proj/bin/a.txt', to: 'proj/bin/b.txt' } });
  assert.equal(cp.status, 200);
  assert.equal(cp.data.action, 'copied');

  const mv = await req('/v1/move', { method: 'POST', agent: 'agent-a', body: { from: 'proj/bin/b.txt', to: 'proj/bin/c.txt' } });
  assert.equal(mv.status, 200);
  assert.equal(mv.data.action, 'moved');

  const del = await req(`/v1/delete?path=${encodeURIComponent('proj/bin/c.txt')}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(del.data.action, 'trashed');
  assert.ok(del.data.trashId);

  const gone = await req(`/v1/stat?path=${encodeURIComponent('proj/bin/c.txt')}`);
  assert.equal(gone.status, 404);
});

test('trash: list, restore, and overwrite-safe undo', async () => {
  const p = 'undo/report.csv';
  await req('/v1/mkdir', { method: 'POST', agent: 'agent-a', body: { path: 'undo' } });
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'original' } });

  const del = await req(`/v1/delete?path=${encodeURIComponent(p)}`, { method: 'DELETE', agent: 'agent-a' });
  assert.equal(del.status, 200);
  const trashId = del.data.trashId;
  assert.ok(trashId);

  const list = await req('/v1/trash?limit=50');
  assert.equal(list.status, 200);
  const batch = list.data.batches.find((b) => b.trashId === trashId);
  assert.ok(batch, 'deleted item must be listed');
  assert.equal(batch.path, p);
  assert.equal(batch.type, 'file');
  assert.equal(batch.deletedBy, 'agent-a');

  const restored = await req('/v1/restore', { method: 'POST', agent: 'agent-a', body: { trashId } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.action, 'restored');
  assert.equal(restored.data.to, p);

  const readBack = await req(`/v1/read?path=${encodeURIComponent(p)}`);
  assert.equal(readBack.data.content, 'original');

  // Delete again, write a new version, then restore over it.
  const del2 = await req(`/v1/delete?path=${encodeURIComponent(p)}`, { method: 'DELETE', agent: 'agent-a' });
  assert.equal(del2.status, 200);
  await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'newer' } });

  const refused = await req('/v1/restore', { method: 'POST', agent: 'agent-a', body: { trashId: del2.data.trashId } });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.code, 'already_exists');

  const forced = await req('/v1/restore', {
    method: 'POST',
    agent: 'agent-a',
    body: { trashId: del2.data.trashId, overwrite: true }
  });
  assert.equal(forced.status, 200);
  assert.ok(forced.data.overwrittenBatch, 'replaced version must go to trash');

  const finalRead = await req(`/v1/read?path=${encodeURIComponent(p)}`);
  assert.equal(finalRead.data.content, 'original');

  const afterList = await req('/v1/trash?limit=50');
  assert.ok(afterList.data.batches.some((b) => b.path === p && b.trashId === forced.data.overwrittenBatch));
});

test('trash can be emptied by age', async () => {
  const empty = await req('/v1/trash', { method: 'POST', body: {} });
  assert.equal(empty.status, 400);

  const ok = await req('/v1/trash', { method: 'POST', body: { all: true } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.removed >= 0);
});

test('upload commit conflict resolves on the second commit', async () => {
  const p = 'askue/raw/commit-conflict.bin';
  const created = await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'old' } });
  assert.equal(created.status, 200);

  const abs = path.join(dataRoot, 'askue', 'raw', 'commit-conflict.bin');
  const old = new Date(Date.now() - 120_000);
  await fsp.utimes(abs, old, old);

  const begin = await req('/v1/uploads', {
    method: 'POST',
    agent: 'agent-b',
    body: { path: p, totalBytes: 3, expectedVersion: created.data.version }
  });
  assert.equal(begin.status, 200);

  const id = begin.data.uploadId;
  const chunk = await req(`/v1/uploads/${id}?offset=0`, { method: 'PUT', agent: 'agent-b', body: Buffer.from('new') });
  assert.equal(chunk.status, 200);

  // Another agent changes the file between begin and commit.
  const foreign = await req('/v1/write', { method: 'POST', agent: 'agent-a', body: { path: p, content: 'fresh' } });
  assert.equal(foreign.status, 200);

  const commit1 = await req(`/v1/uploads/${id}/commit`, { method: 'POST', agent: 'agent-b', body: {} });
  assert.equal(commit1.status, 409);
  assert.equal(commit1.data.ok, false);
  assert.ok(commit1.data.uploadId, 'session must survive a blocked commit');

  const commit2 = await req(`/v1/uploads/${id}/commit`, { method: 'POST', agent: 'agent-b', body: {} });
  assert.equal(commit2.status, 200);
  assert.equal(commit2.data.ok, true);

  const dl = await req(`/v1/file?path=${encodeURIComponent(p)}`);
  assert.equal(dl.buf.toString(), 'new');
});

test('writes are refused when free space is below the safety margin', async () => {
  const tight = await createHub({
    argv: ['--config', path.join(tmpRoot, 'none.json')],
    overrides: {
      root: path.join(tmpRoot, 'tight-data'),
      port: 0,
      host: '127.0.0.1',
      minFreeBytes: Number.MAX_SAFE_INTEGER,
      auth: { enabled: false },
      audit: { enabled: false },
      discovery: { enabled: false }
    }
  });
  try {
    const url = `http://127.0.0.1:${tight.cfg.port}`;
    const res = await fetch(`${url}/v1/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'full/disk.txt', content: 'x' })
    });
    assert.equal(res.status, 507);
    const data = await res.json();
    assert.equal(data.code, 'insufficient_storage');

    const upload = await fetch(`${url}/v1/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'full/big.bin', totalBytes: 1024 })
    });
    assert.equal(upload.status, 507);
  } finally {
    await tight.close();
  }
});


test('MCP: initialize, tools/list, tool call and the conflict contract', async () => {
  const init = await req('/mcp', {
    method: 'POST',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'it', version: '1' } }
    }
  });
  assert.equal(init.status, 200);
  assert.equal(init.data.result.serverInfo.name, 'lanstore');
  assert.match(init.data.result.instructions, /RECENTLY_MODIFIED/);
  assert.ok(init.headers.get('mcp-session-id'));

  const list = await req('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
  const names = list.data.result.tools.map((t) => t.name);
  for (const expected of ['hub_info', 'fs_list', 'fs_read', 'fs_write', 'fs_append', 'fs_transfer', 'fs_search']) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const writeTool = list.data.result.tools.find((t) => t.name === 'fs_write');
  assert.match(writeTool.description, /RECENTLY_MODIFIED/);

  const created = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'fs_mkdir', arguments: { path: 'mcp' } } }
  });
  assert.equal(created.data.result.isError, false);

  const w1 = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'mcp/a.txt', content: 'mcp-v1' } } }
  });
  assert.equal(JSON.parse(w1.data.result.content[0].text).ok, true);

  // agent-b writes through REST, then anonymous MCP agent must be told to read first
  await req('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: 'mcp/a.txt', content: 'rest-v2' } }).then(async (r) => {
    // first attempt may be blocked by MCP's own write; force through with a retry
    if (r.status === 409) {
      const again = await req('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: 'mcp/a.txt', content: 'rest-v2' } });
      assert.equal(again.status, 200);
    }
  });

  const blocked = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'mcp/a.txt', content: 'mcp-v3' } } }
  });
  const blockedText = blocked.data.result.content[0].text;
  assert.equal(blocked.data.result.isError, false);
  assert.match(blockedText, /RECENTLY_MODIFIED/);
  assert.match(blockedText, /rest-v2/);

  const retried = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'fs_write', arguments: { path: 'mcp/a.txt', content: 'mcp-v3' } } }
  });
  const retriedText = retried.data.result.content[0].text;
  assert.doesNotMatch(retriedText, /RECENTLY_MODIFIED/);
  assert.match(retriedText, /"ok": true/);

  const read = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'fs_read', arguments: { path: 'mcp/a.txt' } } }
  });
  assert.equal(JSON.parse(read.data.result.content[0].text).content, 'mcp-v3');

  const badTool = await req('/mcp', {
    method: 'POST',
    body: { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope', arguments: {} } }
  });
  assert.equal(badTool.data.result.isError, true);
});

test('MCP requires a token when auth is enabled', async () => {
  const secureRoot = path.join(tmpRoot, 'secure-data');
  const secure = await createHub({
    argv: ['--config', path.join(tmpRoot, 'no-such-config.json')],
    overrides: {
      root: secureRoot,
      port: 0,
      host: '127.0.0.1',
      auth: { enabled: true, tokens: { 'agent-x': 'secret-token-x' } },
      audit: { enabled: false },
      discovery: { enabled: false }
    }
  });
  try {
    const url = `http://127.0.0.1:${secure.cfg.port}/v1/health`;
    const denied = await fetch(`http://127.0.0.1:${secure.cfg.port}/v1/list?path=`);
    assert.equal(denied.status, 401);

    const publicHealth = await fetch(url);
    assert.equal(publicHealth.status, 200);
    assert.equal((await publicHealth.json()).authEnabled, true);

    const ok = await fetch(url, { headers: { Authorization: 'Bearer secret-token-x' } });
    assert.equal(ok.status, 200);
    const health = await ok.json();
    assert.equal(health.authEnabled, true);

    const who = await fetch(`http://127.0.0.1:${secure.cfg.port}/v1/whoami`, {
      headers: { Authorization: 'Bearer secret-token-x' }
    });
    assert.equal((await who.json()).agent, 'agent-x');
  } finally {
    await secure.close();
  }
});

test('dashboard renders', async () => {
  const res = await req('/');
  assert.equal(res.status, 200);
  const html = res.buf.toString('utf8');
  assert.match(html, /lanstore/);
  assert.match(html, /Черга запису/);
});
