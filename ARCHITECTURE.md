# ARCHITECTURE

This document describes how the Mica-Lite codebase is organized, how
a request flows through it, and what the `mica.*` bridge actually
exposes. It is the present-tense reference. For design intent that
lives beyond what is implemented, see `internal/VISION.md`.

If something in this doc conflicts with the code, the code wins and
this doc is wrong. Flag it and fix it.

## Posture

Sixteen engineering convictions shape every decision in this
codebase. They are mirrored verbatim in CLAUDE.md so agents and
humans see the same list.

1. **Optimize every choice for AI generation.** This is the product
   tenet "designed for AI authorship" applied to implementation.
   When we pick a file format, an API shape, a state location, or a
   folder convention, the test is: can an LLM produce correct code
   against this from a natural-language prompt? Card classes are
   `card.html + card.js + card.css + metadata.json` because LLMs
   write those one-shot. `mica.*` stays small because large APIs
   confuse generators. No custom DSL, no framework-in-framework, no
   bytecode. If a design is nicer for humans but harder for agents,
   the design is wrong and gets reversed.
2. **Plain files over databases.** Humans, agents, and git all read
   the same bytes. No ORM. No migrations. `.mica/` is a directory,
   not a schema.
3. **Pipes, not policy.** Server and host do not know what "chat"
   or "terminal" or "mermaid" is. `if (extension === ".terminal")`
   in a pipe means we failed.
4. **One mechanism.** One ChannelManager for all bidirectional
   channels. One card-class contract for all cards. When we are
   forking, we extract a primitive instead.
5. **User intent, not transport.** Sessions start on file create
   and end on file delete. Not on WebSocket close, not on tab
   close. Transport is ephemeral; intent is durable.
6. **Small orthogonal primitives.** The Emacs instinct. Before
   adding a field to a central config or a method to a central
   API, check whether a smaller composition gets there.
7. **Root cause, not symptoms.** No bandaids. If the mental model
   is right, the fix is obvious. If it is not, stop and redraw.
8. **Runtime tests are the bar.** Compile is necessary, not
   sufficient. Type checks prove code compiles. They do not prove
   a channel survives a re-render.
9. **Read before writing.** Especially the card class you are
   about to change. Rewriting without reading drops details that
   were debugged in.
10. **Don't rebuild agent internals.** Mica is an augmentation
    layer on coding agents (Qwen Code, Claude Code, OpenRouter
    variants), not a replacement. We shape what goes into the
    prompt; the agent handles how it processes. Token-aware
    chat-history trimming, silent summarization, prompt-cache
    management, and reimplementations of `/compress` all live on
    the agent's side of the line — we don't build them. See
    DESIGN-DECISIONS.md §"Augmentation-layer boundary" for the
    full table and the reasoning.
11. **Plan before building.** Cost of fixing wrong code is far
    greater than the cost of correct planning. Specs, contracts,
    and interface boundaries are decided and approved *before*
    any code is written. This is the parent rationale for tenets
    8 and 9, and the justification for every gate we ship.
    Skipping the plan to "just try something" inverts the cost
    asymmetry.
12. **Divide only when architecture and model both demand it.**
    Decompose work into subagent dispatches only when (a) seams
    are architecturally real — named integration boundaries,
    distinct contracts another agent could implement without
    reading the others' code — AND (b) the integrated whole
    exceeds the model's reliable working set. If either gate
    fails, work inline. Reusable design memory, narrative
    cleanliness, and future flexibility are not gates.
13. **Context is the budget.** Every line of skill prose, every
    file read, every dispatch payload consumes the model's
    working set. The skill suite itself is part of the model's
    permanent system prompt — duplicating "read before writing"
    across five skills directly burns the budget on which
    adherence depends. Cut before adding. Curate at every level:
    skill prose, dispatch context, file reads. The dynamic
    counterpart to tenet 1's static design discipline.
14. **Approval gates are user-driven, not file-driven.** A spec
    save is not a build trigger. Humans control the moment a
    build starts. File-watcher events propagate state; they
    don't authorize action. Drives fresh-thread semantics,
    decompose-task gating, and per-turn discipline.
