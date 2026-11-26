import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { Audit } from '../src/audit.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanstore-audit-'));

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('audit log rotates when it exceeds maxBytes', async () => {
  const file = path.join(tmpRoot, 'audit.jsonl');
  const audit = new Audit({ file, maxBytes: 400, backups: 2, tailBytes: 8192 });

  for (let i = 0; i < 30; i++) {
    await audit.log({ agent: 'agent-a', op: 'write', path: `f/note-${i}.txt`, ok: true });
  }

  assert.ok(fs.existsSync(`${file}.1`), 'rotated file must exist');
  const events = await audit.tail(50);
  assert.ok(events.length > 0);
  assert.ok(events.some((ev) => ev.path === 'f/note-29.txt'), 'newest event must be readable');
});

test('audit tail filters and reads rotated history', async () => {
  const file = path.join(tmpRoot, 'audit2.jsonl');
  const audit = new Audit({ file, maxBytes: 300, backups: 3, tailBytes: 16384 });

  for (let i = 0; i < 20; i++) {
    await audit.log({ agent: i % 2 ? 'a' : 'b', op: 'write', path: `p/${i}` });
  }
  const onlyA = await audit.tail(100, { agent: 'a' });
  assert.ok(onlyA.length > 0);
  assert.ok(onlyA.every((ev) => ev.agent === 'a'));

  const writes = await audit.tail(100, { onlyWrites: true });
  assert.ok(writes.length > 0);
  const reads = await audit.tail(100, { op: 'mkdir' });
  assert.equal(reads.length, 0);
});

test('disabled audit writes nothing', async () => {
  const file = path.join(tmpRoot, 'off.jsonl');
  const audit = new Audit({ file, enabled: false });
  await audit.log({ agent: 'x', op: 'write', path: 'a' });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(await audit.tail(10), []);
});
