# Creating Card Classes

This document is the complete reference for building Mica card classes. A card class is a `render.js` file that turns a data file into an interactive widget on the Mica canvas.

---

## 1. Quick Start

A card class needs three things: a `render.js` file, a manifest entry, and a card file.

### Step 1: Create render.js

Create `{project}/.mica/.card-classes/counter/render.js`:

```javascript
export default function render(content, config) {
  const count = parseInt(content.trim(), 10) || 0;

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:16px;font-family:sans-serif;">
      <button id="dec" style="width:36px;height:36px;border-radius:50%;border:1px solid #555;background:#2a2a3e;color:white;font-size:1.2rem;cursor:pointer;">-</button>
      <span id="count" style="font-size:2rem;font-weight:bold;color:#e6edf3;min-width:3ch;text-align:center;">${count}</span>
      <button id="inc" style="width:36px;height:36px;border-radius:50%;border:1px solid #555;background:#2a2a3e;color:white;font-size:1.2rem;cursor:pointer;">+</button>
    </div>

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

### Step 2: Add a manifest entry

Create `{project}/.mica/.card-classes/_manifest.json`:

```json
{
  "counter": {
    "extension": ".counter",
    "badge": "COUNT"
  }
}
```

### Step 3: Create a card file

Create `{project}/.mica/my-counter.counter` with content `0`. The file watcher picks it up and renders the counter widget immediately.

---

## 2. Runtime Model

Card code runs in three distinct environments. Understanding which code runs where is the single most important thing to get right.

```
+------------------------------------------------------------------+
| 1. NODE.JS MODULE (server-side render.js)                        |
|                                                                   |
|    Runs: render(), export functions, stream handlers              |
|    Has:  Full Node.js — import, require, fs, process, fetch      |
|    Has:  mica bridge (export functions and stream handlers)       |
|    Has:  Any npm package (node-pty, marked, agent SDKs, etc.)    |
|                                                                   |
|    render(content, config) returns an HTML string                 |
|    Export functions are ASYNC — receive (content, args, mica)     |
|    Stream handlers: onConnect(mica, args), onMessage(msg, mica), |
|      onDisconnect(mica) — for bidirectional channels              |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| 2. DOCKER CONTAINER (project sandbox)                             |
|                                                                   |
|    Runs: commands via mica.exec()                                 |
|    Has:  bash, find, ls, cat, grep, sed, awk, python3, node      |
|    Has:  project directory mounted at its original path (rw)      |
|    Has:  HOME=/home/sandbox, ~/.claude/ mounted (rw)              |
|                                                                   |
|    Does NOT have:                                                 |
|      - Your IDE, your home directory, other projects              |
|      - ~/.ssh/, ~/.aws/, other credentials                        |
|                                                                   |
|    cwd defaults to project root                                   |
|    timeout defaults to 30s, max 300s                              |
+------------------------------------------------------------------+

+------------------------------------------------------------------+
| 3. BROWSER (inline <script> blocks)                               |
|                                                                   |
|    Runs: <script> blocks from the HTML returned by render()       |
|    Has:  mica bridge (call, send, on, openChannel, broadcast,    |
|           onDestroy)                                               |
|    Has:  container (scoped DOM element for this card)             |
|    Has:  Full DOM APIs, async/await, CDN-loaded libraries         |
|                                                                   |
|    Scripts run inside IIFEs with (mica, container) injected       |
|    Scripts execute ONCE per HTML change (not on every React       |
|    render cycle)                                                   |
|                                                                   |
|    ALWAYS: container.querySelector('#my-el')                      |
|    NEVER:  document.querySelector('#my-el')                       |
+------------------------------------------------------------------+
```

### Data flow

```
Browser                    Node.js (server)              Docker Container
  |                              |                              |
  |-- mica.call('fn', args) ---->|                              |
  |                              |-- mica.exec('cmd') --------->|
  |                              |<-- { stdout, stderr } -------|
  |<-- Promise resolves ---------|                              |
  |                              |                              |
  |-- mica.openChannel('fn') -->|                              |
  |<== bidirectional data =====>|  (onConnect/onMessage/        |
  |                              |   onDisconnect + mica.send)  |
```

---

## 3. Two File Systems

Cards interact with two separate file systems. Confusing them is the most common source of bugs.

### Canvas files (.mica/ directory)

These are card files, chat history, goals, todos, briefs, and logs that live in the project's `.mica/` directory.

```
Access via:   mica.readFile(filename)      — read a canvas file
              mica.writeFile(filename, content) — write a canvas file
              mica.write(content)          — write THIS card's own file

Scope:        Current canvas only
Contains:     Card data files, metadata, collaboration artifacts
Examples:     _todo.todo, _goal.goal, _brief.brief, notes.md, my-counter.counter
```

The agent's built-in tools (`list_files`, `read_file`, `write_file`) also operate on canvas files.

### Project files (project root directory)

These are the project's actual source code, configs, and assets.

```
Access via:   mica.exec('cat ./src/index.js')     — read a project file
              mica.exec('ls -la ./src/')           — list project files
              mica.exec('echo "data" > output.txt') — write a project file

