import test from 'node:test';
import assert from 'node:assert/strict';

import { WriteGuard } from '../src/guard.mjs';

function makeGuard(extra = {}) {
  return new WriteGuard({ cooldownMs: 60_000, challengeTtlMs: 600_000, guardSameAgent: false, ...extra });
}

test('file edited 3s ago by another agent: first write blocked, retry passes', () => {
  const guard = makeGuard();
  const mtimeMs = Date.now() - 3000;

  const first = guard.evaluate('askue/a.csv', { agentId: 'agent-b', exists: true, version: 'sha256:1', mtimeMs });
  assert.equal(first.allow, false);
  assert.equal(first.code, 'RECENTLY_MODIFIED');
  assert.equal(first.reason, 'recently_modified');

  const retry = guard.evaluate('askue/a.csv', { agentId: 'agent-b', exists: true, version: 'sha256:1', mtimeMs });
  assert.equal(retry.allow, true);
  assert.equal(retry.reason, 'second_attempt');

  const third = guard.evaluate('askue/a.csv', { agentId: 'agent-b', exists: true, version: 'sha256:1', mtimeMs });
  assert.equal(third.allow, false, 'challenge is single-use');

  guard.close();
});

test('file older than the cooldown is writable immediately', () => {
  const guard = makeGuard();
  const rec = guard.evaluate('askue/old.csv', {
    agentId: 'agent-b',
    exists: true,
    version: 'sha256:1',
    mtimeMs: Date.now() - 90_000
  });
  assert.equal(rec.allow, true);
  assert.equal(rec.reason, 'stale');
  guard.close();
});

test('a challenge is bound to one agent', () => {
  const guard = makeGuard();
  const mtimeMs = Date.now() - 1000;
  assert.equal(guard.evaluate('x/y.txt', { agentId: 'agent-b', exists: true, version: 'v1', mtimeMs }).allow, false);
  const other = guard.evaluate('x/y.txt', { agentId: 'agent-c', exists: true, version: 'v1', mtimeMs });
  assert.equal(other.allow, false, 'agent-c must read the content as well');
  guard.close();
});

test('own recent write is allowed without an extra round trip', () => {
  const guard = makeGuard();
  const now = Date.now();
  guard.recordWrite('x/y.txt', 'agent-a', 'v1', now);

  const rec = guard.evaluate('x/y.txt', { agentId: 'agent-a', exists: true, version: 'v1', mtimeMs: now });
  assert.equal(rec.allow, true);
  assert.equal(rec.reason, 'own_write');

  const foreign = guard.evaluate('x/y.txt', { agentId: 'agent-b', exists: true, version: 'v1', mtimeMs: now });
  assert.equal(foreign.allow, false);

  guard.close();
});

test('guardSameAgent=true also protects the writer from itself', () => {
  const guard = makeGuard({ guardSameAgent: true });
  const now = Date.now();
  guard.recordWrite('x/y.txt', 'agent-a', 'v1', now);

  const first = guard.evaluate('x/y.txt', { agentId: 'agent-a', exists: true, version: 'v1', mtimeMs: now });
  assert.equal(first.allow, false);
  const retry = guard.evaluate('x/y.txt', { agentId: 'agent-a', exists: true, version: 'v1', mtimeMs: now });
  assert.equal(retry.allow, true);
  guard.close();
});

test('stale expectedVersion returns a conflict and the retry is accepted', () => {
  const guard = makeGuard();
  const rec = guard.evaluate('x/y.txt', {
    agentId: 'agent-b',
    exists: true,
    version: 'v2',
    mtimeMs: Date.now() - 120_000,
    expectedVersion: 'v1'
  });
  assert.equal(rec.allow, false);
  assert.equal(rec.code, 'VERSION_MISMATCH');

  const retry = guard.evaluate('x/y.txt', {
    agentId: 'agent-b',
    exists: true,
    version: 'v2',
    mtimeMs: Date.now() - 120_000,
    expectedVersion: 'v1'
  });
  assert.equal(retry.allow, true);
  assert.equal(retry.reason, 'second_attempt');
  guard.close();
});

test('challenge becomes invalid when the file changes again', () => {
  const guard = makeGuard();
  const mtimeMs = Date.now() - 2000;
  assert.equal(guard.evaluate('x/y.txt', { agentId: 'agent-b', exists: true, version: 'v1', mtimeMs }).allow, false);
  const rec = guard.evaluate('x/y.txt', { agentId: 'agent-b', exists: true, version: 'v2', mtimeMs });
  assert.equal(rec.allow, false);
  assert.equal(rec.code, 'RECENTLY_MODIFIED');
  guard.close();
});

test('new file is always writable', () => {
  const guard = makeGuard();
  const rec = guard.evaluate('new/file.txt', { agentId: 'agent-b', exists: false });
  assert.equal(rec.allow, true);
  assert.equal(rec.reason, 'create');
  guard.close();
});
