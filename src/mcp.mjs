import { HubError, APP_VERSION, humanBytes } from './util.mjs';
import { readJson, sendJson, headerValue } from './http.mjs';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const COOLDOWN_NOTE =
  'Правило запису: якщо файл редагував хтось інший менш ніж N секунд тому, запис відхиляється з кодом RECENTLY_MODIFIED і повертає актуальний вміст. Прочитайте його і повторіть той самий виклик — другий запис буде прийнятий.';

const TOOLS = [
  {
    name: 'hub_info',
    description:
      'Show the hub address, storage root, free disk space, list of projects and the active write-guard policy (cooldown seconds). Call this first on an unknown hub.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'fs_list',
    description:
      'List a directory in shared storage. Returns entries with path, type (dir/file), size and mtime. Use pattern (glob like "*.csv") and recursive=true for trees.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to the hub root. Empty string or "/" means the root.' },
        pattern: { type: 'string', description: 'Optional glob matched against the file name, e.g. "*.json" or "**/*.csv".' },
        recursive: { type: 'boolean', description: 'Walk subdirectories.' },
        depth: { type: 'integer', description: 'Max recursion depth when recursive=true (default 32).' },
        max: { type: 'integer', description: 'Max entries to return (default 1000, hard cap 50000).' },
        hidden: { type: 'boolean', description: 'Include dot-files and dot-directories.' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'fs_tree',
    description: 'Compact recursive directory tree with sizes. Good for a quick project overview.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        depth: { type: 'integer', description: 'Max depth (default 3, max 10).' },
        max: { type: 'integer', description: 'Max entries (default 500).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'fs_stat',
    description: 'Stat one path. Returns type, size, mtime and an opaque version string. Pass that version as expectedVersion on a later write to detect concurrent changes.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_mkdir',
    description: 'Create a directory (parents are created by default). Idempotent: an existing directory returns action "exists".',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        parents: { type: 'boolean', description: 'Create missing parents (default true).' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_read',
    description:
      'Read a file as text (UTF-8) or base64 for binary. Supports offset/maxBytes for large files; the response includes version and nextOffset. Small binary files should be fetched with fs_transfer instead.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer', description: 'Byte offset to start from (default 0).' },
        maxBytes: { type: 'integer', description: 'Max bytes to return (default 65536, max 4194304).' },
        encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], description: 'Force text or base64 output.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_write',
    description:
      'Create or overwrite a file. Content is a string (UTF-8 by default, or base64 with encoding="base64"). ' +
      COOLDOWN_NOTE +
      ' If the result has ok:false and code RECENTLY_MODIFIED or VERSION_MISMATCH, do exactly that: read the returned "content", change what you need, and call fs_write again (passing expectedVersion=version is safest).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        mode: { type: 'string', enum: ['overwrite', 'create', 'append'], description: 'overwrite (default) | create (fail if exists) | append.' },
        expectedVersion: { type: 'string', description: 'Version you read with fs_read/fs_stat. Mismatch returns the fresh content instead of overwriting.' },
        parents: { type: 'boolean', description: 'Create missing parent directories (default true).' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_append',
    description: 'Append text/bytes to a file (creates it when missing). The same 60s write guard applies.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
        expectedVersion: { type: 'string' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_move',
    description: 'Move or rename a file/directory. With overwrite=true an existing target is replaced, subject to the write guard.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_copy',
    description: 'Copy a file or directory (recursive for directories). Copying over an existing file requires overwrite=true and passes the write guard.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        overwrite: { type: 'boolean' }
      },
      required: ['from', 'to'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_delete',
    description: 'Delete a file or directory. By default the item is moved to the hub trash (.lanstore/trash) and can be restored with fs_restore; permanent=true removes it for real. Non-empty directories require recursive=true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' },
        permanent: { type: 'boolean' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_trash_list',
    description: 'List recently deleted items in the hub trash: trashId, original path, type, size and deletion time. Use fs_restore with the trashId to bring an item back.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Max batches to return (default 200).' } },
      additionalProperties: false
    }
  },
  {
    name: 'fs_restore',
    description:
      'Restore an item from the hub trash by trashId (from fs_trash_list). If the destination already exists, pass overwrite=true — the current version is first moved to the trash, so the restore itself stays undoable.',
    inputSchema: {
      type: 'object',
      properties: {
        trashId: { type: 'string' },
        to: { type: 'string', description: 'Restore under a different path (optional).' },
        overwrite: { type: 'boolean' }
      },
      required: ['trashId'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_empty_trash',
    description: 'Permanently remove trashed items. Default: older than 30 days. all=true empties the whole trash.',
    inputSchema: {
      type: 'object',
      properties: {
        olderThanDays: { type: 'integer' },
        all: { type: 'boolean' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'fs_search',
    description: 'Search by file name glob and/or text content (case-insensitive regex or substring, files up to 2 MB). Returns matching paths with line numbers and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Base directory (default root).' },
        name: { type: 'string', description: 'Glob for the file name, e.g. "*askue*".' },
        content: { type: 'string', description: 'Text or regex to find inside files.' },
        max: { type: 'integer', description: 'Max results (default 100).' },
        depth: { type: 'integer', description: 'Max depth (default 16).' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'fs_usage',
    description: 'Recursive size of a directory: bytes, human size, file and directory counts.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'fs_transfer',
    description:
      'Get ready-to-run commands for moving big files (hundreds of MB to tens of GB) between this machine and the hub over HTTP: resumable chunked upload with curl/PowerShell and ranged download. Use this instead of fs_write for large binaries.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        direction: { type: 'string', enum: ['download', 'upload', 'both'], description: 'Default both.' },
        totalBytes: { type: 'integer', description: 'Size of the file to upload, when known.' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'fs_activity',
    description: 'Recent hub activity (who wrote what). Useful to see if another agent is editing the same project right now.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Only events under this path prefix.' },
        agent: { type: 'string' },
        limit: { type: 'integer', description: 'Default 30.' },
        writesOnly: { type: 'boolean' }
      },
      additionalProperties: false
    }
  }
];

export function createMcp({ store, uploads, cfg, audit, startedAt }) {
  const started = startedAt || Date.now();

  function baseUrl(req) {
    if (cfg.publicUrl) return cfg.publicUrl;
    return `http://${headerValue(req, 'host') || `127.0.0.1:${cfg.port}`}`;
  }

  async function callTool(name, args, agent, req) {
    const a = args || {};
    switch (name) {
      case 'hub_info': {
        const projects = await store.list('', { max: 200, includeHidden: false }).catch(() => ({ entries: [] }));
        return {
          ok: true,
          name: cfg.name,
          version: APP_VERSION,
          baseUrl: baseUrl(req),
          mcpUrl: `${baseUrl(req)}/mcp`,
          root: store.root,
          uptimeSec: Math.round((Date.now() - started) / 1000),
          agent: agent.id,
          guard: {
            cooldownMs: cfg.cooldownMs,
            cooldownSec: Math.round(cfg.cooldownMs / 1000),
            rule: 'файл, змінений іншим агентом менш ніж cooldown тому: перший запис відхиляється з новим вмістом, повторний проходить',
            challengeTtlMs: cfg.challengeTtlMs,
            guardSameAgent: cfg.guardSameAgent
          },
          disk: await store.diskInfo(),
          projects: projects.entries
            .filter((e) => e.type === 'dir')
            .map((e) => ({ path: e.path, mtime: e.mtime })),
          limits: {
            inlinePreviewBytes: cfg.inlinePreviewBytes,
            maxInlineWriteBytes: cfg.maxInlineWriteBytes,
            recommendedChunkBytes: cfg.uploads.chunkHint
          },
          activeUploads: uploads.list({ agentId: agent.id }).length
        };
      }

      case 'fs_list': {
        return store.list(a.path ?? '', {
          pattern: a.pattern || null,
          recursive: a.recursive === true,
          depth: a.depth,
          max: a.max,
          includeHidden: a.hidden === true
        });
      }

      case 'fs_tree': {
        const depth = Math.max(1, Math.min(Number(a.depth) || 3, 10));
        const res = await store.list(a.path ?? '', {
          recursive: true,
          depth,
          max: Math.max(1, Math.min(Number(a.max) || 500, 5000))
        });
        return { ...res, depth };
      }

      case 'fs_stat':
        return store.stat(a.path, { withVersion: true });

      case 'fs_mkdir':
        return store.mkdir(a.path, { recursive: a.parents !== false, agentId: agent.id, ip: agent.ip });

      case 'fs_read':
        return store.readText(a.path, {
          offset: a.offset,
          maxBytes: a.maxBytes,
          encoding: a.encoding || 'auto'
        });

      case 'fs_write':
        return store.write(a.path, a.content ?? '', {
          agentId: agent.id,
          encoding: a.encoding === 'base64' ? 'base64' : 'utf8',
          mode: a.mode || 'overwrite',
          expectedVersion: a.expectedVersion || null,
          createParents: a.parents !== false,
          op: 'write',
          ip: agent.ip
        });

      case 'fs_append':
        return store.append(a.path, a.content ?? '', {
          agentId: agent.id,
          encoding: a.encoding === 'base64' ? 'base64' : 'utf8',
          expectedVersion: a.expectedVersion || null,
          op: 'append',
          ip: agent.ip
        });

      case 'fs_move':
        return store.move(a.from, a.to, { agentId: agent.id, overwrite: a.overwrite === true, ip: agent.ip });

      case 'fs_copy':
        return store.copy(a.from, a.to, { agentId: agent.id, overwrite: a.overwrite === true, ip: agent.ip });

      case 'fs_delete':
        return store.remove(a.path, {
          agentId: agent.id,
          recursive: a.recursive === true,
          permanent: a.permanent === true,
          ip: agent.ip
        });

      case 'fs_trash_list':
        return store.listTrash({ limit: a.limit });

      case 'fs_restore':
        return store.restore(a.trashId, {
          to: a.to || null,
          overwrite: a.overwrite === true,
          agentId: agent.id,
          ip: agent.ip
        });

      case 'fs_empty_trash':
        return store.emptyTrash({
          olderThanDays: a.olderThanDays,
          all: a.all === true,
          agentId: agent.id,
          ip: agent.ip
        });

      case 'fs_search':
        return store.search(a.path ?? '', {
          name: a.name || null,
          content: a.content || null,
          max: a.max,
          maxDepth: a.depth
        });

      case 'fs_usage':
        return store.usage(a.path ?? '');

      case 'fs_transfer': {
        const url = `${baseUrl(req)}/v1/file?path=${encodeURIComponent(a.path)}`;
        const authHeader = cfg.auth.enabled ? '-H "Authorization: Bearer $LANSTORE_TOKEN" ' : '';
        const dir = a.direction || 'both';
        const out = {
          ok: true,
          path: a.path,
          baseUrl: baseUrl(req),
          authRequired: cfg.auth.enabled,
          tokenHeader: cfg.auth.enabled ? 'Authorization: Bearer <your token>' : null
        };
        if (dir === 'download' || dir === 'both') {
          out.download = {
            url,
            rangedUrl: `${url}&range=bytes=0-1048575`,
            curl: `curl -L ${authHeader}-o "${a.path.split('/').pop()}" "${url}"`,
            powershell: `Invoke-WebRequest -Uri "${url}" -OutFile "$env:TEMP\\${a.path.split('/').pop()}"${cfg.auth.enabled ? ' -Headers @{Authorization="Bearer $env:LANSTORE_TOKEN"}' : ''}`,
            note: 'Підтримується Range (bytes=start-end) і докачка.'
          };
        }
        if (dir === 'upload' || dir === 'both') {
          out.upload = {
            steps: [
              `POST ${baseUrl(req)}/v1/uploads  {"path":"${a.path}","totalBytes":${a.totalBytes ?? '<size>'}}`,
              `PUT ${baseUrl(req)}/v1/uploads/<uploadId>?offset=0  (raw bytes, chunk ${humanBytes(cfg.uploads.chunkHint)})`,
              'repeat PUT with offset=<nextOffset> until readyToCommit',
              `POST ${baseUrl(req)}/v1/uploads/<uploadId>/commit`
            ],
            chunkBytes: cfg.uploads.chunkHint,
            note: 'Якщо commit повертає RECENTLY_MODIFIED — прочитайте новий вміст (fs_read) і повторіть commit: частини вже на диску.'
          };
        }
        return out;
      }

      case 'fs_activity': {
        const events = await audit.tail(a.limit || 30, {
          path: a.path || undefined,
          agent: a.agent || undefined,
          onlyWrites: a.writesOnly === true
        });
        return { ok: true, count: events.length, events };
      }

      default:
        throw new HubError('unknown_tool', `unknown tool: ${name}`, 404);
    }
  }

  async function handleMessage(msg, agent, req) {
    if (!msg || typeof msg !== 'object') throw new HubError('bad_json', 'invalid JSON-RPC message', 400);
    const { id, method, params } = msg;
    if (!method) return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'invalid request' } };

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'lanstore', title: 'LAN shared storage', version: APP_VERSION },
          instructions:
            'Shared file storage for agents across the LAN. Root paths are relative ("askue/data/x.csv"). ' +
            'Read with fs_read, write with fs_write. If a write returns ok:false + RECENTLY_MODIFIED, the file was ' +
            'changed by another agent within the cooldown window: the fresh content is in the response, so review it ' +
            'and repeat the same write — the retry is accepted. Use fs_transfer for files above ~30 MB.'
        }
      };
    }

    if (method.startsWith('notifications/')) return null;

    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }

    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const result = await callTool(name, args, agent, req);
        const isConflict = result && result.ok === false;
        const text = isConflict
          ? `⚠️ ${result.message}\n\n${JSON.stringify(result, null, 2)}`
          : JSON.stringify(result, null, 2);
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text }], isError: false }
        };
      } catch (err) {
        const known = err instanceof HubError;
        const payload = {
          ok: false,
          code: known ? err.code : 'internal_error',
          message: err.message || 'tool call failed',
          ...(known ? err.extra : {})
        };
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `❌ ${payload.code}: ${payload.message}` }],
            isError: true
          }
        };
      }
    }

    if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
    if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
    if (method === 'logging/setLevel') return { jsonrpc: '2.0', id, result: {} };

    return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  }

  async function handle(req, res, url, agent) {
    if (req.method === 'GET' && (req.headers.accept || '').includes('text/event-stream')) {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end('This server uses streamable HTTP: POST JSON-RPC to /mcp');
      return;
    }
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.setHeader('Allow', 'POST');
      res.end();
      return;
    }

    const body = await readJson(req, cfg.maxJsonBodyBytes);
    const batch = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const msg of batch) {
      const out = await handleMessage(msg, agent, req);
      if (out) responses.push(out);
    }

    res.setHeader('Mcp-Session-Id', `mcp_${started.toString(36)}`);
    if (!responses.length) {
      res.statusCode = 202;
      res.end();
      return;
    }
    const payload = Array.isArray(body) ? responses : responses[0];
    sendJson(res, 200, payload, { 'Content-Type': 'application/json; charset=utf-8' });
  }

  return { handle, tools: TOOLS };
}
