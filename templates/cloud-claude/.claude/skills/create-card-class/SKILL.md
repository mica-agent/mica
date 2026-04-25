---
name: create-card-class
description: Build, create, make, or implement a card, widget, visualization, chart, dashboard, calculator, viewer, browser, editor, game, or any interactive UI that appears on the Mica canvas. Use whenever the user asks for something visual or interactive, even if they don't say "card".
---

# Create a Card Class

A **card class** defines a UI component. An **instance** is a file the class renders.

## STEP 0 — Check what already handles this (do this FIRST)

Before writing a new card class, introspect the registry. The server is the source of truth for what's installed — never guess, never cache, never hardcode.

```javascript
// In card.js (or from the chat agent via a shell call to the API):
const classes = await mica.cardClasses.list();
// → [{ name: "mmd", builtIn: true, format: "html" }, { name: "md", ... }, ...]
```

Or raw:

```
GET /api/card-classes
→ { mmd: { builtIn: true, format: "html" }, md: {...}, ... }
```

If any listed class matches your intent, **use it** — do NOT create another class, and especially do NOT create a project-scoped copy of a built-in (that just shadows the built-in for this project with no benefit).

If a listed class *might* fit but you're not sure, read its metadata or spec before deciding:

```
GET /api/card-classes/{name}/metadata.json   # declared extension, badge, defaultTitle
GET /api/card-classes/{name}/spec.md         # prose description, if the class ships one
```

Only proceed past this step when you have confirmed that no existing class handles the intent.

## Extension conventions — use community-standard short forms

Extensions follow external conventions, not invention. Always use the canonical short form — the registered class will match it.

- Mermaid diagrams → `.mmd` (NOT `.mermaid`)
- Markdown → `.md` (NOT `.markdown`)
- TypeScript → `.ts`, YAML → `.yml`/`.yaml`, etc.

Your new class's extension should also follow this pattern: short, lowercase, matches the community name for the format.

## Where files go

- **Card class**: `.mica/card-classes/{name}/` — project-scoped. Built-in classes live in the Mica repo's `card-classes/` and are NOT the place to add new ones.
- **Instance**: a plain file in the canvas root (usually `docs/`), e.g. `docs/my-board.kanban`. NEVER in `.mica/`.

## ⚠️ NAMING RULE — directory name MUST equal the extension (no dot)

The Mica resolver maps an instance file's extension directly to a directory name. If your extension is `.kanban`, the directory MUST be `kanban/`. If your extension is `.solar`, the directory MUST be `solar/`. **NOT** `solar-system/`, **NOT** `solarSystem/`, **NOT** anything else.

`metadata.json`'s `extension` field is documentation — the **directory name is the actual lookup key**. A mismatch silently fails: `.solar` files in `docs/` will fall through to plain text rendering with a "TXT" badge, even though `metadata.json` declares the extension correctly. There is NO error message; the symptom is just "my custom card renders as text."

| Extension | Directory | Instance filename |
|---|---|---|
| `.counter` | `.mica/card-classes/counter/` | `docs/score.counter` |
| `.solar` | `.mica/card-classes/solar/` | `docs/solar-system.solar` |
| `.kanban` | `.mica/card-classes/kanban/` | `docs/sprint-12.kanban` |

If the user asks for "a solar system card," your extension is `.solar` and your directory is `solar/` — the instance filename can be anything (`solar-system.solar`, `our-system.solar`, etc.).

## Required files in `.mica/card-classes/{name}/`

| File | Required | Purpose |
|---|---|---|
| `metadata.json` | yes | extension, badge, title, dependencies |
| `card.html` | yes | static markup — use IDs for anything the script updates |
| `card.js` | yes | behavior — see globals below |
| `card.css` | no | scoped styles |
| `context.md` | no | class-level AI context |

