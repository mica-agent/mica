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
      // container is pre-defined — NEVER redeclare it
      // Use container.querySelector() — NEVER document.querySelector()
      var el = container.querySelector('#output');
      el.textContent = 'Hello';

      // Call server exports via mica.call()
      // var result = await mica.call('save', { data: { key: 'value' } });

      // Re-render when card data file changes
      var unsub = mica.on('file-changed', function(e) {
        if (e.filename === mica.filename) mica.refresh();
      });

      // Always clean up timers, listeners, observers
      mica.onDestroy(function() { unsub(); });
    </script>
  `;
}

// Optional: server-side export callable from browser via mica.call('save', {...})
export async function save(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args.data));
  return { ok: true };
}
```

## Server-side exports

Named exports become callable from the browser via `mica.call()`. They run in Node.js with the server bridge.

```javascript
// Read-modify-write pattern (most common)
export async function toggle_item(content, args, mica) {
  // content = fresh read of primary file (re-read on each call)
  // args = arguments from browser
  // mica = server bridge (read, write, exec, send, reply, log, createCard)
  var data = JSON.parse(content || '{"items":[]}');
  var item = data.items.find(function(i) { return i.id === args.id; });
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
| `mica.onDestroy(cb)` | Register cleanup callback |
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

Cards are placed on a resizable canvas. Your root element MUST expand to fill the card's dimensions:

```html
<!-- Root element: flex column, height 100% -->
<div style="display:flex;flex-direction:column;height:100%;min-height:0;">
  <!-- Content area: flex:1 fills remaining space -->
  <div id="content" style="flex:1;min-height:0;overflow:auto;"></div>
</div>
```

For canvas/WebGL/Three.js cards, the container and renderer MUST resize with the card:
```javascript
var el = container.querySelector('#canvas-container');
var renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(el.clientWidth, el.clientHeight);
el.appendChild(renderer.domElement);

// CRITICAL: use ResizeObserver, NOT window.addEventListener('resize')
// Cards are resized by dragging on the canvas — this does NOT fire window resize events.
var ro = new ResizeObserver(function() {
  if (el.clientWidth > 0 && el.clientHeight > 0) {
    camera.aspect = el.clientWidth / el.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(el.clientWidth, el.clientHeight);
  }
});
ro.observe(el);

// Always clean up animation frames, observers, and renderer
var animFrame;
function animate() {
  animFrame = requestAnimationFrame(animate);
  renderer.render(scene, camera);
}
animate();

mica.onDestroy(function() {
  ro.disconnect();
  cancelAnimationFrame(animFrame);
  renderer.dispose();
});
```

## Using CDN libraries

When using a CDN library (Three.js, D3, Chart.js, etc.), verify the API before writing code:

```bash
# Verify URL works
curl -sI https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js | head -1
```

Do NOT assume API signatures — different versions have different APIs.

For Three.js r128 specifically:
- `new THREE.Color("#ff8800")` — accepts CSS hex strings directly
- `new THREE.Color(0xff8800)` — accepts hex integers
- Do NOT pass `{r, g, b}` objects — use `THREE.Color` constructor

## Common mistakes to avoid

- `document.querySelector()` — use `container.querySelector()` instead
- `const container = ...` — container is already defined, redeclaring it crashes
- `import x from 'y'` in browser scripts — use `dependencies.scripts` for CDN libs
- Calling undefined functions — all functions must be defined in the same file
- Untested CDN URLs — verify with `curl -sI <url> | head -1` before using
- Skipping the test step — always test before creating an instance
- `window.addEventListener('resize')` — WRONG for cards, use `ResizeObserver` on the container
- Missing `mica.onDestroy()` — animation frames, observers, event listeners all leak without cleanup
- Missing `file-changed` listener — card won't update when its data file is modified
- Fixed pixel dimensions — use `height:100%;flex:1` to fill the card
- `const` for variables you reassign — use `let` instead (e.g. in export functions)
