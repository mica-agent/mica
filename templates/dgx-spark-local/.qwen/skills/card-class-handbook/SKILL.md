---
name: card-class-handbook
description: Knowledge reference for authoring Mica card classes — the CANONICAL CARD.JS shape, CARD_SHIM contract (`container` and `mica` are injected globals — DO NOT redeclare), metadata.json schema, mica.* API, channel handlers, and pitfalls. Load this BEFORE calling `mica_create_class` or `mica_edit_class_file`. The handbook is the contract those tools enforce; without it in working memory, common violations (top-level CARD_SHIM-global redeclaration, IIFE wrapping, `document.getElementById` instead of `container.querySelector`) recur and burn iteration cycles fixing post-write lint errors. Dispatched from `develop` step 4a.
---

# Card-Class Handbook

A **card class** defines a UI component. An **instance** is a file the class renders.

A card class is four files at `.mica/card-classes/<ext>/`:
`metadata.json`, `card.html`, `card.js`, `card.css`. Authored via
the `mica_create_class` tool (NOT raw `write_file`). Verified with
`render_capture`.

This handbook is the knowledge object you load before calling
`mica_create_class` or `mica_edit_class_file` — it teaches the
CANONICAL CARD.JS shape and CARD_SHIM contract those tools enforce.
The verb "card-class-handbook" in the dispatch language refers to
loading this handbook into context, not to a separate action: the
*action* is `mica_create_class`; this handbook is the *rules*.

Loaded from `develop` step 4a *after* spec + approval land. The
universal build flow — research → spec → approval → plan — lives in
`develop/SKILL.md`; don't restate it here. For cross-skill discipline
(reading, library reuse, API discipline, decomposition gates,
approval flow, naming) see `.qwen/skills/_conventions.md`. Tenet
numbers below refer to ARCHITECTURE.md / CLAUDE.md.

## Before creating: check the registry

`mica_list_classes()` returns the project-scoped + built-in classes
already available. If a listed class matches your intent, use it.
Do **not** create a project-scoped copy of a built-in (it just
shadows the built-in for this project with no benefit). If a class
might fit but you're not sure, `read_file
.mica/card-classes/<name>/metadata.json` (or the upstream
`card-classes/<name>/metadata.json` for built-ins) before deciding.

## Author atomically with `mica_create_class`

Card classes are authored via the `mica_create_class` tool, NOT raw `write_file`.
The tool owns the directory location, name shape, and `metadata.json` schema —
the framework cannot place files at wrong paths or with wrong metadata when
you go through the tool. Raw `write_file` to `.mica/card-classes/...` is
reserved for *editing existing* class files; class creation is exclusively
through this tool.

Pull verified `scripts` / `styles` URLs from the canvas decision that
`develop` step 1 wrote (`discover-dependency` records them in spec.md /
decisions.md). Don't write CDN URLs from memory.

```
mica_create_class({
  name: "world-clock",                  // dir name; lowercase + dashes only, no dots
  badge: "WCK",                         // 1-4 char abbreviation
  defaultTitle: "World Clock",
  scripts: ["https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"],
  styles:  ["https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"],
  card_html: "<div class=\"card-world-clock\">...</div>",
  card_js:   "/* see CANONICAL CARD.JS pattern below */",
  card_css:  ".card-world-clock { ... }",  // optional
})
```

Returns `{ ok: true, dir: ".mica/card-classes/world-clock/", paths: { ... } }`.

If you omit `card_js` entirely, the tool writes a working stub in the
canonical shape (below) — edit the body via `mica_edit_class_file`,
don't rewrite from scratch.

**Re-call to UPDATE metadata in place.** When you need to change a
dependency, badge, defaultTitle, scripts, styles, handler, or
primaryFile on an existing class, just call `mica_create_class` again
with the same `name` and same `extension`. The metadata.json updates;
card.html / card.js / card.css are preserved (only touched if you pass
explicit content). **DO NOT** delete-then-recreate to change metadata —
that wastes 5+ tool calls and forces you to rewrite card.html and
card.js from stubs. Only changing `extension` requires a delete (it's
a rename that would orphan existing instances).

Companion tools:
- `mica_edit_class_file({ class, file: "card.js"|"card.html"|"card.css", content?, old_string?, new_string? })` — edit a class file with PRE-WRITE lint. For card.js, the lint that catches top-level redeclaration of CARD_SHIM globals (`mica`, `container`), ESM `import`/`export`, and other common mistakes runs BEFORE the write. Lint failures come back as a same-turn tool error so you can fix and retry without burning a card-error broadcast cycle. Use this INSTEAD of `write_file`/`edit` when modifying class files.
- `mica_create_card_instance({ class_extension, filename })` — creates an
  instance on the canvas at the right path.
- `mica_delete_card_instance({ filename })`
- `mica_delete_class({ name, force? })`
- `mica_list_classes()` — see what's registered before creating.

## CANONICAL CARD.JS — copy this shape

Every `card.js` you write should look like the counter below. Six lines do
six things; the names of those six things are the structure of the file.

```js
// 1. Query into the injected `container`. It's a CARD_SHIM global pointing
//    at this card's DOM root — your code uses it directly.
const titleEl = container.querySelector('.title');
const btnEl   = container.querySelector('button');