Scope:        Full project directory tree
Contains:     Source code, package.json, configs, build outputs, etc.
Examples:     src/index.js, README.md, package.json, tsconfig.json
```

### Example: reading project files from a card

```javascript
// WRONG — this reads from .mica/, not from the project
const src = await mica.readFile('src/index.js');  // null — file doesn't exist in canvas

// RIGHT — this reads from the project directory
const result = await mica.exec('cat src/index.js');
if (result.exitCode === 0) {
  const src = result.stdout;
}
```

---

## 4. The Render Function

The default export. Returns an HTML string (can be sync or async). Runs in Node.js.

```javascript
export default function render(content, config) {
  // content: string — the card file's body text
  // config:  object — metadata about the card

  // config fields:
  //   config.project   — project ID (e.g., "my-app")
  //   config.canvas    — canvas name (e.g., "workspace")
  //   config.filename  — card filename (e.g., "dashboard.my-widget")

  return `<div>Hello, ${config.project}!</div>`;
}
```

### Rules

- **Returns a string.** `render()` can be sync or async. It returns an HTML string.
- **No mica bridge.** The `mica` object is not passed to `render()`. Use export functions or stream handlers for server-side operations.
- **Full Node.js access.** You can `import` any package, read files with `fs`, etc. But prefer keeping render pure — side effects belong in exports or stream handlers.
- **Module-level state is shared.** The module is cached per class. Use module-level Maps keyed by session identity for per-card state (see terminal and chat examples).
- **Return a single HTML string** containing markup, `<style>` tags, `<script src>` tags, and inline `<script>` blocks.

### What you CAN do in render()

```javascript
export default function render(content, config) {
  // Parse the card file content
  const data = JSON.parse(content || '{}');

  // Use JS built-ins
  const timestamp = new Date().toISOString();
  const itemCount = data.items?.length || 0;

  // Build HTML with template literals
  const listHtml = (data.items || [])
    .map(item => `<li>${item.replace(/</g, '&lt;')}</li>`)
    .join('');

  return `
    <div style="padding:16px;">
      <h2>${itemCount} items</h2>
      <ul>${listHtml}</ul>
    </div>
  `;
}
```

### Module-level constants are fine

```javascript
// OK — constants that don't change between renders
const COLORS = { high: '#f87171', medium: '#d29922', low: '#3fb950' };
const MAX_ITEMS = 100;

// OK — monotonic counters for unique IDs (not per-render state)
let idCounter = 0;

export default function render(content, config) {
  const id = `widget-${++idCounter}-${Date.now()}`;
  // ...
}
```

---

## 5. Export Functions

Named exports become server-side functions callable from the browser. They run in the Node.js process and have access to the `mica` bridge.

```javascript
export async function my_function(content, args, mica) {
  // content: string  — the card file's current body text (re-read on each call)
  // args:    object   — arguments passed from the browser
  // mica:    object   — the server bridge (see section 7)

  // Do work...
  const result = await mica.exec('ls -la');

  // Optionally update the card file
  await mica.write('new content');

  // Return value is sent back to the browser as the Promise result
  return { files: result.stdout.split('\n') };
}
```

### Calling exports from the browser

```javascript
// In an inline <script> block:

// Request/response — waits for result
const result = await mica.call('my_function', { id: 42 });

