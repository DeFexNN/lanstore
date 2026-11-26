import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from './config.mjs';
import { WriteGuard } from './guard.mjs';
import { Audit } from './audit.mjs';
import { Store } from './store.mjs';
import { Uploads } from './uploads.mjs';
import { createAuth } from './auth.mjs';
import { applyCors, sendJson, sendText } from './http.mjs';
import { createApi, putFile } from './api.mjs';
import { createMcp } from './mcp.mjs';
import { renderDashboard } from './dashboard.mjs';
import { startBeacon } from './beacon.mjs';
import { APP_VERSION, HubError, isMainModule } from './util.mjs';

export async function createHub({ argv = [], overrides = {} } = {}) {
  const cfg = loadConfig(argv);
  Object.assign(cfg, overrides);
  cfg.auth = { ...cfg.auth, ...(overrides.auth || {}) };
  cfg.audit = { ...cfg.audit, ...(overrides.audit || {}) };
  cfg.uploads = { ...cfg.uploads, ...(overrides.uploads || {}) };
  cfg.trash = { ...cfg.trash, ...(overrides.trash || {}) };
  cfg.discovery = { ...cfg.discovery, ...(overrides.discovery || {}) };
  cfg.root = path.resolve(String(cfg.root));

  const guard = new WriteGuard(cfg);
  const audit = new Audit(cfg.audit);
  const store = new Store({ root: cfg.root, config: cfg, guard, audit });
  await store.init();
  const identity = await store.getIdentity();

  const uploads = new Uploads({ store, cfg });
  await uploads.init();

  const beacon = startBeacon({ cfg, identity, log: (message) => console.error(`[lanstore] ${message}`) });

  const auth = createAuth(cfg);
  const startedAt = Date.now();
  const api = createApi({ store, uploads, cfg, audit, guard, startedAt, identity });
  const mcp = createMcp({ store, uploads, cfg, audit, startedAt });

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    } catch {
      return sendJson(res, 400, { ok: false, code: 'bad_request', message: 'bad request URL' });
    }

    applyCors(res, cfg.cors);

    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    try {
      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        const agent = auth.identify(req, url);
        return await mcp.handle(req, res, url, agent);
      }

      if (url.pathname === '/' || url.pathname === '/index.html') {
        const agent = auth.identify(req, url);
        const html = await renderDashboard({ store, cfg, audit, uploads, req, url, agent });
        return sendText(res, 200, html, 'text/html; charset=utf-8');
      }

      if (url.pathname === '/favicon.ico') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (url.pathname.startsWith('/v1/') || url.pathname === '/v1') {
        const clean = url.pathname.replace(/\/+$/, '');
        const optional = clean === '/v1/health' || clean === '/v1/discover';
        const agent = auth.identify(req, url, { optional });
        if (req.method === 'PUT' && clean === '/v1/file') {
          return await putFile({ req, res, url, store, cfg, agent });
        }
        return await api(req, res, url, agent);
      }

      throw new HubError('not_found', `no such endpoint: ${url.pathname}`, 404);
    } catch (err) {
      return handleError(err, req, res);
    }
  });

  // Large transfers must not be killed by the default 300s request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 75_000;
  server.timeout = 0;

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(cfg.port, cfg.host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address();
  if (address && typeof address === 'object') cfg.port = address.port;

  const close = async () => {
    guard.close();
    await beacon.close();
    await new Promise((resolve) => server.close(resolve));
  };

  return { server, cfg, store, guard, audit, uploads, auth, beacon, identity, close, startedAt };
}

function handleError(err, req, res) {
  const known = err instanceof HubError;
  const status = known ? err.status : Number.isInteger(err?.status) ? err.status : 500;
  const payload = {
    ok: false,
    code: err?.code || 'internal_error',
    message: err?.message || 'internal error',
    ...(known ? err.extra : {})
  };
  if (!known) console.error('[lanstore] request failed:', err);

  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (status === 413) res.setHeader('Connection', 'close');
  sendJson(res, status, payload);
  if (status === 413) res.on('finish', () => req.destroy());
}

export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) out.push({ name, address: item.address });
    }
  }
  return out;
}

export function banner(cfg, extra = {}) {
  const lines = [];
  lines.push('');
  lines.push(`  lanstore ${APP_VERSION} — LAN shared storage for agents`);
  lines.push(`  root:      ${cfg.root}`);
  lines.push(`  listening: http://${cfg.host}:${cfg.port}`);
  for (const { name, address } of lanAddresses()) {
    lines.push(`  LAN:       http://${address}:${cfg.port}   (${name})`);
  }
  lines.push(`  MCP:       http://<host>:${cfg.port}/mcp`);
  if (cfg.discovery?.enabled !== false) {
    lines.push(`  discovery: udp ${cfg.discovery?.port ?? 8788} — IP-less clients find the hub automatically (lanstore-bridge)`);
  }
  lines.push(`  write guard: cooldown ${Math.round(cfg.cooldownMs / 1000)}s — first write returns new content, retry passes`);
  lines.push(`  auth:      ${cfg.auth.enabled ? `enabled (agents: ${Object.keys(cfg.auth.tokens).join(', ') || 'none'})` : 'disabled (LAN open)'}`);
  if (extra.createdRoot) lines.push(`  created:   storage root did not exist and was created`);
  lines.push('');
  return lines.join('\n');
}

export async function main() {
  const hub = await createHub({ argv: process.argv.slice(2) });
  process.stdout.write(banner(hub.cfg) + '\n');

  const shutdown = async (signal) => {
    process.stdout.write(`\n[lanstore] ${signal}: shutting down\n`);
    try {
      await hub.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  if (hub.cfg.configFile) {
    process.stdout.write(`  config:    ${hub.cfg.configFile}\n\n`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('[lanstore] failed to start:', err);
    process.exit(1);
  });
}
