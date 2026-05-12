# ARCHITECTURE

This document describes how the Mica-Lite codebase is organized, how
a request flows through it, and what the `mica.*` bridge actually
exposes. It is the present-tense reference. For design intent that
lives beyond what is implemented, see `internal/VISION.md`.

If something in this doc conflicts with the code, the code wins and
this doc is wrong. Flag it and fix it.

## Posture

Sixteen engineering convictions shape every decision in this codebase. They are listed and explained in **CLAUDE.md § How we build** (the canonical home). Throughout this document, references like *tenet 11* point at that numbered list.


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
handler contract examples, see § Channel handler details
later in this document.

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

Three agent card classes ship today. All are regular card classes
whose `card.js` opens a `mica.openChannel` to a server handler,
and the handler wraps a model. Same channel contract; different
backends.

### Qwen (`.chat`)

`server/micaAgent.ts` is the channel handler. Uses the qwen-code
SDK (`@qwen-code/sdk`) talking to llama-server's OpenAI-compatible
HTTP API at `127.0.0.1:8012`. Tool loop runs through the SDK; tool
calls are XML-tagged. The SDK's `qwen_code` preset provides the
base system prompt; Mica appends the canvas baseline + per-turn
context. Local model, no cloud roundtrip.

### Claude (`.claude`)

`server/claudeAgent.ts` is the channel handler. Uses the Claude
Agent SDK (`@anthropic-ai/claude-agent-sdk`) which spawns the
Claude Code CLI as a subprocess with `cwd` set to the project
path. The CLI reads authentication from the host's
`~/.claude/.credentials.json`. Output streams back through the
channel.

### Opencode (`.opencode`)

`server/opencodeAgent.ts` is the channel handler. Uses the
opencode SDK (`@opencode-ai/sdk`) against a long-running
`opencode-serve` daemon (one per backend lifetime, shared across
sessions). Communication is `session.promptAsync` plus an SSE
event stream on `/global/event`; tool calls go through opencode's
own MCP plumbing. Compatible with the same llama-server backend
as Qwen, plus optional cloud providers (OpenRouter etc.) when
configured.

### Unified agent-tools surface (mica-builtins MCP)

Mica exposes a fixed set of internal tools to all three backends
under the same names and shapes via an MCP server registered as
`mica-builtins`. Single source of truth in
`server/agentTools/registry.ts`. Each tool is described once as
an `AgentToolDef` (name, description, zod schema, REST path,
handler) and adapted to the three SDKs:

- qwen-code SDK → SDK-embedded MCP via `createSdkMcpServer`
- Claude Agent SDK → same shape (the SDK exports the same helpers)
- opencode-serve → external stdio MCP child process
  (`opencodeBridge.mjs`) registered via `Config.mcp`, fetches the
  same REST endpoints

Eight tools today:

| Tool | Purpose |
|---|---|
| `render_capture` | Capture a card screenshot, run it through llama-server's vision encoder, return a text caption — agent's eyes on the rendered output |
| `mica_create_class` | Atomic card-class creation with metadata schema enforced; writes a canonical card.js stub when omitted |
| `mica_edit_class_file` | Edit `card.html`/`card.js`/`card.css` with pre-write lint + partial-edit support (`old_string`+`new_string`); refuses no-op edits where the two strings are identical |
| `mica_create_card_instance` | Place a card instance under canvas-root, idempotent on existing matching content |
| `mica_delete_card_instance` | Delete a card instance file |
| `mica_delete_class` | Delete a card-class directory; refuses if instances exist (force flag overrides) |
| `mica_list_classes` | List project-scoped + built-in card classes |
| `mica_install_skills` | Clone a third-party skills package into `.qwen/skills/` and `.claude/skills/`; two-tier trust (curated table + per-project approvals.json) |

Every backend's prelude (`promptPrelude.ts`) describes the same
tools in the same prose. Adding a new tool means: write the
`AgentToolDef`, register it in `AGENT_TOOLS`, document it once in
the prelude — all three agents pick it up automatically.

### Validators (pre-write + post-write)

Server-side validators run on agent file writes. Two layers:

