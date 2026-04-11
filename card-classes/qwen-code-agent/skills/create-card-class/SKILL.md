---
name: create-card-class
description: Create a new Mica card class with render.js, spec.md, seed files, and verified rendering. Use when asked to create a new type of card.
---

# Create a New Card Class

Follow this exact workflow to create a working card class.

## Steps

1. **Read a working example**: `cat /opt/mica/card-classes/todo/render.js`
2. **Create the directory**: `mkdir -p /opt/mica/project-card-classes/{name}`
3. **Write spec.md**: Describe what the card type does
4. **Write render.js**: Use the template below as your starting point
5. **Write seed file**: `~{primaryFile}` with sensible default content (e.g. `~data.json` with `{}`)
6. **Test**: Run this command and check the output:
   ```bash
   curl -s -X POST $MICA_API_URL/api/card-classes/{name}/test \
     -H 'Content-Type: application/json' -d '{"content":"{}"}'
   ```
   If `error` is not null, read the error, fix render.js, and re-test. Repeat until clean.
7. **Create an instance**:
   ```bash
   curl -s -X POST $MICA_API_URL/api/projects/$MICA_PROJECT/canvases/_root/cards \
     -H 'Content-Type: application/json' -d '{"name": "my-thing.{ext}"}'
   ```

## render.js Template

Write standard HTML/CSS/JS. The card runtime includes a compatibility shim that makes standard DOM APIs work inside cards automatically.

```javascript
export const metadata = {
  extension: ".my-card",
  badge: "CARD",
  primaryFile: "data.json"
};

// Optional: CDN libraries (verify URLs with curl -sI first)
export const dependencies = {
  scripts: ['https://cdn.example.com/lib.min.js']
};

export default function render(content, config) {
  // content = string from primaryFile, config = { project, canvas, filename }
  var data = {};
  try { data = JSON.parse(content); } catch(e) {}

  return `
    <div style="display:flex;flex-direction:column;height:100%;min-height:0;">
      <div id="output" style="flex:1;min-height:0;overflow:auto;padding:16px;"></div>
    </div>
    <script>
      // Standard DOM APIs work — document.querySelector, getElementById, etc.
      var el = document.getElementById('output');
      el.textContent = 'Hello';

      // window.addEventListener('resize') works for card resize (auto-handled)
      // Timers, observers, event listeners auto-cleaned on card removal

      // Persist data via server exports
      // var result = await mica.call('save', { data: myData });

      // React to external data changes
      mica.on('file-changed', function(e) {
        if (e.filename === mica.filename) mica.refresh();
      });
    </script>
  `;
}

// Optional: server-side export callable from browser via mica.call('save', {...})
export async function save(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args.data));
  return { ok: true };
}
```

## What works automatically (runtime shim)

The card runtime provides a compatibility shim so you can write standard web code:

- **`document.querySelector()` / `getElementById()`** — auto-scoped to your card (no cross-card leaks)
- **`window.addEventListener('resize')`** — auto-redirected to card container resize (drag-resize works)
- **`setInterval` / `setTimeout`** — auto-cleaned when card is removed
- **`requestAnimationFrame`** — auto-cleaned when card is removed
- **Event listeners on `window`** — auto-cleaned when card is removed

You do NOT need `container.querySelector()`, `ResizeObserver`, or `mica.onDestroy()` for these. They just work.

## Server-side exports

Named exports become callable from the browser via `mica.call()`. They run in Node.js with the server bridge.

```javascript
// Read-modify-write pattern (most common)
export async function toggle_item(content, args, mica) {
  // content = fresh read of primary file (re-read on each call)
  // args = arguments from browser
  // mica = server bridge (read, write, exec, send, reply, log, createCard)
  let data = JSON.parse(content || '{"items":[]}');
  let item = data.items.find(function(i) { return i.id === args.id; });
  if (item) item.done = !item.done;
  await mica.write('tasks.md', JSON.stringify(data, null, 2));
  return { items: data.items };
}
```

After `mica.call()` modifies data, call `mica.refresh()` to re-render with updated content.

## Browser bridge (mica) — available in inline scripts

| Method | Description |
|--------|-------------|
| `await mica.call(fn, args)` | Call server export, returns Promise with result |
| `mica.send(fn, args)` | Fire-and-forget to server |
| `mica.on(event, cb)` | Subscribe to events (e.g. `file-changed`). Returns unsubscribe function |
| `mica.openChannel(fn, args)` | Open bidirectional channel (for streaming, chat, terminal) |
| `mica.broadcast(event, data)` | Send event to other cards on canvas |
| `mica.refresh()` | Fetch fresh HTML and re-render this card |
| `mica.onDestroy(cb)` | Register cleanup callback (rarely needed — shim auto-cleans) |
| `mica.project` | Project ID (string) |
| `mica.canvas` | Canvas ID (string) |
| `mica.filename` | Card filename (string) |

## Server bridge (mica) — available in export functions

| Method | Description |
|--------|-------------|
| `await mica.read(filename)` | Read file from card directory |
| `await mica.write(filename, content)` | Write file to card directory |
| `await mica.exec(command, opts?)` | Run shell command in container. Returns `{ stdout, stderr, exitCode }` |
| `mica.send(data)` | Broadcast to all connected browsers |
| `mica.reply(data)` | Reply to sender only |
| `await mica.log(message)` | Append to activity log |
| `await mica.createCard(name)` | Create new card on canvas |

## Sizing: fill the card

Your root element should fill the card dimensions:

```html
<div style="display:flex;flex-direction:column;height:100%;min-height:0;">
  <div id="content" style="flex:1;min-height:0;overflow:auto;"></div>
</div>
```

For canvas/WebGL, `window.addEventListener('resize')` works automatically — no ResizeObserver needed:

```javascript
var canvas = document.getElementById('viewport');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setSize(canvas.clientWidth, canvas.clientHeight);

// This fires on card drag-resize (shim handles it)
window.addEventListener('resize', function() {
  camera.aspect = canvas.clientWidth / canvas.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(canvas.clientWidth, canvas.clientHeight);
});
```

## Using CDN libraries

Verify URLs before using: `curl -sI <url> | head -1`

Do NOT assume API signatures — different versions have different APIs.

For Three.js r128:
- `new THREE.Color("#ff8800")` — accepts CSS hex strings
- `new THREE.Color(0xff8800)` — accepts hex integers

## Common mistakes

- **No nested template literals in `<script>` blocks** — the render function returns a template literal, so `${...}` inside inline scripts is interpreted by Node.js, not the browser. Use string concatenation instead:
  ```javascript
  // WRONG — ${rect.left} is evaluated by Node.js, not the browser
  el.style.cssText = `left: ${rect.left}px`;

  // RIGHT — string concatenation runs in the browser
  el.style.cssText = 'left: ' + rect.left + 'px';
  ```
- Use `mica.call()` to persist data (browser state is ephemeral)
- Add `file-changed` listener if data can be modified externally
- Verify CDN URLs with curl before using
- All functions must be defined in the same file — no `import` in browser scripts
- Use `let` not `const` for variables you reassign in export functions
- Use `dependencies.scripts` for CDN libraries, not inline `<script src>`
