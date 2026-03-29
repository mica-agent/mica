# Creating Widget Card Classes

Card classes define how files render as interactive widgets on the Mica whiteboard. Each widget has a Python backend (`render.py`) and produces HTML/JS/CSS that runs in the browser.

## Directory Structure

**Built-in classes** live in `card-classes/`:
```
card-classes/
  chat/render.py
  todo/render.py
  markdown/render.py
```

**Project-specific classes** live in `.mica/.card-classes/` inside the project repo:
```
my-project/
  .mica/
    .card-classes/
      my-widget/
        render.py          # required
      _manifest.json       # optional: badge/title metadata
    workspace/
      dashboard.my-widget  # triggers the card class (extension = class name)
```

Project classes override built-in classes of the same name. Project classes have full Python module access (no import restrictions).

## How Files Map to Card Classes

1. **Frontmatter**: `card: my-widget` in YAML frontmatter (explicit override, always wins)
2. **Extension**: `.chat` → `chat`, `.todo` → `todo`, `.md` → `markdown`, `.mmd` → `mermaid`

Extensions are registered in `card-classes/_manifest.json`. Standard formats keep standard extensions (`.md`, `.mmd`, `.html`); Mica-native types use the class name (`.todo`, `.goal`, `.terminal`).

---

# Widget Communication API

Widgets communicate with their Python backend over WebSocket. There are **5 communication patterns**, all accessed through the `mica` bridge object injected into widget scripts.

## JavaScript API (Browser Side)

Every `<script>` block in your widget HTML receives two implicit variables:
- **`mica`** — the communication bridge (described below)
- **`container`** — the widget's root DOM element

### Pattern 1: Request/Response — `mica.call(fn, args)`

Call a Python `@mica.export` function and get a result back.

```javascript
// JavaScript (in widget <script>)
const result = await mica.call('get_status', { id: 42 });
console.log(result);  // whatever Python returned
```

```python
# Python (in render.py)
@mica.export
def get_status(content, args):
    item_id = args.get("id")
    return {"status": "active", "id": item_id}
```

- Returns a **Promise** that resolves with the function's return value
- Timeout: 5 minutes (300s) by default
- Use for: fetching data, submitting forms, any action where you need the result

### Pattern 2: Fire-and-Forget — `mica.send(fn, args)`

Send data to the Python backend without waiting for a response.

```javascript
// JavaScript
mica.send('log_event', { action: 'button_clicked', ts: Date.now() });
```

```python
# Python
@mica.export
def log_event(content, args):
    mica.log(f"Event: {args['action']} at {args['ts']}")
    # Return value is ignored
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

Open a persistent, bidirectional data stream between the widget and Python.

```javascript
// JavaScript
const ch = mica.openChannel('terminal_session', { shell: '/bin/bash' });

ch.onData((data) => {
  // Data received from Python
  term.write(data.output);
});

ch.onClose(() => {
  console.log('Channel closed');
});

// Send data to Python
ch.send({ input: 'ls -la\n' });

// Later: close the channel
ch.close();
```

```python
# Python
@mica.channel
def terminal_session(content, args, channel):
    shell = args.get("shell", "/bin/bash")
    # channel.send(data) — push data to the browser
    # channel.receive()  — block until data arrives from browser
    # channel.close()    — close the channel
    while True:
        msg = channel.receive()
        if msg is None:
            break  # channel closed by browser
        output = run_shell(msg["input"])
        channel.send({"output": output})
```

- Returns a **Channel** object: `{ id, send(data), close(), onData(cb), onClose(cb) }`
- The Python handler runs in its own thread — it can block on `channel.receive()` without stalling other widgets
- Use for: terminals, real-time collaboration, streaming output, any long-lived bidirectional communication

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

```python
# Python — broadcast from server-side during an export
@mica.export
def process_data(content, args):
    result = do_work(args)
    mica.emit("data-ready", {"rows": len(result)})  # notify all widgets
    return result
