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
| `mica.getContent()` | Returns the instance file content as a string. |
| `mica.filename` | The file this card renders (e.g., `"tasks.todo"`) |
| `mica.windowId` | Unique browser window ID (for source tracking in writes) |
| `mica.on(event, cb)` | Subscribe to events. Returns an unsub function. |
| `mica.onDestroy(cb)` | Register cleanup for card unmount. |
| `mica.openChannel(fn, args)` | Open a bidirectional stream (terminal, chat). |
| `document` | Proxied — querySelector is scoped to this card's container. |
| `setInterval` / `setTimeout` | Auto-cleaned on card destroy. |

### File Operations

```javascript
// Read a file
const res = await fetch('/api/files/' + encodeURIComponent('data.json'));
const data = await res.json();
// data.content has the file text

// Write a file — ALWAYS include source: mica.windowId
fetch('/api/files/' + encodeURIComponent(mica.filename), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: newContent, source: mica.windowId })
});
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

```css
#display {
  font-size: 48px;
  font-weight: bold;
  color: #4a8aff;
  text-align: center;
}
```

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

4. **Before using any CDN library**, verify the API for that specific version.
   Do not assume API signatures from memory.

## Common Mistakes

**DON'T** put instance files in `.mica/` — they must be in the project root:
```
WRONG:  .mica/cards/board.kanban
WRONG:  .mica/card-classes/kanban/board.kanban
RIGHT:  board.kanban  (project root)
```

**DON'T** use positional CSS selectors in scripts:
```javascript
// WRONG — breaks when CARD_SHIM wraps the DOM
container.querySelector(":nth-child(2)");

// CORRECT — always use IDs
container.querySelector("#cal-grid");
```

**DON'T** forget IDs on elements you'll update dynamically:
```html
<!-- card.html — ALWAYS add an ID to elements the script will modify -->
<div id="content-area"></div>
```

**DO** use CDN libraries via `metadata.json` dependencies — not inline script tags.

**DO** use `mica.getContent()` to read the instance file — not data attributes or inline injection.

## Steps to Create a Card Class

1. Choose a name and extension (e.g., `kanban` -> `.kanban`)
2. Create the directory `.mica/card-classes/{name}/`
3. Write `card.html`, `card.js`, `metadata.json` (and optionally `card.css`)
4. Create an instance file **in the project root directory** with initial content
   - Example: write `board.kanban` (NOT in `.mica/`)
   - Use: `fetch('/api/files/board.kanban', { method: 'PUT', body: JSON.stringify({ content: '...' }) })`
   - IMPORTANT: The file MUST be in the project root, not in `.mica/cards/` or `.mica/card-classes/`
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
let count = parseInt(mica.getContent()) || 0;
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
const content = mica.getContent();
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
