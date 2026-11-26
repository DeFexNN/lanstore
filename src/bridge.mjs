#!/usr/bin/env node
/**
 * lanstore bridge — stdio MCP server for Linux/macOS agents.
 *
 * The client (opencode, Claude Code, any MCP host) talks plain stdio JSON-RPC to this
 * process. The process finds the lanstore hub on the LAN by itself:
 *
 *   explicit LANSTORE_URL -> cached address -> UDP beacon -> /24 subnet scan
 *
 * All hub tools (fs_*, hub_info) are re-exported 1:1, plus two local tools:
 *   hub_status     — which hub is in use, how it was found, guard policy
 *   hub_rediscover — re-scan the LAN when the hub moved to another IP
 *
 * If a proxied call fails with a network error, discovery runs again and the call is
 * retried once, so a DHCP lease change does not break the agent.
 */
import readline from 'node:readline';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { APP_VERSION } from './util.mjs';
import { discoverHub, cachePath, verifyHub } from './discover.mjs';

const ENV = process.env;
const TOKEN = (ENV.LANSTORE_TOKEN || '').trim() || null;
const AGENT = (ENV.LANSTORE_AGENT || '').trim() || null;
const PINNED_HUB = (ENV.LANSTORE_HUB_ID || '').trim() || null;
const DEBUG = ENV.LANSTORE_DEBUG === '1' || ENV.LANSTORE_DEBUG === 'true';
const RPC_TIMEOUT_MS = Number(ENV.LANSTORE_RPC_TIMEOUT_MS || 180_000);