// Fire-and-forget — no return value
mica.send('log_event', { action: 'clicked' });
```

### Common pattern: read-modify-write

```javascript
export async function toggle_item(content, args, mica) {
  const data = JSON.parse(content || '{"items":[]}');
  const item = data.items.find(i => i.id === args.id);
  if (item) item.done = !item.done;
  await mica.write(JSON.stringify(data, null, 2));
  return { items: data.items };
}
```

---

## 6. Browser Scripts

Inline `<script>` blocks in the HTML returned by `render()` execute in the browser with two injected variables.

### Execution model

Each `<script>` block is wrapped in an IIFE:

```javascript
(function(mica, container) {
  // Your script code runs here
})(micaBridge, cardDomElement);
```

- **`mica`** — the browser-side bridge object (call, send, on, openChannel, broadcast, onDestroy)
- **`container`** — the card's root DOM element (use for all DOM queries)

### Rules

1. **Always use `container.querySelector()`**, never `document.querySelector()`. Cards are isolated; using `document` would reach into other cards.

2. **Scripts run once per HTML change.** If `render()` returns the same HTML, scripts do not re-execute. This is intentional -- it means mounted library instances (xterm, Three.js, CodeMirror) survive when only the file content changes but the HTML template stays the same.

3. **Event listeners on `document` must be cleaned up.** Use `mica.onDestroy()`:

    ```javascript
    // WRONG — leaks across re-renders
    document.addEventListener('keydown', handler);

    // RIGHT — cleaned up on destroy
    document.addEventListener('keydown', handler);
    mica.onDestroy(() => document.removeEventListener('keydown', handler));
    ```

4. **Full async/await support.** The IIFE wrapper does not block on your async operations, but you can freely use `await` inside your script.

5. **CDN globals are available** via `window.*` (e.g., `window.mermaid`, `window.Terminal`, `window.THREE`). See section 9 for loading dependencies.

### The browser-side mica bridge

| Method | Description |
|--------|-------------|
| `await mica.call(fn, args)` | Call a server-side export, returns Promise with result |
| `mica.send(fn, args)` | Fire-and-forget call to server export, no return value |
| `mica.on(event, callback)` | Subscribe to server-pushed events. Returns unsubscribe function |
| `mica.openChannel(fn, args)` | Open a persistent bidirectional channel. Returns Channel object |
| `mica.broadcast(event, data)` | Send an event to all other cards on this canvas |
| `mica.onDestroy(callback)` | Register cleanup function for re-render/unmount |

---

## 7. Server Bridge API Reference

These functions are available on the `mica` object in **export functions only** (not in `render()`).

| Function | Returns | Description |
|----------|---------|-------------|
| `await mica.write(content)` | `void` | Overwrite this card's own file content. Triggers re-render. |
| `await mica.writeFile(filename, content)` | `void` | Write to any file in the current canvas (.mica/ directory). |
| `await mica.readFile(filename)` | `string \| null` | Read a file from the current canvas. Returns `null` if not found. |
| `await mica.exec(command, options?)` | `{ stdout, stderr, exitCode }` | Run a shell command in the project's Docker container. |
| `await mica.log(message)` | `void` | Append a line to `_log.log` in the canvas. |
| `await mica.emit(event, data)` | `void` | Broadcast an event to all connected browser widgets. |
| `await mica.fetch(url, options?)` | `{ status, statusText, headers, body }` | HTTP request via server proxy. Requires `network: true` in manifest. |
| `await mica.agent.chat(message)` | `object` | Send a message to the canvas's AI agent. Returns response dict. |

### mica.exec() details

Runs a shell command inside the project's Docker container via `docker exec`.

```javascript
const result = await mica.exec(command, { cwd, timeout });
```

- **command** (string): Shell command passed to `/bin/bash -c`
- **cwd** (string, optional): Working directory. Defaults to the project root path.
- **timeout** (number, optional): Milliseconds. Defaults to 30000 (30s). Maximum 300000 (5 min).
- **Returns**: `{ stdout: string, stderr: string, exitCode: number }`
- **maxBuffer**: 10 MB for stdout/stderr

**Error handling**: `mica.exec()` never throws. Check `exitCode` for failure:

```javascript
export async function list_project_files(content, args, mica) {
  const result = await mica.exec(
    'find . -maxdepth 3 -type f -not -path "*/.git/*" -not -path "*/node_modules/*"'
  );
  if (result.exitCode !== 0) {
    return { error: result.stderr, files: [] };
  }
  return { files: result.stdout.split('\n').filter(Boolean) };
}
```

### mica.fetch() details

Card classes have full Node.js access and can use `fetch` or any HTTP library directly.

```javascript
const resp = await mica.fetch('https://api.example.com/data', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'test' })
});
// resp = { status: 200, statusText: 'OK', headers: {...}, body: '...' }
```

Throws an error if the card's manifest entry does not have `network: true`.

---

## 8. Channel API

Channels provide persistent, bidirectional communication between browser scripts and server-side handlers. They are used for terminals, chat sessions, streaming data, and any long-lived interactive pattern.

### Opening a channel (browser side)

```javascript
const ch = mica.openChannel('function_name', { key: 'value' });
```

Returns a Channel object:

| Method | Description |
|--------|-------------|
| `ch.send(data)` | Send data to the server handler |
| `ch.close()` | Soft detach. **No-op** for persistent channels. Callbacks stay active. |
| `ch.destroy()` | Hard close. Removes from registry, sends `channel_close` to server. |
| `ch.onData(callback)` | Set the data callback. Called when server sends data. |
| `ch.onClose(callback)` | Set the close callback. Called when server destroys the session. |

### Persistence model

Channels are keyed by `(project, canvas, filename, fn)`. This means:

- **`openChannel()` with the same key returns the existing channel** with swapped callbacks. No close/reopen message is sent to the server.
- **Channels survive re-renders.** When card HTML changes and scripts re-execute, `openChannel()` reconnects to the existing server session.
- **Channels survive WebSocket reconnects.** On reconnect, all persistent channels automatically reattach.
- **`ch.close()` is a no-op.** It does not close the channel. It is safe to call in `mica.onDestroy()`.
- **`ch.destroy()` is permanent.** Only called by the server when a card file is deleted. Do not call this from card code.

### Pattern: using onDestroy with channels

```javascript
const ch = mica.openChannel('my_session', { mode: 'interactive' });

