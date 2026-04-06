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
- `~` prefix = seeded as flat file into instances
- `_` prefix = seeded as child card subdirectory into instances

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

    <style>
      /* Styles are scoped by being inside the card's DOM container */
    </style>

    <script>
      // Runs in browser. Two injected variables:
      //   mica     — bridge object (call, send, on, openChannel, refresh, onDestroy)
      //   container — this card's root DOM element

      const el = container.querySelector('#output');
      el.textContent = 'Hello from ' + mica.filename;

      // Clean up on card removal
      mica.onDestroy(() => { /* cleanup timers, observers, etc. */ });
    </script>
  `;
}
```

## Key rules

1. **Always `container.querySelector()`** — never `document.querySelector()`. Cards are isolated.

2. **Use concrete min-height on library containers** — `min-height: 150px`, never `min-height: 0`. Cards are positioned asynchronously; libraries need height at init time.

3. **Use ResizeObserver for libraries** that cache dimensions (editors, terminals, charts):
   ```javascript
   const ro = new ResizeObserver(() => widget.resize());
   ro.observe(container);
   mica.onDestroy(() => ro.disconnect());
   ```

4. **Disable autofocus** — libraries that grab focus will scroll the canvas.

5. **File-changed sync** — listen for external edits:
   ```javascript
   const unsub = mica.on('file-changed', (e) => {
     if (e.filename === mica.filename) mica.refresh();
   });
   mica.onDestroy(unsub);
   ```

## Server-side exports (optional)

Named exports become callable from the browser via `mica.call()`:

```javascript
// In render.js (runs in Node.js):
export async function save_data(content, args, mica) {
  // content = current primaryFile content
  // args = arguments from browser
  // mica = server bridge: read, write, exec, send, reply, log, createCard
  await mica.write('data.json', JSON.stringify(args.data));
  return { ok: true };
}

// In browser script:
const result = await mica.call('save_data', { data: { key: 'value' } });
```

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

1. `mkdir -p /opt/mica/card-classes/{name}`
2. Write `spec.md` — describe what the card does
3. Write `render.js` — metadata + render function + optional exports
4. Create an instance: `curl -s -X POST http://localhost:3002/api/projects/$MICA_PROJECT/canvases/_root/cards -H 'Content-Type: application/json' -d '{"name": "my-thing.{ext}"}'`
5. **Verify**: check the response from step 4 — if the `html` field contains "Render error", read the error message and fix render.js. Also try: `curl -s http://localhost:3002/api/projects/$MICA_PROJECT/canvases/_root/cards/my-thing.{ext}` to re-check after fixing.

For channels (bidirectional streaming like chat/terminal), export functions, CDN dependencies, see the full reference: `read_reference('AUTHORING_CARD_CLASSES.md')`.