- **Pre-write** (`canUseTool` hook in micaAgent / claudeAgent):
  `checkProtectedPathPrecondition` (refuses raw `write_file` to
  layout.json + card-class internals, redirects to the structured
  tool), `checkLibraryDiscoveryPrecondition` (gates spec.md /
  decomposition.md / interfaces.md until the discover-dependency
  skill is read), `checkCardClassMetadataConsistency` (extension
  must match dir name). Hook is dead under qwen's `permissionMode:
  yolo` for write tools — known limitation.
- **Post-write** (`fileWatcher` listener in `server/index.ts`):
  `enforceCardClassMetadata`, `enforceCardJsLint`,
  `enforceDecompositionConsistency`, `enforceDependenciesReachable`.
  These run regardless of how the write happened (SDK write_file,
  bash heredoc, external editor).

Errors flow through `validatorErrorBuffer.ts` → injected into the
agent's next-turn `## Validator errors needing your attention`
section AND broadcast as `card-error` events for chat-card UI
surfacing. The buffer self-clears on rewrite — a fix removes the
error from both the agent's prompt and the user's view on the
next file-change event.

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
| `mica.openChannel(fn, args)` | `(fn: string, args?: object) => Channel` | Returns a handle with `onData`, `onClose`, `send`, `close`, `destroy`. See § Channel handler details for semantics |
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

---

## Channel handler details

*Subsystem deep-dive on `ChannelManager` — sessions, clients, handler contract.*

### Unified Channel Manager

#### Problem

Cards need persistent, bidirectional communication with server-side backends — chat agents, terminal PTYs, task runners, custom handlers. The original design used three separate managers (ChatChannelManager, TerminalChannelManager, AgentChannelManager) routed by file extension in a growing if/else chain. This violated tenets #2 (infrastructure provides pipes, not policy) and #5 (one mechanism, not per-type special cases).

Additionally, channels broke on card re-renders because the browser closed and reopened connections during React lifecycle events. The root cause was conflating transport state (connection count) with user intent (session lifecycle) — violating tenet #4.

#### Three Layers

```
┌────────────────────────────────────────────────────────────────┐
│ TRANSPORT (index.ts)                                           │
│                                                                │
│ WebSocket adapter. Translates wire messages into               │
│ ChannelManager method calls. Tracks which transport            │
│ connection owns which client handle. Knows nothing about       │
│ sessions, handlers, or card types.                             │
│                                                                │
│ Could be replaced with SSE, HTTP long-poll, or any other       │
│ bidirectional transport without changing the layers below.      │
└────────────────────────────┬───────────────────────────────────┘
                             │
              open(clientId, key, callbacks)
              sendData(clientId, data)
              detach(clientId)
              destroySession(key)
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ CHANNEL MANAGER (channelManager.ts)                            │
│                                                                │
│ Manages sessions keyed by card file identity.                  │
│ Attaches/detaches clients (opaque callback handles).           │
│ Starts/stops card handlers on lifecycle transitions.           │
│ Transport-agnostic — never imports WebSocket.                  │
└────────────────────────────┬───────────────────────────────────┘
                             │
              ChannelHandler interface
              (onAttach, onDetach, onData, onDestroy)
                             │
┌────────────────────────────▼───────────────────────────────────┐
│ CARD HANDLERS (per card type)                                  │
│                                                                │
│ Registered by card class name. Implement ChannelHandler.       │
│ Decide their own backend semantics: when to start processes,   │
│ what to do with zero clients, how to handle errors.            │
│                                                                │
│ Infrastructure doesn't know what a "chat" or "terminal" is.    │
│ That knowledge lives here.                                     │
└────────────────────────────────────────────────────────────────┘
```

#### Session State Machine

A session is bound to a card file on disk. It starts when the file is created and ends when the file is deleted. These are explicit user events. Everything else — browser connections, backend processes, failures — happens within the session lifetime.

