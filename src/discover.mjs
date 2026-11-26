import dgram from 'node:dgram';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DISCOVER_MAGIC = 'LANSTORE_DISCOVER';
const HUB_MAGIC = 'LANSTORE_HUB';

export function httpPort() {
  return Number(process.env.LANSTORE_PORT || 8787);
}

export function discoveryPort() {
  return Number(process.env.LANSTORE_DISCOVERY_PORT || 8788);
}

export function cachePath() {
  if (process.env.LANSTORE_CACHE) return path.resolve(process.env.LANSTORE_CACHE);
  const base =
    process.env.XDG_CONFIG_HOME ||
    (process.env.HOME ? path.join(process.env.HOME, '.config') : null) ||
    process.env.APPDATA ||
    os.homedir();
  return path.join(base, 'lanstore', 'hub.json');
}

export async function readCache() {
  try {
    const raw = await fsp.readFile(cachePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.url === 'string') return data;
    return null;
  } catch {
    return null;
  }
}

export async function writeCache(found) {
  const file = cachePath();
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const payload = JSON.stringify(
      {
        url: found.url,
        hubId: found.hubId ?? null,
        name: found.name ?? null,
        via: found.via ?? null,
        updatedAt: new Date().toISOString()
      },
      null,
      2
    );
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
  } catch {
    /* cache is optional */
  }
}

export async function clearCache() {
  await fsp.rm(cachePath(), { force: true }).catch(() => {});
}

function headersFor(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Validate that a URL really serves a lanstore hub.
 */
export async function verifyHub(url, { token = null, hubId = null, timeoutMs = 1500 } = {}) {
  const clean = String(url).replace(/\/+$/, '');
  const res = await fetch(`${clean}/v1/health`, {
    headers: headersFor(token),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (res.status === 401) {
    throw new Error('hub requires a token: set LANSTORE_TOKEN');
  }
  if (!res.ok) throw new Error(`health request returned HTTP ${res.status}`);
  const health = await res.json().catch(() => null);
  if (!health?.ok) throw new Error('address does not serve a lanstore hub');
  if (hubId && health.hubId !== hubId) {
    throw new Error(`hub id mismatch (found ${health.hubId}, expected ${hubId})`);
  }
  return {
    url: clean,
    hubId: health.hubId ?? null,
    name: health.name ?? 'lanstore',
    version: health.version ?? null,
    health
  };
}

function ipToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | (Number(part) & 255)) >>> 0, 0);
}

function intToIp(value) {
  const n = value >>> 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function broadcastTargets(port) {
  const targets = new Map();
  const add = (address) => targets.set(`${address}:${port}`, { address, port });

  add('255.255.255.255');
  add('127.0.0.1');

  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (!ni.netmask) continue;
      const ip = ipToInt(ni.address);
      const mask = ipToInt(ni.netmask);
      const broadcast = (ip | (~mask >>> 0)) >>> 0;
      add(intToIp(broadcast));
    }
  }
  return [...targets.values()];
}

/**
 * Broadcast a probe and collect hub replies. No IP configuration needed.
 */
export function udpProbe({ hubId = null, port = discoveryPort(), timeoutMs = 1600, targets = null } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const replies = new Map();
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve([...replies.values()]);
    };

    socket.on('error', finish);
    socket.on('message', (buf, rinfo) => {
      if (!buf.length) return;
      let msg;
      try {
        msg = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (msg?.magic !== HUB_MAGIC || !msg.port) return;
      if (hubId && msg.hubId !== hubId) return;
      const key = `${rinfo.address}:${msg.port}`;
      if (!replies.has(key)) {
        replies.set(key, {
          ...msg,
          address: rinfo.address,
          url: `http://${rinfo.address}:${msg.port}`
        });
      }
    });

    const payload = Buffer.from(
      JSON.stringify({ magic: DISCOVER_MAGIC, protocol: 1, client: os.hostname(), ts: Date.now() })
    );
    const hosts = targets || broadcastTargets(port);
    const sendAll = () => {
      for (const target of hosts) {
        try {
          socket.send(payload, target.port, target.address, () => {});
        } catch {
          /* ignore */
        }
      }
    };

    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* ignore */
      }
      sendAll();
      setTimeout(sendAll, 400);
      setTimeout(sendAll, 900);
    });

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
  });
}

