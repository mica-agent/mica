---
name: create-card-class
description: Build, create, make, or implement a card, widget, visualization, chart, dashboard, calculator, viewer, browser, editor, game, or any interactive UI that appears on the Mica canvas. Use whenever the user asks for something visual or interactive, even if they don't say "card".
---

# Create a Card Class

A **card class** defines a UI component. An **instance** is a file the class renders.

A card class is four files at `.mica/card-classes/<ext>/`:
`metadata.json`, `card.html`, `card.js`, `card.css`. Build path:
copy the skeleton → edit in place → verify with `render_capture`.
You never write any of the four files from scratch.

For cross-skill discipline (reading, library reuse, API
discipline, decomposition gates, approval flow, naming) see
`.qwen/skills/_conventions.md`. Tenet numbers below refer to
ARCHITECTURE.md / CLAUDE.md.

## Step 0 — Check what already handles this

Before authoring, introspect the registry. Reuse beats reinvent
(tenet 15).

```javascript
const classes = await mica.cardClasses.list();
// → [{ name: "mmd", builtIn: true, format: "html" }, ...]
```

If any listed class matches your intent, use it. Do **not**
create a project-scoped copy of a built-in (it just shadows the
built-in for this project with no benefit).

If a class might fit but you're not sure, read its metadata or
spec before deciding:

```
GET /api/card-classes/{name}/metadata.json
GET /api/card-classes/{name}/spec.md
```

## Step 1 — Spec, then approval

Before any `cp -r` of the skeleton, draft `canvas/spec.md` and
post the approval gate (tenet 11 + tenet 14, see `_conventions.md`
§ Approval flow). Implementation starts AFTER the user replies.

Required spec.md sections:

- `# <Card name>` + a one-paragraph elevator pitch
- `## What it does` — user-visible behavior
- `## Files` — the four card-class files with one-line roles
- `## Dependencies` — every external library + Tier-1 verified URL
- `## Subproblems and their solutions` — one row per recognizable
  subproblem (`discover-library` per subproblem, not per card)
- `## Behavior` — interactions, tick rates, persistence
- `## Out of scope for v1`
- `## Smoke test results` (filled after build)
- `## Assumptions` (Tier-3 documented assumptions)

Approval gate posts a one-liner: *"Drafted in `canvas/spec.md` —
review and OK to build?"* Don't paste the spec content; user reads
it on the canvas.

**When to gate vs skip — library use, not line count.** Library
choice is the highest-leverage decision a card-class build makes
(tenet 16: APIs as authored, validate before relying). The spec
is where library choices get surfaced and Tier-1 verified BEFORE
metadata.json is written.

**Always gate (draft spec.md, get approval) when ANY of these hold:**

- The card needs any external library — Three.js, Chart.js,
  Leaflet, FullCalendar, CodeMirror, Sortable.js, Mermaid, Marked,
  D3, Plotly, etc. Library version + URL is what the spec
  surfaces and what Tier-1 verifies.
- The user's request uses words that imply substantial
  visualization or interaction: *3D, scene, chart, graph, map,
  calendar, editor, game, animation, viewer, dashboard,
  visualization, render*. These almost always need libraries
  even if the user doesn't say so.
