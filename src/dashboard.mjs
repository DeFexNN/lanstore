import { APP_VERSION, humanBytes } from './util.mjs';
import { headerValue } from './http.mjs';

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function renderDashboard({ store, cfg, audit, uploads, req, agent }) {
  const baseUrl = cfg.publicUrl || `http://${headerValue(req, 'host') || `127.0.0.1:${cfg.port}`}`;
  const [root, disk, activity] = await Promise.all([
    store.list('', { max: 300 }).catch(() => ({ entries: [] })),
    store.diskInfo(),
    audit.tail(25, { onlyWrites: true }).catch(() => [])
  ]);

  const projects = root.entries.filter((e) => e.type === 'dir');
  const files = root.entries.filter((e) => e.type === 'file').slice(0, 40);
  const activeUploads = uploads.list({ agentId: agent?.id }).length;
  const cooldown = Math.round(cfg.cooldownMs / 1000);

  const projectRows = projects
    .map(
      (p) => `<tr><td><code>${esc(p.path)}/</code></td><td>${esc(p.mtime.slice(0, 19).replace('T', ' '))}</td>
      <td><a href="/v1/list?path=${encodeURIComponent(p.path)}">json</a></td></tr>`
    )
    .join('');

  const fileRows = files
    .map(
      (f) => `<tr><td><a href="/v1/file?path=${encodeURIComponent(f.path)}">${esc(f.name)}</a></td>
      <td>${humanBytes(f.size)}</td><td>${esc(f.mtime.slice(0, 19).replace('T', ' '))}</td></tr>`
    )
    .join('');

  const activityRows = activity
    .slice()
    .reverse()
    .map((ev) => {
      const ok = ev.ok === false ? `<span class="bad">${esc(ev.code)}</span>` : '<span class="ok">ok</span>';
      return `<tr><td>${esc((ev.ts || '').slice(11, 19))}</td><td>${esc(ev.agent)}</td><td>${esc(ev.op)}</td>
        <td><code>${esc(ev.path)}</code></td><td>${ok}</td></tr>`;
    })
    .join('');

  const tokenSnippet = cfg.auth.enabled
    ? `,\n        "headers": { "Authorization": "Bearer <ТОКЕН_ЦЬОГО_АГЕНТА>" }`
    : '';

  const html = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.name)} — LAN storage</title>
<style>
:root{color-scheme:dark}
body{margin:0;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e8ee}
main{max-width:1080px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:#8b93a7;margin:34px 0 10px}
.sub{color:#8b93a7;margin:0 0 22px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}
.card{background:#171a21;border:1px solid #242936;border-radius:10px;padding:12px 14px}
.card b{display:block;font-size:20px;margin-top:2px}
.muted{color:#8b93a7;font-size:13px}
table{width:100%;border-collapse:collapse;background:#171a21;border:1px solid #242936;border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid #222735;font-size:14px;vertical-align:top}
th{background:#1c202a;color:#8b93a7;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
tr:last-child td{border-bottom:0}
code{font-family:ui-monospace,Consolas,monospace;font-size:13px;color:#c9d4ff}
pre{background:#171a21;border:1px solid #242936;border-radius:10px;padding:14px;overflow:auto;font-size:13px}
a{color:#7db3ff;text-decoration:none}a:hover{text-decoration:underline}
.ok{color:#63d29a}.bad{color:#ff8a8a}
.note{background:#1a1f16;border:1px solid #2c3a22;border-radius:10px;padding:12px 14px;color:#cfe3bd;font-size:14px}
</style></head><body><main>
<h1>${esc(cfg.name)} <span class="muted">v${esc(APP_VERSION)}</span></h1>
<p class="sub">Спільне сховище для агентів у локальній мережі · <code>${esc(store.root)}</code></p>

<div class="grid">
  <div class="card"><span class="muted">Вільно на диску</span><b>${disk ? humanBytes(disk.freeBytes) : '?'}</b></div>
  <div class="card"><span class="muted">Всього на диску</span><b>${disk ? humanBytes(disk.totalBytes) : '?'}</b></div>
  <div class="card"><span class="muted">Захисне вікно запису</span><b>${cooldown} с</b></div>
  <div class="card"><span class="muted">Активні завантаження</span><b>${activeUploads}</b></div>
  <div class="card"><span class="muted">Авторизація</span><b>${cfg.auth.enabled ? 'увімкнена' : 'вимкнена'}</b></div>
</div>

<div class="note" style="margin-top:18px">Черга запису: якщо файл редагував інший агент менш ніж ${cooldown} с тому,
перший запис відхиляється і повертає новий вміст. Агент читає його і повторює запис — другий проходить.
Необхідне читання перед записом, без гонок «останній перезаписав усіх».</div>

<h2>Проєкти</h2>
${projects.length ? `<table><tr><th>Тека</th><th>Змінено</th><th></th></tr>${projectRows}</table>` : '<p class="muted">Порожньо. Створіть теку через <code>POST /v1/mkdir</code> або інструмент <code>fs_mkdir</code>.</p>'}

${files.length ? `<h2>Файли в корені</h2><table><tr><th>Файл</th><th>Розмір</th><th>Змінено</th></tr>${fileRows}</table>` : ''}

<h2>Останні операції</h2>
${activity.length ? `<table><tr><th>Час</th><th>Агент</th><th>Операція</th><th>Шлях</th><th></th></tr>${activityRows}</table>` : '<p class="muted">Ще немає подій.</p>'}

<h2>Підключення агента (MCP)</h2>
<pre>{
  "mcp": {
    "servers": {
      "lanstore": {
        "type": "remote",
        "url": "${esc(baseUrl)}/mcp"${esc(tokenSnippet)}
      }
    }
  }
}</pre>
<p class="muted">Claude Code: <code>claude mcp add --transport http lanstore ${esc(baseUrl)}/mcp</code>.
Інші ПК мають бачити цей хост у мережі; порт ${esc(cfg.port)} має бути відкритий у брандмауері.</p>
<p class="muted">Linux/macOS: ставте <code>lanstore-bridge</code> (<code>bash install.sh</code>) — міст сам
знаходить хаб через UDP ${esc(cfg.discovery?.port ?? 8788)} або скан підмережі, IP міняти не потрібно.</p>

<h2>REST швидкий старт</h2>
<pre>curl ${esc(baseUrl)}/v1/health
curl -X POST ${esc(baseUrl)}/v1/mkdir -H "Content-Type: application/json" -d '{"path":"askue/raw"}'
curl -X POST ${esc(baseUrl)}/v1/write -H "Content-Type: application/json" -d '{"path":"askue/raw/readme.md","content":"hello"}'
curl -L -o dump.csv "${esc(baseUrl)}/v1/file?path=askue/raw/dump.csv"</pre>
</main></body></html>`;

  return html;
}
