---
name: create-card-class
description: Build, create, or implement a card, widget, visualization, chart, dashboard, calculator, game, 3D scene, or any interactive UI component on the Mica canvas. Use when asked to build, create, make, or implement anything visual or interactive.
---

# Create a Card Class

A card class is a directory under `.mica/card-classes/{name}/` containing up to four files:

| File | Required | Purpose |
|------|----------|---------|
| `card.html` | Yes | HTML template (normal HTML) |
| `card.js` | Yes | Behavior (normal JS — const/let, template literals, all OK) |
| `card.css` | No | Styles (normal CSS) |
| `metadata.json` | Yes | Extension, badge, title, dependencies |
| `context.md` | No | Class-level AI context |

The directory name must match the file extension it handles (e.g., `counter/` handles `.counter` files).

## metadata.json

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "dependencies": {
    "scripts": ["https://cdn.example.com/lib.min.js"],
    "styles": ["https://cdn.example.com/lib.min.css"]
  }
}
```

`dependencies` is optional. Omit it (or use empty arrays) when no CDN libraries are needed.

## card.html

Normal HTML. This is the card's template — it defines the structure rendered inside the card container.

```html
<div id="display">0</div>
<button id="inc">+</button>
```

## card.js

Normal JavaScript. Use `const`, `let`, template literals, arrow functions — all standard JS works.

### CARD_SHIM Globals

| Global | Description |
|--------|-------------|
| `container` | This card's DOM element. querySelector is scoped to it. |
| `mica.getContent()` | Returns a Promise with the instance file content as a string. Use `await`. |
| `mica.filename` | The file this card renders (e.g., `"tasks.todo"`) |
| `mica.windowId` | Unique browser window ID (for source tracking in writes) |
| `mica.on(event, cb)` | Subscribe to events. Returns an unsub function. |
| `mica.onDestroy(cb)` | Register cleanup for card unmount. |
| `mica.openChannel(fn, args)` | Open a bidirectional stream (terminal, chat). |
| `document` | Proxied — querySelector is scoped to this card's container. |
| `setInterval` / `setTimeout` | Auto-cleaned on card destroy. |

### Server API Reference

These are the ONLY server endpoints available to card scripts. Do NOT invent endpoints.

#### List all files: `GET /api/files`

Returns a flat JSON array of file **metadata** (no content). No query parameters.

```javascript
const res = await fetch('/api/files');
const files = await res.json();
// files = [
//   { "name": "README.md", "size": 1234, "modifiedAt": "2026-01-01T..." },
//   { "name": "docs/spec.md", "size": 5678, "modifiedAt": "..." },
//   { "name": "photo.png", "size": 102400, "modifiedAt": "..." }
// ]
```

- `name` is the **relative path** from project root (e.g., `"docs/spec.md"`)
- Files in subdirectories are included (recursive)
- Dotfiles, `.mica/`, `node_modules/`, `.git/` are excluded
- **No content** in the response — use `GET /api/files/{filename}` to read content
- There is NO directory listing endpoint. Build directory trees client-side from the flat paths.

#### Read a file: `GET /api/files/{filename}`

Returns the **raw file** with the correct `Content-Type` header. Works for both text and binary files.

```javascript
// Text files — use .text()
const res = await fetch('/api/files/' + encodeURIComponent('docs/spec.md'));
const text = await res.text();

// Binary files — use .arrayBuffer() or use the URL directly
const pdfUrl = '/api/files/' + encodeURIComponent('report.pdf');
// For PDFs: pass URL to PDF.js
// For images: use as <img src="...">
```

**IMPORTANT:** This endpoint returns raw bytes, NOT JSON. Use `.text()` for text, `.arrayBuffer()` for binary. Do NOT use `.json()`.

#### Read file content in card.js: `mica.getContent()`

The preferred way to read the card's own file content. Returns a Promise.

```javascript
const content = await mica.getContent();
```

#### Write a file: `PUT /api/files/{filename}`

ALWAYS include `source: mica.windowId` to prevent self-echo sync loops.

```javascript
fetch('/api/files/' + encodeURIComponent(mica.filename), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: newContent, source: mica.windowId })
});
```

Parent directories are created automatically (e.g., writing `docs/spec.md` creates `docs/`).

#### Delete a file: `DELETE /api/files/{filename}`

```javascript
fetch('/api/files/' + encodeURIComponent('old-file.txt'), { method: 'DELETE' });
```

#### Card classes: `GET /api/card-classes`

```javascript
const res = await fetch('/api/card-classes');
const classes = await res.json();
// classes = { "md": { "builtIn": true, "format": "html" }, "todo": { ... } }
```

### WebSocket Events

Events received via `mica.on(event, callback)`:

| Event | Payload | When |
|-------|---------|------|
| `file-created` | `{ filename }` | New file appears in project |
| `file-changed` | `{ filename, source }` | Existing file modified |
| `file-deleted` | `{ filename }` | File removed |
| `layout-changed` | `{ source, device }` | Canvas layout changed |

Always check `source !== mica.windowId` to skip self-originated changes.

### Non-blocking UI

Never block the UI during async operations (file uploads, network requests, batch processing).
Update the DOM progressively — show each item's status as it completes, not all at once after
everything finishes. Use fire-and-forget patterns for saves, show spinners/progress for long ops.

```javascript
// WRONG — blocks UI until all files are uploaded
async function uploadFiles(files) {
  for (const file of files) {
    await uploadOne(file);  // UI frozen until all done
  }
  renderList();  // user sees nothing until here
}

