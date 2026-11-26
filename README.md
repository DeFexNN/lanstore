# lanstore — спільне сховище для агентів у локальній мережі

Один хост тримає теку з проєктами (наприклад `askue/` на 40 ГБ). Агенти з інших ПК у локальній
мережі створюють теки, читають і пишуть файли через HTTP/MCP. Записів не «хто останній, той і правий»:
якщо файл змінили менш ніж хвилину тому, перший запис відхиляється і повертає **новий вміст**, а
повторний запис того самого агента проходить.

Без залежностей, без npm install, без бази даних. Потрібен лише Node.js 20+.

```
ПК-1 (хаб)                     ПК-2..N (агенти)
┌──────────────────────┐       ┌──────────────────────┐
│ lanstore :8787       │◄──────│ MCP  (opencode/claude)│
│  data/askue/...      │  HTTP │ REST (curl/скрипти)   │
│  .lanstore/          │       │ CLI  (node cli.mjs)   │
│   trash, uploads,    │       └──────────────────────┘
│   audit.jsonl        │
└──────────────────────┘
```

---

## Одна команда

Linux / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/DeFexNN/lanstore/main/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/DeFexNN/lanstore/main/install.ps1 | iex
```

Команда робить усе сама:

- ставить `lanstore` і `lanstore-bridge` у PATH-каталог (`~/.local/bin`, на Windows `%LOCALAPPDATA%\lanstore\bin`);
- знаходить установлені harness-и й реєструє міст як MCP-сервер: **opencode**, **Codex CLI**,
  **Claude Code**, **DeepSeek Harness**;
- повторний запуск оновлює конфіги, а не плодить дублі.

Опції передаються після `bash -s --`:

```bash
curl -fsSL .../install.sh | bash -s -- --agent linux-pc --token "$LANSTORE_TOKEN"
curl -fsSL .../install.sh | bash -s -- --clients opencode,codex,claude,dsh
curl -fsSL .../install.sh | bash -s -- --dry-run
```

На Windows: задайте `$env:LANSTORE_AGENT` / `$env:LANSTORE_TOKEN` перед `irm ... | iex`.
Потрібен Node.js 20+; якщо його немає, скрипт скаже точну команду встановлення й нічого не зламає.

Після встановлення:

```bash
lanstore doctor      # хаб знайдено? який hubId, скільки місця
lanstore ls          # файли у спільному сховищі
```

---

## 1. Швидкий старт на хабі

Сховище вже налаштоване на `G:\SBU\SHARE` (файл `config.json` у цій теці). Усі проєкти агентів
створюються всередині нього: `G:\SBU\SHARE\askue\...`. Диск `G:` має існувати на хабі; тека
створюється автоматично.

```powershell
cd <ця тека>
node src\server.mjs
```

Або подвійним кліком `start-hub.cmd`. У консолі буде:

```
lanstore 1.0.0 — LAN shared storage for agents
root:      G:\SBU\SHARE
listening: http://0.0.0.0:8787
LAN:       http://192.168.1.103:8787   (Ethernet)
MCP:       http://<host>:8787/mcp
discovery: udp 8788 — IP-less clients find the hub automatically (lanstore-bridge)
write guard: cooldown 60s — first write returns new content, retry passes
auth:      disabled (LAN open)
```

Щоб змінити корінь: `node src\server.mjs --root "H:\other-share"` або поле `root` у `config.json`.

Відкрити порти в брандмауері (один раз, від адміністратора): TCP 8787 для HTTP/MCP і UDP 8788
для автопошуку хаба.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\open-firewall.ps1 -Port 8787
```

HTTP-порт обов'язковий. UDP-порт потрібен лише для автопошуку з Linux-агентів; без нього міст
усе одно знайде хаб скануванням підмережі (повільніше), або можна задати `LANSTORE_URL`.

Перевірка з іншого ПК:

```powershell
curl http://192.168.1.103:8787/v1/health
```

Дашборд: `http://192.168.1.103:8787/` — теки, вільне місце, останні операції, готовий конфіг MCP.

---

## 2. Черга запису (головна вимога)

Правило: **файл, змінений менш ніж `cooldownMs` тому (типово 60 с), не перезаписується з першого
разу**. Замість запису агент отримує новий вміст файлу і вказівку перечитати його. Другий запис
того самого агента проходить.

Послідовність:

