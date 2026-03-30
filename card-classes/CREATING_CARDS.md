# Creating Widget Card Classes

Card classes define how files render as interactive widgets on the Mica whiteboard. Each widget has a JavaScript backend (`render.js`) and produces HTML/JS/CSS that runs in the browser.

## Directory Structure

A card class is a directory containing a `render.js` file. That's it — no package.json, no build step, no registration beyond the manifest.

### Built-in classes

Ship with Mica in `card-classes/`:

```
card-classes/
├── _manifest.json          # Maps class name → extension + metadata
├── CREATING_CARDS.md       # This file
├── markdown/
│   └── render.js           # export default function render(content, config) → HTML
├── todo/
│   └── render.js           # render + 5 async exports (toggle, add_item, etc.)
├── chat/
│   └── render.js           # render + 2 exports (send_message, check_in)
├── agent/
│   ├── render.js           # render + 1 export (select_provider)
│   └── providers.json      # Agent provider registry (auto-injected into isolate)
├── terminal/
│   └── render.js           # render only (PTY handled Node-side)
├── simple-project/
│   └── render.js           # Canvas card — render + 1 export (create_file)
├── canvas/
│   └── render.js           # Base canvas card with data-slot markers
├── goal/
│   └── render.js           # Markdown + progress bar
├── brief/
│   └── render.js           # Markdown render
├── log/
│   └── render.js           # Markdown render
├── mermaid/
│   └── render.js           # Raw mermaid syntax (rendered browser-side)
├── html/
│   └── render.js           # Raw HTML passthrough
└── text/
    └── render.js           # Escaped plain text in <pre>
```

### Project-specific classes

Live in `.mica/.card-classes/` inside the project repo. Shared with the team via git.

```
my-project/
├── src/                          # Project's own files (untouched)
├── .git/
└── .mica/
    ├── .card-classes/
    │   ├── _manifest.json        # Project manifest (merged on top of built-in)
    │   ├── dashboard/
    │   │   └── render.js         # Custom dashboard card class
    │   └── data-table/
    │       └── render.js         # Custom data table card class
    ├── _project.project          # Uses simple-project class
    ├── _todo.todo                # Uses todo class
    ├── overview.dashboard        # Uses project's dashboard class (extension match)
    └── sales.data-table          # Uses project's data-table class
```

### Workspace-scope classes

Local to this machine, shared across your projects. Live in `~/.mica/card-classes/`:

```
~/.mica/
└── card-classes/
    └── pomodoro/
        └── render.js             # Available in all your projects
```

### Resolution order

When Mica needs to render a card class, it checks (most specific first):

```
Project .mica/.card-classes/{name}/  →  Workspace ~/.mica/card-classes/{name}/  →  Built-in card-classes/{name}/
```

A project class overrides a built-in class of the same name. This lets you customize built-in cards per-project without forking.

### Promotion

Promotion is copying a directory:

- Project → Workspace: `cp -r .mica/.card-classes/my-widget ~/.mica/card-classes/my-widget`
- Workspace → Built-in: contribute upstream to Mica

### What goes in the directory

The only required file is `render.js`. Optional sibling files:

| File | Purpose |
|------|---------|
| `render.js` | **Required.** The card class module — render function + exports |
| `providers.json` | Data file auto-injected into the V8 isolate as `globalThis.__providers` |
| `*.json` | Any JSON data file — injected if the isolate pool detects it |

Card classes do NOT have their own `package.json` or `node_modules`. Server-side libraries (like `marked` for markdown) are provided by the isolate pool. Browser-side libraries are loaded via CDN `<script src>` tags in the HTML output.

## Runtime Environment

Card classes run in **V8 isolates** — lightweight, sandboxed JavaScript contexts with zero OS access. This means:

- **No `require()` or `import`** — you cannot import npm packages or Node.js modules
- **No `fs`, `net`, `child_process`, `process`** — no OS-level APIs
- **No `fetch` or `XMLHttpRequest`** — no direct network access (use `mica.fetch()` with `network: true` in manifest)
- **The `mica` bridge is your only way out** — all interaction with the outside world goes through `mica.*` functions

