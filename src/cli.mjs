#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { humanBytes } from './util.mjs';
import { discoverHub, cachePath } from './discover.mjs';

const argv = process.argv.slice(2);
const flags = { json: false };
const positional = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  const next = () => argv[++i];
  switch (arg) {
    case '--json':
      flags.json = true;
      break;
    case '--url':
      flags.url = next();
      break;
    case '--token':
      flags.token = next();
      break;
    case '--agent':
      flags.agent = next();
      break;
    case '-r':
    case '--recursive':
      flags.recursive = true;
      break;
    case '--permanent':
      flags.permanent = true;
      break;
    case '--overwrite':
      flags.overwrite = true;
      break;
    case '--file':
      flags.file = next();
      break;
    case '--offset':
      flags.offset = Number(next());
      break;
    case '--max':
      flags.max = Number(next());
      break;
    case '--mode':
      flags.mode = next();
      break;
    case '--depth':
      flags.depth = Number(next());
      break;
    case '--pattern':
      flags.pattern = next();
      break;
    case '--name':
      flags.name = next();
      break;
    case '--content':
      flags.content = next();
      break;
    case '--expected':
      flags.expected = next();
      break;
    case '--to':
      flags.to = next();
      break;
    case '-h':
    case '--help':
      flags.help = true;
      break;
    default:
      positional.push(arg);
  }
}

const [cmd, ...rest] = positional;
let base = (flags.url || process.env.LANSTORE_URL || '').replace(/\/+$/, '');
const token = flags.token || process.env.LANSTORE_TOKEN || '';

function headers(extra = {}) {
  const out = { ...extra };
  if (token) out.Authorization = `Bearer ${token}`;
  if (flags.agent) out['X-Agent-Id'] = flags.agent;
  return out;
}

async function call(pathname, { method = 'GET', body = null } = {}) {
  const init = { method, headers: headers({ 'Content-Type': 'application/json' }) };
  if (body !== null) init.body = JSON.stringify(body);
  const res = await fetch(base + pathname, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { ok: res.ok, status: res.status, text };
  }
  return { status: res.status, data };
}

function fail(message, code = 1) {
  console.error(`❌ ${message}`);
  process.exitCode = code;
}

function report(result) {
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result && result.ok === false ? 2 : 0;
    return;
  }
  if (result && result.ok === false) {
    console.error(`\n⚠️  ${result.message}`);
    if (result.content) {
      const body = result.content.length > 4000 ? `${result.content.slice(0, 4000)}\n…` : result.content;
      console.error(`\n--- ${result.path} · ${result.version} · ${humanBytes(result.size)} ---`);
      console.error(body);
      console.error(`--- ${result.truncated ? 'обрізано' : 'кінець'} ---`);
    }
    if (result.retry?.hint) console.error(`\n↻ ${result.retry.hint}`);
    process.exitCode = 2;
    return;
  }
  if (result && result.ok && result.action) {
    const extra = result.version ? ` · ${result.version}` : '';
    const size = result.bytes !== undefined ? ` · ${humanBytes(result.bytes)}` : '';
    console.log(`✅ ${result.action} ${result.path || result.to || ''}${size}${extra}`);
    if (result.note) console.log(`   ${result.note}`);
    process.exitCode = 0;
    return;
  }
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 0;
}

