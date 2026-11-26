import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/** Directory inside the storage root that belongs to the hub itself. */
export const INTERNAL_DIR = '.lanstore';
export const APP_VERSION = '1.2.0';

const WIN_BAD_CHARS = /[<>:"|?*\u0000-\u001f]/;
const WIN_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export class HubError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.name = 'HubError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Normalize a client supplied relative path.
 * Rejects traversal, absolute paths, reserved device names and hub-internal paths.
 */
export function normalizeRel(input, { allowRoot = true, allowReserved = false } = {}) {
  if (input === undefined || input === null) input = '';
  if (typeof input !== 'string') throw new HubError('bad_request', 'path must be a string');
  if (input.includes('\u0000')) throw new HubError('bad_path', 'path contains a NUL byte');

  let s = input.replace(/\\/g, '/');
  s = s.replace(/^[a-zA-Z]:/, ''); // drop "C:" so "C:\x" does not become a segment
  s = s.replace(/^\/+/, '');

  const segs = [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new HubError('path_escape', 'path traversal ("..") is not allowed', 400);
    if (WIN_BAD_CHARS.test(seg)) throw new HubError('bad_path', `invalid character in path segment: ${seg}`, 400);
    if (/[. ]$/.test(seg)) throw new HubError('bad_path', `path segment must not end with a dot or space: ${seg}`, 400);
    if (WIN_DEVICE_NAMES.test(seg)) throw new HubError('bad_path', `reserved device name in path: ${seg}`, 400);
    segs.push(seg);
  }

  const rel = segs.join('/');
  if (!rel && !allowRoot) throw new HubError('bad_request', 'path is required', 400);
  if (!allowReserved && segs[0] === INTERNAL_DIR) {
    throw new HubError('reserved_path', `${INTERNAL_DIR} is reserved for the hub`, 403);
  }
  return rel;
}

export function splitRel(rel) {
  return rel ? rel.split('/') : [];
}

export function parentRel(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}

export function baseName(rel) {
  const i = rel.lastIndexOf('/');
  return i < 0 ? rel : rel.slice(i + 1);
}

/** Join inside the root and reject anything that resolves above it. */
export function resolveInside(root, rel) {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(rootAbs, ...splitRel(rel));
  const relCheck = path.relative(rootAbs, abs);
  if (relCheck === '') return abs;
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new HubError('path_escape', 'path escapes the hub root', 400);
  }
  return abs;
}

/**
 * Reject paths whose real (symlink resolved) location is outside the root.
 * Works for not-yet-existing targets by walking up to the nearest existing ancestor.
 */
export async function assertNoSymlinkEscape(root, abs) {
  let realRoot;
  try {
    realRoot = await fsp.realpath(path.resolve(root));
  } catch {
    realRoot = path.resolve(root);
  }
  let probe = abs;
  for (let i = 0; i < 64; i++) {
    try {
      const real = await fsp.realpath(probe);
      const relCheck = path.relative(realRoot, real);
      if (relCheck !== '' && (relCheck.startsWith('..') || path.isAbsolute(relCheck))) {
        throw new HubError('path_escape', 'resolved path is outside the hub root (symlink)', 403);
      }
      return;
    } catch (err) {
      if (err instanceof HubError) throw err;
      if (err.code !== 'ENOENT') throw err;
      const up = path.dirname(probe);
      if (up === probe) return;
      probe = up;
    }
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows refuses to replace a file that another process holds open.
 * Retry briefly instead of failing the whole write.
 */
export async function renameWithRetry(from, to, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      const retryable = ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(err.code);
      if (i >= tries || !retryable) throw err;
      await delay(40 * (i + 1));
    }
  }
}

export async function sha256File(abs) {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Opaque version of a file.
 * Small files: content hash, so any byte change is detected.
 * Large files: size + mtime, so we never rehash 40 GB on every call.
 */
export async function fileVersion(abs, st, cfg) {
  if (st.size <= cfg.hashLimitBytes) return `sha256:${await sha256File(abs)}`;
  return `stamp:${st.size}-${Math.round(st.mtimeMs)}`;
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  const text = buf.subarray(0, n).toString('utf8');
  let bad = 0;
  for (const ch of text) if (ch === '\uFFFD') bad++;
  return bad > Math.max(1, n * 0.01);
}

export function globToRegExp(glob) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(out + '$', process.platform === 'win32' ? 'i' : '');
}

export function makeMatcher(pattern) {
  if (!pattern) return () => true;
  const re = globToRegExp(pattern);
  const hasSlash = pattern.includes('/');
  return (rel, name) => re.test(hasSlash ? rel : name);
}

export function formatAgo(ms) {
  if (ms === null || ms === undefined) return 'невідомо коли';
  if (ms < 1000) return 'щойно';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec} с`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} хв`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} год`;
  return `${Math.floor(hours / 24)} дн`;
}

export function humanBytes(n) {
  if (n === null || n === undefined) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const MIME = {
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'text/yaml; charset=utf-8',
  yml: 'text/yaml; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  ts: 'text/plain; charset=utf-8',
  py: 'text/x-python; charset=utf-8',
  c: 'text/x-c; charset=utf-8',
  h: 'text/x-c; charset=utf-8',
  cpp: 'text/x-c++; charset=utf-8',
  hpp: 'text/x-c++; charset=utf-8',
  qml: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  db: 'application/octet-stream',
  sqlite: 'application/vnd.sqlite3',
  bin: 'application/octet-stream'
};

export function contentTypeFor(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

export function nowIso() {
  return new Date().toISOString();
}

export function randomId(prefix = '') {
  return prefix + crypto.randomBytes(9).toString('hex');
}

export function isMainModule(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return metaUrl === pathToFileURL(path.resolve(entry)).href;
  } catch {
    return false;
  }
}