1. `agent-pc2` читає `askue/raw/points.csv` і готує правку.
2. `agent-pc3` встигає записати файл.
3. `agent-pc2` викликає запис → **409** `RECENTLY_MODIFIED`:
   ```json
   {
     "ok": false,
     "code": "RECENTLY_MODIFIED",
     "action": "READ_NEW_CONTENT_AND_RETRY",
     "message": "Файл \"askue/raw/points.csv\" був відредагований 4 с тому (12.3 MB). Ознайомтеся з новим вмістом нижче — повторний запис із тим самим вмістом буде прийнятий.",
     "version": "sha256:...",
     "content": "<актуальний вміст>",
     "truncated": false,
     "retry": { "sameContent": true, "expectedVersion": "sha256:..." }
   }
   ```
4. `agent-pc2` бачить новий вміст, вносить свою правку.
5. Повторний запис → **200**, `"guard": "second_attempt"`, `"note": "Запис прийнято після ознайомлення з новим вмістом."`

Деталі, які важливі на практиці:

| Ситуація | Поведінка |
|---|---|
| Файл змінився < 60 с тому, пише **інший** агент, перша спроба | блок + повний/частковий новий вміст |
| Той самий агент повторює запис | проходить один раз (challenge одноразовий) |
| Файл змінився ще раз між спробами | знову блок із найсвіжішим вмістом |
| Агент пише файл, який сам щойно створив | проходить одразу (`guard: own_write`) |
| Файл старіший за 60 с | проходить одразу (`guard: stale`) |
| Агент передав `expectedVersion`, а файл уже інший | блок `VERSION_MISMATCH` + новий вміст |
| Зовнішній редактор/скрипт змінив файл | теж вважається «свіжою правкою» — блок спрацює |
| 40 ГБ файл | у конфлікті повертається перші 128 КБ + шлях для докачки, не весь файл |

Налаштування:

- `cooldownMs` — вікно захисту (типово `60000`).
- `challengeTtlMs` — скільки живе дозвіл на повторний запис (типово 10 хв).
- `guardSameAgent` — `true` змушує навіть автора перечитувати власний свіжий файл (`--guard-same-agent`).
- `inlinePreviewBytes` — скільки байтів вмісту віддавати в конфлікті (типово 128 КБ).

Стан черги тримається в пам'яті процесу: після перезапуску хаба «свіжість» визначається за mtime
файлів, а вже видані дозволи на повторний запис скидаються (агент отримає блок ще раз — це безпечно).

Рекомендований протокол для агента:

```
fs_stat / fs_read  → version
... підготувати вміст ...
fs_write(expectedVersion = version)
   ↳ якщо ok:false → прочитати content із відповіді → fs_write ще раз
```

`expectedVersion` не обов'язковий: сама черга вже не дасть перезаписати свіжий файл «наосліп».

---

## 3. Підключення агентів з інших ПК

### 3.1 Linux/macOS: MCP-міст з автопошуком хаба (рекомендовано)

На ПК агента (потрібен лише Node 20+):

```bash
curl -fsSL https://raw.githubusercontent.com/DeFexNN/lanstore/main/install.sh | bash
lanstore doctor                 # перевірка: хаб знайдено, hubId, вільне місце
lanstore mcp                    # готовий JSON-конфіг MCP для цього ПК
```

`lanstore-bridge` — локальний stdio MCP-сервер. Агент бачить звичайні інструменти `fs_*`, а міст
сам знаходить хаб у мережі. IP хаба не потрібен і може змінюватися хоч щодня.

Що саме реєструє інсталятор (лише для знайдених harness-ів):

| Harness | Куди пише | Команда під капотом |
|---|---|---|
| opencode | глобальний `opencode.json` | `opencode mcp add --global lanstore --env ... -- node bridge.mjs` |
| Codex CLI | `~/.codex/config.toml` | `codex mcp add lanstore --env ... -- node bridge.mjs` |
| Claude Code | `~/.claude.json` (user scope) | `claude mcp add -s user lanstore -e ... -- node bridge.mjs` |
| DeepSeek Harness | `$DSH_HOME/cordis.patch.yml` | керований YAML-блок `mcp-lanstore` |

`--clients all` ставить усі чотири навіть якщо бінарника немає в PATH (для dsh створить
`$DSH_HOME`). `--dry-run` показує план без запису. `--force` переписує наявні записи.

Якщо harness не використовує `~/.local/bin` або встановлений у нестандартне місце — конфіг
можна взяти з `lanstore mcp` і вставити вручну.

Ручні варіанти для окремих клієнтів:

Claude Code:

```bash
claude mcp add lanstore -- ~/.local/bin/lanstore-bridge
```

