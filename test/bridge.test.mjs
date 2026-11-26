import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { createHub } from '../src/server.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanstore-bridge-'));
const hub = await createHub({
  argv: ['--config', path.join(tmpRoot, 'none.json')],
  overrides: {
    root: path.join(tmpRoot, 'data'),
    port: 0,
    host: '127.0.0.1',
    cooldownMs: 60_000,
    auth: { enabled: false },
    audit: { enabled: false },
    discovery: { enabled: false }
  }
});
const base = `http://127.0.0.1:${hub.cfg.port}`;

const bridgePath = fileURLToPath(new URL('../src/bridge.mjs', import.meta.url));
const child = spawn(process.execPath, [bridgePath], {
  env: {
    ...process.env,
    LANSTORE_URL: base,
    LANSTORE_AGENT: 'bridge-agent',
    LANSTORE_SCAN: 'off',
    LANSTORE_CACHE: path.join(tmpRoot, 'cache.json')
  },
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stderr.on('data', (buf) => {
  if (process.env.LANSTORE_DEBUG) process.stderr.write(`[bridge stderr] ${buf}`);
});

const pending = new Map();
let seq = 0;

readline.createInterface({ input: child.stdout }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }
});

function request(method, params, timeoutMs = 20_000) {
  const id = ++seq;
  const message = { jsonrpc: '2.0', id, method };
  if (params !== undefined) message.params = params;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify(message)}\n`);
  });
}

function notify(method, params) {
  const message = { jsonrpc: '2.0', method };
  if (params !== undefined) message.params = params;
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

async function rest(pathname, { method = 'GET', body, agent } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (agent) headers['X-Agent-Id'] = agent;
  const res = await fetch(`${base}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function toolText(response) {
  return response.result.content.map((part) => part.text).join('\n');
}

after(async () => {
  child.kill();
  await hub.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('bridge initializes as a local stdio MCP server', async () => {
  const res = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' }
  });
  assert.equal(res.result.serverInfo.name, 'lanstore-bridge');
  assert.match(res.result.instructions, /hub_rediscover/);
  notify('notifications/initialized');
});

test('bridge re-exports hub tools plus local discovery tools', async () => {
  const res = await request('tools/list', {});
  const names = res.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('fs_write'), 'hub tools must be proxied');
  assert.ok(names.includes('fs_read'));
  assert.ok(names.includes('hub_status'));
  assert.ok(names.includes('hub_rediscover'));
});

test('bridge proxies file operations to the hub', async () => {
  const mkdir = await request('tools/call', { name: 'fs_mkdir', arguments: { path: 'agent-work' } });
  assert.equal(mkdir.result.isError, false);

  const write = await request('tools/call', {
    name: 'fs_write',
    arguments: { path: 'agent-work/notes.md', content: '# from bridge\n' }
  });
  assert.equal(write.result.isError, false);
  assert.match(toolText(write), /"ok": true/);

  const read = await request('tools/call', { name: 'fs_read', arguments: { path: 'agent-work/notes.md' } });
  assert.equal(JSON.parse(toolText(read)).content, '# from bridge\n');
});

test('write guard contract survives the bridge hop', async () => {
  const p = 'agent-work/conflict.txt';
  await request('tools/call', { name: 'fs_write', arguments: { path: p, content: 'bridge-v1' } });

  const foreign = await rest('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: p, content: 'other-v2' } });
  assert.equal(foreign.status, 409);

  const foreignRetry = await rest('/v1/write', { method: 'POST', agent: 'agent-b', body: { path: p, content: 'other-v2' } });
  assert.equal(foreignRetry.status, 200);

  const blocked = await request('tools/call', { name: 'fs_write', arguments: { path: p, content: 'bridge-v3' } });
  assert.equal(blocked.result.isError, false);
  assert.match(toolText(blocked), /RECENTLY_MODIFIED/);
  assert.match(toolText(blocked), /other-v2/);

  const retried = await request('tools/call', { name: 'fs_write', arguments: { path: p, content: 'bridge-v3' } });
  assert.match(toolText(retried), /"ok": true/);
  assert.doesNotMatch(toolText(retried), /RECENTLY_MODIFIED/);
});

test('hub_status reports the discovered hub', async () => {
  const res = await request('tools/call', { name: 'hub_status', arguments: {} });
  const status = JSON.parse(toolText(res));
  assert.equal(status.connected, true);
  assert.equal(status.url, base);
  assert.equal(status.hubId, hub.identity.hubId);
  assert.equal(status.agent, 'bridge-agent');
  assert.equal(status.hub.cooldownSec, 60);
});

test('hub_rediscover can re-pin the hub address', async () => {
  const res = await request('tools/call', { name: 'hub_rediscover', arguments: { url: base } });
  const data = JSON.parse(toolText(res));
  assert.equal(data.ok, true);
  assert.equal(data.url, base);
  assert.ok(data.tools >= 5);

  const status = JSON.parse(toolText(await request('tools/call', { name: 'hub_status', arguments: {} })));
  assert.equal(status.url, base);
});

test('bridge still answers hub_status when the hub is unreachable', async () => {
  const res = await request('tools/call', { name: 'hub_rediscover', arguments: { url: 'http://127.0.0.1:1' } });
  assert.equal(res.result.isError, true);
  assert.match(toolText(res), /не знайдено|fetch|HTTP|ECONNREFUSED|unreachable/i);

  const status = JSON.parse(toolText(await request('tools/call', { name: 'hub_status', arguments: {} })));
  assert.equal(status.connected, false);
  assert.ok(status.error);
});