// 2. Script-scoped state — any name except `container` or `mica`.
let count = 0;

// 3. Functions at script scope. The runtime wraps your file in a closure;
//    that's already your "module." Plain function declarations, no IIFE.
function render() {
  titleEl.textContent = String(count);
}

// 4. DOM events on `container` or its descendants. The shim auto-cleans
//    listeners on unmount, so you don't track them yourself.
btnEl.addEventListener('click', () => {
  count += 1;
  render();
});

// 5. Anything that needs explicit teardown (timers, intervals, fetch
//    abort controllers, websockets, library disposers) → `mica.onDestroy`.
const id = setInterval(render, 1000);
mica.onDestroy(() => clearInterval(id));

// 6. First render at the bottom of the file.
render();
```

**Every card.js you write keeps this shape.** Counter, world clock, Three.js
scene, Leaflet map — only the body of `render()` and the contents of step 5
change. The skeleton is the same. When the body grows, split `render()` into
smaller functions; the six-step skeleton still wraps them.

Cards that load a library (Three.js, Leaflet) layer two extra patterns inside
the same skeleton:

- **Library init goes BETWEEN steps 1 and 2** — once-only setup like
  `const renderer = new THREE.WebGLRenderer();` `container.appendChild(renderer.domElement);`. Then your script-scoped state in step 2 references it.
- **Library teardown goes IN step 5** — `mica.onDestroy(() => { renderer.dispose(); /* dispose textures, geometries, controls */ });`. Without this, the canvas leaks GPU memory across remounts.

When `discover-dependency` selects a third-party library, run
`mica_install_skills` for it (see `discover-dependency/SKILL.md` step 4). The
installed library skill describes its disposers, init-order quirks, and
version-specific gotchas — read that skill BEFORE filling in the body, so
the body lands right the first time.

If you're about to write `const container = ...`, `import {...}`, `export
const`, or `(function(){ ... })()`, you've left the canonical shape. Stop
and rewrite the section to match.

## Reference: file roles and globals

### Required files

| File | Purpose |
|---|---|
| `metadata.json` | extension, badge, title, dependencies |
| `card.html` | static markup — IDs for anything `card.js` updates |
| `card.js` | behavior — runs as top-level code |
| `card.css` | scoped styles (optional) |
| `context.md` | class-level AI context (optional) |

`card.html` is a **fragment**, not a document. The server inlines
`card.js` and `card.css`; do not put `<script src="card.js">` or
`<link rel="stylesheet" href="card.css">` or `<!DOCTYPE>`/`<html>`
in `card.html`. External libraries go in
`metadata.json.dependencies.scripts`/`.styles`.

**Dependencies — invoke `discover-dependency` FIRST.** If your card needs ANY external library (Three.js, Chart.js, Leaflet, D3, anything), your next action is to invoke the `discover-dependency` skill BEFORE writing card.js or metadata.json. The skill does the curl-verification, picks a working CDN URL, and records the decision on canvas. Don't write CDN URLs from memory — it's how stale versions, ESM-only URLs that don't load in card.js's classic-script context, and hallucinated paths sneak in. One curl-verified UMD URL beats three rounds of "Failed to load dependency" debugging.

### `metadata.json`

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "primaryFile": "counter.json",
  "dependencies": { "scripts": [], "styles": [] }
}
```