- The card has multiple subsystems (rendering + persistence +
  events + cleanup) — the spec's `## Subproblems and their
  solutions` table is the place to surface those before code.

**Skip the gate ONLY when ALL of these hold:**

- The card uses no external libraries (pure DOM + `mica.*` APIs).
- Total expected code is < ~50 lines across all four files.
- The user explicitly said "small", "trivial", "just a", or
  similar (e.g., "just a counter card", "trivial toggle").

Counter, toggle, single-button cards with no dependencies are
genuinely small and the spec adds friction. Anything that touches
a library — including the simplest chart or 3D scene — needs the
spec gate to do library research right the first time. Skipping
the gate on library-using cards produces stale-prior URLs and
broken integrations; the iteration cost dwarfs the spec-drafting
cost.

## Step 2 — Copy the skeleton, edit in place

```bash
cp -r /workspaces/mica/templates/_card-class-skeleton .mica/card-classes/<your-name>
```

Then `edit` the four files to replace `REPLACE_ME` placeholders
and add behavior. Verify zero placeholders remain:

```bash
grep -nR "REPLACE_ME" .mica/card-classes/<your-name>/
# expect: no output
```

Until the placeholders are gone, the resolver compares
`extension` to the directory name and the card never loads.

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
| `mica.filename` | instance file path (e.g. `"docs/my.counter"`) |
| `mica.windowId` | stable id for this browser **tab** |
| `mica.cardId` | stable id for this card **instance** |
| `mica.isSelfEcho(event)` | `(event) => boolean` — true if event was caused by THIS card writing |
| `mica.getContent()` | `async () => string` — read the instance file |
| `mica.files.list()` | `async () => [{ path, isFile, isFolder, size, modifiedAt }]` |
| `mica.files.read(path)` | `async (path) => string` |
| `mica.files.readBinary(path)` | `async (path) => ArrayBuffer` |
| `mica.files.write(path, content)` | `async (path, content: string \| ArrayBuffer \| Uint8Array \| Blob \| File) => void` — auto-routes by type, parents auto-created |
| `mica.files.delete(path)` | `async (path) => void` |
| `mica.files.url(path)` | `(path) => string` — for `<img src>`, `<embed>`, downloads |
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

`container` and `mica` are injected globals. **Do not redeclare
them** with top-level `const`/`let` — the runtime wraps your
script in a closure and the redeclaration produces a hard
`SyntaxError` at mount, with the card never starting. Read the
mica.* table and use exact signatures (tenet 16); when a method
isn't listed, it doesn't exist.

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
PTYs, streaming LLM completions, agent loops. Existing handlers
(no work to use them):

| Card class | Handler | What it does |
|---|---|---|
| `.chat` | Qwen agent loop | Subagent dispatch + tools |
| `.claude` | Claude Code agent loop | Same shape, Claude SDK |
| `.terminal` | PTY (node-pty) | Terminal |
| `.llm-chat` | Streaming chat | Reference impl for "just talk to an LLM" |
| `.skills` | SKILL.md authoring | Propose / apply |
| `.canvas-back` | canvas-back.md | Propose / apply |

If your job overlaps, **reuse** that card class (tenet 15).
Don't write a custom handler for what `.llm-chat` already covers.

If you genuinely need a custom handler — different streaming
contract, server-side parsing, multi-step pipeline — two
additions on top of the standard card class:

**(1) `server/plugins/<name>.ts`** exports a factory:

```ts
import type { ChannelHandler, SessionContext } from "../channelManager.js";

export function create<Name>Handler() {
  return async function factory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const history: Message[] = [];
    return {
      onAttach(clientId) {
        ctx.sendTo(clientId, { type: "history", messages: history });
      },
      async onData(_clientId, data) {
        // ctx.broadcast({ type: "delta", content: ... })
      },
      onDestroy() { /* session ended */ },
    };
  };
}
```

**(2) Register in `server/index.ts`:**

```ts
channelManager.registerHandler("<class-name>", create<Name>Handler());
```

`<class-name>` = file extension without the leading dot. The
server routes by extension, **not** by the string passed to
`mica.openChannel(label, args)` — the label is decorative and
most handlers ignore it.

Reference: `card-classes/llm-chat/card.js` and
`server/plugins/llmChat.ts` (~140 lines each side; canonical
send/onData/history shape with abort and SSE parsing).

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

## Verify before declaring done

Before saying the card is ready, smoke-test every external
dependency (tenet 16). The full tier table is in
`_conventions.md` § API discipline. Quick form:

- **Tier 1 — reachability.** For every CDN script/style URL in
  `metadata.json.dependencies` and every tile-server / data URL
  hardcoded in `card.js`: `curl -sI -L <url> | head -1` →
  expect `HTTP/2 200` (302 chains fine if final is 200). Common
  failures: missing `@scope/` prefix, version that never
  published, wrong subpath inside the package.
- **Tier 2 — shape.** For every REST endpoint or library global:
  call once with sample params, confirm the fields/globals the
  card uses actually exist (`L.terminator` vs `L.Terminator`).

Then `render_capture({ filename: "canvas/my.<extension>" })` —
inspect the PNG. JSON validity and `node -c` only prove syntax;
only a visual check proves the card mounted, the layout works,
and no error banner appears.

Append a `## Smoke test results` table to `spec.md` with each
URL, tier, and status.

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

## References

- `.qwen/skills/_conventions.md` — reading, reuse, API
  discipline, dispatch, decomposition gates, approval flow,
  naming.
- `ARCHITECTURE.md` — authoritative `mica.*` API surface and
  framework internals.
- `templates/_card-class-skeleton/` — the canonical four-file
  starting point.
- `card-classes/llm-chat/` + `server/plugins/llmChat.ts` —
  reference channel-handler pair.