```

- JS `mica.broadcast(event, data)` — relays to all connected browser clients
- Python `mica.emit(event, data)` — broadcasts from server during an export/channel handler
- Receivers use `mica.on(event, callback)` (Pattern 3) to listen
- Use for: widget-to-widget coordination, cross-widget notifications

---

## Python API (Backend Side)

### Decorators

```python
import mica

@mica.render
def render(content, config):
    """Required. Return an HTML string.

    Args:
        content: The card file body (str)
        config:  Dict with project, canvas, filename keys
    """
    return "<div>Hello</div>"

@mica.export
def my_function(content, args):
    """Callable from browser via mica.call() or mica.send().

    Args:
        content: The card file body (str) at call time
        args:    Dict of arguments from the JavaScript call

    Returns:
        JSON-serializable value (sent back for mica.call; ignored for mica.send)
    """
    return {"ok": True}

@mica.channel
def my_stream(content, args, channel):
    """Bidirectional channel handler. Runs in its own thread.

    Args:
        content: The card file body (str)
        args:    Dict of arguments from the JavaScript openChannel call
        channel: Channel object with send(), receive(), close()
    """
    while True:
        msg = channel.receive()  # blocks until data arrives
        if msg is None:
            break  # browser closed the channel
        channel.send({"echo": msg})
```

### Server Bridge Functions

These functions let your Python code interact with the Mica server during `@mica.export` execution:

| Function | Description |
|----------|-------------|
| `mica.write(content)` | Overwrite this card's file content |
| `mica.write_file(filename, content)` | Write to any file in the current canvas |
| `mica.read_file(filename)` | Read a file from the current canvas (returns `str` or `None`) |
| `mica.log(message)` | Append a message to the canvas's `_log.log` |
| `mica.emit(event, data)` | Broadcast an event to all connected browser widgets |
| `mica.agent.chat(message)` | Send a message to the canvas's AI agent (returns response dict) |

### Context Available in Config

```python
@mica.render
def render(content, config):
    project  = config["project"]   # e.g. "my-project"
    canvas   = config["canvas"]    # e.g. "workspace"
    filename = config["filename"]  # e.g. "dashboard.my-widget"
```

---

## HTML Structure

Your `render()` function returns a single HTML string containing markup, styles, and scripts:

```python
@mica.render
def render(content, config):
    return """
<div class="my-widget">
    <h1>Hello</h1>
    <div id="output"></div>
</div>

<style>
.my-widget { padding: 16px; font-family: sans-serif; }
</style>

<script>
  // `mica` and `container` are available here
  const el = container.querySelector('#output');
  const data = await mica.call('get_data', {});
  el.textContent = JSON.stringify(data);
</script>
"""
```

### External Scripts and Stylesheets

You can include CDN scripts. The WidgetRuntime guarantees that **all external `<script src="...">` tags are fully loaded** before any inline `<script>` blocks execute.

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

### Using Third-Party Libraries (Critical)

When your widget uses a third-party library that has its own CSS (e.g., xterm.js, CodeMirror, Leaflet), follow these rules to avoid broken rendering:

**1. Inline the library's CSS — do NOT use `<link>` for it.**

CDN-loaded `<link>` stylesheets have unreliable timing. Even though WidgetRuntime waits for the download, the browser may not have *applied* the CSS rules to the DOM by the time your script runs. Libraries that measure DOM elements during initialization (like xterm.js measuring character dimensions) will get wrong values and break.

```python
# ✅ CORRECT: Inline the library CSS in a <style> tag
xtermcss = ".xterm{position:relative;...} .xterm-char-measure-element{visibility:hidden;...}"