15. **Reuse before reinventing.** Before writing custom code,
    check whether `mica.*` APIs, the agent SDK, or an
    established library already does the job. If unsure between
    "use the API" and "write our own", surface the option to the
    user — don't silently roll your own. Tenet 10 is the
    strongest specific case; the same discipline applies to
    `mica.*` (host API) and to 3rd-party libraries.
16. **Follow APIs as authored; validate before relying.** Once
    an API is chosen, use signatures and shapes verbatim — don't
    improvise method names that "look right" (`mica.read()` is
    not a method; `mica.getContent()` is). For 3rd-party
    endpoints — URLs, services, library entry points — verify
    they exist and return the shape your code parses *before*
    committing to the integration. Distinct from tenet 8: that
    verifies the agent's *output*; this verifies the agent's
    *inputs*.

## The pipes

Mica-Lite runs as an Express server (backend, port 3002) and a
Vite frontend (port 5173) on the same host, connected by a
WebSocket. A single Mica instance serves multiple projects. The
browser identifies which project a request is for via an
`X-Mica-Project` header on every `/api/*` call.

### Server files

All paths relative to `/workspaces/mica/server/`.

| File | What it does |
|---|---|
| `index.ts` | Express app, route wiring, WebSocket adapter, file-watcher listener, startup lifecycle |
| `files.ts` | File I/O scoped to project, card-class metadata cache, template management, context assembly for agents |
| `channelManager.ts` | Unified transport-agnostic session manager for bidirectional channels |
| `fileWatcher.ts` | Per-project, ref-counted fs watchers scoped to canvas subtree plus pinned files |
| `writeSource.ts` | Tracks who initiated a write (windowId, "agent", "external") so the next file-changed broadcast carries that source |
| `llamaServer.ts` | Singleton llama.cpp subprocess lifecycle (start, health check, graceful shutdown) |
| `claudeAgent.ts` | Channel handler for `.claude` cards. Spawns the Claude Code CLI via `@anthropic-ai/claude-agent-sdk` |
| `micaAgent.ts` | Channel handler for `.chat` cards. Speaks OpenAI-compatible HTTP to llama-server |
| `micaChat.ts` | Thin wrapper around the Qwen chat path |
| `subagents.ts` | Subagent concurrency control and task delegation |
| `cardValidators.ts` | Card-class preconditions and metadata consistency checks applied to agent-initiated writes |
| `vllmServer.ts` | vLLM lifecycle for VLM (Gemma 4, separate process from llama-server) |
| `plugins/exec.ts` | Shell command execution handler (`mica.exec`) |
| `plugins/pty.ts` | PTY terminal channel handler for `.terminal` cards |
| `plugins/llmChat.ts` | Direct LLM chat channel handler for `.llm-chat` cards |
| `plugins/micaFetch.ts` | Server-proxied HTTP with SSRF protection, rate limit, size cap (`mica.fetch`) |
| `plugins/skillCompose.ts` | Collaborative SKILL.md authoring for `.skills` cards |
| `plugins/canvasBackCompose.ts` | Collaborative canvas-back.md authoring for `.canvas-back` cards |

### Host files

All paths relative to `/workspaces/mica/src/`.

| File | What it does |
|---|---|
| `App.tsx` | Router. Project list or project view |
| `ProjectList.tsx` | Project management UI (list, create, clone, rename, delete) |
| `whiteboard/CardRuntime.tsx` | Card host. Loads dependencies, injects HTML, wraps `card.js` in CARD_SHIM, provides the `mica` bridge |
| `whiteboard/CardFrame.tsx` | Card chrome (header, body, footer, flip/back). Lazy-loads content from the API |
| `whiteboard/CanvasCardRuntime.tsx` | Canvas host. Mounts the canvas card class's HTML and portals child cards into `#canvas-freeform` |
| `whiteboard/FileEditor.tsx` | Text file editor, fallback for unmapped extensions |
| `api/canvasFiles.ts` | File CRUD, project management API client |
| `api/micaSocket.ts` | WebSocket bridge, channel registry, session persistence |

## Per-request project scoping

A single Mica instance serves multiple projects. Every HTTP and
WebSocket request must identify which project it is for. The
mechanism is the `X-Mica-Project` header (with `?project=` as a
fallback for URL contexts that cannot set headers, such as
`<img src>`, `window.open`, or download links).

Threading:

