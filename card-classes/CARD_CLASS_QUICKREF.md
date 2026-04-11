# Card Class API Reference

API reference for card class development. For the creation workflow and templates, use the `create-card-class` skill. For the full runtime deep-dive, see `AUTHORING_CARD_CLASSES.md`.

**Runtime shim:** Card scripts run with a compatibility shim that auto-scopes DOM queries to the card, redirects window resize to card resize, and auto-cleans timers/observers/listeners. Standard DOM APIs (`document.querySelector`, `getElementById`, `window.addEventListener('resize')`) work inside card scripts.

## Metadata export

```javascript
export const metadata = {
  extension: ".my-card",     // required: file extension → card class mapping
  badge: "CARD",             // required: label shown in card header
  primaryFile: "data.json",  // optional: content file inside card directory
  defaultTitle: "My Card",   // optional: display title
};
```

## Dependencies export

```javascript
export const dependencies = {
  scripts: ['https://cdn.example.com/lib.min.js'],  // loaded before scripts run
  styles: ['https://cdn.example.com/lib.min.css'],
};
```

## Browser bridge (mica) — inline scripts

| Method | Returns | Description |
|--------|---------|-------------|
| `mica.call(fn, args)` | `Promise<any>` | Call server export |
| `mica.send(fn, args)` | `void` | Fire-and-forget to server |
| `mica.on(event, cb)` | `() => void` | Subscribe to events. Returns unsubscribe fn |
| `mica.openChannel(fn, args)` | `Channel` | Open bidirectional channel |
| `mica.broadcast(event, data)` | `void` | Send event to other cards |
| `mica.refresh()` | `void` | Re-fetch and re-render this card |
| `mica.onDestroy(cb)` | `void` | Register cleanup callback |
| `mica.project` | `string` | Project ID |
| `mica.canvas` | `string` | Canvas ID |
| `mica.filename` | `string` | Card filename |

## Server bridge (mica) — export functions and stream handlers

| Method | Returns | Description |
|--------|---------|-------------|
| `mica.read(filename)` | `Promise<string>` | Read file from card directory |
| `mica.write(filename, content)` | `Promise<void>` | Write file to card directory |
| `mica.exec(command, opts?)` | `Promise<{stdout, stderr, exitCode}>` | Run shell command in container |
| `mica.send(data)` | `void` | Broadcast to all browsers |
| `mica.reply(data)` | `void` | Reply to sender only (in onMessage) |
| `mica.log(message)` | `Promise<void>` | Append to activity log |
| `mica.createCard(name)` | `Promise<void>` | Create new card on canvas |
| `mica.project` | `string` | Project ID |
| `mica.canvas` | `string` | Canvas ID |
| `mica.filename` | `string` | Card filename |

## Channel API

```javascript
// Browser: open a channel
var ch = mica.openChannel('chat_session', { provider: 'claude' });
ch.send(data);           // Send data to server
ch.onData(function(d) { });  // Receive data from server
ch.onClose(function() { });  // Server closed channel
ch.close();              // Soft detach (session stays alive)
ch.destroy();            // Hard close (session destroyed)
```

```javascript
// Server: stream handlers in render.js
export function onConnect(mica, args) { }    // Channel opened
export function onMessage(msg, mica) { }     // Data from browser
export function onDestroy(mica) { }          // Session destroyed
```

## Card class directory structure

```
card-classes/my-widget/
  render.js       # Implementation (required)
  spec.md         # What this card type does (recommended)
  setup.sh        # One-time container setup (optional, user-approved)
  ~brief.md       # Seed: flat file → instance brief.md
  ~data.json      # Seed: flat file → instance data.json
  _child.todo     # Seed: child card → instance child.todo/
```

- No prefix = class-level file (stays in class dir)
- `~` prefix = seeded as flat file (prefix stripped)
- `_` prefix = seeded as child card subdirectory (prefix stripped)