opencode (`opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "lanstore": {
        "type": "local",
        "command": ["/home/user/.local/bin/lanstore-bridge"],
        "environment": { "LANSTORE_AGENT": "linux-agent" }
      }
    }
  }
}
```

DeepSeek Harness (`$DSH_HOME/cordis.patch.yml`, типово `~/.dsh`):

```yaml
- id: mcp-lanstore
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: lanstore
    transport: stdio
    command: "/home/user/.local/bin/lanstore-bridge"
    env:
      LANSTORE_AGENT: "linux-agent"
```

Якщо `install.sh` копіювався через Windows-архів і ламається на `\r`, виконайте
`sed -i 's/\r$//' install.sh` перед запуском.

Як міст шукає хаб (по порядку):

1. `LANSTORE_URL` — явна адреса, якщо задана.
2. Кеш `~/.config/lanstore/hub.json` — остання робоча адреса, перевіряється через `/v1/health`.
3. UDP-маяк: широкомовний запит на `255.255.255.255:8788` і broadcast кожної локальної мережі;
   хаб відповідає своєю адресою (replied address — той інтерфейс, який реально бачить клієнт).
4. Скан локальної `/24` на порту 8787 (`LANSTORE_SCAN=off` вимикає).

Якщо під час роботи виклик упав через зміну IP, міст сам перешукує хаб і повторює виклик один раз.
Вручну: `hub_rediscover` (можна з `url`, щоб закріпити адресу) та `hub_status`.

Додаткові змінні: `LANSTORE_HUB_ID` (закріпити конкретний хаб), `LANSTORE_CACHE`,
`LANSTORE_SCAN_CIDR=192.168.1.0/24`, `LANSTORE_DEBUG=1`.

### 3.2 MCP напряму за відомим IP (без моста)

Якщо IP хаба стабільний, можна підключитися до нього напряму. Endpoint: `http://<IP-хаба>:8787/mcp`
(JSON-RPC 2.0, streamable HTTP, POST).

`opencode.json` на ПК агента:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "lanstore": {
        "type": "remote",
        "url": "http://192.168.1.103:8787/mcp",
        "headers": { "Authorization": "Bearer ТОКЕН_ЦЬОГО_АГЕНТА" }
      }
    }
  }
}
```

Claude Code:

```powershell
claude mcp add --transport http lanstore http://192.168.1.103:8787/mcp --header "Authorization: Bearer ТОКЕН"
```

Якщо авторизація вимкнена, заголовок не потрібен, але варто передати ім'я агента, щоб черга
розрізняла учасників:

```json
"headers": { "X-Agent-Id": "agent-pc2" }
```

### 3.3 REST

```powershell
$H = "http://192.168.1.103:8787"
$T = @{ Authorization = "Bearer ТОКЕН" }

curl -s $H/v1/health
curl -s -X POST $H/v1/mkdir  -H "Content-Type: application/json" -d '{\"path\":\"askue/raw\"}'
curl -s -X POST $H/v1/write  -H "Content-Type: application/json" -d '{\"path\":\"askue/raw/notes.md\",\"content\":\"# ASKUE\"}'
curl -s "$H/v1/list?path=askue/raw"
curl -sL -o points.csv "$H/v1/file?path=askue/raw/points.csv"
```

Читання/запис конкретного діапазону байтів — через `Range`:

```powershell
curl -H "Range: bytes=0-1048575" -o chunk0 "$H/v1/file?path=askue/big.bin"
```

### 3.4 CLI (для скриптів і ручних перевірок)

CLI теж знаходить хаб сам; `LANSTORE_URL` потрібен лише для примусової адреси.

```powershell
$env:LANSTORE_TOKEN = "ТОКЕН"          # якщо auth увімкнено