Required fields and their silent-failure modes if omitted:

| Field | Silent failure if omitted |
|---|---|
| `extension` | Auto-repaired from directory name with a warning. Always include. |
| `badge` | Card renders with a `???` placeholder on the canvas. |
| `defaultTitle` | Title falls back to raw filename; functional but ugly. |
| `dependencies` | No scripts/styles loaded. |

`primaryFile` is optional (only for classes that render a
specific filename inside a directory instance). Do **not** include
`name`, `description`, or `version` — those are package.json-shaped
fields the framework ignores.

### CARD_SHIM globals in `card.js`

Available without import:

| Global | Shape |
|---|---|
| `container` | this card's DOM element. `container.querySelector(...)` is scoped here |
| `mica.filename` | instance file name **canvas-relative** (e.g. `"my.counter"` — no `canvas/` prefix). Pinned files outside canvas surface with `../` (e.g. `"../docs/notes.md"`) |
| `mica.windowId` | stable id for this browser **tab** |
| `mica.cardId` | stable id for this card **instance** |
| `mica.isSelfEcho(event)` | `(event) => boolean` — true if event was caused by THIS card writing |
| `mica.getContent()` | `async () => string` — read the instance file |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` — **canvas files only** (siblings + pinned) |
| `mica.files.listAll()` | same shape, **project-wide** — includes `.mica/`, `.qwen/`, etc. Use only for debug/inspector cards |
| `mica.files.read(path)` | `async (path) => string` — paths are **canvas-relative** (see Path addressing below) |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` — canvas-relative path |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — canvas-relative path; auto-routes by type, parents auto-created |
| `mica.files.delete(path)` | `async (path) => void` — canvas-relative path |
| `mica.files.url(path)` | `(path) => string` — for `<img src>`, `<embed>`, downloads — canvas-relative path |
| `mica.cardClasses.list()` | `async () => [{ name, builtIn, format }]` |
| `mica.fetch(url, opts?)` | server-proxied HTTP — see § External HTTP |
| `mica.on(event, cb)` | subscribe; events: `file-changed`, `file-created`, `file-deleted`, `layout-changed`, `card-error` |
| `mica.onDestroy(cb)` | cleanup on unmount |
| `mica.openChannel(label, args)` | bidirectional stream to a server plugin |
| `mica.refresh()` | reload the card |
| `mica.reportError(message)` | surface a red "Send to agent" bubble in chat cards |

The `mica.files.*` and `mica.cardClasses.*` namespaces are
Proxy-guarded — calling a method that doesn't exist throws
`TypeError: mica.files has no method 'X'. Known: ...`. To append:
read → concat → write.

### Path addressing

Cards live on the canvas. All `mica.files.*` paths and `mica.filename`
are **canvas-relative**, like a Unix shell with the canvas as `cwd`:

| You write | Resolves to |
|---|---|
| `"foo.bar"` (bare) | `<canvasRoot>/foo.bar` — sibling card on the canvas |
| `"sub/foo"` | `<canvasRoot>/sub/foo` — canvas subdirectory |
| `"../foo"` | one level above canvas — pinned files, project root |
| `"/foo"` | project-root absolute (rare; bypass canvas entirely) |
| `"../.mica/X"` | reach into Mica's internal state (use at your own risk; schema may change between Mica versions) |

Self-reference is prefix-free:
```js
const data = await mica.files.read(mica.filename);          // own instance file
await mica.files.write(mica.filename, JSON.stringify(state)); // round-trip
```

