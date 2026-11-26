import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseArgs(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !String(next).startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return { ...base };
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function defaults(appDir = APP_DIR) {
  return {
    name: 'lanstore',
    host: '0.0.0.0',
    port: 8787,
    root: path.join(appDir, 'data'),
    publicUrl: null,

    // Write guard: a file touched by somebody else less than cooldownMs ago
    // rejects the first write and returns the fresh content.
    cooldownMs: 60_000,
    challengeTtlMs: 10 * 60_000,
    guardSameAgent: false,

    hashLimitBytes: 8 * 1024 * 1024,
    inlinePreviewBytes: 128 * 1024,
    maxInlineWriteBytes: 32 * 1024 * 1024,
    maxJsonBodyBytes: 40 * 1024 * 1024,
    maxPutBytes: 0,

    listDefaultMax: 1000,
    listHardMax: 50_000,
    searchMaxFileBytes: 2 * 1024 * 1024,
    fsync: false,

    trash: { enabled: true, retentionDays: 30 },

    audit: {
      enabled: true,
      file: path.join(appDir, 'logs', 'audit.jsonl'),
      tailBytes: 512 * 1024
    },

    auth: {
      enabled: false,
      tokens: {}
    },

    uploads: {
      chunkHint: 8 * 1024 * 1024,
      ttlMs: 7 * 24 * 3600 * 1000
    },

    cors: true,

    discovery: {
      enabled: true,
      port: 8788
    }
  };
}

export function loadConfig(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const appDir = APP_DIR;

  const configFile = path.resolve(String(args.config || path.join(appDir, 'config.json')));
  let fileConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new Error(`cannot parse config file ${configFile}: ${err.message}`);
    }
  }

  let cfg = deepMerge(defaults(appDir), fileConfig);
  cfg.appDir = appDir;
  cfg.configFile = fs.existsSync(configFile) ? configFile : null;

  const rootBase = args.root || process.env.LANSTORE_ROOT
    ? process.cwd()
    : fs.existsSync(configFile)
      ? path.dirname(configFile)
      : appDir;

  if (args.root) cfg.root = path.resolve(String(args.root));
  if (args.port) cfg.port = Number(args.port);
  if (args.host) cfg.host = String(args.host);
  if (args.cooldown !== undefined) cfg.cooldownMs = Math.max(0, Math.round(Number(args.cooldown) * 1000));
  if (args['guard-same-agent']) cfg.guardSameAgent = true;
  if (args['no-guard-same-agent']) cfg.guardSameAgent = false;
  if (args.url) cfg.publicUrl = String(args.url).replace(/\/+$/, '');
  if (args['no-auth']) cfg.auth = { ...cfg.auth, enabled: false };
  if (args['audit'] === 'off') cfg.audit = { ...cfg.audit, enabled: false };
  if (args['no-discovery'] || args['discovery'] === 'off') cfg.discovery = { ...cfg.discovery, enabled: false };
  if (args['discovery-port']) cfg.discovery = { ...cfg.discovery, port: Number(args['discovery-port']) };

  if (process.env.LANSTORE_ROOT) cfg.root = path.resolve(process.env.LANSTORE_ROOT);
  if (process.env.LANSTORE_PORT) cfg.port = Number(process.env.LANSTORE_PORT);
  if (process.env.LANSTORE_HOST) cfg.host = process.env.LANSTORE_HOST;
  if (process.env.LANSTORE_COOLDOWN_MS) cfg.cooldownMs = Math.max(0, Number(process.env.LANSTORE_COOLDOWN_MS));
  if (process.env.LANSTORE_PUBLIC_URL) cfg.publicUrl = process.env.LANSTORE_PUBLIC_URL.replace(/\/+$/, '');
  if (process.env.LANSTORE_DISCOVERY_PORT) cfg.discovery = { ...cfg.discovery, port: Number(process.env.LANSTORE_DISCOVERY_PORT) };
  if (process.env.LANSTORE_DISCOVERY === 'off') cfg.discovery = { ...cfg.discovery, enabled: false };

  const token = args.token || process.env.LANSTORE_TOKEN;
  if (token) {
    const agent = String(args.agent || process.env.LANSTORE_AGENT || 'default');
    cfg.auth = { enabled: true, tokens: { [agent]: String(token) } };
  }

  cfg.root = path.resolve(rootBase, String(cfg.root));
  if (cfg.audit?.file && !path.isAbsolute(String(cfg.audit.file))) {
    cfg.audit.file = path.resolve(rootBase, String(cfg.audit.file));
  }
  if (cfg.publicUrl) cfg.publicUrl = String(cfg.publicUrl).replace(/\/+$/, '');
  cfg.port = Number(cfg.port) || 0;
  return cfg;
}