```
                    card file created on disk
                    (user clicks + Claude Chat, + Terminal, etc.)
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │         REGISTERED            │
                    │                              │
                    │  Session exists in manager   │
                    │  handler: null               │
                    │  clients: 0                  │
                    └──────────┬───────────────────┘
                               │
                      first client attaches
                               │
                               ▼
                    ┌──────────────────────────────┐
              ┌────▶│          ACTIVE               │◀────┐
              │     │                              │     │
              │     │  handler: started            │     │
              │     │  clients: 1+                 │     │
              │     └──┬────────────┬──────────────┘     │
              │        │            │                     │
              │   last client   handler calls             │
              │   detaches      ctx.idle()                │
              │        │            │                     │
              │        ▼            ▼                     │
              │     ┌──────────────────────────────┐     │
              │     │           IDLE                │     │
              │     │                              │     │
              │     │  clients: 0                  │     │
              │     │  state: preserved            │     │
              │     │  handler decides behavior:   │     │
              │     │  • stay warm (chat)          │     │
              │     │  • timeout → stop (terminal) │     │
              │     └──┬───────────────────────────┘     │
              │        │                                  │
              │   client reattaches ──────────────────────┘
              │
              │
              ── ANY STATE ──
                    │
           card file deleted / server shutdown / ctx.destroy()
                    │
                    ▼
              ┌──────────────────────────────┐
              │         DESTROYED             │
              │                              │
              │  handler.onDestroy() called  │
              │  all clients notified        │
              │  session removed             │
              └──────────────────────────────┘
```

Key: the transition from ACTIVE to IDLE is **not** a teardown signal. It's informational — the handler decides what to do. A chat handler stays warm. A terminal handler starts an idle timer. An agent handler ignores it (task keeps running). The session is only destroyed by explicit events: card deletion, server shutdown, or the handler itself calling `ctx.destroy()`.

#### Client (Browser) State Machine

Clients are browser-side handles that attach to sessions. They're identified by `(project, canvas, filename, fn)` — the card file and the function being called. This is the **channel key**.

```
        openChannel(project, canvas, filename, fn, args)
                    │
          key exists in registry?
           YES ── swap callbacks, return same handle (no WS message)
           NO  ── create new handle, send channel_open
                    │
                    ▼
              ┌──────────────┐       ┌──────────────┐
              │  ATTACHED    │◀─────▶│  DETACHED    │
              │              │       │              │
              │  send works  │       │  in registry │
              │  receiving   │       │  callbacks   │
              │  data        │       │  nulled      │
              └──────┬───────┘       └──────┬───────┘
                     │                      │
              ch.destroy()           openChannel() again
              (card deleted)         (script re-run, reconnect)
                     │
                     ▼
              ┌──────────────┐
              │  DESTROYED   │  removed from registry
              │              │  channel_close sent to server
              └──────────────┘
```

`ch.close()` = **detach** (soft, client-side only). Nulls callbacks, but handle stays in registry. No message sent to server. This is safe for React cleanup — the channel persists across re-renders. The next `openChannel()` with the same key returns the existing handle and swaps in fresh callbacks.

`ch.destroy()` = **hard close**. Removes from registry. Sends `channel_close`. Server tears down session if appropriate.

This distinction is why card scripts "just work" across re-renders:
```javascript
const ch = mica.openChannel('chat_session', { provider: 'claude' });
// First run: creates channel, sends channel_open
// Subsequent runs: returns existing channel, swaps callbacks
// No close/reopen cycle. No race conditions.

mica.onDestroy(() => ch.close());
// close() = detach. Channel stays alive in registry.
// Next script execution gets it back via openChannel().
```

#### Channel handlers

Each card class that uses a channel registers a handler at server
startup (in `server/index.ts`). Handlers implement the
`ChannelHandler` interface directly. Card `card.js` code does not
contain server-side handler code — there is no `render.js` and no
module-export model. The browser side and the server side are
separate files, wired together by `mica.openChannel(fn, args)` on
the browser and `channelManager.registerHandler(name, factory)`
on the server.

Registration at startup looks like this:

```typescript
channelManager.registerHandler("chat",       createAgentHandler(fileWatcher));   // .chat  → Qwen agent
channelManager.registerHandler("claude",     createClaudeAgentHandler(fileWatcher)); // .claude → Claude Code agent
channelManager.registerHandler("terminal",   createPtyHandler());                 // .terminal → PTY
channelManager.registerHandler("llm-chat",   createLlmChatHandler());             // .llm-chat → direct LLM chat
channelManager.registerHandler("skills",     createSkillComposeHandler());        // .skills → collaborative SKILL.md authoring
channelManager.registerHandler("canvas-back", createCanvasBackComposeHandler());  // .canvas-back → propose-then-apply editor
```