**What IS available:**
- All JavaScript built-ins: `JSON`, `Math`, `Date`, `RegExp`, `Map`, `Set`, `Promise`, `Array`, etc.
- String template literals for HTML generation
- The `marked` library (auto-injected for card classes that reference it) for markdown → HTML conversion
- Any data files in the card class directory (e.g., `providers.json`) are auto-injected as globals

The render function is synchronous — it returns an HTML string. Export functions can be `async` and use `await mica.write()`, `await mica.agent.chat()`, etc.

---

## How Files Map to Card Classes

1. **Frontmatter**: `card: my-widget` in YAML frontmatter (explicit override, always wins)
2. **Extension**: `.chat` -> `chat`, `.todo` -> `todo`, `.md` -> `markdown`, `.mmd` -> `mermaid`

Extensions are registered in `card-classes/_manifest.json`. Standard formats keep standard extensions (`.md`, `.mmd`, `.html`); Mica-native types use the class name (`.todo`, `.goal`, `.terminal`).

---

# Card Class API

A card class is a JavaScript module (`render.js`) that exports a default `render` function and optionally exports named async functions callable from the browser.

## The Render Function

The default export. Takes the card's file content and a config object, returns an HTML string.

```javascript
// render.js
export default function render(content, config) {
  const project  = config.project;   // e.g. "my-project"
  const canvas   = config.canvas;    // e.g. "workspace"
  const filename = config.filename;  // e.g. "dashboard.my-widget"

  return `
    <div class="my-widget">
      <h1>Hello</h1>
      <div id="output"></div>
    </div>

    <style>
    .my-widget { padding: 16px; font-family: sans-serif; }
    </style>

    <script>
      // mica and container are available here
      const el = container.querySelector('#output');
      const data = await mica.call('get_data', {});
      el.textContent = JSON.stringify(data);
    </script>
  `;
}
```

## Export Functions

Named exports become callable from the browser via `mica.call()` or `mica.send()`. They receive three arguments: the current file content, the args object from JavaScript, and the `mica` bridge.

```javascript
export async function get_data(content, args, mica) {
  // content: the card file body (string) at call time
  // args:    object of arguments from the browser-side call
  // mica:    server bridge (write, readFile, agent.chat, etc.)
  return { status: "active", id: args.id };
}
```

All `mica` bridge functions are async — use `await`.

## Server Bridge Functions

These are available on the `mica` object passed to export functions:

| Function | Description |
|----------|-------------|
| `await mica.write(content)` | Overwrite this card's file content |
| `await mica.writeFile(filename, content)` | Write to any file in the current canvas |
| `await mica.readFile(filename)` | Read a file from the current canvas (returns `string` or `null`) |
| `await mica.exec(command, options?)` | Run a shell command. Returns `{ stdout, stderr, exitCode }`. Options: `{ cwd?, timeout? }`. cwd defaults to project root, timeout defaults to 30s (max 300s) |
| `await mica.log(message)` | Append a message to the canvas's `_log.log` |
| `await mica.emit(event, data)` | Broadcast an event to all connected browser widgets |
| `await mica.fetch(url, options)` | Fetch a URL via server proxy (requires `network: true` in manifest) |
| `await mica.agent.chat(message)` | Send a message to the canvas's AI agent (returns response dict) |

### Shell Access

Cards have full access to the project filesystem and shell via `mica.exec()`:

```javascript
export async function list_files(content, args, mica) {
  const result = await mica.exec('find . -maxdepth 2 -type f -not -path "*/.git/*" -not -path "*/node_modules/*"');
  return result.stdout.split('\n').filter(Boolean);
}

export async function read_file(content, args, mica) {
  const result = await mica.exec(`cat ${JSON.stringify(args.path)}`);
  return { content: result.stdout, error: result.exitCode !== 0 ? result.stderr : null };
}
```