ch.onData((data) => {
  // Handle incoming data
  container.querySelector('#output').textContent = data.message;
});

ch.onClose(() => {
  // Server destroyed the session (file deleted, server shutdown)
  container.querySelector('#output').textContent = '[session ended]';
});

// Safe — ch.close() is a no-op, channel stays alive for next render
mica.onDestroy(() => ch.close());
```

### Working example: terminal card pattern

From `card-classes/terminal/render.js`:

```javascript
// Open a PTY channel — persists across re-renders
const ch = mica.openChannel('pty_session', { cols: term.cols, rows: term.rows });

// Receive PTY output
ch.onData((data) => {
  if (data.output !== undefined) term.write(data.output);
});

// Session ended (card deleted)
ch.onClose(() => {
  term.write('\r\n\x1b[90m[session closed]\x1b[0m\r\n');
});

// Send keyboard input
term.onData((input) => { ch.send({ input }); });

// Send resize events
term.onResize((size) => {
  ch.send({ resize: true, cols: size.cols, rows: size.rows });
});

// Cleanup: close() is a no-op, channel stays alive
mica.onDestroy(() => {
  ch.close();
  ro.disconnect();
  term.dispose();
});
```

### Working example: chat card pattern

From `card-classes/claude-chat/render.js`:

```javascript
const ch = mica.openChannel('chat_session', { provider: 'claude' });

ch.onData((data) => {
  switch (data.type) {
    case 'history':
      // Replay conversation history on (re)connect
      for (const m of data.messages) addMessage(m.role, m.content, m.agent);
      break;
    case 'user':
      addMessage('user', data.content);
      break;
    case 'thinking':
      showWorkingStatus();
      break;
    case 'progress':
      updateProgressLog(data.description);
      break;
    case 'assistant':
      addMessage('assistant', data.content, data.agent);
      break;
    case 'error':
      addMessage('assistant', 'Error: ' + data.error, 'System');
      break;
  }
});

// Send user message
function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = '';
  ch.send({ message: text });
}

mica.onDestroy(() => { ch.close(); });
```

### Server-side stream handlers

Card classes implement the server side of channels by exporting `onConnect`, `onMessage`, and `onDisconnect`. These mirror WebSocket semantics — the infrastructure provides the transport, the card class decides the behavior.

```javascript
import * as pty from 'node-pty';  // Full Node.js access — import anything

const sessions = new Map();  // Per-session state (module is cached per class)

function sessionKey(mica) {
  return `${mica.project}/${mica.canvas}/${mica.filename}`;
}

// Called once when the channel session is created (first client attaches)
export function onConnect(mica, args) {
  const proc = pty.spawn('bash', ['--login'], { cols: args.cols || 80, rows: args.rows || 24 });
  sessions.set(sessionKey(mica), { proc, scrollback: '' });

  proc.onData((data) => {
    mica.send({ output: data });  // Broadcast to all connected browsers
  });
}

// Called for every message from any connected browser
export function onMessage(msg, mica) {
  const session = sessions.get(sessionKey(mica));

  // Handle reconnect: replay state to just the reconnecting client
  if (msg.type === 'attached') {
    if (session?.scrollback) mica.reply({ output: session.scrollback });
    return;
  }

  if (msg.input) session?.proc?.write(msg.input);
}

// Called when the session is destroyed (card file deleted, server shutdown)
export function onDisconnect(mica) {
  const session = sessions.get(sessionKey(mica));
  session?.proc?.kill();
  sessions.delete(sessionKey(mica));
}
```

**Key patterns:**
- **`mica.send(data)`** broadcasts to all connected browsers
- **`mica.reply(data)`** sends only to the client that triggered the current `onMessage` call
- **`{ type: "attached" }` message** is delivered automatically when a client reconnects (refresh, second window). Use it to replay state (scrollback, history) without losing the live session.
- **Module-level state** via `Map` keyed by `project/canvas/filename` — the module is cached per class, so multiple cards of the same class share the module but have separate session state.
- **Full Node.js access** — import `node-pty`, `@anthropic-ai/claude-agent-sdk`, `marked`, or any npm package.

---

## 9. Dependencies

Card classes that use third-party libraries from CDN should declare them via a `dependencies` export. This guarantees scripts and styles are fully loaded and applied before inline `<script>` blocks execute.

```javascript
export const dependencies = {
  scripts: [
    'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js',
    'https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js',
  ],
  styles: [
    'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css',
  ],
};