const LOCAL_TOOLS = [
  {
    name: 'hub_status',
    description:
      'Показати, до якого lanstore-хаба підключений міст: URL, hubId, як адресу знайдено (cache/udp/scan/explicit), стан черги запису і чи заданий токен.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'hub_rediscover',
    description:
      'Примусово перешукати хаб у локальній мережі. Використовуйте, якщо хаб переїхав на іншу IP або змінився порт. Можна передати url, щоб закріпити конкретну адресу на цю сесію.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http://host:port — закріпити вручну (необов’язково).' } },
      additionalProperties: false
    }
  },
  {
    name: 'fs_upload_local',
    description:
      'Завантажити файл із ЦІЄЇ машини на хаб через resumable-сесію (будь-який розмір, без base64). ' +
      'Якщо файл на хабі щойно змінив інший агент, повертається конфлікт із новим вмістом та uploadId: ' +
      'прочитайте вміст і викличте fs_commit_upload, щоб не передавати файл заново. Повторний виклик з uploadId докачує з nextOffset.',
    inputSchema: {
      type: 'object',
      properties: {
        localPath: { type: 'string', description: 'Шлях до файлу на цій машині.' },
        remotePath: { type: 'string', description: 'Шлях на хабі. Якщо закінчується на "/" — додається ім’я файлу.' },
        mode: { type: 'string', enum: ['overwrite', 'create'] },
        expectedVersion: { type: 'string' },
        uploadId: { type: 'string', description: 'Продовжити наявну сесію (з nextOffset).' }
      },
      required: ['localPath'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_commit_upload',
    description: 'Зафіксувати upload-сесію, створену fs_upload_local, після ознайомлення з конфліктом. Файл заново не передається.',
    inputSchema: {
      type: 'object',
      properties: {
        uploadId: { type: 'string' },
        expectedVersion: { type: 'string' }
      },
      required: ['uploadId'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_download_local',
    description:
      'Скачати файл із хаба на ЦЮ машину потоком. overwrite=true перезаписує локальний файл, resume=true докачує частково завантажений через Range.',
    inputSchema: {
      type: 'object',
      properties: {
        remotePath: { type: 'string' },
        localPath: { type: 'string', description: 'Куди зберегти (типово — ім’я файлу в поточній теці).' },
        overwrite: { type: 'boolean' },
        resume: { type: 'boolean' }
      },
      required: ['remotePath'],
      additionalProperties: false
    }
  }
];

const log = (...args) => {
  if (DEBUG) process.stderr.write(`[lanstore-bridge] ${args.join(' ')}\n`);
};

let hub = null;
let overrideUrl = null;
let toolsCache = null;
let toolsCacheAt = 0;
let rpcSeq = 0;

class RpcError extends Error {
  constructor(error) {
    super(error?.message || 'hub JSON-RPC error');
    this.code = error?.code ?? -32000;
  }
}

class HubUnavailable extends Error {}

async function ensureHub({ force = false } = {}) {
  if (hub && !force) return hub;
  const found = await discoverHub({
    url: overrideUrl,
    token: TOKEN,
    hubId: PINNED_HUB,
    skipCache: force,
    timeoutMs: force ? 5000 : 2500,
    log: (...args) => log(...args)
  });
  log(`hub: ${found.url} (${found.via}, ${found.hubId})`);
  hub = found;
  return hub;
}

function isNetworkError(err) {
  if (!err) return false;
  if (err instanceof HubUnavailable) return false;
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return true;
  const code = err.cause?.code || err.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code);
}

async function rpcOnce(target, method, params) {
  const res = await fetch(`${target.url}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      ...(AGENT ? { 'X-Agent-Id': AGENT } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
  });

  if (res.status === 401) throw new HubUnavailable('хаб відхилив токен (401). Задайте LANSTORE_TOKEN у конфігу MCP.');
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HubUnavailable(`хаб відповів HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => null);
  if (!data) throw new Error('хаб повернув некоректну JSON-RPC відповідь');
  if (data.error) throw new RpcError(data.error);
  return data.result;
}

async function rpc(method, params, { retry = true } = {}) {
  let target;
  try {
    target = await ensureHub();
  } catch (err) {
    throw new HubUnavailable(err.message);
  }

  try {
    return await rpcOnce(target, method, params);
  } catch (err) {
    if (retry && isNetworkError(err)) {
      log(`hub ${target.url} unreachable (${err.message}); rediscovering`);
      hub = null;
      const fresh = await ensureHub({ force: true });
      return rpcOnce(fresh, method, params);
    }
    throw err;
  }
}

/** Direct HTTP to the hub (files, upload sessions) with one rediscovery retry. */
async function hubRequest(pathname, { method = 'GET', headers = {}, body = null, retry = true } = {}) {
  let target;
  try {
    target = await ensureHub();
  } catch (err) {
    throw new HubUnavailable(err.message);
  }

  const doFetch = async (t) => {
    const res = await fetch(`${t.url}${pathname}`, {
      method,
      headers: {
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
        ...(AGENT ? { 'X-Agent-Id': AGENT } : {}),
        ...headers
      },
      body:
        body === null
          ? undefined
          : typeof body === 'string' || body instanceof Uint8Array
            ? body
            : JSON.stringify(body),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS)
    });
    if (res.status === 401) {
      throw new HubUnavailable('хаб відхилив токен (401). Задайте LANSTORE_TOKEN у конфігу MCP.');
    }
    return res;
  };

  try {
    return await doFetch(target);
  } catch (err) {
    if (retry && isNetworkError(err)) {
      log(`hub ${target.url} unreachable (${err.message}); rediscovering`);
      hub = null;
      const fresh = await ensureHub({ force: true });
      return doFetch(fresh);
    }
    throw err;
  }
}

async function hubJson(pathname, options = {}) {
  const res = await hubRequest(pathname, options);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: res.ok, status: res.status, message: text.slice(0, 500) };
  }
}

