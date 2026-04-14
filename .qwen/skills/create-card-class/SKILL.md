---
name: create-card-class
description: Build, create, or implement a card, widget, visualization, chart, dashboard, calculator, game, 3D scene, or any interactive UI component on the Mica canvas. Use when asked to build, create, make, or implement anything visual or interactive.
---

# Create a Card Class

A card class is a directory with a `render.js` file that produces interactive HTML.
Create it at `.mica/card-classes/{name}/render.js`. The directory name must match the
file extension it handles (e.g., `counter/` handles `.counter` files).

## render.js Contract

```javascript
export const metadata = {
  extension: ".mycard",    // file extension this class handles
  badge: "MY",             // short badge in card header
  defaultTitle: "My Card"
};

export const dependencies = {};  // optional CDN scripts/styles

export default function render(content, config) {
  // content = file content as string
  // Return HTML string with <style> and <script>
  return '<div>...</div>' +
    '<style>...</style>' +
    '<script>...</script>';
}
```

## Critical Rules

1. **Use string concatenation, NOT template literals** in `<script>` blocks.
   The render function's return value is inside a template literal, so inline
   scripts cannot use backticks or `${...}`. Use `'string' + var` throughout.

2. **For HTML attributes in script strings, use escaped double quotes `\\"`.**
   Do NOT use `\\'` (escaped single quotes) — this causes transform errors.
   Example: `'html += "<div style=\\"color:red\\">"'`

3. **No non-ASCII characters in `<script>` blocks.** Use ASCII only.
   Box-drawing chars, em-dashes, Unicode symbols cause parse errors.

3. **Double-escape `\n` in strings inside scripts.** Write `\\n` so the
   template literal produces `\n`.

4. **Use `var`, not `const`/`let`** in script blocks.

5. **Before using any CDN library**, verify the API for that specific version.
   Do not assume API signatures from memory.

## Available Globals in `<script>` Blocks

| Global | Description |
|--------|-------------|
| `container` | This card's DOM element. querySelector is scoped to it. |
| `mica.filename` | The file this card renders (e.g., "tasks.todo") |
| `mica.windowId` | Unique browser window ID (for source tracking) |
| `mica.on(event, cb)` | Subscribe to events. Returns unsub function. |
| `mica.onDestroy(cb)` | Register cleanup for card unmount. |
| `mica.refresh()` | Re-render this card from server. |
| `document` | Proxied -- querySelector scoped to this card. |
| `setInterval/setTimeout` | Auto-cleaned on card destroy. |

## File Operations

```javascript
// Read a file
fetch('/api/files/' + encodeURIComponent('data.json'))
  .then(function(r) { return r.json(); })
  .then(function(data) { /* data.content */ });

// Write a file (include source for sync)
fetch('/api/files/' + encodeURIComponent('data.json'), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: newContent, source: mica.windowId })
});
```

## Optimistic UI Pattern

Update the DOM immediately, save in the background with debounce:

```javascript
var saveTimer = null;
function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    fetch('/api/files/' + encodeURIComponent(mica.filename), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: buildContent(), source: mica.windowId })
    }).catch(function(err) { console.error('save failed:', err); });
  }, 300);
}
mica.onDestroy(function() { if (saveTimer) clearTimeout(saveTimer); });

// External sync -- only refresh when someone else changes the file
var unsub = mica.on('file-changed', function(e) {
  if (e.filename === mica.filename && e.source !== mica.windowId) mica.refresh();
});
mica.onDestroy(function() { unsub(); });
```

## Steps to Create a Card Class

1. Choose a name and extension (e.g., `kanban` -> `.kanban`)
2. Create `.mica/card-classes/{name}/render.js`
3. Write metadata, dependencies, and render function
4. Create an instance file **in the project root directory** with initial content
   - Example: write `/project/board.kanban` (NOT in .mica/)
   - Use: `fetch('/api/files/board.kanban', { method: 'PUT', body: JSON.stringify({ content: '...' }) })`
   - IMPORTANT: The file MUST be in the project root, not in .mica/cards/ or .mica/card-classes/
