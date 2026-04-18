---
name: create-card-class
description: Build, create, make, or implement a card, widget, visualization, chart, dashboard, calculator, viewer, browser, editor, game, or any interactive UI that appears on the Mica canvas. Use whenever the user asks for something visual or interactive, even if they don't say "card".
---

# Create a Card Class

A **card class** defines a UI component. An **instance** is a file the class renders.

## Where files go

- **Card class**: `.mica/card-classes/{name}/` — project-scoped. Built-in classes live in the Mica repo's `card-classes/` and are NOT the place to add new ones. The name becomes the file extension (`kanban/` handles `.kanban` files).
- **Instance**: a plain file in the canvas root (usually `docs/`), e.g. `docs/my-board.kanban`. NEVER in `.mica/`.

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

`primaryFile` is optional — only for classes that render a specific filename inside a directory instance.

## CARD_SHIM globals in `card.js`

Available without import:

| Global | Shape |
|---|---|
| `container` | this card's DOM element. `container.querySelector(...)` is scoped here |
| `mica.filename` | the instance file path (e.g. `"docs/my.counter"`) |
| `mica.windowId` | stable id for this browser (mostly used by the helpers below) |
| `mica.getContent()` | `async () => string` — read the instance file content |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` — list project files AND directories. `isFile` and `isFolder` are opposites; use whichever reads natural. |
| `mica.files.read(path)` | `async (path) => string` — read a text file |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` — read a binary file |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — pass a string for text files, an ArrayBuffer/Blob for binary. Helper auto-routes; `source` auto-injected, parents auto-created, binary streams to disk with no size limit. |
| `mica.files.delete(path)` | `async (path) => void` |
| `mica.files.url(path)` | `(path) => string` — URL for `<img src>` / `<embed>` / download links |
| `mica.cardClasses.list()` | `async () => [{ name, builtIn, format }]` |
| `mica.on(event, cb)` | subscribe; returns unsub fn. Events: `file-changed`, `file-created`, `file-deleted`, `layout-changed` |
| `mica.onDestroy(cb)` | cleanup on unmount |
| `mica.openChannel(fn, args)` | bidirectional stream to a server plugin |
| `mica.refresh()` | reload the card (e.g. after external file change) |

**Prefer `mica.files.*` over raw `fetch('/api/files/...')`.** The helpers handle URL encoding, the `source` field for writes, and field-name normalization — you can't hallucinate endpoint paths or response shapes if you use them.

## WebSocket events via `mica.on(event, cb)`

| Event | Payload shape |
|---|---|
| `file-changed` | `{ type: "file-changed", filename: string, source: string }` |
| `file-created` | `{ type: "file-created", filename: string }` |
| `file-deleted` | `{ type: "file-deleted", filename: string }` |
| `layout-changed` | `{ type: "layout-changed", source: string, device: string }` |

`source` is either a writer's `mica.windowId` (writes that went through `mica.files.write()`) or the literal string `"external"` (e.g. the agent wrote the file directly). To skip self-echoes: `source !== mica.windowId`.

## Raw HTTP endpoints (fallback only)

You should almost never need these — `mica.files.*` and `mica.cardClasses.list()` cover the common cases. Documented here in case you need something they don't expose.

- `GET /api/files` — `[{ name, type: "file"|"directory", size, modifiedAt }]` (field is `name`, NOT `path`)
- `GET /api/files/{encodedPath}` — raw bytes; use `.text()` or `.arrayBuffer()`, NEVER `.json()`
- `PUT /api/files/{encodedPath}` — body `{ content, source: mica.windowId }`
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
3. **Writes: always include `source: mica.windowId`** to avoid the file-changed event bouncing back.
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
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

mica.onDestroy(() => { unsub(); });
```

No class. No registration. No `this`. No `export`. Top-level async is fine (`await` works at the top). Use `mica.files.write()` — you don't need to remember URL encoding, `source: mica.windowId`, or the `application/json` header.

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

Then `edit` the files in place to replace the `REPLACE_ME` placeholders and add your card's behavior. Do NOT use `write_file` to author `card.js` from an empty page — that's where class-wrappers, `export` keywords, and invented base classes leak in. The skeleton already has the correct shape; stay inside its structure.

After the copy:
1. `edit metadata.json`: set `extension`, `badge`, `defaultTitle`
2. `edit card.html`: replace the placeholder `<div id="body">` with your markup
3. `edit card.js`: remove the placeholder line and add behavior. Uncomment the `mica.files.*` / `mica.on(...)` patterns you need.
4. `edit card.css` if you need custom styling beyond the default.

Verify by creating an instance file (e.g. `docs/my.<extension>`) and hard-refreshing the browser.

## Decompose before coding

Multi-file build. Use the `decompose-task` skill. Typical ladder AFTER the skeleton copy:

1. `edit metadata.json` — set extension + badge + defaultTitle
2. `edit card.html` — minimal layout with IDs for dynamic elements
3. `edit card.js` — one wired event (e.g. button click → DOM update)
4. read/write via `mica.getContent()` + `mica.files.*`
5. events via `mica.on('file-changed', ...)` if the card needs to react
6. CSS + polish

Ship step 1, verify, then step 2. Do not one-shot a 200-line `card.js`. Run `bash scripts/restart.sh` after server changes; hard-refresh after frontend-only changes.
