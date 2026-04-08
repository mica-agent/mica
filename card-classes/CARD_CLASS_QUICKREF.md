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

`~brief.md` in the card class directory is a template — it seeds `brief.md` into every new card instance automatically.

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

5. **File-changed sync** — refresh when the card's primary file changes. The `source` field is `"user"` for direct edits, or the card filename when a server export wrote it. For most cards, refresh on any change to your own file:
   ```javascript
   const unsub = mica.on('file-changed', (e) => {
     if (e.filename === mica.filename) mica.refresh();
   });
   mica.onDestroy(unsub);
   ```
   Only filter by source if your card writes to its own file on a **timer** (not in response to user interaction) — otherwise you'll miss updates from your own export functions.

6. **Use `mica.write()` in server-side code** — not shell commands. `mica.write()` tracks the source so `file-changed` events correctly identify who made the change, preventing spurious re-renders.

## Things that break

- **Script re-runs on every render** — `mica.refresh()` re-injects HTML and re-executes all scripts. Don't store state in JS closure variables; use the primaryFile for persistence.
- **Always clean up in `mica.onDestroy()`** — timers, event listeners, observers, and channels all leak if not cleaned up. Every `setInterval`, `addEventListener`, `ResizeObserver`, and `mica.on()` needs a corresponding cleanup.
- **Channels survive re-renders** — `mica.openChannel()` with the same fn returns the existing channel. Don't close and reopen manually on refresh.
- **`document.querySelector()` reaches outside your card** — always use `container.querySelector()`.
- **`mica.read()`, `mica.write()`, `mica.exec()` are server-only** — they don't exist in browser scripts. To read/write files from the browser, create a server export function and call it with `mica.call('my_fn', args)`.

## Module-level state

Module-level variables are **shared across all cards of this class**. Safe pattern: key by card identity.

```javascript
// At module level in render.js:
const sessions = new Map();

// In onConnect / export functions:
const key = `${mica.project}/${mica.canvas}/${mica.filename}`;
sessions.set(key, { /* per-card state */ });
```

Never use bare module-level variables like `let currentUser = null` — they leak across cards.

## Server-side exports (optional)

Use exports for **stateless request/response** interactions — user action → server does work → returns result.

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

Use **channels** instead when you need persistent state, bidirectional streaming, or a long-lived session (terminal, chat agent). See `AUTHORING_CARD_CLASSES.md` for the channel API.

## Server bridge (mica) — available in exports and stream handlers

| Method | Description |
|--------|-------------|
| `mica.read(filename)` | Read file from card directory |
| `mica.write(filename, content)` | Write file to card directory (tracks source for file-changed events) |
| `mica.exec(command)` | Run shell command in container — never throws, check `exitCode` |
| `mica.send(data)` | Broadcast to all connected browsers |
| `mica.reply(data)` | Reply to the client that sent the message |
| `mica.log(message)` | Append to activity log |
| `mica.createCard(name)` | Create a new card on the canvas |

## Browser bridge (mica) — available in inline scripts

| Method | Description |
|--------|-------------|
| `mica.call(fn, args)` | Call server export, returns Promise |
| `mica.send(fn, args)` | Fire-and-forget to server |
| `mica.on(event, cb)` | Subscribe to events (e.g. 'file-changed') — returns unsubscribe function |
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
2. Write `spec.md` using this template:
   ```markdown
   # Card Name
   One sentence description.

   ## Content format
   What the primaryFile contains (e.g., JSON, markdown, plain text).

   ## Interactions
   What the user can do with this card.
   ```
3. Read an existing card class for a working example: `cat /opt/mica/card-classes/mermaid/render.js`
4. Write `render.js` — metadata + render function + optional exports
5. Write `~brief.md` — default brief seeded into new instances (recommended)
6. Create an instance: `curl -s -X POST http://localhost:3002/api/projects/$MICA_PROJECT/canvases/_root/cards -H 'Content-Type: application/json' -d '{"name": "my-thing.{ext}"}'`
7. **Verify**: check the response — if the `html` field contains "Render error", read the error and fix render.js. Re-check: `curl -s http://localhost:3002/api/projects/$MICA_PROJECT/canvases/_root/cards/my-thing.{ext}`

## Error handling and auto-refresh

If `render()` throws:
- The error is shown as red text in the card UI
- A `card-error` event is broadcast to chat agents on the canvas — they auto-respond and fix the code
- Once the render.js fix is saved, the card **auto-refreshes automatically** — no need to manually refresh or recreate the instance

Defensive pattern for bad content:
```javascript
export default function render(content, config) {
  try {
    const data = JSON.parse(content || '{}');
    return `<div>${data.value}</div>`;
  } catch {
    return `<div style="color:#f87171;padding:16px;">Invalid data format</div>`;
  }
}
```

## Change propagation reference

| Event | Trigger | Who acts |
|-------|---------|----------|
| `file-changed` + `source` | primaryFile edited | Card script: refresh if `source !== mica.filename` |
| `file-created` | New card instance created | Canvas: adds card automatically |
| `file-deleted` | Card instance deleted | Canvas: removes card automatically |
| `class-changed` | render.js saved/fixed | Canvas: re-renders card in-place automatically |
| `card-error` | render() threw | Chat agents: auto-notified, attempt fix |
| `classes-updated` | New card class created | Canvas toolbar: rebuilds buttons automatically |

**Key point:** After fixing render.js, the canvas auto-refreshes affected cards. No manual action needed.

For channels (bidirectional streaming like chat/terminal), export functions, CDN dependencies, see the full reference: `read_reference('AUTHORING_CARD_CLASSES.md')`.