5. The card appears on the canvas automatically (file watcher detects it)

## Complete Example: Counter Card

```javascript
// .mica/card-classes/counter/render.js
export const metadata = { extension: ".counter", badge: "CTR", defaultTitle: "Counter" };
export const dependencies = {};

export default function render(content, config) {
  var count = parseInt(content) || 0;

  return '<div style="text-align:center;padding:20px">' +
    '<div id="count" style="font-size:48px;font-weight:bold;color:#4a8aff">' + count + '</div>' +
    '<div style="margin-top:12px;display:flex;gap:8px;justify-content:center">' +
      '<button id="dec" style="padding:8px 16px;font-size:18px;cursor:pointer">-</button>' +
      '<button id="inc" style="padding:8px 16px;font-size:18px;cursor:pointer">+</button>' +
    '</div>' +
  '</div>' +
  '<script>' +
  '(function() {' +
    'var count = parseInt(container.querySelector("#count").textContent) || 0;' +
    'var countEl = container.querySelector("#count");' +
    'var saveTimer = null;' +
    'function save() {' +
      'if (saveTimer) clearTimeout(saveTimer);' +
      'saveTimer = setTimeout(function() {' +
        'fetch("/api/files/" + encodeURIComponent(mica.filename), {' +
          'method: "PUT",' +
          'headers: { "Content-Type": "application/json" },' +
          'body: JSON.stringify({ content: String(count), source: mica.windowId })' +
        '}).catch(function(err) { console.error("save failed:", err); });' +
      '}, 300);' +
    '}' +
    'container.querySelector("#inc").addEventListener("click", function(e) {' +
      'e.stopPropagation(); count++; countEl.textContent = count; save();' +
    '});' +
    'container.querySelector("#dec").addEventListener("click", function(e) {' +
      'e.stopPropagation(); count--; countEl.textContent = count; save();' +
    '});' +
    'var unsub = mica.on("file-changed", function(e) {' +
      'if (e.filename === mica.filename && e.source !== mica.windowId) mica.refresh();' +
    '});' +
    'mica.onDestroy(function() { unsub(); if (saveTimer) clearTimeout(saveTimer); });' +
  '})();' +
  '</script>';
}
```

## Complete Example: Chart Card (with CDN library)

```javascript
// .mica/card-classes/chart/render.js
export const metadata = { extension: ".chart", badge: "CHART", defaultTitle: "Chart" };
export const dependencies = {
  scripts: ["https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"]
};

export default function render(content, config) {
  var data = {};
  try { data = JSON.parse(content); } catch(e) {}
  var dataJson = JSON.stringify(data)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  return '<div style="padding:8px;height:100%;display:flex;flex-direction:column">' +
    '<div style="flex:1;min-height:0"><canvas id="chart"></canvas></div>' +
    '<div id="data" style="display:none" data-json="' + dataJson + '"></div>' +
  '</div>' +
  '<script>' +
  '(function() {' +
    'var raw = container.querySelector("#data").dataset.json' +
      '.replace(/&amp;/g,"&").replace(/&lt;/g,"<")' +
      '.replace(/&gt;/g,">").replace(/&quot;/g,String.fromCharCode(34));' +
    'var data = {};' +
    'try { data = JSON.parse(raw); } catch(e) {}' +
    'var labels = data.labels || ["Jan","Feb","Mar","Apr"];' +
    'var values = data.values || [10,20,15,25];' +
    'var chart = new Chart(container.querySelector("#chart"), {' +
      'type: "bar",' +
      'data: { labels: labels, datasets: [{ label: "Value", data: values, backgroundColor: "rgba(74,138,255,0.6)" }] },' +
      'options: { responsive: true, maintainAspectRatio: false }' +
    '});' +
    'var unsub = mica.on("file-changed", function(e) {' +
      'if (e.filename === mica.filename && e.source !== mica.windowId) mica.refresh();' +
    '});' +
    'mica.onDestroy(function() { unsub(); chart.destroy(); });' +
  '})();' +
  '</script>';
}
```
