#!/usr/bin/env node
/**
 * lanstore installer.
 *
 * Installs the CLI/MCP-bridge wrappers for the current user and registers the
 * bridge as an MCP server in every detected agent harness:
 *
 *   opencode        -> opencode mcp add --global
 *   Codex CLI       -> codex mcp add
 *   Claude Code     -> claude mcp add -s user
 *   DeepSeek Harness-> $DSH_HOME/cordis.patch.yml (managed block)
 *
 * Safe to run repeatedly: opencode/codex upsert, Claude is removed+re-added,
 * the dsh block is replaced between markers.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './config.mjs';
import { isMainModule } from './util.mjs';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BRIDGE_PATH = path.join(APP_DIR, 'src', 'bridge.mjs');
export const CLI_PATH = path.join(APP_DIR, 'src', 'cli.mjs');
export const NODE_PATH = process.execPath;

const DSH_START = '# >>> lanstore mcp (managed)';
const DSH_END = '# <<< lanstore mcp (managed)';
const ALL_CLIENTS = ['opencode', 'codex', 'claude', 'dsh'];
const CLIENT_LABEL = {
  opencode: 'opencode',
  codex: 'Codex CLI',
  claude: 'Claude Code',
  dsh: 'DeepSeek Harness'
};

export function defaultAgentName() {
  let host = os.hostname().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!host) host = 'agent';
  return host.slice(0, 40);
}

export function parseClients(value) {
  if (!value) return 'auto';
  const raw = String(value).trim().toLowerCase();
  if (raw === 'all' || raw === 'auto') return raw;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = list.filter((name) => !ALL_CLIENTS.includes(name));
  if (unknown.length) {
    throw new Error(`unknown client(s): ${unknown.join(', ')} (expected: ${ALL_CLIENTS.join(', ')}, all)`);
  }
  return [...new Set(list)];
}

export function buildOpencodeArgs({ nodePath = NODE_PATH, bridgePath = BRIDGE_PATH, env = {} } = {}) {
  const args = ['mcp', 'add', '--global', 'lanstore'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push('--', nodePath, bridgePath);
  return args;
}

export function buildCodexArgs({ nodePath = NODE_PATH, bridgePath = BRIDGE_PATH, env = {} } = {}) {
  const args = ['mcp', 'add', 'lanstore'];
  for (const [key, value] of Object.entries(env)) args.push('--env', `${key}=${value}`);
  args.push('--', nodePath, bridgePath);
  return args;
}

export function buildClaudeAddArgs({ nodePath = NODE_PATH, bridgePath = BRIDGE_PATH, env = {} } = {}) {
  const args = ['mcp', 'add', '-s', 'user', 'lanstore'];
  for (const [key, value] of Object.entries(env)) args.push('-e', `${key}=${value}`);
  args.push('--', nodePath, bridgePath);
  return args;
}

const yamlString = (value) => JSON.stringify(String(value));

export function buildDshBlock({ nodePath = NODE_PATH, bridgePath = BRIDGE_PATH, env = {} } = {}) {
  const lines = [
    DSH_START,
    '- id: mcp-lanstore',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: lanstore',
    '    transport: stdio',
    `    command: ${yamlString(nodePath)}`,
    `    args: [${yamlString(bridgePath)}]`
  ];
  const entries = Object.entries(env);
  if (entries.length) {
    lines.push('    env:');
    for (const [key, value] of entries) lines.push(`      ${key}: ${yamlString(value)}`);
  }
  lines.push(DSH_END);
  return lines.join('\n');
}

/** Replace the managed block or append a new one. Preserves all user patches. */
export function mergeDshBlock(existing, block) {
  const text = existing || '';
  const start = text.indexOf(DSH_START);
  if (start >= 0) {
    const end = text.indexOf(DSH_END, start);
    if (end > start) {
      const after = end + DSH_END.length;
      return `${text.slice(0, start)}${block}${text.slice(after)}`.replace(/\n{3,}/g, '\n\n');
    }
  }
  if (!text.trim()) return `${block}\n`;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

export function dshHome(env = process.env) {
  return env.DSH_HOME ? path.resolve(env.DSH_HOME) : path.join(os.homedir(), '.dsh');
}

export function which(command, env = process.env) {
  const pathVar = env.PATH || env.Path || '';
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function cmdQuote(value) {
  const s = String(value);
  return /[\s"&|<>^]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function runCommand(command, args, { dryRun = false } = {}) {
  if (dryRun) return { ok: true, dryRun: true, stdout: '', stderr: '' };
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(cmdQuote).join(' ')], {
          windowsVerbatimArguments: true,
          encoding: 'utf8'
        })
      : spawnSync(command, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

async function writeExecutable(file, content, { dryRun }) {
  if (dryRun) return;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content);
  if (process.platform !== 'win32') await fsp.chmod(file, 0o755);
}

export function wrapperScripts({ nodePath = NODE_PATH, appDir = APP_DIR } = {}) {
  const cli = path.join(appDir, 'src', 'cli.mjs');
  const bridge = path.join(appDir, 'src', 'bridge.mjs');
  if (process.platform === 'win32') {
    return {
      'lanstore.cmd': `@echo off\r\n"${nodePath}" "${cli}" %*\r\n`,
      'lanstore-bridge.cmd': `@echo off\r\n"${nodePath}" "${bridge}" %*\r\n`
    };
  }
  return {
    lanstore: `#!/usr/bin/env bash\n# generated by lanstore installer\nexec ${shellQuote(nodePath)} ${shellQuote(cli)} "$@"\n`,
    'lanstore-bridge': `#!/usr/bin/env bash\n# generated by lanstore installer\nexec ${shellQuote(nodePath)} ${shellQuote(bridge)} "$@"\n`
  };
}

export function defaultBinDir(env = process.env) {
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'lanstore', 'bin');
  }
  return path.join(os.homedir(), '.local', 'bin');
}