export default function render(content, config) {
  // Terminal and FitAddon globals are guaranteed available
  return `
    <div id="term" style="height:260px;"></div>
    <script>
      const term = new Terminal();
      const fitAddon = new FitAddon.FitAddon();
      term.loadAddon(fitAddon);
      term.open(container.querySelector('#term'));
      fitAddon.fit();
      mica.onDestroy(() => term.dispose());
    </script>
  `;
}
```

### Loading order

1. Declared `dependencies.styles` are loaded into `<head>` (deduplicated)
2. Declared `dependencies.scripts` are loaded into `<head>` (deduplicated)
3. Browser waits for all CSS rules to be applied (two animation frames)
4. Card HTML is injected into the DOM
5. Any inline `<link>` and `<script src>` tags are hoisted to `<head>` and loaded
6. All resources finish loading
7. Inline `<script>` blocks execute with `mica` and `container` injected

### Alternative: inline `<script src>` tags

You can also load CDN scripts directly in your HTML. The runtime guarantees all external scripts are loaded before inline scripts execute:

```javascript
export default function render(content, config) {
  return `
    <div id="chart"></div>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
    <script>
      // window.mermaid is guaranteed loaded here
      window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
    </script>
  `;
}
```

Use the `dependencies` export when the library has CSS that must be applied before script initialization (xterm.js, CodeMirror, etc.). Use inline `<script src>` for simpler libraries without CSS timing requirements.

### Referencing CDN globals

CDN scripts set globals on `window`. Reference them via `window.*` in inline scripts:

```javascript
// After loading mermaid via CDN
window.mermaid.render('id', syntax);

// After loading Three.js via CDN
const scene = new THREE.Scene();

// After loading xterm.js via CDN
const term = new Terminal();
```

---

## 10. Common Pitfalls

### container.querySelector vs document.querySelector

```javascript
// WRONG — reaches into other cards, breaks isolation
const el = document.querySelector('#output');

// RIGHT — scoped to this card's DOM
const el = container.querySelector('#output');
```

### height: 100% resolves to 0

The card container has no explicit height set. Percentage heights resolve to 0.

```html
<!-- WRONG — resolves to 0 height -->
<div id="term" style="height:100%;"></div>

<!-- RIGHT — fixed pixel height or min-height -->
<div id="term" style="height:260px;"></div>
<div id="term" style="min-height:260px;"></div>
```

### Event listener leaks on document

```javascript
// WRONG — listener persists across re-renders, stacks up
document.addEventListener('keydown', handler);

// RIGHT — cleaned up on re-render
document.addEventListener('keydown', handler);
mica.onDestroy(() => document.removeEventListener('keydown', handler));
```

### Module-level mutable state

```javascript
// WRONG — state persists across different card instances sharing the cached module
let currentData = {};

export default function render(content, config) {
  currentData = JSON.parse(content);  // Overwrites state for all cards of this class
  // ...
}

// RIGHT — derive state from content parameter on each call
export default function render(content, config) {
  const currentData = JSON.parse(content || '{}');
  // ...
}
```

### Initializing a CDN library multiple times

```javascript
// WRONG — reinitializing mermaid blanks out previously rendered diagrams
mermaidLib.initialize({ startOnLoad: false, theme: 'dark' });

// RIGHT — use a window flag to initialize once
if (!window.__mermaidInitialized) {
  mermaidLib.initialize({ startOnLoad: false, theme: 'dark' });
  window.__mermaidInitialized = true;
}
```

See `card-classes/mermaid/render.js` for the full pattern.

### Calling mica.exec() inside render()

```javascript
// WRONG — render() has no mica bridge, this will throw
export default function render(content, config) {
  const files = mica.exec('ls');  // ERROR: mica is not defined
  return `<div>${files}</div>`;
}

// RIGHT — move to an export function, call from browser script
export default function render(content, config) {
  return `
    <div id="files"></div>
    <script>
      const result = await mica.call('list_files', {});
      container.querySelector('#files').textContent = result.files.join('\\n');
    </script>
  `;
}

export async function list_files(content, args, mica) {
  const result = await mica.exec('ls');
  return { files: result.stdout.split('\\n').filter(Boolean) };
}
```

### CSS class name collisions between cards

```html
<!-- WRONG — .widget class from one card bleeds into another -->
<style>
  .widget { padding: 16px; background: red; }
</style>