// CORRECT — update UI after each file
async function uploadFiles(files) {
  for (const file of files) {
    renderProgress(file.name, 'uploading...');
    await uploadOne(file);
    renderProgress(file.name, 'done');
  }
}
```

### Optimistic UI Pattern

Update the DOM immediately, save in the background with debounce:

```javascript
let saveTimer = null;

function save(content) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/files/' + encodeURIComponent(mica.filename), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, source: mica.windowId })
    }).catch(err => console.error('save failed:', err));
  }, 300);
}

// Sync — only refresh when someone else changes the file
const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

mica.onDestroy(() => {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
});
```

## card.css

Normal CSS. Styles are scoped to the card. Optional — omit if not needed.

**IMPORTANT: Mica uses a dark theme.** Use dark backgrounds and light text:

```css
/* CORRECT — dark theme */
#display {
  font-size: 48px;
  font-weight: bold;
  color: #4a8aff;
  text-align: center;
  background: transparent;
}

button {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: #ccc;
  cursor: pointer;
}

button:hover {
  background: rgba(255, 255, 255, 0.1);
}

input, textarea {
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: #ccc;
}
```

**DO NOT** use light theme colors (#fff backgrounds, #333 text, #f0f0f0). The canvas background is `#0a0a0f`.

## Critical Rules

1. **Use IDs to reference DOM elements.** The CARD_SHIM scopes `document.querySelector`
   to the card container. Positional selectors like `:nth-child`, `:first-child` will
   NOT work reliably because the shim wraps the DOM.
   Correct: `container.querySelector("#my-grid")`
   WRONG: `container.querySelector(":nth-child(2)")`

2. **Use `mica.getContent()` for file data.** Don't pass data through HTML data attributes.
   Read the instance file content directly.

3. **Include `source: mica.windowId` in all file writes.** This prevents sync loops where
   the card refreshes from its own save.

4. **Prefer established CDN libraries over hand-coding.** Use well-known libraries for
   complex functionality. Examples: Chart.js for charts, FullCalendar for calendars,
   Sortable.js for drag-and-drop, CodeMirror for code editing, Leaflet for maps,
   Marked for markdown rendering, Mermaid for diagrams. Add them via `metadata.json`
   dependencies. Don't reinvent what a library does well.

5. **Before using any CDN library**, verify the API for that specific version.
   Do not assume API signatures from memory.

6. **Only use the documented API endpoints.** Do NOT invent query parameters, endpoints,
   or response formats. The server API is fixed — see "Server API Reference" above.

