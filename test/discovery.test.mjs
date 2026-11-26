import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHub } from '../src/server.mjs';
import { discoverHub, udpProbe, verifyHub, readCache, clearCache } from '../src/discover.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanstore-disc-'));
const beaconPort = 20000 + Math.floor(Math.random() * 10000);

process.env.LANSTORE_CACHE = path.join(tmpRoot, 'hub-cache.json');
process.env.LANSTORE_DISCOVERY_PORT = String(beaconPort);
process.env.LANSTORE_SCAN = 'off';
delete process.env.LANSTORE_URL;

const hub = await createHub({
  argv: ['--config', path.join(tmpRoot, 'none.json')],
  overrides: {
    root: path.join(tmpRoot, 'data'),
    port: 0,
    host: '0.0.0.0',
    auth: { enabled: false },
    audit: { enabled: false },
    discovery: { enabled: true, port: beaconPort }
  }
});
const base = `http://127.0.0.1:${hub.cfg.port}`;

after(async () => {
  await hub.close();
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('UDP beacon answers a discovery probe', async () => {
  const replies = await udpProbe({ hubId: hub.identity.hubId, port: beaconPort, timeoutMs: 1500 });
  assert.ok(replies.length >= 1, 'expected at least one UDP reply');
  const answer = replies[0];
  assert.equal(answer.magic, 'LANSTORE_HUB');
  assert.equal(answer.hubId, hub.identity.hubId);
  assert.equal(answer.port, hub.cfg.port);
  assert.ok(answer.url.endsWith(`:${hub.cfg.port}`), `unexpected reply url ${answer.url}`);
});

test('the beacon ignores probes for another hub id', async () => {
  const replies = await udpProbe({ hubId: 'hub_ffffffffffffffff', port: beaconPort, timeoutMs: 900 });
  assert.equal(replies.length, 0);
});

test('discoverHub finds the hub over UDP and caches it', async () => {
  await clearCache();
  const found = await discoverHub({ timeoutMs: 1600, allowScan: false });
  assert.equal(found.via, 'udp');
  assert.ok(found.url.endsWith(`:${hub.cfg.port}`), `unexpected url ${found.url}`);
  assert.equal(found.hubId, hub.identity.hubId);

  const cache = await readCache();
  assert.ok(cache, 'cache file should be written');
  assert.equal(cache.url, found.url);
  assert.equal(cache.hubId, hub.identity.hubId);
});

test('discoverHub prefers the cached address on the next call', async () => {
  const cache = await readCache();
  const found = await discoverHub({ timeoutMs: 1600, allowScan: false });
  assert.equal(found.via, 'cache');
  assert.equal(found.url, cache.url);
});

test('discoverHub honours an explicit URL', async () => {
  const found = await discoverHub({ url: base, timeoutMs: 1500 });
  assert.equal(found.via, 'explicit');
  assert.equal(found.url, base);
});

test('verifyHub rejects non-hub addresses', async () => {
  await assert.rejects(() => verifyHub('http://127.0.0.1:1', { timeoutMs: 500 }), /HTTP|fetch|hub/i);
});

test('health exposes hubId so clients can pin the right hub', async () => {
  const res = await fetch(`${base}/v1/health`);
  const data = await res.json();
  assert.equal(data.hubId, hub.identity.hubId);
  assert.equal(data.discovery.udpPort, beaconPort);
  assert.equal(data.discovery.enabled, true);

  const disc = await (await fetch(`${base}/v1/discover`)).json();
  assert.equal(disc.magic, 'LANSTORE_HUB');
  assert.equal(disc.hubId, hub.identity.hubId);
});

test('restricted health stays available without a token when auth is on', async () => {
  const secure = await createHub({
    argv: ['--config', path.join(tmpRoot, 'none.json')],
    overrides: {
      root: path.join(tmpRoot, 'secure'),
      port: 0,
      host: '127.0.0.1',
      auth: { enabled: true, tokens: { 'agent-y': 'tok-y' } },
      audit: { enabled: false },
      discovery: { enabled: false }
    }
  });
  try {
    const url = `http://127.0.0.1:${secure.cfg.port}/v1/health`;
    const publicHealth = await fetch(url);
    assert.equal(publicHealth.status, 200);
    const data = await publicHealth.json();
    assert.equal(data.authEnabled, true);
    assert.equal(data.root, undefined);
    assert.equal(data.storage, undefined);
    assert.ok(data.hubId);

    const denied = await fetch(`http://127.0.0.1:${secure.cfg.port}/v1/list?path=`);
    assert.equal(denied.status, 401);

    const withToken = await fetch(url, { headers: { Authorization: 'Bearer tok-y' } });
    const full = await withToken.json();
    assert.ok(typeof full.root === 'string');
  } finally {
    await secure.close();
  }
});