For interactive/streaming shell access from the browser, use `mica.openChannel('shell')`:

```javascript
// In widget <script>:
const ch = mica.openChannel('shell', { cols: 80, rows: 24 });
ch.onData((data) => term.write(data.output));  // PTY output
ch.send({ input: 'npm test\n' });               // send input
ch.send({ resize: true, cols: 120, rows: 40 }); // resize
mica.onDestroy(() => ch.close());
```

### Network Access

By default, card classes cannot make network requests. To enable `mica.fetch()`, set `network: true` in the manifest entry:

```json
{
  "my-widget": {
    "extension": ".my-widget",
    "badge": "WIDGET",
    "defaultTitle": "My Widget",
    "network": true
  }
}
```

`mica.fetch()` returns `{ status, statusText, headers, body }` or throws if network is not permitted. The request is proxied through the server — the card's V8 isolate has no direct network access.

```javascript
export async function load_data(content, args, mica) {
  const resp = await mica.fetch("https://api.example.com/data", {
    method: "GET",
    headers: { "Accept": "application/json" }
  });
  return JSON.parse(resp.body);
}
```

---

# Widget Communication API

Widgets communicate with their JavaScript backend over WebSocket. There are **5 communication patterns**, all accessed through the `mica` bridge object injected into widget scripts.

## JavaScript API (Browser Side)

Every `<script>` block in your widget HTML receives two implicit variables:
- **`mica`** — the communication bridge (described below)
- **`container`** — the widget's root DOM element

### Pattern 1: Request/Response — `mica.call(fn, args)`

Call a backend export function and get a result back.

```javascript
// JavaScript (in widget <script>)
const result = await mica.call('get_status', { id: 42 });
console.log(result);  // whatever the export returned
```

```javascript
// Backend (in render.js)
export async function get_status(content, args, mica) {
  return { status: "active", id: args.id };
}
```

- Returns a **Promise** that resolves with the function's return value
- Timeout: 5 minutes (300s) by default
- Use for: fetching data, submitting forms, any action where you need the result

### Pattern 2: Fire-and-Forget — `mica.send(fn, args)`

Send data to the backend without waiting for a response.

```javascript
// JavaScript
mica.send('log_event', { action: 'button_clicked', ts: Date.now() });
```

```javascript
// Backend
export async function log_event(content, args, mica) {
  await mica.log(`Event: ${args.action} at ${args.ts}`);
  // Return value is ignored
}
```

- Returns **void** (no Promise)
- Use for: analytics, logging, non-critical updates where you don't need confirmation

### Pattern 3: Server Push — `mica.on(event, callback)`

Subscribe to events pushed from the server to all widgets.

```javascript
// JavaScript
const unsub = mica.on('file-changed', (data) => {
  console.log('File changed:', data.filename);
});

// Later: unsubscribe
unsub();
```

- Returns an **unsubscribe function**
- Events are broadcast to all connected widgets (not scoped to a single widget)
- Built-in events: `file-changed`, `file-created`, `file-deleted`
- Use for: reacting to external changes, real-time notifications

### Pattern 4: Bidirectional Channel — `mica.openChannel(fn, args)`

Open a persistent, bidirectional data stream between the widget and the backend.

```javascript
// JavaScript
const ch = mica.openChannel('terminal_session', { shell: '/bin/bash' });

ch.onData((data) => {
  term.write(data.output);
});

ch.onClose(() => {
  console.log('Channel closed');
});

// Send data to backend
ch.send({ input: 'ls -la\n' });

// Later: close the channel
ch.close();
```

- Returns a **Channel** object: `{ id, send(data), close(), onData(cb), onClose(cb) }`
- Use for: terminals, real-time collaboration, streaming output, any long-lived bidirectional communication

> **Note:** Channels are not yet implemented in the JavaScript card runtime. The browser-side API (`mica.openChannel`) works, but backend channel handlers (the `@mica.channel` async generator pattern) are coming soon. Terminal and agent channels are currently handled by dedicated Node-side managers that bypass the card class system.