7. **Dark theme only.** Use transparent/dark backgrounds, light text (#ccc/#ddd/#eee),
   subtle borders (rgba(255,255,255,0.06-0.1)). Never use light/white backgrounds.

## Common Mistakes

**DON'T** put instance files in `.mica/` — they must be in the project root or docs dir:
```
WRONG:  .mica/cards/board.kanban
WRONG:  .mica/card-classes/kanban/board.kanban
RIGHT:  board.kanban  (project root)
RIGHT:  docs/board.kanban  (docs directory)
```

**DON'T** invent API endpoints or query parameters:
```javascript
// WRONG — this endpoint does not exist
fetch('/api/files?path=/docs&type=directory')
fetch('/api/directory/list')
fetch('/api/tree')

// CORRECT — use the documented endpoints
fetch('/api/files')                                    // list all files
fetch('/api/files/' + encodeURIComponent('docs/spec.md'))  // read one file
```

**DON'T** assume file read returns JSON:
```javascript
// WRONG — GET /api/files/:filename returns raw bytes, not JSON
const res = await fetch('/api/files/' + encodeURIComponent('spec.md'));
const data = await res.json();   // BREAKS — it's not JSON!
const content = data.content;     // undefined!

// CORRECT — use .text() for text files
const text = await res.text();

// CORRECT — use .arrayBuffer() for binary files
const bytes = await res.arrayBuffer();
```

**DON'T** assume file list includes content:
```javascript
// WRONG — /api/files returns metadata only
const files = await (await fetch('/api/files')).json();
files[0].content  // undefined! Only has name, size, modifiedAt

// CORRECT — list gives metadata, then fetch content per file
const text = await (await fetch('/api/files/' + encodeURIComponent(files[0].name))).text();
```

**DON'T** use positional CSS selectors in scripts:
```javascript
// WRONG — breaks when CARD_SHIM wraps the DOM
container.querySelector(":nth-child(2)");

// CORRECT — always use IDs
container.querySelector("#cal-grid");
```

**DON'T** use light theme colors:
```css
/* WRONG */
background: #f0f0f0;
color: #333;
border: 1px solid #ccc;

/* CORRECT */
background: rgba(255, 255, 255, 0.03);
color: #ccc;
border: 1px solid rgba(255, 255, 255, 0.06);
```

**DON'T** forget IDs on elements you'll update dynamically:
```html
<!-- card.html — ALWAYS add an ID to elements the script will modify -->
<div id="content-area"></div>
```

**DO** use CDN libraries via `metadata.json` dependencies — not inline script tags.

**DO** use `mica.getContent()` to read the instance file — not data attributes or inline injection.

**DO** build directory trees client-side from the flat file list when you need hierarchy.

## Steps to Create a Card Class

1. Choose a name and extension (e.g., `kanban` -> `.kanban`)
2. Create the directory `.mica/card-classes/{name}/`
3. Write `card.html`, `card.js`, `metadata.json` (and optionally `card.css`)
4. Create an instance file **in the project directory** with initial content
   - Example: write `board.kanban` (NOT in `.mica/`)
   - Use: `fetch('/api/files/board.kanban', { method: 'PUT', body: JSON.stringify({ content: '...' }) })`
   - IMPORTANT: The file MUST be in the project root or docs dir, not in `.mica/cards/` or `.mica/card-classes/`
5. The card appears on the canvas automatically (file watcher detects it)

---

## Complete Example: Counter Card

### `.mica/card-classes/counter/metadata.json`

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter"
}
```

### `.mica/card-classes/counter/card.html`

```html
<div id="counter-display">
  <div id="count" style="font-size:48px;font-weight:bold;color:#4a8aff;text-align:center">0</div>
  <div style="margin-top:12px;display:flex;gap:8px;justify-content:center">
    <button id="dec" style="padding:8px 16px;font-size:18px;cursor:pointer">-</button>
    <button id="inc" style="padding:8px 16px;font-size:18px;cursor:pointer">+</button>
  </div>
</div>
```

### `.mica/card-classes/counter/card.js`

```javascript
const countEl = container.querySelector("#count");
let count = parseInt(await mica.getContent()) || 0;
countEl.textContent = count;

let saveTimer = null;

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch('/api/files/' + encodeURIComponent(mica.filename), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: String(count), source: mica.windowId })
    }).catch(err => console.error('save failed:', err));
  }, 300);
}

container.querySelector("#inc").addEventListener("click", (e) => {
  e.stopPropagation();
  count++;
  countEl.textContent = count;
  save();
});

container.querySelector("#dec").addEventListener("click", (e) => {
  e.stopPropagation();
  count--;
  countEl.textContent = count;
  save();
});

const unsub = mica.on("file-changed", (e) => {
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

mica.onDestroy(() => {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
});
```

---

## Complete Example: Chart Card (with CDN dependency)

### `.mica/card-classes/chart/metadata.json`

```json
{
  "extension": ".chart",
  "badge": "CHART",
  "defaultTitle": "Chart",
  "dependencies": {
    "scripts": ["https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"]
  }
}
```

### `.mica/card-classes/chart/card.html`

```html
<div id="chart-wrapper" style="padding:8px;height:100%;display:flex;flex-direction:column">
  <div style="flex:1;min-height:0">
    <canvas id="chart-canvas"></canvas>
  </div>
</div>
```

### `.mica/card-classes/chart/card.js`

```javascript
const content = await mica.getContent();
let data = {};
try { data = JSON.parse(content); } catch(e) {}

const labels = data.labels || ["Jan", "Feb", "Mar", "Apr"];
const values = data.values || [10, 20, 15, 25];

const chart = new Chart(container.querySelector("#chart-canvas"), {
  type: "bar",
  data: {
    labels,
    datasets: [{
      label: "Value",
      data: values,
      backgroundColor: "rgba(74, 138, 255, 0.6)"
    }]
  },
  options: {
    responsive: true,
    maintainAspectRatio: false
  }
});

const unsub = mica.on("file-changed", (e) => {
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

mica.onDestroy(() => {
  unsub();
  chart.destroy();
});
```

### `.mica/card-classes/chart/card.css`

```css
#chart-wrapper {
  background: transparent;
}
```

### Instance file (project root): `sales.chart`

```json
{"labels": ["Q1", "Q2", "Q3", "Q4"], "values": [120, 340, 250, 410]}
```