lanstore doctor
lanstore --agent agent-pc2 ls askue
lanstore --agent agent-pc2 write askue/raw/notes.md --file notes.md
lanstore --agent agent-pc2 cat askue/raw/points.csv --max 65536
lanstore --agent agent-pc2 upload .\dump.csv askue/raw/dump.csv
lanstore download askue/raw/dump.csv .\dump.csv
lanstore --agent agent-pc2 trash
lanstore --agent agent-pc2 restore <trashId> --overwrite
lanstore --agent agent-pc2 activity
```

Конфлікт CLI показує текстом і завершується кодом `2`, тож скрипт може перечитати файл і повторити.

---

## 4. Великі файли (десятки ГБ)

Прямий `POST /v1/write` приймає до 32 МБ (JSON). Для великих об'ємів — **resumable upload session**:

```powershell
# 1. Почати сесію (тут же спрацьовує перевірка черги — без витрати трафіку)
curl -s -X POST $H/v1/uploads -H "Content-Type: application/json" `
     -d '{\"path\":\"askue/raw/export.csv\",\"totalBytes\":42949672960}'
# → { "uploadId": "up_ab12...", "nextOffset": 0 }

# 2. Слати частини поспіль, байти як тіло запиту
curl -s -X PUT  "$H/v1/uploads/up_ab12...?offset=0"          --data-binary "@chunk-0000.bin"
curl -s -X PUT  "$H/v1/uploads/up_ab12...?offset=67108864"   --data-binary "@chunk-0001.bin"
#    nextOffset у відповіді підказує, звідки продовжити після обриву

# 3. Фіксація — тут остаточно спрацьовує черга запису
curl -s -X POST "$H/v1/uploads/up_ab12.../commit"
```

Якщо `commit` повернув `RECENTLY_MODIFIED`, частини вже лежать на диску хаба: прочитайте новий вміст
і повторіть `commit` — заново 40 ГБ передавати не треба.

`node src\cli.mjs upload` робить те саме автоматично, розмір частини бере з `uploads.chunkHint`
(типово 8 МБ; для 40 ГБ поставте 64 МБ у `config.json`).

Докачка при скачуванні: `curl -C - -o export.csv "$H/v1/file?path=askue/raw/export.csv"`.

---

## 5. REST API

| Метод | Шлях | Призначення |
|---|---|---|
| GET | `/v1/health` | стан, вільне місце, політика черги |
| GET | `/v1/whoami` | хто я для хаба (агент/IP) |
| GET | `/v1/info` | корінь, ліміти, активні завантаження |
| GET | `/v1/list?path=&pattern=&recursive=&depth=&max=&hidden=` | список теки |
| GET | `/v1/stat?path=` | розмір, mtime, `version` |
| POST | `/v1/mkdir` `{path, recursive}` | створити теку |
| POST | `/v1/write` `{path, content, encoding?, mode?, expectedVersion?, parents?}` | записати текст/base64 (≤32 МБ) |
| POST | `/v1/append` `{path, content, ...}` | дописати |
| GET/HEAD | `/v1/file?path=` | віддати файл, `Range`, `ETag`, `304` |
| PUT | `/v1/file?path=&mode=&expectedVersion=&parents=` | завантажити тіло як файл (стрім) |
| POST | `/v1/move` `{from, to, overwrite}` | перемістити/перейменувати |
| POST | `/v1/copy` `{from, to, overwrite}` | копіювати (теки — рекурсивно) |
| POST/DELETE | `/v1/delete` `{path, recursive, permanent}` | у кошик або остаточно |
| GET | `/v1/trash?limit=` | що лежить у кошику (trashId, шлях, тип, розмір, час) |
| POST | `/v1/restore` `{trashId, to?, overwrite?}` | відновити з кошика |
| POST | `/v1/trash` `{olderThanDays?\|all?}` | очистити кошик (за віком або повністю) |
| GET | `/v1/read?path=&offset=&maxBytes=` | текстовий фрагмент + `version`, `nextOffset` |
| GET | `/v1/search?path=&name=&content=&max=` | пошук за іменем/вмістом |
| GET | `/v1/usage?path=` | розмір теки |
| GET | `/v1/activity?limit=&path=&agent=&writes=1` | журнал операцій |
| POST | `/v1/precheck` `{path, expectedVersion?}` | «чи пройде запис зараз?» без запису |
| POST | `/v1/uploads` `{path, totalBytes, mode?, expectedVersion?}` | почати велике завантаження |
| PUT | `/v1/uploads/{id}?offset=N` | частина (байти в тілі) |
| POST | `/v1/uploads/{id}/commit` | зафіксувати |
| DELETE | `/v1/uploads/{id}` | скасувати |
| GET | `/v1/uploads` | мої активні сесії |
| POST | `/mcp` | MCP JSON-RPC |

Коди: `200` — успіх, `400/403/404/409/413/416/500` — помилка. Конфлікт черги — **409** з
`ok: false` і новим вмістом.

---

## 6. MCP-інструменти

