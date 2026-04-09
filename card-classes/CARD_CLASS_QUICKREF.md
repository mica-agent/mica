# Card Class Quick Reference

This is the essential reference for creating card classes. For the full API (channels, dependencies, export functions), use `read_reference('AUTHORING_CARD_CLASSES.md')`.

## Card class directory

```
card-classes/my-widget/
  render.js       ← implementation (required)
  spec.md         ← what this card type does (recommended)
  ~brief.md       ← default brief for new instances (~ = flat file seed)
  ~config.json    ← any flat file seed
  _child.todo     ← child card seed (_ = card subdirectory)
```

- No prefix = class-level file (stays in class dir, not seeded)
- `~` prefix = seeded as flat file into instances (`~brief.md` → `brief.md`)
- `_` prefix = seeded as child card subdirectory into instances
- `setup.sh` = runs once in the project container to install dependencies (user approves first)

## Minimal render.js

```javascript
export const metadata = {
  extension: ".widget",    // file extension → card class mapping
  badge: "WIDGET",         // label shown in card header
  primaryFile: "data.json" // content file inside card directory
};

export default function render(content, config) {
  // content = string from primaryFile
  // config = { project, canvas, filename }
  // Returns HTML string

  return `
    <div style="padding:16px;">
      <h2>My Widget</h2>
      <div id="output"></div>
    </div>

    <script>
      // Runs in browser. Two injected variables:
      //   mica     — bridge object (call, send, on, openChannel, refresh, onDestroy)
      //   container — this card's root DOM element

      const el = container.querySelector('#output');
      el.textContent = 'Hello from ' + mica.filename;

      mica.onDestroy(() => { /* cleanup timers, observers, etc. */ });
    </script>
  `;
}
```

## Key rules

1. **Use `container.querySelector()` for DOM access** — `container` is pre-defined as your card's root element. Never use `document.querySelector()` or `document.getElementById()`. Never redeclare `container` (`const container = ...` will crash).

2. **render.js is self-contained** — define every function you call. There are no implicit imports or shared libraries. If you use `hexToRgb()`, you must define it in the same file.

3. **`mica.read()`, `mica.write()`, `mica.exec()` are server-only** — use `mica.call()` from browser scripts to invoke server export functions.

4. **No ES modules in browser scripts** — `import` and `import maps` don't work inside card scripts. Load CDN libraries via the `dependencies` export, then use them as globals:
   ```javascript
   export const dependencies = {
     scripts: ['https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js']
   };
   // Then in the inline <script>: use THREE.Scene(), THREE.Mesh(), etc.
   ```
   **Before adding a CDN URL**, verify it works: `curl -sI <url> | head -1` should return `200`. Many CDN URLs are outdated or removed — always test first.
   **Three.js note:** Use r128 from cdnjs (r150+ removed non-module builds). OrbitControls is not available as a standalone global script — implement camera controls manually.

3. **File-changed sync** — refresh when the card's data file changes:
   ```javascript
   const unsub = mica.on('file-changed', (e) => {
     if (e.filename === mica.filename) mica.refresh();
   });
   mica.onDestroy(unsub);
   ```

4. **Clean up in `mica.onDestroy()`** — timers, event listeners, observers, and channels leak if not cleaned up.

## Server-side exports (optional)

Named exports become callable from the browser via `mica.call()`:

```javascript
// In render.js (runs in Node.js):
export async function save_data(content, args, mica) {
  await mica.write('data.json', JSON.stringify(args.data));
  return { ok: true };
}

// In browser script:
const result = await mica.call('save_data', { data: { key: 'value' } });
```

After `mica.call()` modifies data, call `mica.refresh()` to re-render with the updated content.

## Server bridge (mica) — available in exports and stream handlers

| Method | Description |
|--------|-------------|
| `mica.read(filename)` | Read file from card directory |
| `mica.write(filename, content)` | Write file to card directory |
| `mica.exec(command)` | Run shell command in container |
| `mica.send(data)` | Broadcast to all connected browsers |
| `mica.reply(data)` | Reply to the client that sent the message |
| `mica.log(message)` | Append to activity log |
| `mica.createCard(name)` | Create a new card on the canvas |

## Browser bridge (mica) — available in inline scripts

| Method | Description |
|--------|-------------|
| `mica.call(fn, args)` | Call server export, returns Promise |
| `mica.send(fn, args)` | Fire-and-forget to server |
| `mica.on(event, cb)` | Subscribe to events (e.g. 'file-changed') |
| `mica.openChannel(fn)` | Open bidirectional channel |
| `mica.refresh()` | Re-fetch and re-render this card |
| `mica.onDestroy(cb)` | Register cleanup callback |
| `mica.project` | Project ID |
| `mica.canvas` | Canvas ID |
| `mica.filename` | Card filename |

## Complete example: counter card

```javascript
export const metadata = {
  extension: ".counter",
  badge: "COUNT",
  primaryFile: "counter.txt"
};

export default function render(content, config) {
  const count = parseInt(content.trim(), 10) || 0;
  return `
    <div style="display:flex;align-items:center;gap:12px;padding:16px;">
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
  await mica.write('counter.txt', String(count));
  return { count };
}

export async function decrement(content, args, mica) {
  const count = Math.max(0, (parseInt(content.trim(), 10) || 0) - 1);
  await mica.write('counter.txt', String(count));
  return { count };
}
```

## Creating a card class step by step

1. `mkdir -p /opt/mica/project-card-classes/{name}`
2. Read an existing card class for a working example: `cat /opt/mica/card-classes/mermaid/render.js`
3. Write `spec.md` — describe what the card does
4. Write `render.js` — metadata + render function + optional exports
5. Write `~{primaryFile}` — seed content for new instances (e.g. `~data.json` with default data). Without this, new instances start with an empty primary file and may not render.
6. **Test before creating**: `curl -s -X POST http://localhost:3002/api/card-classes/{name}/test -H 'Content-Type: application/json' -d '{"content":"{}"}' | grep error` — if `error` is not null, fix render.js before proceeding.
7. Create an instance: `curl -s -X POST http://localhost:3002/api/projects/$MICA_PROJECT/canvases/_root/cards -H 'Content-Type: application/json' -d '{"name": "my-thing.{ext}"}'`

## Container dependencies (setup.sh)

If your card class needs CLI tools or packages installed in the project container, create a `setup.sh` in the card class directory:

```bash
#!/bin/bash
npm install -g some-cli-tool
```

The user will be shown the script and asked to approve before it runs. It runs once per project, as root, inside the isolated container. Use this for npm packages, pip packages, apt packages, or any tool the card's server-side code needs.

For channels (bidirectional streaming like chat/terminal), export functions, CDN dependencies, see the full reference: `read_reference('AUTHORING_CARD_CLASSES.md')`.