The key (`chat`, `claude`, `terminal`, etc.) is the card class
name. When the browser calls `mica.openChannel(fn, args)` from a
card of that class, ChannelManager routes the session to the
registered handler.

#### ChannelHandler interface

```typescript
interface ChannelHandler {
  onAttach?(clientId: string, args: Record<string, unknown>): void;
  onDetach?(clientId: string): void;
  onData?(clientId: string, data: unknown): void;
  onDestroy?(): void;
}
```

Lifecycle semantics:

- `onAttach` fires when a client (browser tab) attaches to the
  session. For reconnects, ChannelManager delivers a synthetic
  `{ type: "attached" }` as the first `onData` call so handlers
  can replay state (scrollback, history, current status).
- `onDetach` fires when a client disconnects. Other clients on
  the same session are unaffected.
- `onData` fires on every browser-originated message. Handlers
  read the message and decide what to push back via the
  ctx-provided send/reply helpers.
- `onDestroy` fires once, when the session ends (card file
  deleted, or server shutdown).

#### Handler examples

Where each live channel handler lives today and what it does:

**Claude agent** (`server/claudeAgent.ts`):
```
onAttach:    load chat history, replay to attaching client
onData:      { type: "user_message", text } → spawn Claude Code CLI subprocess,
             stream tool calls and responses back, auto-commit agent writes.
             Handles tool-use loop, write-source tracking, busy lock.
onDetach:    no-op — session continues
onDestroy:   cancel any in-flight turn, close streams
```

**Qwen agent** (`server/micaAgent.ts`):
```
onAttach:    load chat history, replay to attaching client
onData:      { type: "user_message", text } → tool loop against llama-server
             at 127.0.0.1:8012. XML-fallback tool-call parsing.
             Canvas-scope file-watcher integration (reactive turns on user idle).
onDetach:    no-op — session continues
onDestroy:   abort in-flight turn
```

**Terminal** (`server/plugins/pty.ts`):
```
onAttach:    spawn node-pty, replay scrollback to attaching client
onData:      { input } → forward to PTY stdin
             { resize, cols, rows } → resize PTY
             { ping } → respond with pong + ptyAlive status
onDetach:    if last client, PTY continues running (handler policy)
onDestroy:   kill PTY
```

**LLM chat** (`server/plugins/llmChat.ts`):
```
onData:      { message } → direct prompt to local LLM, no tools, stream response
```

**Skill compose** (`server/plugins/skillCompose.ts`):
```
onData:      collaborative SKILL.md editing loop — agent proposes, user reviews,
             resulting file written to .claude/skills/<name>/ or .qwen/skills/<name>/
```

The ChannelManager itself does not know what any of these
handlers do. It only knows sessions, clients, and lifecycle. The
handler decides backend semantics — when to start a process,
what "idle" means for this card type, how to handle errors.

#### Transport Adapter Pattern

The WebSocket handler in `index.ts` is a thin translation layer:

```
WS message: channel_open    →  channelManager.open(clientId, ...)
WS message: channel_data    →  channelManager.sendData(clientId, data)
WS message: channel_close   →  channelManager.detach(clientId)
WS event: connection closed  →  for each client: channelManager.detach(clientId)
File event: file deleted     →  channelManager.destroySession(project, canvas, filename)
Server event: shutdown       →  channelManager.destroyAll()
```

The adapter tracks which WebSocket connection owns which client IDs (`Map<WebSocket, Set<string>>`). This is transport-level bookkeeping that doesn't belong in the ChannelManager.

#### Why This Design

| Tenet | How it applies |
|-------|---------------|
| #2 Infrastructure provides pipes, not policy | ChannelManager doesn't know chat/terminal/agent semantics |
| #4 Lifecycle bound to user intent | Session created on card file create, destroyed on card file delete |
| #5 One mechanism | Single ChannelManager replaces three separate managers |
| #6 Card class = extension point | New handler = a new file implementing ChannelHandler, registered in `server/index.ts`. Frontend side: a new card class opening `mica.openChannel()` in its `card.js`. No framework changes |
| #7 Transport-agnostic | ChannelManager never imports WebSocket |

---

## Decisions

*Working decisions that shaped Mica-Lite. Each entry captures the choice, why it was made, and what it displaces. For design intent that has not yet shipped, see `internal/VISION.md`.*