<!-- RIGHT — use inline styles for card layout -->
<div style="padding:16px;background:#0d1117;"></div>
```

Use inline `style` attributes for your card's own layout. Reserve `<style>` tags for third-party library CSS that requires class-based selectors.

---

## 11. Debugging

### Render errors

Server console shows:
```
[card-manager] render failed for <filename>: <error message>
```

Common causes: syntax error in render.js, JSON.parse on malformed content, referencing undefined variables.

### Export function errors

Returned to the browser as a rejected Promise. The browser console shows the error. Wrap `mica.call()` in try/catch:

```javascript
try {
  const result = await mica.call('my_function', { id: 42 });
} catch (err) {
  console.error('Export failed:', err.message);
}
```

### Inline script errors

Browser console shows:
```
[widget-runtime] Script error in <filename>: <error>
```

Common causes: referencing `document.querySelector` instead of `container.querySelector`, CDN library not loaded, typos in element IDs.

### mica.exec() errors

`mica.exec()` never throws. Always check the result:

```javascript
const result = await mica.exec('npm test');
if (result.exitCode !== 0) {
  await mica.log(`Command failed: ${result.stderr}`);
}
```

### Server-side printf debugging

Use `mica.log()` in export functions to write messages to `_log.log` on the canvas:

```javascript
export async function debug_function(content, args, mica) {
  await mica.log('debug_function called with: ' + JSON.stringify(args));
  const result = await mica.exec('whoami');
  await mica.log('whoami result: ' + result.stdout);
  return result;
}
```

### Auto-reload on card class changes

The file watcher monitors card class directories. When you modify a `render.js` file:
1. The cached module for that class is invalidated
2. The module is re-imported on the next render
3. All cards using that class automatically re-render

No server restart needed during development.

---

## 12. Manifest Reference

The manifest file maps card class names to file extensions and UI metadata. There are two manifest locations:

- **Built-in**: `card-classes/_manifest.json` (ships with Mica)
- **Project-specific**: `{project}/.mica/.card-classes/_manifest.json` (merged on top of built-in)

### Format

```json
{
  "class-name": {
    "extension": ".class-name",
    "badge": "BADGE",
    "defaultTitle": "My Card",
    "system": false,
    "network": false
  }
}
```

### Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `extension` | Yes | string | File extension that maps to this class. Must start with `.` |
| `badge` | Yes | string | Short label shown on the card header (e.g., "TODO", "CHAT", "TERM") |
| `defaultTitle` | No | string | Display title when the filename is a system card (e.g., `_project.project`) |
| `system` | No | boolean | If `true`, card appears in the system cards section of the canvas. Default `false` |
| `network` | No | boolean | If `true`, enables `mica.fetch()` for server-proxied HTTP requests. Default `false` |

### Extension mapping rules

- The extension determines which `render.js` is used. A file named `overview.dashboard` uses the `dashboard` card class.
- Standard formats keep standard extensions: `.md` -> markdown, `.html` -> html, `.txt` -> text, `.mmd` -> mermaid
- Mica-native types use the class name as extension: `.todo`, `.goal`, `.terminal`, `.chat`
- Multiple card files can use the same class: `backend.todo` and `frontend.todo` both render with the `todo` class.
- YAML frontmatter `card: name` overrides extension-based resolution.

---

## 13. Complete Examples

### Example 1: Counter (simple export-based state)

A minimal card that persists a counter value in its card file.

**`render.js`**:

```javascript
export default function render(content, config) {
  const count = parseInt(content.trim(), 10) || 0;

  return `
    <div style="display:flex;align-items:center;gap:12px;padding:16px;font-family:sans-serif;">
      <button id="dec" style="
        width:36px;height:36px;border-radius:50%;border:1px solid #555;
        background:#2a2a3e;color:white;font-size:1.2rem;cursor:pointer;
      ">-</button>
      <span id="count" style="
        font-size:2rem;font-weight:bold;color:#e6edf3;min-width:3ch;text-align:center;
      ">${count}</span>
      <button id="inc" style="
        width:36px;height:36px;border-radius:50%;border:1px solid #555;
        background:#2a2a3e;color:white;font-size:1.2rem;cursor:pointer;
      ">+</button>
    </div>

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

**Manifest entry**: `{ "counter": { "extension": ".counter", "badge": "COUNT" } }`

**Card file**: `my-counter.counter` with content `0`

---

### Example 2: File Browser (mica.exec for project files)

A card that browses the project's source files. Demonstrates `mica.exec()` for reading project files and `mica.call()` for interactive navigation.

**`render.js`**:

```javascript
export default function render(content, config) {
  return `
    <div style="
      display:flex;flex-direction:column;min-height:200px;max-height:400px;
      background:#0d1117;border-radius:6px;overflow:hidden;
      font-family:'SF Mono','Fira Code',monospace;font-size:13px;
    ">
      <div style="
        padding:8px 12px;background:#161b22;border-bottom:1px solid #30363d;
        color:#e6edf3;font-weight:600;display:flex;align-items:center;gap:8px;
      ">
        <span style="color:#58a6ff;">&#128193;</span>
        <span id="current-path" style="flex:1;">.</span>
        <button id="refresh-btn" style="
          background:none;border:1px solid #30363d;color:#8b949e;border-radius:4px;
          padding:2px 8px;cursor:pointer;font-size:11px;
        ">Refresh</button>
      </div>
      <div id="file-list" style="
        flex:1;overflow-y:auto;padding:4px 0;color:#e6edf3;
      ">
        <div style="color:#8b949e;padding:8px 12px;">Loading...</div>
      </div>
      <div id="file-preview" style="
        display:none;border-top:1px solid #30363d;max-height:200px;overflow-y:auto;
      ">
        <pre id="preview-content" style="
          margin:0;padding:8px 12px;color:#8b949e;font-size:12px;white-space:pre-wrap;
          word-break:break-all;
        "></pre>
      </div>
    </div>

    <script>
      const listEl = container.querySelector('#file-list');
      const pathEl = container.querySelector('#current-path');
      const previewEl = container.querySelector('#file-preview');
      const previewContent = container.querySelector('#preview-content');
      const refreshBtn = container.querySelector('#refresh-btn');

      let currentDir = '.';

      async function loadDir(dir) {
        currentDir = dir;
        pathEl.textContent = dir;
        listEl.innerHTML = '<div style="color:#8b949e;padding:8px 12px;">Loading...</div>';
        previewEl.style.display = 'none';

        try {
          const result = await mica.call('list_dir', { path: dir });
          if (result.error) {
            listEl.innerHTML = '<div style="color:#f87171;padding:8px 12px;">Error: '
              + result.error + '</div>';
            return;
          }
          renderFileList(result.entries);
        } catch (err) {
          listEl.innerHTML = '<div style="color:#f87171;padding:8px 12px;">Failed: '
            + err.message + '</div>';
        }
      }

      function renderFileList(entries) {
        if (entries.length === 0) {
          listEl.innerHTML = '<div style="color:#8b949e;padding:8px 12px;">(empty)</div>';
          return;
        }

        listEl.innerHTML = '';

        // Add parent directory link if not at root
        if (currentDir !== '.') {
          const parentDir = currentDir.split('/').slice(0, -1).join('/') || '.';
          const row = document.createElement('div');
          row.style.cssText = 'padding:4px 12px;cursor:pointer;display:flex;align-items:center;gap:6px;';
          row.innerHTML = '<span style="color:#58a6ff;">&#128193;</span><span style="color:#58a6ff;">..</span>';
          row.addEventListener('click', () => loadDir(parentDir));
          row.addEventListener('mouseenter', () => { row.style.background = '#161b22'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
          listEl.appendChild(row);
        }

        for (const entry of entries) {
          const row = document.createElement('div');
          row.style.cssText = 'padding:4px 12px;cursor:pointer;display:flex;align-items:center;gap:6px;';
          const icon = entry.type === 'dir' ? '&#128193;' : '&#128196;';
          const color = entry.type === 'dir' ? '#58a6ff' : '#e6edf3';
          row.innerHTML = '<span style="color:' + color + ';">' + icon
            + '</span><span style="color:' + color + ';">' + entry.name + '</span>';

          row.addEventListener('click', () => {
            if (entry.type === 'dir') {
              loadDir(entry.path);
            } else {
              previewFile(entry.path);
            }
          });
          row.addEventListener('mouseenter', () => { row.style.background = '#161b22'; });
          row.addEventListener('mouseleave', () => { row.style.background = 'none'; });
          listEl.appendChild(row);
        }
      }

      async function previewFile(filePath) {
        try {
          const result = await mica.call('read_project_file', { path: filePath });
          if (result.error) {
            previewContent.textContent = 'Error: ' + result.error;
          } else {
            previewContent.textContent = result.content;
          }
          previewEl.style.display = 'block';
        } catch (err) {
          previewContent.textContent = 'Failed: ' + err.message;
          previewEl.style.display = 'block';
        }
      }

      refreshBtn.addEventListener('click', () => loadDir(currentDir));

      // Initial load
      loadDir('.');
    </script>
  `;
}

export async function list_dir(content, args, mica) {
  const dir = args.path || '.';
  // Use find to list one level of entries, excluding .git and node_modules
  const result = await mica.exec(
    `find ${JSON.stringify(dir)} -maxdepth 1 -mindepth 1 `
    + `-not -name ".git" -not -name "node_modules" -not -name ".mica" `
    + `| sort`,
    { timeout: 10000 }
  );

  if (result.exitCode !== 0) {
    return { error: result.stderr || 'Command failed', entries: [] };
  }

  const paths = result.stdout.split('\n').filter(Boolean);
  const entries = [];

  for (const p of paths) {
    // Check if each path is a directory
    const typeCheck = await mica.exec(`test -d ${JSON.stringify(p)} && echo dir || echo file`);
    const name = p.split('/').pop();
    entries.push({
      name,
      path: p,
      type: typeCheck.stdout.trim() === 'dir' ? 'dir' : 'file',
    });
  }

  // Sort: directories first, then files
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { entries };
}

export async function read_project_file(content, args, mica) {
  const path = args.path;
  if (!path) return { error: 'No path provided', content: '' };

  // Safety: only read files, not directories or special files
  const check = await mica.exec(`test -f ${JSON.stringify(path)} && echo ok || echo no`);
  if (check.stdout.trim() !== 'ok') {
    return { error: 'Not a regular file', content: '' };
  }

  // Limit file size to avoid huge reads
  const result = await mica.exec(`head -c 50000 ${JSON.stringify(path)}`);
  if (result.exitCode !== 0) {
    return { error: result.stderr || 'Failed to read file', content: '' };
  }
  return { content: result.stdout };
}
```

**Manifest entry**: `{ "file-browser": { "extension": ".file-browser", "badge": "FILES" } }`

**Card file**: `browser.file-browser` (content can be empty)

---

### Example 3: Chat Card (channel-based, persistent)

A simplified chat card that demonstrates the channel pattern for bidirectional, persistent communication with an AI agent.

**`render.js`**:

```javascript
export default function render(content, config) {
  return `
    <div style="
      display:flex;flex-direction:column;height:100%;min-height:260px;
      background:#0d1117;border-radius:6px;overflow:hidden;
      font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
    ">
      <div style="
        padding:8px 12px;background:#161b22;border-bottom:1px solid #30363d;
        color:#e6edf3;font-size:13px;font-weight:600;
      ">Chat</div>

      <div id="messages" style="
        flex:1;overflow-y:auto;padding:8px 12px;min-height:0;
        display:flex;flex-direction:column;gap:8px;
      ">
        <div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">
          Send a message to start.
        </div>
      </div>

      <div style="
        display:flex;gap:6px;padding:8px 12px;
        border-top:1px solid #30363d;flex-shrink:0;
      ">
        <input id="input" type="text" placeholder="Type a message..."
          style="
            flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;
            padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;
            font-family:inherit;
          "
        />
        <button id="send-btn" style="
          background:#60a5fa;color:#0d1117;border:none;border-radius:6px;
          padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;
        ">Send</button>
      </div>
    </div>

    <script>
    (() => {
      const messagesEl = container.querySelector('#messages');
      const inputEl = container.querySelector('#input');
      const sendBtn = container.querySelector('#send-btn');
      let busy = false;

      // Open persistent channel — survives re-renders
      const ch = mica.openChannel('chat_session', { provider: 'claude' });

      function addMessage(role, text) {
        // Clear placeholder
        if (messagesEl.children.length === 1
            && messagesEl.children[0].style.textAlign === 'center') {
          messagesEl.innerHTML = '';
        }
        const div = document.createElement('div');
        div.style.cssText = role === 'user'
          ? 'align-self:flex-end;background:rgba(96,165,250,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
          : 'align-self:flex-start;background:rgba(255,255,255,0.06);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:85%;';
        div.textContent = text;
        div.style.color = '#e6edf3';
        div.style.fontSize = '13px';
        div.style.lineHeight = '1.5';
        messagesEl.appendChild(div);
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      // Handle channel data from server
      ch.onData((data) => {
        switch (data.type) {
          case 'history':
            messagesEl.innerHTML = '';
            if (data.messages && data.messages.length > 0) {
              for (const m of data.messages) addMessage(m.role, m.content);
            }
            break;
          case 'user':
            addMessage('user', data.content);
            break;
          case 'thinking':
            busy = true;
            sendBtn.disabled = true;
            break;
          case 'assistant':
            busy = false;
            sendBtn.disabled = false;
            addMessage('assistant', data.content);
            break;
          case 'error':
            busy = false;
            sendBtn.disabled = false;
            addMessage('assistant', 'Error: ' + (data.error || 'Unknown'));
            break;
        }
      });

      ch.onClose(() => {
        addMessage('system', '[Session closed]');
      });

      function send() {
        const text = inputEl.value.trim();
        if (!text || busy) return;
        inputEl.value = '';
        ch.send({ message: text });
      }

      sendBtn.addEventListener('click', send);
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      });

      mica.onDestroy(() => { ch.close(); });
    })();
    </script>
  `;
}
```

**Manifest entry**: `{ "claude-chat": { "extension": ".claude-chat", "badge": "CLAUDE" } }`

**Card file**: `assistant.claude-chat` (content managed by the channel handler)

---

## Reference Card Classes

For more patterns, read these existing card classes:

| Card class | File | Pattern demonstrated |
|------------|------|---------------------|
| `todo` | `card-classes/todo/render.js` | Complex export-based state, parsing structured content, read-modify-write |
| `terminal` | `card-classes/terminal/render.js` | Channel-based PTY, xterm.js with inlined CSS, ResizeObserver |
| `claude-chat` | `card-classes/claude-chat/render.js` | Channel-based chat, status bar, message history replay |
| `mermaid` | `card-classes/mermaid/render.js` | CDN dependency via `dependencies` export, unique IDs, window flag for one-time init |
| `markdown` | `card-classes/markdown/render.js` | CDN dependency with CSS, declared `dependencies` export |
| `simple-project` | `card-classes/simple-project/render.js` | Canvas card with `data-slot` elements |