async function configureOpencode(ctx) {
  const bin = which('opencode');
  if (!bin) return { client: 'opencode', status: 'missing', message: 'opencode не знайдено в PATH' };
  const result = runCommand('opencode', buildOpencodeArgs(ctx), { dryRun: ctx.dryRun });
  return {
    client: 'opencode',
    status: result.ok ? 'ok' : 'warn',
    message: result.ok ? 'MCP-сервер lanstore додано в глобальний конфіг opencode' : firstLine(result.stderr) || 'opencode mcp add failed',
    path: 'opencode.json (global)'
  };
}

async function configureCodex(ctx) {
  const bin = which('codex');
  if (!bin) return { client: 'codex', status: 'missing', message: 'codex не знайдено в PATH' };
  const codexHome = process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex');
  if (!ctx.dryRun) await fsp.mkdir(codexHome, { recursive: true }).catch(() => {});
  const result = runCommand('codex', buildCodexArgs(ctx), { dryRun: ctx.dryRun });
  return {
    client: 'codex',
    status: result.ok ? 'ok' : 'warn',
    message: result.ok ? 'MCP-сервер lanstore додано в config.toml' : firstLine(result.stderr) || 'codex mcp add failed',
    path: path.join(codexHome, 'config.toml')
  };
}

async function configureClaude(ctx) {
  const bin = which('claude');
  if (!bin) return { client: 'claude', status: 'missing', message: 'claude не знайдено в PATH' };

  // `claude mcp add` refuses to overwrite: remove first, ignore "not found".
  const removed = runCommand('claude', ['mcp', 'remove', 'lanstore', '-s', 'user'], { dryRun: ctx.dryRun });
  if (!ctx.dryRun && !removed.ok && !/not found|does not exist|no such/i.test(removed.stderr || '')) {
    // keep going, add will report the real problem
  }
  const result = runCommand('claude', buildClaudeAddArgs(ctx), { dryRun: ctx.dryRun });
  return {
    client: 'claude',
    status: result.ok ? 'ok' : 'warn',
    message: result.ok ? 'MCP-сервер lanstore додано (user scope)' : firstLine(result.stderr) || 'claude mcp add failed',
    path: '~/.claude.json (user scope)'
  };
}

async function configureDsh(ctx, { explicit }) {
  const bin = which('dsh', ctx.processEnv);
  const home = dshHome(ctx.processEnv);
  const file = path.join(home, 'cordis.patch.yml');
  if (!bin && !fs.existsSync(home) && !explicit) {
    return { client: 'dsh', status: 'missing', message: 'DeepSeek Harness не знайдено (немає dsh і $DSH_HOME)' };
  }

  let existing = '';
  try {
    existing = await fsp.readFile(file, 'utf8');
  } catch {
    /* new file */
  }
  const block = buildDshBlock(ctx);
  const next = mergeDshBlock(existing, block);
  if (next !== existing) {
    if (!ctx.dryRun) {
      await fsp.mkdir(home, { recursive: true });
      await fsp.writeFile(file, next);
    }
  }
  return {
    client: 'dsh',
    status: 'ok',
    message: existing.includes(DSH_START) ? 'блок lanstore оновлено' : 'додано MCP-клієнт lanstore',
    path: file
  };
}

function firstLine(text) {
  return String(text || '').trim().split('\n').filter(Boolean)[0] || '';
}