### Pattern 5: Widget Broadcast — `mica.broadcast(event, data)`

Broadcast an event from one widget to all other connected widgets.

```javascript
// JavaScript — sender widget
mica.broadcast('selection-changed', { itemId: 42, source: 'list' });

// JavaScript — receiver widget
const unsub = mica.on('selection-changed', (data) => {
  console.log('Selected:', data.itemId);
});
```

```javascript
// Backend — broadcast from server-side during an export
export async function process_data(content, args, mica) {
  const result = doWork(args);
  await mica.emit("data-ready", { rows: result.length });  // notify all widgets
  return result;
}
```

- JS `mica.broadcast(event, data)` — relays to all connected browser clients
- Backend `mica.emit(event, data)` — broadcasts from server during an export handler
- Receivers use `mica.on(event, callback)` (Pattern 3) to listen
- Use for: widget-to-widget coordination, cross-widget notifications

### Choosing Between Exports and Channels

Use **exports** (via `mica.call`/`mica.send`) when:
- The operation is request -> response (e.g., send a chat message, save settings)
- You need `mica.agent.chat()` for a single-turn interaction
- The browser waits for one result

Use **channels** (via `mica.openChannel`) when:
- You need to push multiple updates to the browser over time (progress, streaming)
- The operation involves a multi-step workflow with intermediate status updates
- You need bidirectional communication (e.g., terminal I/O, human-in-the-loop)

Both support all server bridge functions including `mica.agent.chat()`.

---

## HTML Structure

Your `render()` function returns a single HTML string containing markup, styles, and scripts:

```javascript
export default function render(content, config) {
  return `
    <div class="my-widget">
      <h1>Hello</h1>
      <div id="output"></div>
    </div>

    <style>
    .my-widget { padding: 16px; font-family: sans-serif; }
    </style>

    <script>
      // mica and container are available here
      const el = container.querySelector('#output');
      const data = await mica.call('get_data', {});
      el.textContent = JSON.stringify(data);
    </script>
  `;
}
```

### Declaring Dependencies (Recommended)

Card classes that use third-party libraries should declare them via an `export const dependencies` alongside the render function. This tells the runtime to **preload scripts and styles before injecting the HTML**, guaranteeing that libraries are fully loaded AND their CSS is applied when your inline scripts execute.

```javascript
export const dependencies = {
  scripts: [
    "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js",
    "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js",
  ],
  styles: [
    "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css",
  ],
};

export default function render(content, config) {
  // xterm.js and its CSS are guaranteed loaded and applied
  return `
    <div id="term" style="height:260px;"></div>
    <script>
      const term = new Terminal();
      term.open(container.querySelector('#term'));
      mica.onDestroy(() => term.dispose());
    </script>
  `;
}
```

**Why use `dependencies` instead of `<script src>` in HTML?**

| | `dependencies` export | `<script src>` in HTML |
|---|---|---|
| **Loading order** | Loaded before HTML is injected | Discovered after HTML is parsed |
| **CSS timing** | CSS is guaranteed applied before scripts run | CSS may not be applied (browser timing issue) |
| **Library CSS** | Use `<link>` normally — no need to inline | Must inline library CSS as `<style>` to avoid timing issues |
| **Deduplication** | From declared list (reliable) | From HTML parsing (fragile) |
| **Preloading** | Server knows deps at class load time | Only discovered at render time |

**For card classes that use libraries with their own CSS (xterm.js, CodeMirror, Toast UI Editor, etc.), `dependencies` is strongly recommended.** It eliminates the CSS timing hack that previously required inlining entire library stylesheets.

See `card-classes/markdown/render.js` for a full example using Toast UI Editor with declared dependencies.

### External Scripts and Stylesheets (Legacy / Simple)

You can also include CDN scripts directly in the HTML. The WidgetRuntime guarantees that **all external `<script src="...">` tags are fully loaded** before any inline `<script>` blocks execute. This approach still works and is fine for libraries that don't have CSS timing issues.