return f"""
<div id="term" style="height:300px;"></div>
<style>{xtermcss}</style>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script>
  var term = new Terminal();
  term.open(container.querySelector('#term'));
</script>
"""
```

```html
<!-- ❌ WRONG: CDN link — CSS may not be applied when term.open() runs -->
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css"/>
```

**2. Use inline `style` attributes for widget layout — do NOT use `<style>` rules.**

Widget `<style>` rules are global and share scope with the library's CSS. Rules like `overflow: hidden`, `position`, `height`, or even `* { box-sizing: border-box }` can interfere with how the library positions its internal elements (viewports, canvases, measurement spans). Use inline `style` attributes for your widget's own layout to keep it isolated from the library's CSS.

```html
<!-- ✅ CORRECT: Inline styles for widget layout -->
<div style="display:flex;flex-direction:column;height:300px;overflow:hidden;">
  <div style="padding:8px;background:#161b22;">Title bar</div>
  <div id="term" style="flex:1;min-height:0;"></div>
</div>
<style>/* Only library CSS here */</style>

<!-- ❌ WRONG: <style> rules for widget layout — will conflict with library CSS -->
<style>
  .my-wrapper { overflow: hidden; height: 300px; }
  #term { flex: 1; min-height: 0; overflow: hidden; }
</style>
```

**3. Use fixed pixel heights for containers — do NOT use `height: 100%`.**

Widgets render inside `.widget-runtime` which has no explicit height. `height: 100%` resolves to 0, causing libraries like xterm.js to calculate 0 rows. Always use a fixed pixel height on the outermost container.

```html
<!-- ✅ CORRECT: Fixed pixel height -->
<div id="term" style="height:260px;"></div>

<!-- ❌ WRONG: Percentage height — resolves to 0 -->
<div id="term" style="height:100%;"></div>
```

The card body has `max-height: 280px` with `12px` vertical padding (content area: `268px`). Keep your widget height ≤ 260px to fit without clipping.

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

The extension is how Mica knows which `render.py` to use. A file named `overview.my-widget` will be rendered by the `my-widget` card class because `.my-widget` is registered in the manifest.

**Multiple instances are natural**: `overview.dashboard` and `sales.dashboard` are both rendered by the `dashboard` class.

---

## Complete Example: Counter Widget

```python
import mica
import json

@mica.render
def render(content, config):
    count = 0
    try:
        count = int(content.strip()) if content.strip() else 0
    except ValueError:
        pass

    return f"""
<div class="counter">
    <span id="count">{count}</span>
    <button id="inc">+</button>
    <button id="dec">-</button>
</div>

<style>
.counter {{ display: flex; align-items: center; gap: 12px; padding: 16px; }}
.counter span {{ font-size: 2rem; font-weight: bold; min-width: 3ch; text-align: center; }}
.counter button {{
    width: 40px; height: 40px; border-radius: 50%; border: 1px solid #555;
    background: #2a2a3e; color: white; font-size: 1.2rem; cursor: pointer;
}}
.counter button:hover {{ background: #3a3a5e; }}
</style>

<script>
  const countEl = container.querySelector('#count');

  container.querySelector('#inc').addEventListener('click', async () => {{
    const result = await mica.call('increment', {{}});
    countEl.textContent = result.count;
  }});

  container.querySelector('#dec').addEventListener('click', async () => {{
    const result = await mica.call('decrement', {{}});
    countEl.textContent = result.count;
  }});
</script>
"""

@mica.export
def increment(content, args):
    count = int(content.strip() or "0") + 1
    mica.write(str(count))
    return {"count": count}

@mica.export
def decrement(content, args):
    count = max(0, int(content.strip() or "0") - 1)
    mica.write(str(count))
    return {"count": count}
```

## Reference Examples

Look at existing card classes for more patterns:
- `card-classes/chat/render.py` — Chat with message history, agent integration
- `card-classes/todo/render.py` — Todo list with assignments
- `card-classes/html/render.py` — Raw HTML passthrough
- `.mica/.card-classes/terminal/render.py` (in any project) — xterm.js terminal with PTY channel (example of third-party library integration with inlined CSS)