### Files are files, not directories

Mica-Lite does not use a card-as-directory model. A card is a
plain file at the project root. The file extension selects the
card class. The canvas arranges cards by layout, not by
directory hierarchy.

This is the biggest departure from earlier Mica drafts. Old
drafts had cards as directories (`project.project/`, `research/`)
with child cards as nested directories. The current model is
flat: files at the root, `.mica/` for operational metadata, no
containment in the file system.

Reasons for the change:

- Files LLMs already know how to produce (the "designed for AI
  authorship" tenet).
- Plain text editing works out of the box.
- Git behavior matches user expectations — no hidden moves when
  "reorganizing" cards.
- The canvas layout is separate state, and different canvas
  card classes can arrange the same files differently.

Card arrangement ("containment" in the old vocabulary) lives in
`.mica/layout.json`, keyed by device class. Different canvas
card classes read and write the same file, choosing how to
display the same set of files.

### Multi-project, single-host, per-request scoping

A single Mica instance serves multiple projects. There is no
per-project Mica process and no per-project container.

Requests identify their project via an `X-Mica-Project` header
(with `?project=` as a query fallback for URL contexts that
cannot set headers, such as `<img src>` or `window.open`). The
card runtime auto-injects the header on every `/api/*` fetch.
The server reads it via `getRequestProject(req)`.

No module-level globals hold the "current project." Every
request reads the header. Responses set `Vary: X-Mica-Project`
so browser cache does not mix project state.

Reason: no surprising tab-level bleeding. Two tabs on different
projects interact with different state at every request. No
context swap to track.

Per-project container isolation as a blast radius is under
consideration (see `internal/VISION.md`) but is not the current
reality.

### Augmentation-layer boundary: Mica shapes the input, the agent runs the turn

Mica-Lite runs on top of coding agents (Qwen Code, Claude Code,
and OpenRouter-routed variants). It augments them. It does not
replace them. This line is load-bearing: without it, Mica drifts
toward reimplementing concerns the SDK already owns, and ends up
competing with the tool it's built on.

**The rule.** Everything upstream of the SDK call is Mica's
problem. Everything after the SDK receives the payload is the
agent's problem.

| Mica-layer (shape the input) | Agent-layer (run the turn) |
|---|---|
| What lives in the canvas baseline | Prompt-cache / KV-cache management |
| How canvas files are presented (full vs summary) | In-session chat-history compaction (`/compress`) |
| Which cards are pinned to every turn vs on-demand | Tool-result compression inside a turn |
| Breaking big tasks into bounded subagent scopes (the analyze-repo skill) | Deciding what fits in the model's context |
| Storing chat history on disk canonically | Rolling its own truncation when exceeded |
| Surfacing the `mica.*` bridge and subagent defs | Using those tools to complete the user's ask |
| UX: fresh-thread action, context meter, overflow error card | Handling prompt rejection at the transport level |

**Things Mica does not build** (non-goals, explicit):

- Token-aware trimming of chat history before sending to the SDK.
- Silent summarization of old chat turns.
- Prompt-cache / KV-cache-aware prefix construction.
- Any reimplementation of the agent's `/compress` command.
- Parsing the model's response stream to detect context
  exhaustion and retry with smaller payload.

If the agent's compaction has bugs, those are upstream bugs to
file with the SDK. Our response is to make the canvas + fresh-
thread pattern strong enough that compaction is rarely needed.
We do not compensate for agent internals by reinventing them.

Reason: reimplementing the agent inside Mica is a losing trade.
We don't control prompt-cache state the way the SDK does (a
token-aware trim blows the KV cache every turn, costing real
latency), and we inherit all the bugs of the original feature
without the team around it to fix them. Shaping the prompt well
upstream is the leverage Mica has.

### Canvas is memory; threads are working memory

The product tenet "context lives on the canvas, not inside the
agent" has a direct implication for how chat threads relate to
durable memory. A thread is not a record; the canvas is.

**Live thread.** The in-progress chat session on one chat card.
Loaded into the agent's context each turn. Working memory for
this arc of work. Dies when the arc ends.

**Archived thread.** A past thread, stored on disk under
`.mica/chats/archived/<timestamp>-<slug>.json`. Not in the
baseline. Browsable by humans. Readable by agents on specific
demand, never as ambient context.