```html
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>

<script>
  // xterm.js is guaranteed to be loaded here.
  const term = new Terminal();
  term.open(container.querySelector('#terminal'));
</script>
```

**Resource loading sequence:**
1. `el.innerHTML = html` — widget HTML is injected into the DOM
2. `<link rel="stylesheet">` tags are hoisted to `<head>` (deduplicated) and begin loading
3. `<script src="...">` tags are hoisted to `<head>` (deduplicated) and begin loading
4. The runtime waits for **all** CSS and JS resources to finish loading
5. Inline `<script>` blocks execute inside IIFEs with `mica` and `container` injected

### DOM Updates and morphdom

Card content re-renders use **morphdom** for efficient DOM diffing. This means the DOM is patched in place rather than replaced wholesale. Library instances mounted to DOM nodes — Three.js scenes, xterm terminals, CodeMirror editors — **survive re-renders** as long as their container element persists in the new HTML.

This is why you don't need to re-initialize libraries on every render. Mount once, and morphdom keeps the element alive.

### Third-Party Library Lifecycle — `mica.onDestroy`

When your widget mounts a third-party library that allocates resources (WebGL contexts, intervals, event listeners), register a cleanup function with `mica.onDestroy()`. This runs when the card is removed from the whiteboard.

```javascript
// Card script:
const term = new Terminal();
term.open(container.querySelector('#term'));
mica.onDestroy(() => term.dispose()); // Clean up on card removal
```

Another example with Three.js:

```javascript
const renderer = new THREE.WebGLRenderer({ canvas: container.querySelector('#gl') });
const scene = new THREE.Scene();
const animId = requestAnimationFrame(function loop() {
  renderer.render(scene, camera);
  animId = requestAnimationFrame(loop);
});
mica.onDestroy(() => {
  cancelAnimationFrame(animId);
  renderer.dispose();
});
```

### Using Third-Party Libraries (Critical)

When your widget uses a third-party library that has its own CSS (e.g., xterm.js, CodeMirror, Leaflet), follow these rules to avoid broken rendering:

**1. Inline the library's CSS — do NOT use `<link>` for it.**

CDN-loaded `<link>` stylesheets have unreliable timing. Even though WidgetRuntime waits for the download, the browser may not have *applied* the CSS rules to the DOM by the time your script runs. Libraries that measure DOM elements during initialization (like xterm.js measuring character dimensions) will get wrong values and break.

```javascript
// CORRECT: Inline the library CSS in a <style> tag
const xtermcss = ".xterm{position:relative;...} .xterm-char-measure-element{visibility:hidden;...}";

return `
  <div id="term" style="height:300px;"></div>
  <style>${xtermcss}</style>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script>
    var term = new Terminal();
    term.open(container.querySelector('#term'));
    mica.onDestroy(() => term.dispose());
  </script>
`;
```

```html
<!-- WRONG: CDN link — CSS may not be applied when term.open() runs -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css"/>
```

**2. Use inline `style` attributes for widget layout — do NOT use `<style>` rules.**

Widget `<style>` rules are global and share scope with the library's CSS. Rules like `overflow: hidden`, `position`, `height`, or even `* { box-sizing: border-box }` can interfere with how the library positions its internal elements (viewports, canvases, measurement spans). Use inline `style` attributes for your widget's own layout to keep it isolated from the library's CSS.

```html
<!-- CORRECT: Inline styles for widget layout -->
<div style="display:flex;flex-direction:column;height:300px;overflow:hidden;">
  <div style="padding:8px;background:#161b22;">Title bar</div>
  <div id="term" style="flex:1;min-height:0;"></div>
</div>
<style>/* Only library CSS here */</style>

<!-- WRONG: <style> rules for widget layout — will conflict with library CSS -->
<style>
  .my-wrapper { overflow: hidden; height: 300px; }
  #term { flex: 1; min-height: 0; overflow: hidden; }
</style>
```

