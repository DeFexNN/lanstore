import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildDshBlock,
  mergeDshBlock,
  buildOpencodeArgs,
  buildCodexArgs,
  buildClaudeAddArgs,
  defaultAgentName,
  wrapperScripts,
  install,
  parseClients
} from '../src/installer.mjs';

const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'lanstore-inst-'));

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

test('parseClients accepts lists and rejects unknown names', () => {
  assert.equal(parseClients(undefined), 'auto');
  assert.equal(parseClients('all'), 'all');
  assert.deepEqual(parseClients('opencode,codex'), ['opencode', 'codex']);
  assert.deepEqual(parseClients('dsh,dsh'), ['dsh']);
  assert.throws(() => parseClients('cursor'), /unknown client/);
});

test('defaultAgentName is a safe id', () => {
  const name = defaultAgentName();
  assert.match(name, /^[a-z0-9][a-z0-9._-]*$/);
  assert.ok(name.length <= 40);
});

test('client command builders point at node + bridge', () => {
  const opts = { nodePath: '/usr/bin/node', bridgePath: '/opt/lanstore/src/bridge.mjs', env: { LANSTORE_AGENT: 'pc-1' } };

  const opencode = buildOpencodeArgs(opts);
  assert.deepEqual(opencode.slice(0, 5), ['mcp', 'add', '--global', 'lanstore', '--env']);
  assert.equal(opencode[5], 'LANSTORE_AGENT=pc-1');
  assert.deepEqual(opencode.slice(-3), ['--', '/usr/bin/node', '/opt/lanstore/src/bridge.mjs']);

  const codex = buildCodexArgs(opts);
  assert.deepEqual(codex.slice(0, 3), ['mcp', 'add', 'lanstore']);
  assert.deepEqual(codex.slice(-3), ['--', '/usr/bin/node', '/opt/lanstore/src/bridge.mjs']);

  const claude = buildClaudeAddArgs(opts);
  assert.deepEqual(claude.slice(0, 5), ['mcp', 'add', '-s', 'user', 'lanstore']);
  assert.deepEqual(claude.slice(-3), ['--', '/usr/bin/node', '/opt/lanstore/src/bridge.mjs']);
});

test('dsh block is a valid managed YAML entry', () => {
  const block = buildDshBlock({
    nodePath: 'C:\\Program Files\\nodejs\\node.exe',
    bridgePath: '/home/u/.local/share/lanstore/src/bridge.mjs',
    env: { LANSTORE_AGENT: 'linux-pc', LANSTORE_TOKEN: 'abc' }
  });
  assert.match(block, /# >>> lanstore mcp \(managed\)/);
  assert.match(block, /- id: mcp-lanstore/);
  assert.match(block, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(block, /serverName: lanstore/);
  assert.match(block, /transport: stdio/);
  assert.match(block, /command: "C:\\\\Program Files\\\\nodejs\\\\node.exe"/);
  assert.match(block, /args: \["\/home\/u\/\.local\/share\/lanstore\/src\/bridge\.mjs"\]/);
  assert.match(block, /LANSTORE_AGENT: "linux-pc"/);
  assert.match(block, /LANSTORE_TOKEN: "abc"/);
  assert.match(block, /# <<< lanstore mcp \(managed\)/);
});

test('dsh block without env has no dangling env key', () => {
  const block = buildDshBlock({ env: {} });
  assert.doesNotMatch(block, /env:/);
  assert.match(block, /args: \[/);
});

test('mergeDshBlock appends once and replaces on repeat', () => {
  const block = buildDshBlock({ env: { LANSTORE_AGENT: 'a' } });
  const once = mergeDshBlock('', block);
  assert.equal(once.trim(), block.trim());

  const appended = mergeDshBlock('- id: other\n  name: plugin\n', block);
  assert.match(appended, /- id: other/);
  assert.match(appended, /mcp-lanstore/);

  const updated = mergeDshBlock(once.replace('"a"', '"b"'), block);
  assert.equal((updated.match(/lanstore mcp \(managed\)/g) || []).length, 2); // start + end markers
  assert.match(updated, /LANSTORE_AGENT: "a"/);
  assert.doesNotMatch(updated, /"b"/);
});

test('wrapper scripts reference the bridge and CLI', () => {
  const files = wrapperScripts({ nodePath: '/usr/bin/node', appDir: '/opt/lanstore' });
  const names = Object.keys(files).sort();
  if (process.platform === 'win32') {
    assert.deepEqual(names, ['lanstore-bridge.cmd', 'lanstore.cmd']);
    assert.match(files['lanstore-bridge.cmd'], /src\\bridge\.mjs/);
  } else {
    assert.deepEqual(names, ['lanstore', 'lanstore-bridge']);
    assert.match(files['lanstore-bridge'], /src\/bridge\.mjs/);
  }
});

test('install writes wrappers and a dsh config, idempotently', async () => {
  const home = path.join(tmpRoot, 'home');
  const dsh = path.join(home, '.dsh');
  const bin = path.join(home, 'bin');
  await fsp.mkdir(home, { recursive: true });

  const env = { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dsh, PATH: '' };
  const argv = ['--clients', 'dsh', '--bin-dir', bin, '--agent', 'test-agent'];
  const first = await install({ argv, env });
  assert.equal(first.agent, 'test-agent');
  assert.ok(first.installedFiles.length >= 2);
  for (const file of first.installedFiles) assert.ok(fs.existsSync(file), `missing ${file}`);

  const yamlFile = path.join(dsh, 'cordis.patch.yml');
  const yaml = await fsp.readFile(yamlFile, 'utf8');
  assert.match(yaml, /serverName: lanstore/);
  assert.match(yaml, /LANSTORE_AGENT: "test-agent"/);
  assert.equal((yaml.match(/# >>> lanstore/g) || []).length, 1);

  const second = await install({ argv, env });
  const yamlAgain = await fsp.readFile(yamlFile, 'utf8');
  assert.equal(yamlAgain, yaml, 'second run must not duplicate the block');
  assert.equal(second.clients[0].status, 'ok');

  if (process.platform !== 'win32') {
    const mode = fs.statSync(first.installedFiles[0]).mode & 0o777;
    assert.ok(mode & 0o111, 'wrapper must be executable');
  }
});

test('dry run writes nothing', async () => {
  const home = path.join(tmpRoot, 'dry-home');
  const dsh = path.join(home, '.dsh');
  const bin = path.join(home, 'bin');
  await fsp.mkdir(home, { recursive: true });

  const summary = await install({
    argv: ['--clients', 'dsh', '--bin-dir', bin, '--agent', 'dry', '--dry-run'],
    env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: dsh, PATH: '' }
  });
  assert.equal(summary.dryRun, true);
  assert.ok(!fs.existsSync(bin), 'bin dir must not be created');
  assert.ok(!fs.existsSync(path.join(dsh, 'cordis.patch.yml')), 'dsh config must not be written');
});