export async function install({ argv = [], env = process.env } = {}) {
  const args = parseArgs(argv);
  if (args.help) return { help: true };

  const dryRun = args['dry-run'] === true;
  const agent = String(args.agent || env.LANSTORE_AGENT || defaultAgentName());
  const token = args.token ? String(args.token) : env.LANSTORE_TOKEN || null;
  const hubId = args['hub-id'] ? String(args['hub-id']) : null;
  const requested = parseClients(args.clients);

  const ctx = {
    nodePath: NODE_PATH,
    bridgePath: BRIDGE_PATH,
    env: {
      LANSTORE_AGENT: agent,
      ...(token ? { LANSTORE_TOKEN: token } : {}),
      ...(hubId ? { LANSTORE_HUB_ID: hubId } : {})
    },
    processEnv: env,
    dryRun
  };

  const detected = {
    opencode: !!which('opencode', env),
    codex: !!which('codex', env),
    claude: !!which('claude', env),
    dsh: !!which('dsh', env) || fs.existsSync(dshHome(env))
  };

  let targets;
  let explicitDsh = false;
  if (requested === 'auto') {
    targets = ALL_CLIENTS.filter((name) => detected[name]);
  } else if (requested === 'all') {
    targets = [...ALL_CLIENTS];
    explicitDsh = true;
  } else {
    targets = requested;
    explicitDsh = requested.includes('dsh');
  }

  const binDir = args['bin-dir'] ? path.resolve(String(args['bin-dir'])) : defaultBinDir(env);
  const wrappers = wrapperScripts({ nodePath: ctx.nodePath, appDir: APP_DIR });
  const installedFiles = [];
  for (const [name, content] of Object.entries(wrappers)) {
    const target = path.join(binDir, name);
    await writeExecutable(target, content, { dryRun });
    installedFiles.push(target);
  }

  const results = [];
  for (const name of targets) {
    try {
      if (name === 'opencode') results.push(await configureOpencode(ctx));
      else if (name === 'codex') results.push(await configureCodex(ctx));
      else if (name === 'claude') results.push(await configureClaude(ctx));
      else if (name === 'dsh') results.push(await configureDsh(ctx, { explicit: explicitDsh }));
    } catch (err) {
      results.push({ client: name, status: 'warn', message: err.message });
    }
  }

  const pathIncluded =
    process.platform === 'win32'
      ? String(env.PATH || env.Path || '').toLowerCase().includes(binDir.toLowerCase())
      : `:${String(env.PATH || '').replace(/\/+$/, '')}:`.includes(`:${binDir.replace(/\/+$/, '')}:`);

  return {
    ok: results.every((r) => r.status !== 'warn'),
    appDir: APP_DIR,
    node: ctx.nodePath,
    nodeVersion: process.versions.node,
    binDir,
    binDirInPath: pathIncluded,
    installedFiles,
    agent,
    tokenConfigured: !!token,
    hubId,
    dryRun,
    clients: results,
    skipped: ALL_CLIENTS.filter((name) => !targets.includes(name))
  };
}

function printSummary(summary) {
  const line = (status) => {
    if (status === 'ok') return '✅';
    if (status === 'missing') return '––';
    return '⚠️ ';
  };
  console.log('');
  console.log('lanstore installer');
  console.log(`  app:   ${summary.appDir}`);
  console.log(`  node:  ${summary.node} (v${summary.nodeVersion})`);
  console.log(`  bin:   ${summary.binDir}${summary.dryRun ? '  [dry-run]' : ''}`);
  console.log('');
  console.log('CLI / MCP bridge:');
  for (const file of summary.installedFiles) console.log(`  ${file}`);
  console.log('');
  console.log('MCP clients:');
  if (!summary.clients.length) {
    console.log('  –– нічого не знайдено. Підключіть вручну: lanstore mcp');
  }
  for (const item of summary.clients) {
    const label = (CLIENT_LABEL[item.client] || item.client).padEnd(17);
    console.log(`  ${line(item.status)} ${label} ${item.message}${item.path ? `\n     ${item.path}` : ''}`);
  }
  for (const skipped of summary.skipped) {
    console.log(`  –– ${(CLIENT_LABEL[skipped] || skipped).padEnd(17)} не знайдено (пропущено)`);
  }
  console.log('');
  if (!summary.binDirInPath) {
    console.log('⚠️  Каталог bin не в PATH. Додайте:');
    if (process.platform === 'win32') {
      console.log(`   setx PATH "%PATH%;${summary.binDir}"`);
    } else {
      console.log(`   export PATH="${summary.binDir}:$PATH"`);
      console.log('   # щоб назавжди: echo \'export PATH="$HOME/.local/bin:$PATH"\' >> ~/.bashrc');
    }
    console.log('');
  }
  console.log('Далі:');
  console.log('  lanstore doctor      # перевірити автопошук хаба');
  console.log('  lanstore ls          # список файлів у спільному сховищі');
  console.log('');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`lanstore installer

Usage: install.sh [options]

Options:
  --clients <list>   all | auto | opencode,codex,claude,dsh   (default: auto — detected only)
  --agent <name>     agent id for X-Agent-Id / LANSTORE_AGENT (default: hostname)
  --token <token>    LANSTORE_TOKEN for the bridge
  --hub-id <id>      pin a specific hub (LANSTORE_HUB_ID)
  --bin-dir <dir>    where to put lanstore / lanstore-bridge wrappers
  --dry-run          print actions without writing
  --force            reconfigure even if already present

Examples:
  install.sh
  install.sh --agent linux-pc --token "$LANSTORE_TOKEN"
  install.sh --clients opencode,codex,claude,dsh --bin-dir /usr/local/bin`);
    return;
  }

  const summary = await install({ argv });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  printSummary(summary);
  if (!summary.ok) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