| Інструмент | Що робить |
|---|---|
| `hub_info` | адреса, корінь, вільне місце, політика черги, список проєктів |
| `fs_list` | список теки (`pattern`, `recursive`, `depth`, `max`, `hidden`) |
| `fs_tree` | компактне дерево |
| `fs_stat` | розмір, mtime, `version` |
| `fs_mkdir` | створити теку (ідемпотентно) |
| `fs_read` | текст/base64, `offset`, `maxBytes`, `version`, `nextOffset` |
| `fs_write` | створити/перезаписати; при конфлікті повертає новий вміст |
| `fs_append` | дописати |
| `fs_move` / `fs_copy` / `fs_delete` | переміщення, копіювання, кошик |
| `fs_search` | пошук за іменем і/або вмістом |
| `fs_usage` | розмір теки |
| `fs_transfer` | готові команди curl/PowerShell для великих файлів |
| `fs_activity` | хто що писав останнім часом |
| `fs_trash_list` | кошик: що видалено, коли і ким |
| `fs_restore` | відновити елемент за `trashId` (overwrite-safe: стара версія теж іде в кошик) |
| `fs_empty_trash` | очистити кошик за віком або повністю |

Міст для Linux/macOS (`lanstore-bridge`) додає локальні інструменти:

| Інструмент | Що робить |
|---|---|
| `hub_status` | до якого хаба підключено, як адресу знайдено, стан черги |
| `hub_rediscover` | примусово перешукати хаб (опційно закріпити `url`) |
| `fs_upload_local` | залити файл із локального диска на хаб через resumable-сесію, без base64 |
| `fs_commit_upload` | зафіксувати сесію після конфлікту, не передаючи файл заново |
| `fs_download_local` | скачати файл із хаба на локальний диск потоком (`overwrite`, `resume`) |

Інструкція в `initialize` прямо пояснює моделі контракт `RECENTLY_MODIFIED → перечитати → повторити`,
тому агент не сприймає 409 як фатальну помилку.

---

## 7. Конфігурація

Пріоритет: `config.json` → змінні середовища → аргументи командного рядка.

`config.json` (приклад у `config.example.json`):

```json
{
  "host": "0.0.0.0",
  "port": 8787,
  "root": "./data",
  "publicUrl": "http://192.168.1.103:8787",
  "cooldownMs": 60000,
  "challengeTtlMs": 600000,
  "guardSameAgent": false,
  "inlinePreviewBytes": 131072,
  "maxInlineWriteBytes": 33554432,
  "trash": { "enabled": true, "retentionDays": 30 },
  "uploads": { "chunkHint": 8388608 },
  "minFreeBytes": 536870912,
  "audit": { "enabled": true, "maxBytes": 33554432, "backups": 3 },
  "discovery": { "enabled": true, "port": 8788 },
  "auth": {
    "enabled": true,
    "tokens": {
      "agent-pc2": "СЮДИ_ДОВГИЙ_ВИПАДКОВИЙ_ТОКЕН",
      "agent-pc3": "ІНШИЙ_ТОКЕН"
    }
  }
}
```

Токен згенерувати:

```powershell
node -e "console.log(require('node:crypto').randomBytes(24).toString('base64url'))"
```

Аргументи:

```
--root <path>        тека сховища        --port 8787
--host 0.0.0.0       --cooldown 60 (сек)  --guard-same-agent
--token <token> --agent <name>            --no-auth
--config <file>      --url <public base> --audit off
--no-discovery       --discovery-port 8788
```

Змінні: `LANSTORE_ROOT`, `LANSTORE_PORT`, `LANSTORE_HOST`, `LANSTORE_PUBLIC_URL`,
`LANSTORE_TOKEN`, `LANSTORE_AGENT`, `LANSTORE_COOLDOWN_MS`, `LANSTORE_DISCOVERY`,
`LANSTORE_DISCOVERY_PORT`.

---

## 8. Безпека

- У режимі за замовчуванням авторизації немає — хаб відкритий для всієї локальної мережі. Для
  спільної роботи в довіреній мережі це нормально, але токени краще увімкнути.
- З токенами кожен агент отримує власну ідентичність: черга розрізняє «хто писав», журнал фіксує
  агента, а один агент не може підмінити іншого.
- Без токенів ідентичність береться з `X-Agent-Id` (заголовок із клієнта, не секрет).
- Усі шляхи нормалізуються: `..`, абсолютні шляхи, `C:\...`, symlink-вихід за межі кореня та
  службова тека `.lanstore` заблоковані.
- Службова тека `.lanstore` (кошик, сесії завантажень, тимчасові файли) недоступна через API.
- Для доступу з-поза локальної мережі — не відкривайте порт у публічний інтернет напряму;
  використовуйте VPN (Tailscale/Radmin/WireGuard) або reverse-proxy з TLS.