function usage() {
  console.log(`lanstore CLI ${'1.0.0'}

Usage:
  lanstore <command> [args] [flags]

Commands:
  health                       hub status, disk space, guard policy
  info                         hub configuration summary
  ls [path]                    list a directory (-r, --pattern "*.csv", --max 200)
  tree [path]                  recursive tree (--depth 3)
  stat <path>                  size, mtime, version
  cat <path>                   write file bytes to stdout (--offset, --max)
  write <path>                 write content from --file or stdin (--mode, --expected)
  append <path>                append content from --file or stdin
  mkdir <path>                 create directory (+ parents)
  rm <path>                    move to trash (-r for directories, --permanent)
  trash                        list recently deleted items (--max)
  restore <trashId>            restore from trash (--to <path>, --overwrite)
  mv <from> <to>               move/rename (--overwrite)
  cp <from> <to>               copy (--overwrite)
  search [term]                search names/content (--name, --content, --max)
  upload <local> <remote>      resumable upload, any size
  download <remote> <local>    streamed download with resume support
  precheck <path>              would a write be blocked right now?
  activity                     recent operations (--max)
  url <path>                   print download URL
  doctor                       show auto-discovery result and hub state
  mcp                          print MCP client config (local bridge, auto-discovery)

Global flags:
  --url <http://host:8787>     hub address (or LANSTORE_URL); omit to auto-discover
  --token <token>              API token (or LANSTORE_TOKEN)
  --agent <name>               agent id when the hub runs without auth
  --json                       raw JSON output

Discovery order when --url/LANSTORE_URL is not set:
  cached address -> UDP beacon (port 8788) -> local /24 scan on port 8787

Exit codes: 0 ok, 1 error, 2 write blocked — read the returned content and retry.`);
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function ensureOk(res) {
  if (res.status >= 200 && res.status < 300) return res.data;
  report(res.data);
  if (!res.data || res.data.ok !== false) process.exitCode = 1;
  return null;
}

async function doList(target, tree = false) {
  const q = new URLSearchParams({ path: target || '' });
  if (flags.recursive || tree) q.set('recursive', '1');
  if (tree) q.set('depth', String(flags.depth || 3));
  if (flags.pattern) q.set('pattern', flags.pattern);
  if (flags.max) q.set('max', String(flags.max));
  const res = await call(`/v1/list?${q}`);
  const data = await ensureOk(res);
  if (!data) return;
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  for (const entry of data.entries) {
    const size = entry.type === 'dir' ? '     <dir>' : String(entry.size).padStart(10);
    const stamp = (entry.mtime || '').slice(0, 16).replace('T', ' ');
    console.log(`${entry.type === 'dir' ? 'd' : '-'} ${size}  ${stamp}  ${entry.path}${entry.type === 'dir' ? '/' : ''}`);
  }
  console.log(`\n${data.count} entries${data.truncated ? ' (truncated)' : ''}`);
}

async function doWrite(target, append) {
  let content;
  if (flags.file) content = await fsp.readFile(flags.file);
  else content = await readStdin();
  if (!content.length) {
    console.error('❌ empty content: pass --file <path> or pipe stdin');
    process.exitCode = 1;
    return;
  }

  const LIMIT = 16 * 1024 * 1024;
  if (!append && content.length > LIMIT) {
    const temp = path.join(os.tmpdir(), `.lanstore-upload-${Date.now()}.tmp`);
    await fsp.writeFile(temp, content);
    try {
      await doUpload(temp, target);
    } finally {
      await fsp.rm(temp, { force: true });
    }
    return;
  }

  const res = await call(append ? '/v1/append' : '/v1/write', {
    method: 'POST',
    body: {
      path: target,
      content: content.toString('utf8'),
      mode: flags.mode || (append ? 'append' : 'overwrite'),
      expectedVersion: flags.expected || null
    }
  });
  report(res.data);
  if (res.status === 409) process.exitCode = 2;
}

async function doUpload(local, remote) {
  const stat = await fsp.stat(local);
  let target = remote;
  if (!target || target.endsWith('/')) target = `${target || ''}${path.basename(local)}`;

  const begin = await call('/v1/uploads', {
    method: 'POST',
    body: { path: target, totalBytes: stat.size, mode: flags.mode || 'overwrite', expectedVersion: flags.expected || null }
  });
  if (begin.status === 409) {
    report(begin.data);
    process.exitCode = 2;
    return;
  }
  if (begin.status !== 200) {
    await ensureOk(begin);
    return;
  }

  const id = begin.data.uploadId;
  const chunkSize = begin.data.chunkHint || 8 * 1024 * 1024;
  const fh = await fsp.open(local, 'r');
  let offset = 0;
  try {
    const buffer = Buffer.alloc(chunkSize);
    while (offset < stat.size) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(chunkSize, stat.size - offset), offset);
      if (!bytesRead) break;
      const res = await fetch(`${base}/v1/uploads/${id}?offset=${offset}`, {
        method: 'PUT',
        headers: headers(),
        body: buffer.subarray(0, bytesRead)
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        report(data.ok === false ? data : { ok: false, code: 'upload_failed', message: `HTTP ${res.status}` });
        return;
      }
      offset += bytesRead;
      if (process.stderr.isTTY) {
        process.stderr.write(`\r  ${humanBytes(offset)} / ${humanBytes(stat.size)}`);
      }
    }
    if (process.stderr.isTTY) process.stderr.write('\n');
  } finally {
    await fh.close();
  }

  const commit = await call(`/v1/uploads/${id}/commit`, { method: 'POST', body: { expectedVersion: flags.expected || null } });
  report(commit.data);
  if (commit.status === 409) process.exitCode = 2;
}