**Canvas.** Outlives threads. Every durable finding belongs here.

An overflow is not a failure of memory — it is a signal that an
arc of work has produced enough volume that findings should be
promoted to canvas and a fresh thread started. "Fresh thread" is
a healthy reset, not failure recovery.

**Agent behavior policy.** Before reading an archived thread,
exhaust canvas sources: card contents, `decisions.md`, card
modifiedAt timestamps, `git log`. If the canvas cannot answer a
question the user treats as settled work, that is a gap — ask
for clarification, or offer to promote the missing information
to a card. Archived threads are one-off references. Never load a
full archived thread into context; extract what's needed and
summarize.

This mirrors the analyze-repo discipline: don't read a whole
large artifact into context; skim with intent.

### Storage model — work lives outside `.mica/`

```
my-project/
├── .mica/                      ← infrastructure only
│   ├── config.json             ← project config
│   ├── layout.json             ← canvas layout, keyed by device class
│   ├── canvas-back.md          ← project-level AI context
│   ├── chats/                  ← chat history per agent card
│   ├── cards/                  ← per-card state and AI context sidecars
│   └── card-classes/           ← project-scoped card class definitions
├── brief.md                    ← work files at project root
├── spec.md
├── tasks.todo
├── architecture.mmd
├── agent.claude                ← agent cards are just files too
├── .claude/skills/             ← skills copied from the template
├── .qwen/skills/               ← skills from the template
└── .git/
```

Cards are the work. `.mica/` is the machinery. Delete `.mica/`
and the project is back to plain files.

Card classes (the vocabulary) are infrastructure and stay in
`.mica/card-classes/` (project scope) or `card-classes/` (built-
in in the Mica repo).

### Card classes are project-wide

Card classes live at two scopes. The resolver checks project
first:

```
.mica/card-classes/<name>/    project-scoped
card-classes/<name>/          built-in
```

Project-scoped classes travel with the project in git. Built-in
classes ship with Mica. A workspace tier at
`~/.mica/card-classes/` is a horizon item (see VISION); it is
not implemented today.

### Agent architecture — two built-in classes, set will change

Today two agent card classes ship. `.chat` is backed by local
Qwen through llama-server. `.claude` is backed by the Claude
Code SDK via a spawned CLI subprocess. Both are regular card
classes whose `card.js` opens a `mica.openChannel` to a server
handler.

The set will change — new agents, different models, specialist
roles. What stays constant is the contract: an agent is a card
class that owns a brief, opens a channel to a server handler,
and reads the canvas for context. Multi-agent coordination via
direct agent-to-agent messaging is a horizon item.

Philosophically: multiple agent types will share plumbing
(status, plan steps, blocker UI, channel protocol) while
differing in rendering and backend behavior. The decision is
to accept duplication across card classes until patterns
emerge clearly. Extracting a shared library upfront tends to
be premature. When the pattern is clear, a maintenance pass
extracts primitives. Agents have the same maintenance problem
humans do (copies drift), but a different strength (they can
read an entire codebase instantly to apply a fix everywhere).

### Agent context — brief as identity, canvas as shared context

An agent's identity is its `brief.md`-equivalent content in the
agent card's instance file or directory. The brief defines
role, personality, constraints, and instructions. Part of the
brief is model-specific (tool format, SDK capabilities) and
comes from the card class. Part is role-specific and the user
customizes it.

The agent's context is the canvas itself. Agents read the same
files humans see: briefs, specs, todos, diagrams. There is no
separate "agent memory" and no hidden key-value store. The
canvas is the shared context.

### Card class as back of the card

A card has two sides. The **front** is the instance — the
user's file, its content, the accumulated state. The **back**
is the card class: `card.html`, `card.js`, `card.css`, and
`metadata.json`, plus the AI context (`context.md` at class
level and `<card>.context.md` at instance level).

The class is the machinery. The instance is the work. A
user-facing flip UI (see VISION) is the natural way to expose
this.

### Skeleton-copy-first for new card classes

New card classes are created by copying
`templates/_card-class-skeleton/` to
`.mica/card-classes/<name>/`, then editing the four files in
place. The skeleton has the correct shape for CARD_SHIM, the
`mica.*` bridge, and the metadata format.

