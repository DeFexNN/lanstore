import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HubError } from './util.mjs';

export function clientIp(req) {
  const raw = req.socket?.remoteAddress || '';
  return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

export function applyCors(res, enabled = true) {
  if (!enabled) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-Api-Key, Content-Type, Content-Range, X-Offset, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, ETag, Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export function sendJson(res, status, body, extraHeaders = null) {
  const text = JSON.stringify(body ?? null, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(text));
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.end(text);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', Buffer.byteLength(text));
  res.end(text);
}

export async function readBody(req, limit = 0) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (limit && total > limit) {
      throw new HubError('too_large', `request body exceeds ${limit} bytes`, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(req, limit = 0) {
  const raw = await readBody(req, limit);
  if (!raw.length) return {};
  try {
    const parsed = JSON.parse(raw.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch {
    throw new HubError('bad_json', 'request body is not a valid JSON object', 400);
  }
}

/**
 * Stream a request body straight to a file (no buffering).
 * Returns the number of bytes written.
 */
export async function writeReqToFile(req, dest, { limit = 0 } = {}) {
  const out = fs.createWriteStream(dest, { flags: 'wx' });
  let total = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (limit && total > limit) {
        cb(new HubError('too_large', `request body exceeds ${limit} bytes`, 413));
      } else {
        cb(null, chunk);
      }
    }
  });
  await pipeline(req, limiter, out);
  return total;
}

export function headerValue(req, name) {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}