Sibling-card reference is a bare name — no `canvas/` prefix to remember
or hardcode. If a card's logic ever wants to construct a sibling path,
the bare name IS the path:
```js
const referenced = await mica.files.read("test-dsm.data-source-monitor");
```

Event payloads (`file-changed`, `file-created`, `file-deleted`,
`card-error`) carry `event.filename` already canvas-relative, so
`event.filename === mica.filename` works for own-file filtering.

`container` and `mica` are injected globals. **Do not redeclare
them** with top-level `const`/`let` — the runtime wraps your
script in a closure and the redeclaration produces a hard
`SyntaxError` at mount, with the card never starting. Read the
mica.* table and use exact signatures (tenet 16); when a method
isn't listed, it doesn't exist.

### Event listeners — prefer `container`, the shim handles cleanup

For DOM events, attach to `container` (or one of its descendants)
whenever possible, NOT `document` or `window`:

```js
container.addEventListener('keydown', onKey);   // ✓ scoped, auto-cleaned
container.querySelector('#btn').addEventListener('click', onClick);  // ✓
```

The shim auto-cleans listeners attached via `window.addEventListener`,
`document.addEventListener`, `setInterval`, `setTimeout`, and
`requestAnimationFrame` — they all unregister when the card unmounts.
If you must use `document` or `window` (e.g., a global keyboard
shortcut, or a non-bubbling event you can't catch from `container`),
just use them — the shim wraps them transparently.

What you should NOT do: attach via `_rd.addEventListener(...)` or
some other direct reference that bypasses the shim. Anything that
escapes the shim's wrap leaks across re-renders and accumulates a
stack of stale listeners over the page's lifetime — a real failure
mode that caused "weird keyboard behavior" until the shim was
extended to cover `document` listeners (2026-05-02). Don't get
clever; just use `document` / `window` / `container` directly.

If you have a callback you specifically need to clean up at a
different time than card unmount, use `mica.onDestroy(unsubFn)`
to register the cleanup, OR keep the unsubscribe handle and call
it explicitly when needed (e.g., the cleanup pattern at
[card.js:411](#L411) below).

## External HTTP via `mica.fetch(url, opts)`

Cards cannot hit most public APIs directly — CORS blocks them.
`mica.fetch` proxies through Mica's server. SSRF-protected
(blocks loopback / private / link-local / cloud-metadata IPs).
Rate-limited 120 req/60s per project. 10 MB cap, 60 s max
timeout.

The Promise **always resolves**. Check `errorCode` first
(our-side: SSRF, DNS, timeout, rate limit), then `status`
(upstream HTTP). Body is always a string.

```js
const r = await mica.fetch('https://api.example.com/items', {
  method: 'POST',
  headers: { 'Authorization': 'Bearer ' + KEY },
  body: JSON.stringify({ name: 'foo' }),
  timeout: 15000,
});
if (r.errorCode) { /* our-side failure: r.error human-readable */ }
else if (r.status >= 400) { /* upstream HTTP error */ }
else { const data = JSON.parse(r.body); /* ... */ }
```

`errorCode` values: `url_invalid`, `ssrf_blocked`, `dns_error`,
`connect_error`, `timeout`, `rate_limited`, `response_error`,
`internal_error`. `rate_limited` includes `retryAfterMs` —
respect it; don't fire-loop. For binaries (PDFs, images), use
`mica.files.url()` + `<img>`/`<embed>`, not `mica.fetch`.

For Mica's own `/api/*`, prefer `mica.files.*` helpers (auto
URL-encode, set `source`/`cardSource`). Raw `fetch('/api/...')`
works too — the runtime auto-injects `X-Mica-Project`.

## WebSocket events via `mica.on(event, cb)`

| Event | Payload |
|---|---|
| `file-changed` | `{ filename, source, cardSource? }` |
| `file-created` | `{ filename, source, cardSource? }` |
| `file-deleted` | `{ filename }` |
| `layout-changed` | `{ source, device }` |

`source` is the writer's `mica.windowId` (per tab), `"agent"`,
or `"external"` (git pull, manual edit). `cardSource` is the
writer's `mica.cardId`. To skip self-echoes use
`mica.isSelfEcho(e)` — **not** `e.source !== mica.windowId`
(windowId is per-tab, so it suppresses sibling cards in the same
tab).

## Server-side channel handlers

Some card classes need bidirectional duplex streams — terminal
PTYs, streaming LLM completions, agent loops. Existing
handlers wired to fixed extensions (no work to use them):

| Card class | Handler | What it does |
|---|---|---|
| `.chat` | Qwen agent loop | Project-wide chat with skills + canvas baseline |
| `.claude` | Claude Code agent loop | Same shape, Claude SDK |
| `.terminal` | PTY (node-pty) | Terminal |
| `.llm-chat` | Streaming chat | Generic LLM chat |
| `.skills` | SKILL.md authoring | Propose / apply |
| `.canvas-back` | canvas-back.md | Propose / apply |

### Reusable handlers — **do NOT write a server plugin**

Mica ships **reusable parameterized handlers** that any card class
can opt into via `metadata.json`. Adding a new card class that
needs server-side capability requires zero server code in most
common cases.

**Two reusable handlers are most relevant for new card classes:**

| Handler | What it gives you | When to pick |
|---|---|---|
| `llm-direct` | Streaming chat against an LLM with a fixed system prompt + per-turn user message. Handler manages the streaming round-trip. | LLM-driven cards: persona-chat, summarizer, single-purpose assistant. |
| `process` | Spawn a long-lived subprocess; bidirectional stdin/stdout/stderr; lifecycle-driven start/stop. | Wrapping CLI tools (nvidia-smi, ffmpeg, autoresearch), language servers, daemons, polling tasks. |

**The pattern (same for both):**

1. **Discover.** `curl http://localhost:3002/api/handlers` returns
   every reusable handler with its `name`, `description`,
   `whenToUse`, `argsSchema`, `sendShapes`, `recvShapes`. Read
   `whenToUse` to pick.
2. **Pick** by `whenToUse`. If nothing fits, flag this to the
   human — agents do not write server plugins.
3. **Wire.** In your card class `metadata.json` set
   `"handler": "<name>"`. In `card.js` call
   `mica.openChannel("session", args)` and send/receive
   per `sendShapes` / `recvShapes`.
4. **Trust the schema.** Bad args fail at the channel boundary
   with a structured error citing the failing path. Treat that
   error as ground truth — fix the args, don't argue with it.

**Critical reminder — `metadata.handler` is required when you use
a reusable handler.** Without the field, the framework auto-routes
to a handler matching the card class extension; if none exists,
channel_open fails with "No handler registered for: <ext>.
Available handlers: ..." (the error names the fix). The recurring
gotcha: `mica_create_class` accepts a `handler` parameter — pass
it explicitly when the card needs a reusable handler.

#### LLM-driven cards — `metadata.handler: "llm-direct"`

`card-classes/persona-chat/` is a complete working reference —
three small files, no server code, system prompt comes from the
instance file content. Read once for the shape; consult
`/api/handlers` for everything else.

#### Long-running subprocess cards — `metadata.handler: "process"`

The `process` handler is **lifecycle-driven**: the subprocess is
NOT spawned at channel-open time. Card opens the channel first
(no required args), then sends a `start` message with the
command + args + cwd + env when it's ready. This lets the same
channel survive multiple start/stop cycles and lets the card
load per-instance config before invoking.

**Card.js shape (canonical):**

```js
const ch = mica.openChannel("session");  // no args at open time
let running = false;

ch.onData((msg) => {
  if (msg.type === "idle")     { /* nothing running yet — show Start UI */ }
  if (msg.type === "started")  { running = true;  /* show pid, set status running */ }
  if (msg.type === "stdout")   { /* append msg.data to log pane */ }
  if (msg.type === "stderr")   { /* append msg.data with stderr styling */ }
  if (msg.type === "exit")     { running = false; /* code, signal */ }
  if (msg.type === "error")    { /* spawn or runtime error — surface to user */ }
});

function start() {
  ch.send({
    type: "start",
    command: "nvidia-smi",
    args: ["--query-gpu=...", "-l", "1"],
    cwd: "/workspaces/.cache/<tool>",          // optional; defaults to project root
    env: { "MY_KEY": "${MY_KEY}" },             // optional; ${VAR} interpolated
  });
}

function stop() { ch.send({ type: "signal", signal: "SIGTERM" }); }

mica.onDestroy(() => { try { ch.close(); } catch {} });
```

**Common patterns:**

- **Tool data → chart.** Subprocess emits CSV/JSON to stdout; card parses each `stdout` event, appends to a chart's data series.
- **Persistent service.** `start` once, send periodic `input` messages with line-delimited commands; receive responses on `stdout`.
- **Restart on config change.** When the user changes the instance file, send `signal` + wait for `exit` event + send fresh `start` with new args.

**On attach (page reload, second tab opens the card):** the
handler emits `{type: "idle"}` if no subprocess is running, OR
replays scrollback (`stdout` data) + a fresh `started` event if
one is. Card UI just appends — no special-case "scrollback"
handling needed.

**Don't:**
- Don't spawn at openChannel time. The handler doesn't accept
  command/args/cwd in openChannel args. Use `start` messages.
- Don't send another `start` while the subprocess is running.
  Send `signal`, wait for `exit`, then `start` again. Two-stage
  restart.
- Don't use this for stateless tool calls the agent should
  invoke directly. Those go in `<project>/.mica/tools.json` for
  the cli-mcp adapter (see `add-third-party-tool` skill). The
  process handler is for stateful, persistent subprocesses
  driven by card UI.

**Failure mode to recognize:** if you see a card-error broadcast
of "No handler registered for: <your-extension>", the
`metadata.handler` field is missing. The error message tells you
the available handlers — pick the right one, set the field, save
metadata.json, retry.

The legacy `.llm-chat` / `.terminal` / `.chat` / `.claude`
extensions stay routed by file extension as in the table above.
The `metadata.handler` mechanism is additive and only kicks in
when present.

## Worked example — counter card

`.mica/card-classes/counter/metadata.json`:

```json
{
  "extension": ".counter",
  "badge": "CTR",
  "defaultTitle": "Counter",
  "dependencies": { "scripts": [], "styles": [] }
}
```

`.mica/card-classes/counter/card.html` (fragment, top-level
`<div>`):

```html
<div style="display:flex;flex-direction:column;gap:8px;padding:12px">
  <div id="display" style="font-size:32px;text-align:center">0</div>
  <button id="inc">+</button>
</div>
```

`.mica/card-classes/counter/card.js` (top-level code, no class,
no `export`):

```js
const displayEl = container.querySelector('#display');
const btn = container.querySelector('#inc');

let count = parseInt(await mica.getContent()) || 0;
displayEl.textContent = count;

btn.addEventListener('click', async () => {
  count++;
  displayEl.textContent = count;
  await mica.files.write(mica.filename, String(count));
});

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    mica.refresh();
  }
});

mica.onDestroy(() => { unsub(); });
```

Instance: create `docs/my.counter` with content `0`. Card
appears on the canvas.

## Verify with `render_capture`

`render_capture({ filename: "canvas/my.<extension>" })` — inspect
the PNG. JSON validity and `node -c` only prove syntax; only a
visual check proves the card mounted, the layout works, and no
error banner appears.

For every CDN script/style URL and every URL hardcoded in
card.js, `curl -sI -L <url> | head -1` to confirm reachability
before declaring done. Full tier table in `_conventions.md`
§ API discipline. Append a `## Smoke test results` row to
spec.md for each URL.

## Pitfalls

### Card class not appearing? Never restart.

The file watcher hot-reloads card-class directories on disk
change. The fix is never a server restart.

| Symptom | Real cause |
|---|---|
| `curl /api/card-classes` doesn't list it | The endpoint is project-scoped. Use `mica.cardClasses.list()` from inside a card, or pass `-H 'X-Mica-Project: <project>'`. |
| Instance renders as TXT badge | `extension` in `metadata.json` doesn't match the parent directory name. |
| Card mounts as a blank box | `card.html` rendered but `card.js` errored. Check chat for a `[card-error]` broadcast — usually a syntax error or a redeclared CARD_SHIM global. |
| Edit doesn't update | Click off and back, or make a no-op edit to the instance file to trigger a `file-changed` event. |

If you genuinely think a `server/*.ts` change needs a restart,
ask the user inline — don't run `scripts/restart.sh` yourself
(you live inside the backend's process tree).

### "Failed to load dependency: <url>" loop

When the chat surfaces this card-error, the URL itself is the
prime suspect. **Do not** re-read `metadata.json` looking for
clarity — the file contains exactly the URL that's failing.
Re-reading produces no new information; the loop runs until the
SDK kills it.

1. Verify with `curl -sI -L "<url>" | head -1`. If 404, the URL
   is hallucinated.
2. Find the real URL via npm registry
   (`curl -s https://registry.npmjs.org/<pkg>` for `dist-tags.latest`
   and `main`) or jsdelivr
   (`https://www.jsdelivr.com/package/npm/<pkg>` lists every
   tarball file).
3. Update `metadata.json`, ask the user to refresh.

Time budget: ONE round of curl + one metadata edit. If the
second URL also 404s, stop and ask the user.

### `render_capture` screenshot is black for WebGL / Three.js cards

`render_capture` defaults to `html2canvas`, which reads `<canvas>`
content via `canvas.toDataURL()`. WebGL contexts (Three.js, regl,
PixiJS in WebGL mode, Babylon, raw WebGL) return blank from
`toDataURL` because the GPU discards the back buffer after compositing
unless preserved. Result: captures come back transparent / black
even when the user sees the scene rendering correctly on screen.

**Preferred fix — register `mica.onCapture(cb)`.** The shim
exposes a snapshot hook that the screenshot pipeline calls *before*
falling back to `html2canvas`. Inside the callback, render
on-demand and return a dataURL. No `preserveDrawingBuffer` flag
needed; the pipeline accepts whatever you produce.

```js
mica.onCapture(() => {
  // Render once at capture time so the back buffer is current.
  renderer.render(scene, camera);
  return canvasEl.toDataURL("image/png");
});
```

The hook is per-card, automatically cleaned up on unmount, and
applies a 5-second timeout. If the callback throws or times out
the pipeline falls back to `html2canvas` and you get the blank-
canvas symptom anyway, so make the body fast and synchronous
(or at least quick to resolve). Works for any rendering tech —
OffscreenCanvas, regl, Babylon, video elements, anything that
can produce a dataURL.

**Fallback fix (if for some reason you don't register `onCapture`):**
construct the WebGL renderer with `preserveDrawingBuffer: true`.
This keeps the back buffer readable so html2canvas's toDataURL
returns the last frame.

```js
const renderer = new THREE.WebGLRenderer({
  canvas: canvasEl,
  antialias: true,
  preserveDrawingBuffer: true,  // fallback for non-hook capture
});
```

Symptom that points here: `render_capture` describes the canvas
as "completely black" / "blank" / "transparent" while the user
confirms they see content on screen. Don't add debug cubes /
backgrounds / wrappers chasing a phantom — register the hook (or
flip the flag) and re-capture.

## References

- `.qwen/skills/develop/SKILL.md` — universal build flow
  (research, spec, approval, plan-or-inline) that gates this
  skill.
- `.qwen/skills/_conventions.md` — reading, reuse, API
  discipline, dispatch, decomposition gates, approval flow,
  naming.
- `ARCHITECTURE.md` — authoritative `mica.*` API surface and
  framework internals.
- `card-classes/llm-chat/` + `server/plugins/llmChat.ts` —
  reference channel-handler pair.