Reason: writing `card.js` from an empty page repeatedly invites
class-wrappers, ES-module syntax, and invented base-class APIs
that CARD_SHIM does not support. Starting from the skeleton
keeps the generated code on the correct shape. The
`card-class-handbook` skill leads with this rule.

### Self-describing card classes — metadata.json

Each card class declares its own metadata in `metadata.json`:

```json
{
  "extension": ".todo",
  "badge": "TODO",
  "defaultTitle": "To Do",
  "primaryFile": "tasks.md",
  "dependencies": { "scripts": [], "styles": [] }
}
```

The system reads `metadata.json` from each card class directory
on startup. No central registry, no manifest file outside the
class itself.

Load-bearing constraint: the directory name must equal the
extension without the dot. A class at
`.mica/card-classes/kanban/` handles `.kanban` files. The
`extension` field in `metadata.json` is documentation. The
directory name is the actual lookup key. A mismatch silently
falls through to the text renderer.

### Event source attribution — source and cardSource

Cross-window and cross-card coordination needs a way to skip
self-echoes. Early drafts tried timing hacks (debounce,
ignore-next-event flags). Fragile.

**Decision:** broadcasts include a `source` field identifying
the origin. `source` is either a `windowId` (per browser tab),
`"agent"` (a server-side agent handler wrote it), or
`"external"` (no source was marked — git pull, manual edit,
process outside Mica).

File writes through `mica.files.write()` additionally carry a
`cardSource` field containing the writing card's `cardId`
(per-card-instance UUID). This lets sibling cards in the same
tab tell each other's writes apart.

Cards use `mica.isSelfEcho(event)` to filter. This is the
general pattern — any cross-card broadcast should include
these fields so originators can skip their own echoes.

### Layout is canvas card state

Layout positions live in `.mica/layout.json`, keyed by device
class (phone, tablet, desktop, display). The canvas card class
reads and writes this file. Different canvas card classes can
persist layout under different keys or formats.

Earlier drafts placed layout at `project.project/layout.json`
inside the canvas card's directory, following a
"layout-belongs-to-the-card" principle. That placement is
superseded by the files-are-files decision above: the canvas
is a card file, not a directory, so layout moved to
`.mica/layout.json`.

Cross-window sync uses `layout-changed` broadcasts with
`source` attribution (see above).

### Cards as tools (not implemented)

Earlier design sketches proposed `mica.callCard(cardName, fn,
args)` so any card with named server-side exports could be
called by other cards. An orchestrator agent delegates to a
specialist agent card; a dashboard pulls from data cards.

**Status: not implemented.** The runtime bridge does not expose
`mica.callCard`. This is an internal-VISION item, not a
present-tense design decision. Documenting it here to prevent
agents or humans from assuming it works.

### Implemented (formerly deferred)

The following items appeared as "Deferred" in earlier versions
of this doc and are now built:

- **Canvas card owns the toolbar.** The canvas card class
  renders the toolbar. `CanvasCardRuntime` does not own it.
- **Canvas card owns layout and arrangement.** The canvas card
  decides how children are mounted inside `#canvas-freeform`.
- **`CanvasCardRuntime` is a thin host.** It renders the canvas
  card's HTML and portals child cards into `#canvas-freeform`.
  It does not own layout, drag, or toolbar.
- **Reactivity.** The agent watches the file watcher, filters
  events to its canvas scope, coalesces with a 15-second idle
  gate, skips its own writes via write-source tracking, and
  delivers coalesced events as a synthetic turn.

### Deferred

- **"Flip the card" UI.** A button on the card header that
  shows the card class definition (`card.html`, `card.js`,
  `card.css`, `metadata.json`) and the AI context files
  instead of the instance content. A "Customize" action
  copies a built-in class to `.mica/card-classes/` for local
  editing. Purely frontend. No backend changes needed. The
  data model is in place; the UI layer is pending.

### Open questions

- Workspace-tier card classes at `~/.mica/card-classes/`:
  when, and with what cross-project promotion UX.
- Card class versioning and breaking changes as the surface
  evolves.
- Per-project container isolation as a blast radius: whether
  Mica needs it in addition to what the agent systems already
  provide.
- Card class system-dependency declaration
  (`systemDeps` in metadata) for classes that need
  non-JavaScript binaries available on the host.