function hostsOfCidr(cidr) {
  const match = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(String(cidr).trim());
  if (!match) return [];
  const prefix = Number(match[2]);
  if (prefix < 16 || prefix > 30) return [];
  const network = ipToInt(match[1]) & ((0xffffffff << (32 - prefix)) >>> 0);
  const size = 2 ** (32 - prefix);
  const out = [];
  for (let i = 1; i < size - 1 && out.length < 1024; i++) out.push(intToIp((network + i) >>> 0));
  return out;
}

function candidateIps() {
  if (process.env.LANSTORE_SCAN_CIDR) return hostsOfCidr(process.env.LANSTORE_SCAN_CIDR);

  const out = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.address.startsWith('169.254.')) continue;
      const prefix = ni.cidr ? Number(ni.cidr.split('/')[1]) : 24;
      const maskBits = Math.max(24, Math.min(Number.isFinite(prefix) ? prefix : 24, 30));
      const network = ipToInt(ni.address) & ((0xffffffff << (32 - maskBits)) >>> 0);
      const size = 2 ** (32 - maskBits);
      for (let i = 1; i < size - 1; i++) {
        const ip = intToIp((network + i) >>> 0);
        if (ip !== ni.address) out.add(ip);
        if (out.size >= 1024) return [...out];
      }
    }
  }
  return [...out];
}

/**
 * Last-resort discovery: probe every host in the local /24 on the hub HTTP port.
 */
export async function scanSubnets({ token = null, hubId = null, port = httpPort(), timeoutMs = 450, concurrency = 64, log = () => {} } = {}) {
  const ips = candidateIps();
  if (!ips.length) return null;
  log(`scan: ${ips.length} hosts on port ${port}`);

  let index = 0;
  let found = null;
  const controller = new AbortController();

  const worker = async () => {
    while (!found && index < ips.length) {
      const ip = ips[index++];
      const url = `http://${ip}:${port}`;
      try {
        const res = await fetch(`${url}/v1/health`, {
          headers: headersFor(token),
          signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal])
        });
        if (!res.ok) continue;
        const data = await res.json().catch(() => null);
        if (data?.ok && (!hubId || data.hubId === hubId)) {
          found = { url, hubId: data.hubId ?? null, name: data.name ?? 'lanstore', version: data.version ?? null, health: data, via: 'scan' };
          controller.abort();
        }
      } catch {
        /* host is down or not a hub */
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, ips.length)) }, worker));
  return found;
}

/**
 * Resolve the hub: explicit URL -> cache -> UDP beacon -> subnet scan.
 * Returns { url, hubId, name, version, health, via }.
 */
export async function discoverHub({
  url = null,
  token = null,
  hubId = null,
  timeoutMs = 2500,
  skipCache = false,
  allowScan = true,
  log = () => {}
} = {}) {
  const explicit = String(url || process.env.LANSTORE_URL || '').trim();
  if (explicit) {
    const hit = await verifyHub(explicit, { token, hubId });
    return { ...hit, via: 'explicit' };
  }

  if (!skipCache) {
    const cached = await readCache();
    if (cached?.url) {
      try {
        const hit = await verifyHub(cached.url, { token, hubId, timeoutMs: Math.min(1200, timeoutMs) });
        log(`found in cache: ${cached.url}`);
        return { ...hit, via: 'cache', cachePath: cachePath() };
      } catch (err) {
        log(`cache miss (${cached.url}): ${err.message}`);
      }
    }
  }

  const replies = await udpProbe({ hubId, timeoutMs: Math.min(timeoutMs, 1600) });
  log(`udp replies: ${replies.length}`);
  for (const reply of replies) {
    try {
      const hit = await verifyHub(reply.url, { token, hubId, timeoutMs: 1200 });
      const found = { ...hit, via: 'udp', address: reply.address, cachePath: cachePath() };
      await writeCache(found);
      return found;
    } catch (err) {
      log(`udp candidate ${reply.url} failed: ${err.message}`);
    }
  }

  if (allowScan && process.env.LANSTORE_SCAN !== 'off') {
    const hit = await scanSubnets({ token, hubId, log });
    if (hit) {
      const found = { ...hit, cachePath: cachePath() };
      await writeCache(found);
      return found;
    }
  }

  throw new Error(
    'lanstore hub не знайдено в локальній мережі (UDP-маяк і скан підмережі не дали результату). ' +
      'Перевірте, що хаб запущений і порт відкритий, або задайте LANSTORE_URL=http://host:8787.'
  );
}