1. `App.tsx` knows the active project and passes it down.
2. `CardFrame` renders each card with a `project` prop.
3. `CardRuntime` passes `project` to its `mica` bridge.
4. The bridge's `fetch` helpers auto-inject `X-Mica-Project` on
   every `/api/*` call.
5. The server's `getRequestProject(req)` reads the header (or
   query) on each route handler.
6. Responses set `Vary: X-Mica-Project` so browser cache does not
   confuse bodies across projects.

No module-level globals hold the active project. Every request
reads the header. This is load-bearing: without it, a stale
project reference would route one tab's actions into another
project's state.

## The host

### CardRuntime and CARD_SHIM

`CardRuntime.tsx` hosts a single card. Given `html`, `exports`,
`dependencies`, `project`, `canvas`, and `filename`:

1. Preloads declared CDN `dependencies.scripts` and
   `dependencies.styles` once (deduped across cards).
2. Injects `html` into the card's `container` element.
3. Finds each `<script>` in the injected HTML, wraps it with the
   **CARD_SHIM** prelude, and evaluates it.

The CARD_SHIM prelude provides the illusion a card author works
against:

- **Scoped globals.** `container` (the card's DOM element) and
  `mica` (the bridge) are injected as closed-over locals. A
  Proxy shadow hides the real `document` from the card's
  `querySelector` / `getElementById` calls, so a card cannot
  reach another card's DOM.
- **Window resize.** `window.addEventListener('resize', fn)` is
  redirected to a ResizeObserver on the card's container, so a
  card that wants to react to size changes gets its own card's
  size, not the window's.
- **Auto-cleanup.** `setTimeout`, `setInterval`,
  `requestAnimationFrame`, and `addEventListener` calls from
  card code are tracked and cleaned up on card unmount or
  re-render. A card cannot leak a timer across a re-render.
- **Scoped fetch.** `fetch(url)` to `/api/*` auto-injects
  `X-Mica-Project: ${mica.project}` if the card did not set it
  explicitly.
- **Error reporting.** Uncaught exceptions from card code POST
  to `/api/projects/:project/canvases/:canvas/cards/:file/error`
  so they surface in the server log.

The practical effect: a card author writes top-level code and it
just works. No class wrapper, no `export`, no registration call,
no manual cleanup. The exact shim code lives in
`src/whiteboard/CardRuntime.tsx` (lines 28-77 at the time of
writing).

### CanvasCardRuntime

A canvas is a card like any other — it has `card.html`,
`card.js`, `metadata.json`. What makes it a canvas is that its
HTML produces a `#canvas-freeform` element into which child
cards are mounted.

`CanvasCardRuntime.tsx` is the thin host. It:

1. Renders the canvas card class's HTML using a CardRuntime.
2. Polls for `#canvas-freeform` in the rendered DOM (child
   effects run before parent effects, so it is usually already
   there on the first tick).
3. Creates an isolated child container inside `#canvas-freeform`
   for each file on the canvas.
4. Mounts a separate CardRuntime inside each child container.

The canvas card class owns layout, drag, resize, and the
toolbar. The React host does not. Different canvas card classes
can ship different layouts (kanban, timeline) using the same
mechanism.

## Card class loading

Card classes are directories with a fixed contract. Resolution
checks project scope first, then built-in:

```
.mica/card-classes/<name>/    project-scoped
card-classes/<name>/          built-in (ships with Mica)
```

The directory name must equal the instance file extension
without the dot. A class at `.mica/card-classes/kanban/` handles
`.kanban` files. The `metadata.json`'s `extension` field is
documentation. The **directory name** is the actual lookup key.
A mismatch silently falls through to the text renderer.

### metadata.json fields

| Field | Required | Meaning |
|---|---|---|
| `extension` | yes | File extension this class handles (must match directory name without dot) |
| `badge` | yes | Short label shown on the card header |
| `defaultTitle` | no | Display title for new instances |
| `primaryFile` | no | For classes whose instance is a directory, the file inside that holds the state |
| `dependencies.scripts` | no | CDN URLs to preload before `card.js` runs |
| `dependencies.styles` | no | CDN CSS URLs to preload |

### Dependency preloading

The first time a card class is rendered in a page, its declared
`dependencies.scripts` and `.styles` are hoisted to `<head>` and
loaded once. Subsequent cards of the same class reuse the
already-loaded copies — the browser's module cache handles
deduplication.

## WebSocket communication

The Mica WebSocket carries five patterns. Cards use the high-level
`mica.*` methods rather than framing messages directly, but the
patterns are visible in the API:

| Pattern | Browser API | Use case |
|---|---|---|
| Request/response | `mica.call(fn, args)` | Invoke a server export, await a result |
| Fire-and-forget | `mica.send(fn, args)` | Invoke a server export, no response needed |
| Server push | `mica.on(event, cb)` | React to file changes, layout changes, agent status |
| Bidirectional channel | `mica.openChannel(fn, args)` | Terminal PTY, agent chat, any long-lived stream |
| Cross-card broadcast | `mica.broadcast(event, data)` | Ephemeral signals between cards in the same tab |

Broadcasts include a `source` field that identifies the
originating window (see "File watcher and source attribution").
Cards use `mica.isSelfEcho(event)` to skip echoes of their own
writes.

## ChannelManager

All bidirectional streams (chat, claude, terminal, llm-chat,
skills, canvas-back) go through one ChannelManager. It is
transport-agnostic and does not know what a "chat" or "terminal"
is. Card-type-specific behavior lives in registered handlers.

A session is bound to a card file on disk. It starts on file
create, it ends on file delete. Transport connections attach and
detach during the session's life without destroying the session.

For the state machines, the transport adapter pattern, and
handler contract examples, see
[ARCHITECTURE-DETAILS.md](ARCHITECTURE-DETAILS.md).

### Registered channel handlers

Each entry below is a card class that has a server-side channel
handler registered via `channelManager.registerHandler(<class>, factory)`
in `server/index.ts`. A card whose extension matches one of these
classes can call `mica.openChannel(label, args?)` from its `card.js`
and the channel routes to the matching handler. Cards whose extension
has NO registered handler will fail with `Error: No handler registered
for: <class>`.

**Routing rule:** the route key is the card's file extension, NOT the
`label` argument. The label is decorative (passed to the factory's
`_args`); cards typically use any string they like.

| Card class | Handler factory | Source | Purpose |
|---|---|---|---|
| `.chat` | `createAgentHandler` | `server/micaAgent.ts` | Qwen agent SDK loop with subagent dispatch + tools |
| `.claude` | `createClaudeAgentHandler` | `server/claudeAgent.ts` | Claude Code SDK loop, parallel shape |
| `.terminal` | `createPtyHandler` | `server/plugins/pty.ts` | Terminal PTY (node-pty) |
| `.llm-chat` | `createLlmChatHandler` | `server/plugins/llmChat.ts` | OpenAI-compatible streaming chat, switchable models, no tools |
| `.skills` | `createSkillComposeHandler` | `server/plugins/skillCompose.ts` | Collaborative SKILL.md authoring (propose → apply) |
| `.canvas-back` | `createCanvasBackComposeHandler` | `server/plugins/canvasBackCompose.ts` | Propose-then-apply edits to canvas-back.md |

**For LLM access in a custom card class**, prefer reusing `.llm-chat`
(if the off-the-shelf streaming-chat UX fits) or `.chat` / `.claude`
(if the full agent loop fits). Build a new handler under
`server/plugins/<name>.ts` only when the LLM contract is genuinely
domain-specific (custom system prompt managed server-side, structured
JSON deltas, retrieval, multi-step pipelines).

**Anti-pattern:** a card-class spec or implementation that has the
card calling LLM endpoints directly via `fetch()` or `mica.fetch()`.
LLM endpoint, model selection, API keys, retry, abort, and protocol
parsing belong server-side. The card's job is to render and forward
user input.

### Service handlers (RPC, not duplex)

Distinct from channel handlers. Registered via
`registerMicaHandler(namespace, handler)` in `server/index.ts`,
exposed to cards as `mica.<namespace>.*`. Used for one-shot
request/response, not stateful streams:

| Namespace | Card-side API | Purpose |
|---|---|---|
| `chat` | `mica.chat.*` | Send a message into a chat thread from another card |
| `exec` | `mica.exec.*` | Run a server-side command, get output |
| `fetch` | `mica.fetch(url, opts)` | SSRF-protected, rate-limited HTTP |
| `render` | `mica.render.capture(filename)` | Headless screenshot of a rendered card |

If you find yourself building a custom service-handler-shaped need,
ask whether a channel handler is the better fit (long-lived state,
streaming responses, abort semantics).

## Agents

Two agent card classes ship today. Both are regular card classes
whose `card.js` opens a `mica.openChannel` to a server handler,
and the handler wraps a model.

### Claude (`.claude`)

`server/claudeAgent.ts` is the channel handler. It uses
`@anthropic-ai/claude-agent-sdk`. For each turn it spawns the
Claude Code CLI as a subprocess with `cwd` set to the project
path. The CLI reads authentication from the host's
`~/.claude/.credentials.json`. Output streams back through the
channel.

### Qwen (`.chat`)

`server/micaAgent.ts` is the channel handler. It calls
llama-server's OpenAI-compatible HTTP API at `127.0.0.1:8012`.
Tool loop, history trimming (system prompt + last N messages),
XML-fallback tool-call parsing for models that do not populate
`tool_calls` cleanly, and truncation-detection are handled here.

### Subagent delegation

`server/subagents.ts` provides concurrency control when an agent
spawns child agents. Parent context is passed to the child, and
child work runs to completion before the parent turn continues.

### Write-source tracking

When an agent writes a file, `writeSource.ts` marks the write as
`source: "agent"`. The file-watcher listener reads that marker
when it broadcasts the resulting `file-changed` event, so cards
subscribing to file changes can tell an agent write apart from
a human edit.

## File watcher and source attribution

`server/fileWatcher.ts` is a multi-project, ref-counted directory
watcher.

### Scope

For each project, inotify watches are registered only for:

- The canvas subtree (default `docs/`).
- Parent directories of explicitly pinned files.

Files outside that scope are invisible. The rationale is
practical: `.mica/` watches cover the infrastructure we care
about, and watching the whole project root would consume
inotify watch slots for every large subdirectory the user
happens to have in the project (node_modules, venv, dist, etc.).
The `IGNORE_DIRS` list makes the default exclusions explicit.

### Event shape

Events emit with type `"changed"`, `"created"`, or `"deleted"`,
a project-relative filename, and the project name. Debounced at
300ms per file.

### Source attribution on broadcast

The file watcher itself does not know who wrote a file. Before
broadcasting to browsers, `server/index.ts` consumes the write
source from `writeSource.ts`:

| Source value | Meaning |
|---|---|
| `<windowId>` | A browser tab (set via `mica.files.write()`, or via raw `/api/files` PUT with a `source` field) |
| `"agent"` | An agent handler wrote the file |
| `"external"` | No source was marked — fallback for outside-Mica writes (git pull, manual edit, etc.) |

Writes via `mica.files.write()` also attach a `cardSource` field,
which is the per-card-instance UUID. This lets sibling cards in
the same tab tell each other's writes apart. Use
`mica.isSelfEcho(event)` to check against it.

Event payloads delivered over WebSocket:

| Event | Payload |
|---|---|
| `file-created` | `{ type, filename, source, cardSource? }` |
| `file-changed` | `{ type, filename, source, cardSource? }` |
| `file-deleted` | `{ type, filename }` (no source on deletions) |
| `layout-changed` | `{ type, source, device }` |
| `card-class-changed` | `{ type, filename, change }` (fires when a file in `.mica/card-classes/` changes) |

## Reactivity

The agent reacts to file changes inside its canvas scope without
being prompted. The mechanism lives inside the agent handlers
(`micaAgent.ts` and `claudeAgent.ts`), not in a separate service.

How it works:

- Each active agent session registers a listener on
  `fileWatcher`.
- Incoming file-change events are filtered by canvas scope
  (inside `canvasRoot`, or in the session's pinned set).
- Events are also filtered by write source: if the file was
  written by this agent session itself, skip (prevents
  feedback loops).
- Events are coalesced into a per-session buffer with a 15-second
  idle gate (`USER_IDLE_BEFORE_AGENT_MS`). Each new event
  re-arms the timer, so continuous typing does not trigger a
  reaction mid-edit.
- When the idle window fires, if no other turn is in progress
  (per-session busy lock), the buffered events are delivered
  to the agent as a synthetic "the user edited these files"
  turn.

Broadcasts to other card clients are a separate path and are
unaffected by the idle gate — multi-tab live typing still
updates instantly. Only the agent gets held back until idle.

## llama-server lifecycle

`server/llamaServer.ts` manages a singleton llama.cpp subprocess
that serves an OpenAI-compatible API at `127.0.0.1:8012`. Qwen
agent requests go here.

| Property | Value |
|---|---|
| Default model | Qwen3.6-35B-A3B, quantized as `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` from `unsloth/Qwen3.6-35B-A3B-GGUF` |
| Override | `LLAMA_HF_REPO` + `LLAMA_HF_FILE` env vars, or `MODEL_PATH` for a local file |
| Context window | 65K per slot |
| Parallel slots | 3 |
| Sampling defaults | `temp=0.6`, `top-p=0.95` (Qwen3.6 "precise coding" recommendations) |
| GPU offload | `--n-gpu-layers 999` |
| Health check | 500ms poll until ready (120s timeout) |
| Shutdown | SIGTERM, 5s grace, then SIGKILL |

The server starts on first agent request, stays running until
Mica shuts down, and shuts down gracefully on process exit.

## The mica.* API

This is the authoritative reference. The bridge lives at
`src/api/micaSocket.ts` (`createBridge`) and
`src/whiteboard/CardRuntime.tsx` (CARD_SHIM wrapper and
high-level helpers). If this doc and the code disagree, the code
wins.

### Identity

| Property | Type | Meaning |
|---|---|---|
| `mica.project` | `string` | Current project name |
| `mica.canvas` | `string` | Canvas identifier (currently always `"__canvas__"` for the root canvas) |
| `mica.filename` | `string` | This card's instance filename, project-relative |
| `mica.windowId` | `string` | Per-browser-tab ID, stable across renders |
| `mica.cardId` | `string` | Per-card-instance UUID, stable across reloads. Sidecar at `.mica/cards/<sanitized>.id.json` |

### Content

| Method | Signature | Notes |
|---|---|---|
| `mica.getContent()` | `() => string \| Promise<string>` | Returns cached string after the initial fetch resolves; returns the Promise before that. Use with `await` for reliable access |
| `mica.refresh()` | `() => Promise<void>` | Re-fetches HTML from the server and re-renders. Used to opt in to updates after a `file-changed` event |

### Files

All methods take project-relative paths. `mica.files.write()`
auto-injects both `source` (windowId) and `cardSource`
(cardId) so `mica.isSelfEcho(event)` filters correctly.

| Method | Signature | Returns |
|---|---|---|
| `mica.files.list()` | `() => Promise<Array<FileEntry>>` | `[{ path, isFile, isFolder, size, modifiedAt }]` |
| `mica.files.read(path)` | `(path: string) => Promise<string>` | Text contents |
| `mica.files.readBinary(path)` | `(path: string) => Promise<ArrayBuffer>` | Binary contents |
| `mica.files.write(path, content)` | `(path: string, content: string \| ArrayBuffer \| ArrayBufferView \| Blob) => Promise<void>` | Text is PUT as JSON. Binary streams to a separate upload endpoint. Parents auto-created |
| `mica.files.delete(path)` | `(path: string) => Promise<void>` | Silently succeeds on 404 |
| `mica.files.url(path)` | `(path: string) => string` | Returns `/api/files/<encoded>?project=<encoded>` for `<img>`, `<embed>`, `window.open` |

### Cards

| Method | Signature | Returns |
|---|---|---|
| `mica.cardClasses.list()` | `() => Promise<Array<{ name, builtIn, format }>>` | Installed classes, project-scoped first |
| `mica.isSelfEcho(event)` | `(event: { cardSource?: string }) => boolean` | True if `event.cardSource === mica.cardId` |

### Events

| Method | Signature | Notes |
|---|---|---|
| `mica.on(event, cb)` | `(event: string, cb: (data) => void) => () => void` | Returns an unsubscribe function. Events: `file-changed`, `file-created`, `file-deleted`, `layout-changed`, `card-class-changed` |
| `mica.onDestroy(cb)` | `(cb: () => void) => void` | Runs on card unmount and re-render. Use for explicit cleanup |
| `mica.broadcast(event, data)` | `(event: string, data?: object) => void` | Browser-side signal to all cards in this tab (and other tabs on the same project via server relay) |

### Server calls

| Method | Signature | Notes |
|---|---|---|
| `mica.call(fn, args)` | `(fn: string, args?: object) => Promise<unknown>` | Request/response to a server export. Returns whatever the export resolves |
| `mica.send(fn, args)` | `(fn: string, args?: object) => void` | Fire-and-forget |
| `mica.openChannel(fn, args)` | `(fn: string, args?: object) => Channel` | Returns a handle with `onData`, `onClose`, `send`, `close`, `destroy`. See [ARCHITECTURE-DETAILS.md](ARCHITECTURE-DETAILS.md) for semantics |
| `mica.fetch(url, opts)` | See below | Server-proxied HTTP with SSRF guard, rate limit, size cap |

### mica.fetch contract

Always resolves. Never throws on upstream or our-side failure.

Options:

| Field | Type | Default |
|---|---|---|
| `method` | `"GET" \| "POST" \| "PUT" \| "DELETE" \| "HEAD" \| "PATCH"` | `"GET"` |
| `headers` | `Record<string, string>` | `{}` |
| `body` | `string` | none |
| `timeout` | `number` (ms) | server default, clamped to `[1, 60000]` |

Return shape:

```ts
{
  status: number;              // upstream HTTP status; 0 on our-side failure
  headers: Record<string, string>;   // lowercased upstream headers; empty on our-side failure
  body: string;                // response body; empty on our-side failure
  truncated?: boolean;         // true if body was capped at the response-size limit
  durationMs: number;          // DNS + connect + read
  error?: string;              // human-readable message, present only on our-side failure
  errorCode?: string;          // stable code, present only on our-side failure
  retryAfterMs?: number;       // present only when errorCode === "rate_limited"
}
```

`errorCode` values (all are our-side; upstream HTTP errors come
back as `status >= 400`):

| Code | Meaning |
|---|---|
| `url_invalid` | Unparseable URL or unsupported scheme |
| `ssrf_blocked` | Resolved to a private, loopback, link-local, or cloud-metadata IP |
| `dns_error` | DNS resolution failed |
| `connect_error` | TCP connect or TLS handshake failed |
| `timeout` | Exceeded `opts.timeout` |
| `rate_limited` | Per-project rate limit hit; see `retryAfterMs` |
| `response_error` | Body decode or streaming failure |
| `internal_error` | Transport failure between card and Mica server |

The SSRF check resolves DNS before connecting and rejects any
address in a private or metadata range. Cards cannot reach
`localhost` or cloud-metadata endpoints through `mica.fetch`.
For calls to Mica's own `/api/*`, use `mica.files.*` and the
other high-level helpers, or raw `fetch('/api/...')` (which
CARD_SHIM auto-scopes to the project).

### What is NOT in the browser mica.*

`mica.read`, `mica.write`, and `mica.exec` appear as names on
the bridge but are **server-side methods used by export
handlers**. In the browser they return a structured error and
point the card author at `mica.call()` to invoke a server
export instead. Do not try to call them from `card.js`.

## Security model

Mica-Lite today runs all of its moving parts on the host. The
trust boundaries are:

| Boundary | What it protects |
|---|---|
| CARD_SHIM | Browser-side DOM isolation between cards; auto-cleanup of card-owned timers and listeners. Not a sandbox — a hostile card can in principle do anything in-browser JS can do |
| Project path scoping | Every `/api/*` request is scoped by `X-Mica-Project`. Card code cannot reach into another project's files via the normal helpers |
| `mica.fetch` SSRF guard | Proxied HTTP resolves DNS first, rejects private/loopback/metadata ranges, enforces per-project rate limit and response cap |
| Agent subprocess sandbox | Claude Code runs in its own container with its own sandboxing and tool policies. Qwen agent runs inside the Mica server but its tool surface is restricted to the same file I/O boundaries as card code |

No per-project Mica container. No V8 isolate card sandbox. Both
are design candidates described in `internal/VISION.md`.

## What is not here

Topics that earlier drafts of this doc described as present are
in fact not implemented. They live in `internal/VISION.md` as
design intent, not in the current system:

- Portfolio / workspace-level card.
- V8 isolate card sandbox (the `isolated-vm` dependency is in
  `package.json` but not wired up).
- Per-project Mica container isolation.
- Cross-workspace card class promotion (`~/.mica/card-classes/`).
- Multi-agent direct messaging via `mica.callCard`.

Reactivity, which earlier drafts described as not implemented,
is implemented — see the "Reactivity" section above.