async function uploadLocal(args) {
  const localPath = path.resolve(String(args.localPath || ''));
  const stat = await fsp.stat(localPath).catch(() => null);
  if (!stat || !stat.isFile()) throw new Error(`not a file: ${localPath}`);

  let remote = String(args.remotePath || path.basename(localPath));
  if (remote.endsWith('/')) remote += path.basename(localPath);

  let uploadId = args.uploadId ? String(args.uploadId) : null;
  let offset = 0;
  let chunkSize = 8 * 1024 * 1024;

  if (uploadId) {
    const meta = await hubJson(`/v1/uploads/${uploadId}`);
    if (meta.ok === false) return textResult(meta);
    offset = Number(meta.nextOffset) || 0;
    remote = meta.path || remote;
  } else {
    const begin = await hubJson('/v1/uploads', {
      method: 'POST',
      body: {
        path: remote,
        totalBytes: stat.size,
        mode: args.mode || 'overwrite',
        expectedVersion: args.expectedVersion || null
      }
    });
    if (begin.ok === false) {
      begin.hint = 'Ознайомтеся з content вище і повторіть fs_upload_local (можна з expectedVersion = version).';
      return textResult(begin);
    }
    uploadId = begin.uploadId;
    offset = Number(begin.nextOffset) || 0;
    chunkSize = Number(begin.chunkHint) || chunkSize;
  }

  const fh = await fsp.open(localPath, 'r');
  try {
    const buffer = Buffer.alloc(chunkSize);
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (!bytesRead) break;
      const res = await hubRequest(`/v1/uploads/${uploadId}?offset=${offset}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: buffer.subarray(0, bytesRead)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return textResult({
          ...data,
          uploadId,
          hint: 'Повторіть fs_upload_local з цим uploadId, щоб докачати з nextOffset.'
        });
      }
      offset = Number(data.nextOffset) || offset + bytesRead;
    }
  } finally {
    await fh.close();
  }

  const commit = await hubJson(`/v1/uploads/${uploadId}/commit`, {
    method: 'POST',
    body: { expectedVersion: args.expectedVersion || null }
  });
  if (commit.ok === false) {
    commit.uploadId = uploadId;
    commit.localPath = localPath;
    commit.hint = 'Прочитайте content і викличте fs_commit_upload з цим uploadId (файл уже на хабі).';
  } else {
    commit.localPath = localPath;
    commit.remotePath = commit.path || remote;
  }
  return textResult(commit);
}

async function commitUpload(args) {
  const uploadId = String(args.uploadId || '');
  if (!/^up_[a-f0-9]{18}$/.test(uploadId)) throw new Error('invalid uploadId (expected up_<hex>)');
  const result = await hubJson(`/v1/uploads/${uploadId}/commit`, {
    method: 'POST',
    body: { expectedVersion: args.expectedVersion || null }
  });
  return textResult(result);
}

async function downloadLocal(args) {
  const remote = String(args.remotePath || '');
  if (!remote) throw new Error('remotePath is required');
  const localPath = path.resolve(String(args.localPath || path.basename(remote)));
  const overwrite = args.overwrite === true;
  const resume = args.resume === true;

  let start = 0;
  try {
    const existing = await fsp.stat(localPath);
    if (existing.isFile()) {
      if (!overwrite && !resume) {
        throw new Error(`local file exists: ${localPath} (pass overwrite=true or resume=true)`);
      }
      if (resume) start = existing.size;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  const res = await hubRequest(`/v1/file?path=${encodeURIComponent(remote)}`, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ ok: false, code: `HTTP_${res.status}`, message: `HTTP ${res.status}` }));
    return textResult(data);
  }
  if (start > 0 && res.status !== 206) start = 0;

  await fsp.mkdir(path.dirname(localPath), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(localPath, { flags: start > 0 ? 'a' : 'w' }));
  const st = await fsp.stat(localPath);
  return textResult({
    ok: true,
    action: 'downloaded',
    remotePath: remote,
    localPath,
    bytes: st.size,
    resumedFrom: start || null
  });
}


function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError: false };
}

function errorResult(err) {
  return { content: [{ type: 'text', text: `❌ ${err.message}` }], isError: true };
}

async function listTools() {
  if (!toolsCache || Date.now() - toolsCacheAt > 60_000) {
    try {
      const result = await rpc('tools/list', {});
      toolsCache = Array.isArray(result?.tools) ? result.tools : [];
      toolsCacheAt = Date.now();
    } catch (err) {
      log(`tools/list failed: ${err.message}`);
    }
  }
  return [...(toolsCache || []), ...LOCAL_TOOLS];
}

async function hubStatus() {
  let error = null;
  let health = null;
  if (!hub) {
    try {
      await ensureHub();
    } catch (err) {
      error = err.message;
    }
  }
  if (hub) {
    try {
      const verified = await verifyHub(hub.url, { token: TOKEN, hubId: PINNED_HUB, timeoutMs: 1500 });
      health = verified.health;
      hub = { ...hub, ...verified, via: hub.via };
    } catch (err) {
      error = err.message;
    }
  }
  return {
    ok: !error,
    connected: !!hub && !error,
    url: hub?.url || null,
    hubId: hub?.hubId || null,
    name: hub?.name || null,
    discoveredBy: hub?.via || null,
    agent: AGENT || 'anonymous',
    tokenConfigured: !!TOKEN,
    pinnedHubId: PINNED_HUB,
    bridgeVersion: APP_VERSION,
    cacheFile: cachePath(),
    hub: health,
    error
  };
}

async function callTool({ name, arguments: args }) {
  if (name === 'hub_status') return textResult(await hubStatus());

  if (name === 'fs_upload_local') {
    try {
      return await uploadLocal(args || {});
    } catch (err) {
      return errorResult(err);
    }
  }
  if (name === 'fs_commit_upload') {
    try {
      return await commitUpload(args || {});
    } catch (err) {
      return errorResult(err);
    }
  }
  if (name === 'fs_download_local') {
    try {
      return await downloadLocal(args || {});
    } catch (err) {
      return errorResult(err);
    }
  }

  if (name === 'hub_rediscover') {
    hub = null;
    toolsCache = null;
    toolsCacheAt = 0;
    overrideUrl = args?.url ? String(args.url) : null;
    try {
      const found = await ensureHub({ force: true });
      const result = await rpc('tools/list', {});
      toolsCache = Array.isArray(result?.tools) ? result.tools : [];
      toolsCacheAt = Date.now();
      return textResult({
        ok: true,
        rediscovered: true,
        url: found.url,
        hubId: found.hubId,
        name: found.name,
        foundBy: found.via,
        tools: toolsCache.length,
        pinned: overrideUrl || null
      });
    } catch (err) {
      return errorResult(err);
    }
  }

  try {
    return await rpc('tools/call', { name, arguments: args || {} });
  } catch (err) {
    if (err instanceof RpcError) return errorResult(new Error(`${err.code}: ${err.message}`));
    return errorResult(
      new Error(`${err.message}. Якщо хаб переїхав на іншу IP — викличте hub_rediscover.`)
    );
  }
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return jsonRpcError(null, -32600, 'invalid request');
  const { id, method, params } = msg;

  if (!method) return jsonRpcError(id ?? null, -32600, 'missing method');

  if (method === 'initialize') {
    const requested = params?.protocolVersion;
    const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: supported.includes(requested) ? requested : supported[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'lanstore-bridge', title: 'LAN shared storage (auto-discovery)', version: APP_VERSION },
        instructions:
          'Міст до спільного сховища lanstore у локальній мережі. Адреса хаба визначається автоматично ' +
          '(LANSTORE_URL → кеш → UDP-маяк → скан підмережі), тому IP хаба може змінюватися. ' +
          'Працюйте через fs_* як зі звичайними файлами. Якщо запис повертає ok:false + RECENTLY_MODIFIED — ' +
          'файл щойно змінив інший агент: у відповіді є новий вміст, прочитайте його і повторіть запис, ' +
          'друга спроба проходить. Для діагностики: hub_status; якщо хаб переїхав: hub_rediscover.'
      }
    };
  }

  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'shutdown') return { jsonrpc: '2.0', id, result: null };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: await listTools() } };
  }

  if (method === 'tools/call') {
    return { jsonrpc: '2.0', id, result: await callTool(params || {}) };
  }

  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  if (method === 'logging/setLevel') return { jsonrpc: '2.0', id, result: {} };

  return jsonRpcError(id, -32601, `method not found: ${method}`);
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const queue = [];
let busy = false;

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const message = queue.shift();
    try {
      const response = await handleMessage(message);
      if (response) send(response);
    } catch (err) {
      log(`unhandled: ${err.stack || err.message}`);
      send(jsonRpcError(message?.id, -32603, err.message || 'internal error'));
    }
  }
  busy = false;
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    send(jsonRpcError(null, -32700, 'parse error'));
    return;
  }
  if (Array.isArray(message)) {
    for (const item of message) queue.push(item);
  } else {
    queue.push(message);
  }
  void pump();
});

rl.on('close', () => {
  log('stdin closed, exiting');
  process.exit(0);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

// Warm the cache so the first tool call is fast; never block startup on it.
ensureHub().catch((err) => log(`initial discovery failed: ${err.message}`));
