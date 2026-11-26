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