async function doDownload(remote, local) {
  const res = await fetch(`${base}/v1/file?path=${encodeURIComponent(remote)}&download=1`, { headers: headers() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    report(data.ok === false ? data : { ok: false, code: 'download_failed', message: `HTTP ${res.status}` });
    process.exitCode = 1;
    return;
  }
  await fsp.mkdir(path.dirname(path.resolve(local)), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(local));
  const st = await fsp.stat(local);
  console.log(`✅ downloaded ${remote} → ${local} (${humanBytes(st.size)})`);
}

function doMcp() {
  const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
  const environment = {};
  const effectiveToken = token || process.env.LANSTORE_TOKEN;
  if (effectiveToken) environment.LANSTORE_TOKEN = effectiveToken;
  if (flags.agent || process.env.LANSTORE_AGENT) environment.LANSTORE_AGENT = flags.agent || process.env.LANSTORE_AGENT;

  const config = {
    mcp: {
      lanstore: {
        type: 'local',
        command: [process.execPath, bridgePath],
        enabled: true,
        ...(Object.keys(environment).length ? { environment } : {})
      }
    }
  };
  console.log(JSON.stringify(config, null, 2));
  console.error('');
  console.error('Claude Code:');
  console.error(`  claude mcp add lanstore -- ${process.execPath} "${bridgePath}"`);
  console.error('');
  console.error('Міст сам знайде хаб у мережі (UDP 8788 + скан підмережі). Опційно: LANSTORE_TOKEN, LANSTORE_AGENT.');
}

async function doDoctor() {
  const started = Date.now();
  let found = null;
  let error = null;
  try {
    found = await discoverHub({ url: flags.url || null, token, timeoutMs: 5000, log: (m) => process.env.LANSTORE_DEBUG && console.error(`[discover] ${m}`) });
  } catch (err) {
    error = err.message;
  }

  if (flags.json) {
    console.log(JSON.stringify({ ...(found || {}), error, cacheFile: cachePath() }, null, 2));
    if (error) process.exitCode = 1;
    return;
  }
  if (error) {
    console.error(`❌ ${error}`);
    process.exitCode = 1;
    return;
  }

  const health = found.health || {};
  console.log(`hub:        ${found.url}`);
  console.log(`found by:   ${found.via}${found.address ? ` (${found.address})` : ''} in ${Date.now() - started} ms`);
  console.log(`hubId:      ${found.hubId}`);
  console.log(`name:       ${found.name} ${found.version || ''}`);
  console.log(`guard:      ${health.cooldownSec ?? '?'}s cooldown`);
  console.log(`auth:       ${health.authEnabled ? 'enabled' : 'disabled'}`);
  if (health.storage) console.log(`storage:    ${health.storage.freeHuman} free of ${health.storage.totalHuman}`);
  if (health.root) console.log(`root:       ${health.root}`);
  console.log(`cache:      ${cachePath()}`);
  console.log(`agent:      ${flags.agent || process.env.LANSTORE_AGENT || 'anonymous'}`);
}

async function main() {
  if (flags.help || !cmd) return usage();

  if (cmd === 'doctor') return doDoctor();
  if (cmd === 'mcp') return doMcp();

  if (!base) {
    try {
      const found = await discoverHub({ token, timeoutMs: 4000 });
      base = found.url;
      if (process.env.LANSTORE_DEBUG) process.stderr.write(`[lanstore] hub ${base} via ${found.via}\n`);
    } catch (err) {
      fail(err.message);
      return;
    }
  }

  switch (cmd) {
    case 'health': {
      const res = await call('/v1/health');
      const data = await ensureOk(res);
      if (!data) return;
      if (flags.json) return void console.log(JSON.stringify(data, null, 2));
      console.log(`${data.name} ${data.version}  ·  up ${data.uptimeSec}s  ·  ${data.platform}`);
      console.log(`root:    ${data.root}`);
      console.log(`storage: ${data.storage ? `${data.storage.freeHuman} free of ${data.storage.totalHuman}` : 'n/a'}`);
      console.log(`guard:   cooldown ${data.guard.cooldownMs / 1000}s, pending ${data.guard.pendingChallenges}`);
      console.log(`auth:    ${data.authEnabled ? 'enabled' : 'disabled'}`);
      return;
    }

    case 'info': {
      const data = await ensureOk(await call('/v1/info'));
      if (data) console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'ls':
      return doList(rest.join(' '));

    case 'tree':
      return doList(rest.join(' '), true);
    case 'stat': {
      const data = await ensureOk(await call(`/v1/stat?path=${encodeURIComponent(rest.join(' '))}`));
      if (!data) return;
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    case 'cat': {
      const target = rest.join(' ');
      if (!target) return fail('cat <path>');
      const hdrs = headers();
      if (flags.offset || flags.max) {
        const start = flags.offset || 0;
        const end = flags.max ? start + flags.max - 1 : '';
        hdrs.Range = `bytes=${start}-${end}`;
      }
      const res = await fetch(`${base}/v1/file?path=${encodeURIComponent(target)}`, { headers: hdrs });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return report(data.ok === false ? data : { ok: false, code: 'read_failed', message: `HTTP ${res.status}` });
      }
      await pipeline(Readable.fromWeb(res.body), process.stdout);
      return;
    }

    case 'write':
      return doWrite(rest.join(' '), false);

    case 'append':
      return doWrite(rest.join(' '), true);

    case 'mkdir': {
      const data = await ensureOk(await call('/v1/mkdir', { method: 'POST', body: { path: rest[0] } }));
      if (data) report(data);
      return;
    }

    case 'rm': {
      const target = rest[0];
      if (!target) return fail('rm <path>');
      const q = new URLSearchParams({ path: target });
      if (flags.recursive) q.set('recursive', '1');
      if (flags.permanent) q.set('permanent', '1');
      const data = await ensureOk(await call(`/v1/delete?${q}`, { method: 'DELETE' }));
      if (data) report(data);
      return;
    }

    case 'trash': {
      const data = await ensureOk(await call(`/v1/trash?limit=${flags.max || 100}`));
      if (!data) return;
      if (flags.json) return void console.log(JSON.stringify(data, null, 2));
      for (const batch of data.batches) {
        const stamp = (batch.deletedAt || '').slice(0, 19).replace('T', ' ');
        console.log(`${batch.trashId}  ${stamp}  ${batch.type === 'dir' ? 'd' : '-'} ${String(batch.size).padStart(10)}  ${batch.path}`);
      }
      console.log(`\n${data.count} item(s) in trash`);
      return;
    }

    case 'restore': {
      const trashId = rest[0];
      if (!trashId) return fail('restore <trashId>');
      const data = await ensureOk(
        await call('/v1/restore', {
          method: 'POST',
          body: { trashId, to: flags.to || null, overwrite: !!flags.overwrite }
        })
      );
      if (data) report(data);
      return;
    }

    case 'mv':
    case 'cp': {      const [from, to] = rest;
      if (!from || !to) return fail(`${cmd} <from> <to>`);
      const data = await ensureOk(
        await call(`/v1/${cmd === 'mv' ? 'move' : 'copy'}`, {
          method: 'POST',
          body: { from, to, overwrite: !!flags.overwrite }
        })
      );
      if (data) report(data);
      return;
    }

    case 'search': {
      const q = new URLSearchParams();
      if (rest.length) q.set('content', rest.join(' '));
      if (flags.name) q.set('name', flags.name);
      if (flags.content) q.set('content', flags.content);
      if (flags.max) q.set('max', String(flags.max));
      if (flags.depth) q.set('depth', String(flags.depth));
      const data = await ensureOk(await call(`/v1/search?${q}`));
      if (!data) return;
      if (flags.json) return void console.log(JSON.stringify(data, null, 2));
      for (const item of data.results) {
        if (item.snippet !== undefined) console.log(`${item.path}:${item.line}: ${item.snippet}`);
        else console.log(`${item.path}  ${humanBytes(item.size)}  ${item.mtime?.slice(0, 16).replace('T', ' ')}`);
      }
      console.log(`\n${data.count} results${data.truncated ? ' (truncated)' : ''}`);
      return;
    }

    case 'upload': {
      const [local, remote] = rest;
      if (!local) return fail('upload <local> <remote>');
      return doUpload(local, remote || '');
    }

    case 'download': {
      const [remote, local] = rest;
      if (!remote) return fail('download <remote> <local>');
      return doDownload(remote, local || path.basename(remote));
    }

    case 'precheck': {
      const res = await call('/v1/precheck', { method: 'POST', body: { path: rest[0], expectedVersion: flags.expected || null } });
      return report(res.data);
    }

    case 'activity': {
      const data = await ensureOk(await call(`/v1/activity?limit=${flags.max || 30}`));
      if (!data) return;
      if (flags.json) return void console.log(JSON.stringify(data, null, 2));
      for (const ev of data.events) {
        console.log(`${(ev.ts || '').slice(0, 19).replace('T', ' ')}  ${String(ev.agent).padEnd(12)} ${String(ev.op).padEnd(8)} ${ev.path}${ev.ok === false ? `  [${ev.code}]` : ''}`);
      }
      return;
    }

    case 'url': {
      const target = rest.join(' ');
      console.log(`${base}/v1/file?path=${encodeURIComponent(target)}${token ? `&token=${encodeURIComponent(token)}` : ''}`);
      return;
    }

    default:
      fail(`unknown command: ${cmd}`);
      usage();
  }
}

main().catch((err) => {
  if (err?.code === 'ECONNREFUSED') {
    fail(`cannot reach the hub at ${base} — is it running?`, 1);
    return;
  }
  console.error('❌', err);
  process.exitCode = 1;
});