---

## 9. Обслуговування

- **Журнал**: `logs/audit.jsonl` (JSONL: час, агент, операція, шлях, код, розмір, версія, IP).
  Авторотація: після `audit.maxBytes` (32 МБ) файл стає `.1`, тримається `audit.backups` копій.
  Читається через `GET /v1/activity`.
- **Кошик**: `/v1/trash` показує видалене, `/v1/restore` повертає назад. У CLI:
  `lanstore trash` та `lanstore restore <trashId> [--to path] [--overwrite]`. Фізично —
  `<root>/.lanstore/trash/<id>/` з `meta.json` (хто/коли/що). Автоочищення —
  `trash.retentionDays` (30 днів), вручну — `POST /v1/trash {"all":true}`.
- **Місце на диску**: якщо вільно менше `minFreeBytes` (512 МБ) + розмір запису, хаб
  відповідає `507 insufficient_storage` і нічого не пише.
- **Сесії завантажень**: `<root>/.lanstore/uploads/<id>/`, незавершені старші за 7 днів
  видаляються при старті.
- **Резервні копії**: робіть бекап каталогу `data/` (`.lanstore` можна виключити, крім випадків,
  коли потрібен кошик).
- **Автозапуск**: Task Scheduler → «При старті системи» → `node.exe src\server.mjs` з робочою
  текою проєкту; або `nssm install lanstore node src\server.mjs`.

---

## 10. Тести

```powershell
node --test
```

56 тестів: юніти черги (блок/повтор/чужий агент/власний запис/застаріла версія); інтеграційні —
MCP handshake і tools, конфліктний цикл, Range/HEAD/304, resumable upload (стрімінг частин),
захист шляхів, токени, дашборд, кошик/відновлення, ліміт вільного місця; автопошук (UDP-маяк, кеш,
кілька кандидатів), stdio-міст (upload/download локальних файлів), ротація журналу та інсталятор.

---

## 11. Структура

```
lanstore/
  src/server.mjs     HTTP-сервер, маршрутизація, банери, помилки
  src/store.mjs      файлові операції, версії, конфлікти, кошик, пошук
  src/guard.mjs      черга запису: cooldown, challenges, блокування по шляху
  src/uploads.mjs    resumable-сесії для великих файлів
  src/mcp.mjs        MCP JSON-RPC + опис інструментів
  src/api.mjs        REST-обробники
  src/cli.mjs        клієнт командного рядка (з автопошуком)
  src/bridge.mjs     stdio MCP-міст для Linux/macOS (автопошук хаба)
  src/installer.mjs  інсталятор: wrappers + реєстрація MCP у 4 harness-ах
  src/discover.mjs   клієнтський автопошук: кеш → UDP → скан /24
  src/beacon.mjs     UDP-маяк хаба (порт 8788)
  src/dashboard.mjs  веб-огляд
  src/auth.mjs       токени → агенти
  src/audit.mjs      журнал JSONL
  src/util.mjs       шляхи, версії, glob, формат
  test/              node:test
  install.sh         одна команда для Linux/macOS (bootstrap + installer)
  install.ps1        одна команда для Windows
  config.example.json
  data/              сховище за замовчуванням, якщо root не заданий
  logs/              журнал
```

## 12. Відомі обмеження

- Блокування черги — у пам'яті одного процесу. Запускайте **один** екземпляр на корінь сховища.
- `fs_write` через MCP приймає до 32 МБ; більше — `fs_transfer`/upload-сесії.
- Для файлів > 8 МБ версія = `stamp:<size>-<mtime>`, а не хеш вмісту (щоб не перечитувати 40 ГБ
  на кожен `stat`). Для виявлення змін цього достатньо; точний хеш дрібних файлів — `sha256:`.
- HTTP без TLS: у межах довіреної локальної мережі/VPN.
- Автопошук спирається на широкомовні UDP-пакети. Якщо на Wi-Fi увімкнено client isolation або
  хаб в іншій підмережі, маяк не дійде: спрацює скан `/24` (та сама підмережа) або задайте
  `LANSTORE_URL`. Через VPN (Radmin/Tailscale/WireGuard) broadcast зазвичай не проходить — там
  адресу краще вказати явно.
- Міст кешує адресу в `~/.config/lanstore/hub.json`; якщо хаб переїхав, кеш автоматично
  перевіряється і оновлюється, а `hub_rediscover` форсує пошук.