## `metadata.json`

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": { "scripts": [], "styles": [] }
}
```

**Required fields — every `metadata.json` MUST include all of these:**

| Field | Silent failure if omitted |
|---|---|
| `extension` | Framework auto-repairs from the directory name and logs a warning. Always include to avoid the roundtrip. |
| `badge` | Card renders with a `???` placeholder on the canvas — a visible regression, not caught by `JSON.parse` verification. |
| `defaultTitle` | Card title falls back to the raw instance filename; functional but ugly. |
| `dependencies` | No scripts/styles loaded — fine if you need none, silent breakage of your card's libraries otherwise. |

`primaryFile` is optional — only for classes that render a specific filename inside a directory instance.

**Do NOT include `name`, `description`, or `version`.** Those are not Mica fields and get ignored; they're a package.json-shaped leak from LLM priors. The fields above are the only ones the framework reads.

## CARD_SHIM globals in `card.js`

Available without import:

| Global | Shape |
|---|---|
| `container` | this card's DOM element. `container.querySelector(...)` is scoped here |
| `mica.filename` | the instance file path (e.g. `"docs/my.counter"`) |
| `mica.windowId` | stable id for this browser **tab** (per-tab, NOT per-card) |
| `mica.cardId` | stable id for this card **instance** (the per-file UUID) |
| `mica.isSelfEcho(event)` | `(event) => boolean` — true if `event` was caused by THIS card writing. Use this instead of `event.source !== mica.windowId` (windowId is per-tab, so the windowId check also suppresses sibling cards in the same tab). |
| `mica.getContent()` | `async () => string` — read the instance file content |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` — list project files AND directories. `isFile` and `isFolder` are opposites; use whichever reads natural. |
| `mica.files.read(path)` | `async (path) => string` — read a text file |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` — read a binary file |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — pass a string for text files, an ArrayBuffer/Blob for binary. Helper auto-routes; `source` auto-injected, parents auto-created, binary streams to disk with no size limit. |
| `mica.files.delete(path)` | `async (path) => void` |
| `mica.files.url(path)` | `(path) => string` — URL for `<img src>` / `<embed>` / download links |
| `mica.cardClasses.list()` | `async () => [{ name, builtIn, format }]` |
| `mica.fetch(url, opts?)` | `async (url, { method?, headers?, body?, timeout? }) => { status, headers, body, durationMs, error?, errorCode?, truncated? }` — server-proxied HTTP (bypasses CORS). SSRF-protected (blocks private/loopback IPs). Rate-limited 120 req/60s per project. 10MB response cap, 60s max timeout. **Always resolves**; check `errorCode` then `status`. See "External HTTP" section below. |
| `mica.on(event, cb)` | subscribe; returns unsub fn. Events: `file-changed`, `file-created`, `file-deleted`, `layout-changed`, `card-error` |
| `mica.onDestroy(cb)` | cleanup on unmount |
| `mica.openChannel(fn, args)` | bidirectional stream to a server plugin |
| `mica.refresh()` | reload the card (e.g. after external file change) |
| `mica.reportError(message)` | fire-and-forget; surfaces `message` as a red "Send to agent" bubble in chat cards across the project. Use inside a catch block when your card also shows its own toast but you want the agent to know. |

**The above table is exhaustive for `mica.files.*` and `mica.cardClasses.*`.** These namespaces are Proxy-guarded — calling a method that doesn't exist (e.g. `mica.files.append`, `mica.files.exists`, `mica.files.move`) throws `TypeError: mica.files has no method 'X'. Known: list, read, readBinary, write, delete, url.` AND auto-reports to chat. If you need to append to a file, the pattern is **read → concat → write**:

```js
const existing = await mica.files.read('docs/log.md').catch(() => '');
await mica.files.write('docs/log.md', existing + '\n' + newLine);
```

**Prefer `mica.files.*` over raw `fetch('/api/files/...')`.** The helpers handle URL encoding, the `source` field for writes, and field-name normalization — you can't hallucinate endpoint paths or response shapes if you use them.

**If you do use raw `fetch()` for `/api/*`**, the card runtime auto-injects the `X-Mica-Project` header so the server can tell which project's state to read/write. This works for fetches in your top-level card.js code. For belt-and-suspenders reliability (e.g. fetches inside dynamically-generated strings or edge-case code paths), pass `{ headers: { 'X-Mica-Project': mica.project } }` explicitly — the auto-inject skips headers you already set.

## External HTTP via `mica.fetch(url, opts)`

Cards cannot hit most public APIs directly from the browser — CORS blocks them. `mica.fetch` proxies the request through the Mica server, which strips CORS. The server enforces SSRF protection (blocks loopback / private / link-local / cloud-metadata IPs), a per-project rate limit (120 req / 60s rolling window), a 10 MB response cap, and a 60s max timeout.

**The Promise always resolves.** Check `errorCode` first (our-side failures: SSRF, DNS, timeout, rate limit, bad URL), then `status` (upstream HTTP code). Body is always a string — call `JSON.parse()` yourself when needed.

### Usage

```js
// Simple GET
const r = await mica.fetch('https://api.openweathermap.org/data/2.5/weather?q=NYC&appid=' + KEY);
if (r.errorCode) {
  // Our-side failure: r.error is human-readable, r.errorCode is stable
  statusEl.textContent = 'Fetch failed: ' + r.error;
  return;
}
if (r.status >= 400) {
  // Upstream HTTP error
  statusEl.textContent = 'API returned ' + r.status;
  return;
}
const data = JSON.parse(r.body);
// ... use data

// POST with JSON body
const r2 = await mica.fetch('https://api.example.com/v1/items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + KEY },
  body: JSON.stringify({ name: 'foo' }),
  timeout: 15000,  // ms; clamped to [1, 60000]
});
```

### What you get back

```js
{
  status: 200,            // upstream HTTP status; 0 when our-side failure prevented completion
  headers: { ... },       // lowercased upstream response headers; empty when status === 0
  body: '{"..."}',        // response body as a string (JSON.parse yourself); empty when status === 0
  durationMs: 142,        // total time including DNS + connect + read
  truncated: true,        // only present if body hit the 10 MB cap (the fetch succeeded otherwise)
  error: 'human msg',     // only present on our-side failure
  errorCode: 'timeout',   // only present on our-side failure; one of:
                          //   url_invalid | ssrf_blocked | dns_error | connect_error
                          //   timeout | rate_limited | response_error | internal_error
  retryAfterMs: 12340,    // only on errorCode='rate_limited' — wait this long before retrying
}
```

### Rules

1. **Don't retry indefinitely on rate_limited.** Use `retryAfterMs` or show a user message. Fire-looping will keep you throttled.
2. **API keys live in your card code.** The card author/user provides them — Mica doesn't vault them. If you don't want them in card source, read them from a project file (`mica.files.read('docs/secrets.json')`) or from the instance file's content (`mica.getContent()`).
3. **Don't try to reach localhost or private IPs through `mica.fetch`** — SSRF protection will reject them. For calls to Mica's own `/api/*`, use the appropriate `mica.*` helper or raw `fetch('/api/...')` (which auto-scopes to the project).
4. **Binary responses are returned as UTF-8 strings** (may contain replacement chars). For PDFs, images, etc. use `mica.files.url()` + `<img>`/`<embed>` tags or proxy through `mica.files.write()` + `mica.files.readBinary()` — don't go via `mica.fetch` for binaries.

## WebSocket events via `mica.on(event, cb)`

| Event | Payload shape |
|---|---|
| `file-changed` | `{ type: "file-changed", filename: string, source: string, cardSource?: string }` |
| `file-created` | `{ type: "file-created", filename: string, source: string, cardSource?: string }` |
| `file-deleted` | `{ type: "file-deleted", filename: string }` |
| `layout-changed` | `{ type: "layout-changed", source: string, device: string }` |

`source` is the writer's `mica.windowId` (per browser tab), or `"agent"` (the chat agent wrote it), or `"external"` (an outside process — git pull, manual edit). `cardSource` is the writer's `mica.cardId` (per-card-instance UUID), set when the write went through `mica.files.write()`.

To skip self-echoes use `mica.isSelfEcho(e)` — NOT `e.source !== mica.windowId`. windowId is per-tab, so the windowId check also suppresses writes from sibling cards in the same tab. `mica.isSelfEcho()` checks `cardSource` against this card's UUID.

## Raw HTTP endpoints (fallback only)

You should almost never need these — `mica.files.*` and `mica.cardClasses.list()` cover the common cases. Documented here in case you need something they don't expose.

- `GET /api/files` — `[{ name, type: "file"|"directory", size, modifiedAt }]` (field is `name`, NOT `path`)
- `GET /api/files/{encodedPath}` — raw bytes; use `.text()` or `.arrayBuffer()`, NEVER `.json()`
- `PUT /api/files/{encodedPath}` — body `{ content, source: mica.windowId, cardSource: mica.cardId }`
- `DELETE /api/files/{encodedPath}`
- `GET /api/card-classes` — `{ [name]: { builtIn, format } }`

Do NOT invent endpoints or query params (`?path=`, `/api/directory`, `/api/tree`, `/api/filesystem` — none exist).

## Verify API shapes if you suspect drift

If you're using `mica.files.*` and something seems wrong, the helper may be stale relative to the server. Quick check:

```bash
curl -s http://127.0.0.1:3002/api/files | head -5
```

Compare against what the helper returns. Common hallucinated fields that don't exist anywhere: `file.path` (on the raw response), `file.isDirectory` (on the raw response — `type === "directory"` is the real check), `file.mtime` (never exists — use `modifiedAt`).

## Rules

1. **Dark theme only.** Backgrounds transparent or `rgba(255,255,255,0.03-0.06)`. Text `#ccc`/`#ddd`/`#e6edf3`. Borders `rgba(255,255,255,0.06-0.1)`. No `#fff`, no `#f0f0f0`.
2. **Use IDs for dynamic elements** — never `:nth-child`, never positional selectors.
3. **Prefer `mica.files.write()`** — auto-injects both `source` and `cardSource` so self-echoes can be filtered with `mica.isSelfEcho(e)`. Raw `fetch()` writes need both fields by hand.
4. **Prefer CDN libraries** via `metadata.json.dependencies.scripts` over hand-coding: Chart.js, FullCalendar, Sortable.js, CodeMirror, Leaflet, Marked, Mermaid. Don't reinvent.
5. **Never block the UI** during async work — update DOM progressively.
6. **Instance files go in the canvas root** (usually `docs/`), not in `.mica/`.
7. **Verify API shapes with `curl` before writing code that depends on them** (see above).

## ❌ FORBIDDEN — never write `card.js` like this

```js
// WRONG — Mica has NO class-registration model. This class is never instantiated.
class MyCard {
  constructor(context) { this.context = context; }
  async render(container) { ... }
  destroy() { ... }
}
if (typeof Mica !== 'undefined' && Mica.registerCardClass) {
  Mica.registerCardClass('mycard', MyCard);  // Mica.registerCardClass DOES NOT EXIST
}
```

Also forbidden: `this.context.api.listFiles(...)`, `this.context.api.getFile(...)`, `context.template`, `export default class` — these are all invented APIs. If you write any of them, the card will silently not start.

## ✅ CORRECT — `card.js` runs as top-level code

```js
// container and mica are injected globals. Write top-level code only.
const displayEl = container.querySelector('#display');
const btn = container.querySelector('#inc');

let count = parseInt(await mica.getContent()) || 0;
displayEl.textContent = count;

btn.addEventListener('click', async () => {
  count++;
  displayEl.textContent = count;
  await mica.files.write(mica.filename, String(count));
});

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    mica.refresh();
  }
});

mica.onDestroy(() => { unsub(); });
```

No class. No registration. No `this`. No `export`. Top-level async is fine (`await` works at the top). Use `mica.files.write()` — you don't need to remember URL encoding, the `source`/`cardSource` fields, or the `application/json` header.

## Minimal working counter card

Three files under `.mica/card-classes/counter/`:

**`metadata.json`**
```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "dependencies": { "scripts": [], "styles": [] }
}
```

**`card.html`**
```html
<div style="display:flex;flex-direction:column;gap:8px;padding:12px">
  <div id="display" style="font-size:32px;color:#e6edf3;text-align:center">0</div>
  <button id="inc" style="padding:8px;background:rgba(255,255,255,0.06);color:#ccc;border:1px solid rgba(255,255,255,0.1);border-radius:4px;cursor:pointer">+</button>
</div>
```

**`card.js`** — the ✅ example above.

**Instance**: create `docs/my.counter` with content `0`. Card appears on canvas.

## ✳️ STEP 0 — Start by copying the skeleton, do NOT write from scratch

A correct `card.js` / `card.html` / `metadata.json` / `card.css` skeleton lives at `/workspaces/mica/templates/_card-class-skeleton/`. The very first thing you do in any card-class build is:

```bash
cp -r /workspaces/mica/templates/_card-class-skeleton .mica/card-classes/<your-name>
```

Then `edit` the files in place to replace the `REPLACE_ME` placeholders and add your card's behavior. Do NOT use `write_file` to author **any** of the four files from an empty page:

- `card.js` hand-written from scratch leaks class-wrappers, `export` keywords, and invented base classes.
- `metadata.json` hand-written from scratch drops required fields (`badge`, `defaultTitle`) and leaks package.json-shaped fields (`name`, `version`) — see the Required fields table above.
- `card.html` / `card.css` hand-written drift from scoping conventions.

The skeleton already has the correct shape; stay inside its structure.

After the copy:
1. `edit metadata.json`: set `extension`, `badge`, `defaultTitle`
2. `edit card.html`: replace the placeholder `<div id="body">` with your markup
3. `edit card.js`: remove the placeholder line and add behavior. Uncomment the `mica.files.*` / `mica.on(...)` patterns you need.
4. `edit card.css` if you need custom styling beyond the default.
5. **Create an instance file** (e.g. `canvas/my.<extension>`) so the card mounts on the canvas.
6. **Visually verify with `render_capture`.** Call the tool with the instance filename, e.g.:

   ```
   render_capture({ filename: "canvas/my.<extension>" })
   ```

   The result includes a PNG of the rendered card — inspect it directly to confirm: the card mounted, the expected layout appears, labels are legible, nothing is clipped or overflowing, no red error banner. If something looks wrong, iterate on the card-class files and re-capture. JSON validity and `node -c` only prove syntax; only a visual check proves the card actually works.

## Decompose before coding

Multi-file build. Use the `decompose-task` skill. Typical ladder AFTER the skeleton copy:

1. `edit metadata.json` — set extension + badge + defaultTitle
2. `edit card.html` — minimal layout with IDs for dynamic elements
3. `edit card.js` — one wired event (e.g. button click → DOM update)
4. read/write via `mica.getContent()` + `mica.files.*`
5. events via `mica.on('file-changed', ...)` if the card needs to react
6. CSS + polish

Ship step 1, verify, then step 2. Do not one-shot a 200-line `card.js`. Run `bash scripts/restart.sh` after server changes; hard-refresh after frontend-only changes.