**3. Use fixed pixel heights for containers — do NOT use `height: 100%`.**

Widgets render inside `.widget-runtime` which has no explicit height. `height: 100%` resolves to 0, causing libraries like xterm.js to calculate 0 rows. Always use a fixed pixel height on the outermost container.

```html
<!-- CORRECT: Fixed pixel height -->
<div id="term" style="height:260px;"></div>

<!-- WRONG: Percentage height — resolves to 0 -->
<div id="term" style="height:100%;"></div>
```

The card body has `max-height: 280px` with `12px` vertical padding (content area: `268px`). Keep your widget height <= 260px to fit without clipping.

### Important Notes

- Each `<script>` block runs inside an IIFE with `mica` and `container` injected — no globals needed
- Scripts execute **once** per HTML change, not on every React render cycle
- External `<script src="...">` are loaded into `<head>` (cached globally) before inline scripts run
- Use `container.querySelector(...)` instead of `document.querySelector(...)` to scope DOM queries to your widget
- The single `<style>` tag should contain **only** the third-party library's CSS — never mix widget layout rules into it

---

## _manifest.json

Register your card class with an extension and UI metadata. Place this at `.card-classes/_manifest.json` for project-specific classes:

```json
{
  "my-widget": {
    "extension": ".my-widget",
    "badge": "WIDGET",
    "defaultTitle": "My Widget"
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `extension` | Yes | File extension that maps to this class (e.g., `.dashboard`, `.my-widget`) |
| `badge` | Yes | Short label shown on the card header (e.g., "WIDGET", "DASH") |
| `system` | No | If `true`, card appears in the system cards section |
| `defaultTitle` | No | Title shown when the filename is just `_name.ext` |
| `network` | No | If `true`, enables `mica.fetch()` for server-proxied HTTP requests. Default `false`. |

The extension is how Mica knows which `render.js` to use. A file named `overview.my-widget` will be rendered by the `my-widget` card class because `.my-widget` is registered in the manifest.

**Multiple instances are natural**: `overview.dashboard` and `sales.dashboard` are both rendered by the `dashboard` class.

---

## Complete Example: Counter Widget

```javascript
// render.js

export default function render(content, config) {
  const count = parseInt(content.trim(), 10) || 0;

  return `
    <div class="counter">
      <span id="count">${count}</span>
      <button id="inc">+</button>
      <button id="dec">-</button>
    </div>

    <style>
    .counter { display: flex; align-items: center; gap: 12px; padding: 16px; }
    .counter span { font-size: 2rem; font-weight: bold; min-width: 3ch; text-align: center; }
    .counter button {
      width: 40px; height: 40px; border-radius: 50%; border: 1px solid #555;
      background: #2a2a3e; color: white; font-size: 1.2rem; cursor: pointer;
    }
    .counter button:hover { background: #3a3a5e; }
    </style>

    <script>
      const countEl = container.querySelector('#count');

      container.querySelector('#inc').addEventListener('click', async () => {
        const result = await mica.call('increment', {});
        countEl.textContent = result.count;
      });

      container.querySelector('#dec').addEventListener('click', async () => {
        const result = await mica.call('decrement', {});
        countEl.textContent = result.count;
      });
    </script>
  `;
}

export async function increment(content, args, mica) {
  const count = (parseInt(content.trim(), 10) || 0) + 1;
  await mica.write(String(count));
  return { count };
}

export async function decrement(content, args, mica) {
  const count = Math.max(0, (parseInt(content.trim(), 10) || 0) - 1);
  await mica.write(String(count));
  return { count };
}
```

## Reference Examples

Look at existing card classes for more patterns:
- `card-classes/chat/render.js` — Chat with message history, agent integration
- `card-classes/todo/render.js` — Todo list with assignments, priorities, agent integration
- `card-classes/html/render.js` — Raw HTML passthrough
- `card-classes/terminal/render.js` — xterm.js terminal (example of third-party library integration with inlined CSS)
