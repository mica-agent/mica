# ARCHITECTURE

This document describes how the Mica codebase is organized, how
a request flows through it, and what the `mica.*` bridge actually
exposes. It is the present-tense reference.

If something in this doc conflicts with the code, the code wins and
this doc is wrong. Flag it and fix it.

## High-level architecture

```
                  ┌─────────────────────────────────────────────┐
                  │  Devices — phone · tablet · laptop · display│
                  │  (live-synced; optional Tailscale Serve)    │
                  └─────────────────────┬───────────────────────┘
                                        │  HTTPS + WS
                                        ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │ HOST  — React + Vite  (port 5173)                                 │
  │                                                                   │
  │   CardRuntime + CARD_SHIM                                         │
  │     scopes DOM · injects card.js · auto-cleans timers/listeners   │
  │                                │                                  │
  │                                ▼                                  │
  │   mica.* bridge                                                   │
  │     files · openChannel · fetch · speak/listen · on · isSelfEcho  │
  └───────────────────────────────────┬───────────────────────────────┘
                                      │  /api/* + WS channels
                                      │  X-Mica-Project header
                                      ▼
  ┌───────────────────────────────────────────────────────────────────┐
  │ BACKEND  — Express + WebSocket (port 3002)                        │
  │ single user · per-project tagged                                  │
  │                                                                   │
  │  ┌─ File watcher ──────┐   ┌─ Channel manager ────────────────┐   │
  │  │ per-project inotify │   │ duplex sessions ·                │   │
  │  │ source-attribution  │   │ transport-agnostic               │   │
  │  └─────────────────────┘   └──────────┬───────────────────────┘   │
  │                                       │                           │
  │                          ┌────────────┴────────────┐              │
  │                          ▼                         ▼              │
  │              ┌─ Agent handlers ─────┐   ┌─ Generic plugins ─────┐ │
  │              │ .qwen · .claude ·    │   │ pty (.terminal) ·     │ │
  │              │ .opencode · .voice   │   │ llm-chat · micaFetch ·│ │
  │              └──────────┬───────────┘   │ per-card sidecars     │ │
  │                         ┊ invokes       └───────────────────────┘ │
  │              ┌─ Agent-tools MCP ──────────────────────────────┐   │
  │              │ render_capture · mica_create_class ·           │   │
  │              │ mica_shell · mica_install_skills · ...         │   │
  │              └────────────────────────────────────────────────┘   │
  └─────────────────────┬───────────────────────────────┬─────────────┘
                        │                               │
                        ▼                               ▼
  ┌─ Filesystem ──────────────────────┐  ┌─ Inference & voice ─────────┐
  │ /workspaces/<project>/            │  │ Local vLLM (port 8012)      │
  │   canvas/                         │  │ llama-server (legacy)       │
  │   .mica/  (config, layout,        │  │ OpenRouter · Anthropic API  │
  │            chats, cards,          │  │ Parakeet STT · Kokoro TTS   │
  │            card-classes)          │  │ (voice sidecars,            │
  │   shared/  (pinned host docs)     │  │  auto-spawn on first use)   │
  └───────────────────────────────────┘  └─────────────────────────────┘
```

**Three planes.** The **Host** (browser-side, where cards render
and `mica.*` lives), the **Backend** (where channel sessions live
and agent handlers dispatch), and the **external surfaces** the
backend mediates (inference backends, voice sidecars, project
files). Devices sit above the Host; everything below the Backend
is reached only through it.

**Solid arrows** are primary data flow paths — every request and
channel travels them. The **dotted line** between agent handlers
and the agent-tools MCP surface marks the invocation relationship:
agents *call* tools, but tools aren't in the hot per-message path.

The rest of this document is the per-subsystem deep-dive in
roughly the order the diagram presents: pipes → host → channels →
agents → file watcher → mica.* API → security.

## Posture

Sixteen engineering convictions shape every decision in this codebase. They are listed and explained in **CLAUDE.md § How we build** (the canonical home). Throughout this document, references like *tenet 11* point at that numbered list.


## The pipes

Mica runs as an Express server (backend, port 3002) and a
Vite frontend (port 5173) on the same host, connected by a
WebSocket. A single Mica instance serves multiple projects. The
browser identifies which project a request is for via an
`X-Mica-Project` header on every `/api/*` call.

### Server files

All paths relative to `/workspaces/mica/server/`. Grouped by role
rather than listed alphabetically — the goal is "where does X
live?", not a full inventory.

**Core**

| File | What it does |
|---|---|
| `index.ts` | Express app, route wiring, WebSocket adapter, file-watcher listener, startup lifecycle, channel-handler registration |
| `files.ts` | File I/O scoped to project, card-class metadata cache, template management, context assembly for agents |
| `channelManager.ts` | Unified transport-agnostic session manager for bidirectional channels |
| `connections.ts` | WebSocket connection registry (per-project subscribers, broadcast routing) |
| `fileWatcher.ts` | Per-project, ref-counted fs watchers scoped to canvas subtree plus pinned files |
| `writeSource.ts` | Tracks who initiated a write (windowId, "agent", "external") so the next file-changed broadcast carries that source |
| `handlerManifest.ts` | Describes built-in handlers (`llm-direct`, `llm-agent`, `process`) for the `mica_list_handlers` tool |
| `handlerBaselineInjection.ts` | Assembles per-turn baseline context for chat handlers (canvas files + shared pins + canvas-back) |

**Agent handlers** (one per agent card class)

| File | What it does |
|---|---|
| `micaAgent.ts` | Channel handler for `.qwen` cards. Spawns Qwen Code CLI via `@qwen-code/sdk` |
| `micaAgentGuards.ts` | Guard rules applied to the Qwen agent's tool calls (path scoping, write tracking) |
| `micaChat.ts` | Thin OpenAI-compatible HTTP wrapper used by the local model path |
| `claudeAgent.ts` | Channel handler for `.claude` cards. Spawns Claude Code CLI via `@anthropic-ai/claude-agent-sdk` |
| `opencodeAgent.ts` | Channel handler for `.opencode` cards. Speaks to `opencode serve` daemon via `@opencode-ai/sdk` |
| `opencodeServer.ts` | Lifecycle of the shared `opencode serve` daemon (one per backend, multi-session) |
| `opencodeConfig.ts` | Per-card provider/model configuration for opencode (local vLLM / OpenRouter / OpenAI-compatible) |
| `voiceAgent.ts` | Channel handler for `.voice` cards. Owns STT/TTS dispatch, tool routing, ambient announcements, settings sidecar |
| `voiceAgentSdk.ts` | LLM call path for voice replies (model selection, streaming) |
| `voiceTools.ts`, `voiceTools.sdk.ts` | Tool definitions the voice agent exposes (e.g. `send_to_card`, `read_card`) |
| `voiceStreaming.ts` | Server-side sentence segmentation for streamed TTS |
| `voiceServers.ts` | Parakeet STT and Kokoro TTS sidecar lifecycle (auto-spawn on first request) |

**Channel plugins** (`server/plugins/`, one per non-agent handler)

| File | What it does |
|---|---|
| `pty.ts` | PTY terminal channel handler for `.terminal` cards |
| `llmChat.ts` | Direct LLM chat for `.llm-chat` cards (no tool loop) |
| `llmAgent.ts` | Generic LLM agent handler with tool loop (the `llm-agent` reusable handler) |
| `llmRestApi.ts` | REST/OpenAI-compatible adapter used by `llm-chat` and `llm-agent` |
| `processChannel.ts` | Generic long-lived process handler (the `process` reusable handler, used by card-class sidecars) |
| `skillCompose.ts` | Collaborative SKILL.md authoring for `.skills` cards |
| `canvasBackCompose.ts` | Collaborative canvas-back.md authoring for `.canvas-back` cards |
| `cardClassTools.ts` | Card-class CRUD tool surface invoked by agents (typed inputs, schema enforced) |
| `cliMcp.ts` | Generic MCP bridge for CLI-spawned agent SDKs (qwen-code, opencode) |
| `git.ts`, `exec.ts` | Channel handlers for `.gitrepo` and `mica.exec` respectively |
| `micaFetch.ts` | Server-proxied HTTP with SSRF protection, rate limit, size cap (`mica.fetch`) |

**Agent-tools registry** (`server/agentTools/`, surfaced to every chat agent via MCP)

| File | What it does |
|---|---|
| `registry.ts` | Master `AGENT_TOOLS` array; 18 tools today |
| `sdkMcpBuilder.ts` | Wraps the registry into the in-process MCP server each agent SDK consumes |
| `restRoutes.ts` | REST adapter (`/api/tools/*`) for the opencode out-of-process MCP bridge |
| `promptPrelude.ts` | Standing tool-usage guidance injected into every chat agent's system prompt |
| `renderCapture.ts` | `render_capture` — screenshot a card and run vision over it |
| `cardClass.ts` | `mica_create_class`, `mica_edit_class_file`, `mica_create_card_instance`, `mica_delete_*`, `mica_list_classes` |
| `installSkills.ts`, `listSkillPackages.ts` | `mica_install_skills`, `mica_list_skill_packages` (curated library-skill packs) |
| `inspectUrl.ts` | `mica_inspect_url` — verified-CDN URL probe (status, content-type, UMD/ESM detection, methods extraction) |
| `inspectPythonPackage.ts` | `mica_inspect_python_package` — verify a package is installed, surface top-level API |
| `listHandlers.ts` | `mica_list_handlers` — enumerate built-in channel handlers (`llm-direct`, `llm-agent`, `process`) |
| `micaShell.ts` | `mica_shell` — run shell commands |
| `restartSidecar.ts`, `sidecarLog.ts`, `verifySidecar.ts` | `mica_restart_sidecar`, `mica_sidecar_log`, `mica_verify_sidecar` for card-class sidecars |
| `sharedDocs.ts` | `mica_list_shared_docs`, `mica_pin_shared_doc` — workspace-shared doc discovery + one-shot pin-and-read |

**Per-project state, validation, telemetry**

| File | What it does |
|---|---|
| `specFrontmatter.ts` | Parser for the YAML frontmatter at the top of `canvas/<name>-spec.md` — the structured contract `mica_create_class` reads |
| `cardValidators.ts` | Card-class preconditions and metadata consistency checks applied to agent-initiated writes |
| `validatorErrorBuffer.ts` | Flap-advisory buffer — surfaces validators that error→clear→error so the agent sees the pattern |
| `cardErrorBuffer.ts` | Per-card error history surfaced via `/api/cards/:filename/errors` |
| `cardSidecar.ts` | Card-class private sidecar lifecycle (declared in `metadata.json sidecar:`) |
| `sharedPin.ts` | Workspace-shared-doc pin lifecycle (mirrors `/workspaces/shared/*` into `<project>/shared/`) |
| `contextWindow.ts` | Provider-aware context-window resolution (OpenRouter catalog, OpenAI-compat probe, local env fallback) |
| `subagents.ts` | Subagent concurrency control and task delegation |
| `projectActivity.ts` | Tracks active turn count per project (drives the pulsing green dot in the project list) |
| `metrics.ts` | Per-project telemetry counters |
| `renderCaptureCounter.ts` | Per-turn `render_capture` rate limiter |
| `screenshot.ts` | Vision back-end for `render_capture` |
| `skillInvocationTracker.ts` | Tracks which skills the agent loaded this turn (skill-tool prerequisite enforcement) |
| `toolPrerequisites.ts` | "Did the agent invoke skill X before tool Y?" gates |
| `turnEvents.ts`, `turnSnapshots.ts` | Per-turn event stream + snapshot persistence |
| `userMessageTracker.ts` | Last-user-message tracking (drives the spec-approval gate: refuses `mica_create_class` until a real user message arrives after spec write) |

**Inference subprocess lifecycle**

| File | What it does |
|---|---|
| `llamaServer.ts` | Singleton llama.cpp subprocess lifecycle (rollback inference path; see § Inference backends) |

### Host files

All paths relative to `/workspaces/mica/src/`.

| File | What it does |
|---|---|
| `App.tsx` | Router. Project list or project view; pin-added toasts; reconnection banner |
| `ProjectList.tsx` | Project management UI (list, create from template, clone, rename, delete); pulsing-green-dot active-turn indicator |
| `whiteboard/CardRuntime.tsx` | Card host. Loads dependencies, injects HTML, wraps `card.js` in CARD_SHIM, provides the `mica` bridge |
| `whiteboard/CardFrame.tsx` | Card chrome (header, body, footer, flip/back). Lazy-loads content from the API |
| `whiteboard/CanvasCardRuntime.tsx` | Canvas host. Mounts the canvas card class's HTML and portals child cards into `#canvas-freeform` |
| `whiteboard/FileEditor.tsx` | Text file editor, fallback for unmapped extensions |
| `api/canvasFiles.ts` | File CRUD, project management API client, device-class detection |
| `api/canvasPaths.ts` | Canvas-relative path helpers (cards see canvas-relative; the wire is project-relative) |
| `api/micaSocket.ts` | WebSocket bridge, channel registry, session persistence |
| `api/mica.ts` | Card-side `mica.chat` / `mica.file` helpers (consumed inside CARD_SHIM) |
| `api/voice.ts` | Card-side `mica.speak` / `mica.listen` helpers |

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
| `dependencies.umd_scripts` | no | CDN URLs (UMD bundles only) to preload via `<script>` before `card.js` runs |
| `dependencies.styles` | no | CDN CSS URLs to preload |
| `handler` | no | Route the card's channel to a reusable handler (`llm-direct` / `llm-agent` / `process`) instead of needing a class-specific server file |
| `sidecar` | no | Card-class-private long-lived subprocess (entry, ready_path, ready_timeout_ms, interpreter). Server-side lifecycle in `server/cardSidecar.ts` |

ESM CDN URLs do **not** go in `umd_scripts` (the deps-reachable
validator refuses them with a prescriptive error). Load ESM
inside `card.js` via `await import(url)` — the CARD_SHIM wraps
`card.js` in an async function, so top-level `await` works.

### Dependency preloading

The first time a card class is rendered in a page, its declared
`dependencies.umd_scripts` and `.styles` are hoisted to `<head>`
and loaded once. Subsequent cards of the same class reuse the
already-loaded copies — the browser's module cache handles
deduplication.

### Card-class extensibility patterns

Three patterns let new card classes add behavior without writing
a class-specific server handler:

- **Reusable channel handlers** — point `metadata.json#handler` at
  `llm-direct`, `llm-agent`, or `process`. See § Registered
  channel handlers. The `mica_list_handlers` tool surfaces the
  catalog to agents so they discover these primitives during card
  authoring.
- **Card-class private sidecars** — declare `metadata.json#sidecar`
  to spawn a per-class subprocess on first card open.
  `server/cardSidecar.ts` owns the lifecycle (start, health-poll
  the `ready_path`, restart on file change, tear down on Mica
  exit). Sidecar HTTP is reachable from `card.js` via
  `mica.fetch('mica-internal://card-server/...')`, which the
  bridge routes to the right sidecar.
- **Workspace-shared docs** — pre-vetted reference docs at
  `/workspaces/shared/` (CDN library catalogs, design notes) can
  be pinned into a project via the `mica_pin_shared_doc` tool or
  the `.shared-library` browse card.
  `server/sharedPin.ts` mirrors the doc into the project's
  `shared/` directory; `server/handlerBaselineInjection.ts`
  includes pinned files in every chat-agent's per-turn baseline.

### Spec frontmatter — the contract for `mica_create_class`

For canvas card classes, the build flow writes
`canvas/<name>-spec.md` with a YAML frontmatter block at the top:

```yaml
---
card-class:
  name: world-clock                # MUST match the spec filename stem
  badge: WCK                       # 1–4 chars
  default_title: World Clock
  handler: ~                       # null unless using a reusable handler
  sidecar: ~                       # null unless this card needs a sidecar
  dependencies:
    umd_scripts:
      - {url: "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js", format: UMD, version: "1.9.4"}
    styles:
      - "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css"
  subtasks:
    - {name: "render world map", tier: 1, mechanism: "card.js + Leaflet UMD", verify: "render_capture"}
  out_of_scope:
    - "timezone autocomplete (defer to v2)"
---

# World Clock
[human-readable intent, tradeoffs, open questions]
```

`server/specFrontmatter.ts` parses this block; `mica_create_class`
reads it directly when the agent calls the tool with just
`{ name }`. The structured part IS the contract — what used to be
duplicated between a markdown table in the spec and explicit tool
args now lives in one place. The prose below the frontmatter is
for human review.

This is what closes the spec-vs-build drift gap: the tool's input
shape and the spec's structured part are the same bytes, so they
can't disagree.

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

Each entry below is a routing key registered via
`channelManager.registerHandler(<key>, factory[, manifest])` in
`server/index.ts`. The route key is normally a card's file
extension (so a `.qwen` card routes to the `"qwen"` handler), but
**reusable handlers** (`llm-direct`, `llm-agent`, `process`) are
addressed by their key from a card class's
`metadata.json#handler` field rather than from the extension —
this is what lets a custom card class get an LLM or sidecar
without writing a new server handler.

Cards whose extension (or `handler:`) has NO registered key fail
with `Error: No handler registered for: <class>`.

**Routing rule:** the route key is the card's file extension (or
`metadata.handler` for reusable-handler cards), NOT the `label`
argument to `openChannel`. The label is decorative (passed to the
factory's `_args`); cards typically use any string they like.

**Per-card-class handlers** (route key = file extension)

| Key | Handler factory | Source | Purpose |
|---|---|---|---|
| `qwen` | `createAgentHandler` | `server/micaAgent.ts` | Qwen Code SDK loop with subagent dispatch + tools |
| `claude` | `createClaudeAgentHandler` | `server/claudeAgent.ts` | Claude Code SDK loop, parallel shape |
| `opencode` | `createOpencodeAgentHandler` | `server/opencodeAgent.ts` | OpenCode SDK loop, lazy-spawned `opencode serve` daemon |
| `voice` | `createVoiceAgentHandler` | `server/voiceAgent.ts` | Canvas-aware voice assistant (STT → LLM → TTS, tool routing to chat cards) |
| `terminal` | `createPtyHandler` | `server/plugins/pty.ts` | Terminal PTY (node-pty) |
| `llm-chat` | `createLlmChatHandler` | `server/plugins/llmChat.ts` | OpenAI-compatible streaming chat, switchable models, no tools (legacy binding kept for `.llm-chat` extension) |
| `skills` | `createSkillComposeHandler` | `server/plugins/skillCompose.ts` | Collaborative SKILL.md authoring (propose → apply) |
| `canvas-back` | `createCanvasBackComposeHandler` | `server/plugins/canvasBackCompose.ts` | Propose-then-apply edits to canvas-back.md |

**Reusable handlers** (route key referenced from `metadata.json#handler`; surfaced to agents via `mica_list_handlers`)

| Key | Handler factory | Source | Purpose |
|---|---|---|---|
| `llm-direct` | `createLlmChatHandler` | `server/plugins/llmChat.ts` | Streaming chat with parameterized system prompt + model. Same handler as `llm-chat` but discoverable to agents as a generic primitive. |
| `llm-agent` | `createLlmAgentHandler` | `server/plugins/llmAgent.ts` | Generic LLM agent with tool loop. Card classes that want agent-shaped behavior without writing their own handler point `handler: "llm-agent"` |
| `process` | `createProcessHandler` | `server/plugins/processChannel.ts` | Long-lived subprocess with stdin/stdout duplex. Used by card classes that need a sidecar (declared via `metadata.json sidecar:`). |

**For LLM access in a custom card class**, the priority order is:
(1) point `metadata.handler` at `llm-direct` or `llm-agent` (no
server code to write); (2) reuse `.qwen` / `.claude` / `.opencode`
(if you want a full coding-agent loop); (3) build a new handler
under `server/plugins/<name>.ts` only when the contract is
genuinely domain-specific (custom system prompt managed
server-side, structured JSON deltas, retrieval, multi-step
pipelines).

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

Four agent card classes ship today. All are regular card classes
whose `card.js` opens a `mica.openChannel` to a server handler,
and the handler wraps a model. Same channel contract; different
backends and tool shapes.

### Qwen (`.qwen`)

`server/micaAgent.ts` is the channel handler. Uses the qwen-code
SDK (`@qwen-code/sdk`) talking to an OpenAI-compatible HTTP API
at `127.0.0.1:8012` (the bundled local vLLM by default; the same
endpoint llama-server speaks when the rollback path is active).
Tool loop runs through the SDK; tool calls are XML-tagged. The
SDK's `qwen_code` preset provides the base system prompt; Mica
appends the canvas baseline + per-turn context. Local model, no
cloud roundtrip.

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
sessions; `server/opencodeServer.ts` owns the daemon lifecycle).
Communication is `session.promptAsync` plus an SSE event stream on
`/global/event`; tool calls go through opencode's own MCP
plumbing. Per-card provider/model selection
(`server/opencodeConfig.ts`) routes each session to local vLLM,
OpenRouter, or any OpenAI-compatible endpoint. Context window is
resolved per-turn via `server/contextWindow.ts` (OpenRouter
catalog, OpenAI-compat probe, or local env fallback).

### Voice (`.voice`)

`server/voiceAgent.ts` is the channel handler. Unlike the other
three agents (which receive typed user messages), the voice agent
receives **microphone audio frames** from `card.js`, streams them
through the Parakeet STT sidecar (`server/voiceServers.ts`,
auto-spawned on first request), runs the transcript through an
LLM call (`server/voiceAgentSdk.ts`), and streams the reply back
as TTS audio chunks via the Kokoro sidecar.
`server/voiceStreaming.ts` segments the streamed reply into
sentences for low-latency TTS playback.

The voice agent's distinguishing tool is **dispatch to other
chat cards on the canvas** (`voiceTools.ts`,
`voiceTools.sdk.ts`): "ask the qwen agent to do X" routes the
user's intent into the named chat card's channel without the
voice agent itself performing the coding work. Per-card sidecar
settings (`/api/cards/settings?path=…`) cover voice selection,
ambient auto-read, default dispatch target, VAD preset
(quiet/normal/noisy), and inter-sentence pacing.

### Unified agent-tools surface (mica-builtins MCP)

Mica exposes a fixed set of internal tools to all four agent
backends under the same names and shapes via an MCP server
registered as `mica-builtins`. Single source of truth in
`server/agentTools/registry.ts` (the `AGENT_TOOLS` array). Each
tool is described once as an `AgentToolDef` (name, description,
zod schema, REST path, handler) and adapted to whichever SDK the
agent uses:

- qwen-code SDK → SDK-embedded MCP via `createSdkMcpServer`
  (`server/agentTools/sdkMcpBuilder.ts`)
- Claude Agent SDK → same shape (the SDK exports the same helpers)
- opencode-serve → out-of-process MCP child
  (`server/agentTools/opencodeBridge.mjs`) registered via
  `Config.mcp`, fetches the same REST endpoints
  (`server/agentTools/restRoutes.ts`)
- voice agent → fetches the same REST endpoints directly (voice
  agent's tool dispatch lives in `voiceTools.sdk.ts`, but the
  underlying mica-builtins suite is shared)

**18 tools today**, grouped by purpose:

| Tool | Purpose |
|---|---|
| **Vision** | |
| `render_capture` | Capture a card screenshot, run it through the vision model, return a caption — agent's eyes on the rendered output. Supports `user_intent` for MATCHES/MISMATCH/UNVERIFIABLE verdicts. |
| **Card-class authoring** | |
| `mica_create_class` | Atomic card-class creation; reads `canvas/<name>-spec.md` frontmatter as the contract. |
| `mica_edit_class_file` | Edit `card.html`/`card.js`/`card.css` with pre-write lint + partial-edit support (`old_string`+`new_string`); refuses no-op edits. |
| `mica_create_card_instance` | Place a card instance under canvas-root, idempotent on existing matching content. |
| `mica_delete_card_instance` | Delete a card instance file. |
| `mica_delete_class` | Delete a card-class directory; refuses if instances exist (force flag overrides). |
| `mica_list_classes` | List project-scoped + built-in card classes. |
| `mica_list_handlers` | Enumerate the reusable channel handlers (`llm-direct`, `llm-agent`, `process`) a new card class can plug into without writing server code. |
| **Library discovery & verification** | |
| `mica_install_skills` | Install curated third-party skills package into `.qwen/skills/` and `.claude/skills/`; two-tier trust (curated table + per-project approvals). |
| `mica_list_skill_packages` | List curated skill packs available to `mica_install_skills`. |
| `mica_inspect_url` | Server-side probe of a candidate dependency URL — status, content-type, size, UMD/ESM detection, extracted method names. Used INSTEAD of `curl` to keep response bytes out of chat history. |
| `mica_inspect_python_package` | Verify a Python package is installed and surface its top-level API. Pre-flight for sidecar-bearing card classes. |
| **Workspace-shared docs** | |
| `mica_list_shared_docs` | List pre-vetted docs in `/workspaces/shared/` available for pinning into the project. |
| `mica_pin_shared_doc` | One-shot pin + read — copies the doc into the project's `shared/` and returns its body in the same tool result. Toast surfaces "Mica pinned X" to the user. |
| **System / sidecar control** | |
| `mica_shell` | Run shell commands (with project-scoped cwd). |
| `mica_restart_sidecar` | Restart a card-class private sidecar. |
| `mica_sidecar_log` | Tail the sidecar's stdout/stderr. |
| `mica_verify_sidecar` | Health-check a sidecar's `ready_path` HTTP endpoint. |

Every agent's prelude (`server/agentTools/promptPrelude.ts`)
describes the same tools in the same prose. Adding a new tool
means: write the `AgentToolDef`, register it in `AGENT_TOOLS`,
document it once in the prelude — all four agents pick it up
automatically.

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

## Inference backends

Three local-inference paths and two cloud paths are wired up.
What runs depends on the active card class and (for opencode) its
per-card provider setting.

### Primary: vLLM (chat + voice agents, May 2026 → present)

`scripts/start.sh` starts a `vllm/vllm-openai:cu130-nightly`
container serving `RedHatAI/Qwen3.6-35B-A3B-NVFP4` at
`127.0.0.1:8012`. The container is reused across Mica restarts
(`scripts/stop.sh` leaves it warm by default; vLLM cold-boot is
30–90 s). Continuous batching lets Qwen and voice share the same
served model with near-zero overhead.

The `served-model-name` list (`qwen-vl`, `qwen-voice`,
`openai:qwen-vl`, `qwen3-vl-local`, `openai:qwen3-vl-local`)
covers both the Qwen coding agent and the voice agent's LLM call.
Speed gain over the previous llama.cpp Q4 path is ~30–40 % on
long outputs (NVFP4 + MTP-1 spec decode).

Set `MICA_DISABLE_CHAT_VLLM=1` to skip the vLLM container — used
for frontend-only iteration. Set `MICA_DISABLE_LLAMA=1`
(default in `scripts/start.sh`) to skip the llama-server fallback.

### Fallback: llama-server

`server/llamaServer.ts` manages a singleton llama.cpp subprocess
on the same `127.0.0.1:8012` port. Kept in the tree as a rollback
path; unset `MICA_DISABLE_LLAMA` and set `MICA_DISABLE_CHAT_VLLM=1`
to make it primary again.

| Property | Value |
|---|---|
| Default model | Qwen3.6-35B-A3B, quantized as `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` from `unsloth/Qwen3.6-35B-A3B-GGUF` |
| Override | `LLAMA_HF_REPO` + `LLAMA_HF_FILE` env vars, or `MODEL_PATH` for a local file |
| Context window | 128K per slot (bumped from 64K after tool-loop overflow mid-turn; see `server/llamaServer.ts` line 20+) |
| Parallel slots | 3 |
| Sampling defaults | `temp=0.6`, `top-p=0.95` (Qwen3.6 "precise coding" recommendations) |
| GPU offload | `--n-gpu-layers 999` |
| Health check | 500 ms poll until ready (120 s timeout) |
| Shutdown | SIGTERM, 5 s grace, then SIGKILL |

The server starts on first agent request, stays running until
Mica shuts down, and shuts down gracefully on process exit.

### Cloud paths (opencode only)

Per-card provider selection in `server/opencodeConfig.ts` lets a
`.opencode` card route to:

- **OpenRouter** — any OpenRouter-hosted model. Bring an API key
  in the card's settings panel.
- **OpenAI-compatible** — any `/v1`-shaped endpoint (self-hosted
  vLLM elsewhere, Together, Groq, etc.).

Context window resolution is provider-aware
(`server/contextWindow.ts`): OpenRouter catalog lookup, OpenAI-compat
probe, or local env fallback. The Qwen and Voice agents stay local;
only opencode is provider-switchable today.

### Voice sidecars

`server/voiceServers.ts` owns the Parakeet STT and Kokoro TTS
sidecar processes. Both are auto-spawned on first voice request
and stay warm. Hosts are overridable via `VOICE_STT_HOST` /
`VOICE_TTS_HOST` env vars (default `127.0.0.1`).

## Templates

A template is a directory under `templates/` that gets `cp -r`'d
verbatim into a new project's filesystem when the user picks it
from the project-creation flow. There is no transformation step;
no naming convention magic; no metadata interpolation. **The
template's filesystem layout is the new project's initial state.**

This is the contract that lets per-project customization work
(see `.qwen/skills/`, `.mica/canvas-back.md`,
`.qwen/settings.json` in CLAUDE.md / FEATURES.md): templates seed
those paths once, and every byte after creation lives in the
project, not in Mica core. Two consequences:

- A project's builder workflow can diverge from any other
  project's without touching Mica.
- Fixing or improving a template doesn't retroactively touch
  existing projects — they keep the bytes they were created with.

### Shipped templates

| Directory | Seeds onto canvas | Intended workflow |
|---|---|---|
| `templates/dgx-spark-local/` | `agent.qwen`, `canvas-back.canvas-back`, `shared.shared-library`, `skills.skills` | Local-first. The `.qwen` agent talks to the bundled vLLM. No API key required. Canvas-back tells the agent it's on a local model and to be lean. |
| `templates/opencode-builder/` | `agent.opencode`, `canvas-back.canvas-back`, `shared.shared-library`, `skills.skills`, `voice.voice` | Hybrid local-or-cloud. The `.opencode` agent's gear menu picks local vLLM / OpenRouter / OpenAI-compat per card. Voice card seeded by default for hands-free narration. Canvas-back explains routing tradeoffs. |
| `templates/_card-class-skeleton/` | n/a (not a project template) | Scaffold copied by `mica_create_class` when authoring a new card class. Not picked from the project-creation UI. |

Both shipped templates ship the **same** `.qwen/skills/`
directory (14 skills + `_conventions.md`). They differ only in
seeded canvas cards and canvas-back framing. See FEATURES.md §
Templates & the builder workflow for the user-facing summary.

### Materialization

`createProjectFromTemplate` in `server/files.ts` is the
implementation: `cp -r templates/<picked>/. <new-project>/`. No
substitution, no rename, no extra files. If a template needs to
ship something different (a custom canvas-back, a pre-seeded
`.gitignore`, an example card), it ships the file at the literal
path it should land at — the materialization code does not
change.

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

Mica today runs all of its moving parts on the host. The
trust boundaries are:

| Boundary | What it protects |
|---|---|
| CARD_SHIM | Browser-side DOM isolation between cards; auto-cleanup of card-owned timers and listeners. Not a sandbox — a hostile card can in principle do anything in-browser JS can do |
| Project path scoping | Every `/api/*` request is scoped by `X-Mica-Project`. Card code cannot reach into another project's files via the normal helpers |
| `mica.fetch` SSRF guard | Proxied HTTP resolves DNS first, rejects private/loopback/metadata ranges, enforces per-project rate limit and response cap |
| Agent subprocess sandbox | Claude Code runs in its own container with its own sandboxing and tool policies. Qwen agent runs inside the Mica server but its tool surface is restricted to the same file I/O boundaries as card code |

No per-project Mica container. No V8 isolate card sandbox. Both
have been considered; neither is built today.

## What is not here

Topics that earlier drafts of this doc described as present are
in fact not implemented. Listed here as design candidates, not
part of the current system:

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
channelManager.registerHandler("qwen",       createAgentHandler(fileWatcher));   // .qwen → Qwen Code (renamed from .chat)
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
onData:      { type: "user_message", text } → tool loop against the
             local inference backend at 127.0.0.1:8012 (vLLM primary,
             llama-server fallback). XML-fallback tool-call parsing.
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

*Working decisions that shaped Mica. Each entry captures the choice, why it was made, and what it displaces.*


### Files are files, not directories

Mica does not use a card-as-directory model. A card is a
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
consideration but is not the current reality.

### Augmentation-layer boundary: Mica shapes the input, the agent runs the turn

Mica runs on top of coding agents (Qwen Code, Claude Code,
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

### Agent architecture — four built-in classes, set will change

Today four agent card classes ship. `.qwen` is backed by Qwen
Code talking to the local vLLM (llama-server is the rollback
path). `.claude` is backed by the Claude Code SDK via a spawned
CLI subprocess. `.opencode` runs the OpenCode SDK against a
shared `opencode serve` daemon, with per-card provider selection
(local vLLM / OpenRouter / OpenAI-compatible). `.voice` adds a
canvas-aware voice assistant on top of Parakeet STT + Kokoro TTS
sidecars; its distinguishing capability is dispatching user
intent to the other chat-card agents. All four are regular card
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

### Spec frontmatter is the `mica_create_class` contract

For canvas card classes, the structured fields that
`mica_create_class` needs (name, badge, dependencies, subtask
decomposition, handler, sidecar) live as YAML frontmatter at the
top of `canvas/<name>-spec.md`. The tool reads the frontmatter
directly when invoked with just `{ name }`; explicit args still
override.

Reason: before frontmatter, the spec described the structured
contract twice — once as a markdown table for human review, once
as explicit `mica_create_class` arguments. Drift between the two
(wrong version pinned, ESM URL in the UMD slot, missing subtask
tier) was the most common failure mode. Frontmatter collapses it
to one location whose bytes are both human-readable and
machine-consumable. See § Spec frontmatter and
`server/specFrontmatter.ts`.

### Workspace-shared docs as a pin surface

Pre-vetted reference material (CDN library catalogs, verified
URL patterns, design notes) lives at `/workspaces/shared/` on the
host. Projects pull it in via a pin operation — either the user
clicking through the `.shared-library` card, or the agent
invoking `mica_pin_shared_doc` (which returns the doc's body in
the same tool result, no second `read_file` call needed).
`server/sharedPin.ts` mirrors the doc into the project's
`shared/` directory; `server/handlerBaselineInjection.ts`
includes pinned files in every chat-agent's per-turn baseline,
alongside canvas files and canvas-back.

Reason: agents repeatedly burned 30+ tool calls re-discovering
URLs we already knew were correct (Three.js UMD URL, Leaflet
ESM URL, Wikimedia API shape). Cataloging the answers once and
exposing them via a curated, pinnable surface short-circuits
that loop. Pinning is explicit — pinned docs enter the agent's
baseline; unpinned ones don't — which keeps the per-turn context
bounded.

### Voice is a peer agent, not a feature on top of chat

The `.voice` card class has its own channel handler
(`server/voiceAgent.ts`), its own per-turn LLM call, and its own
tool surface (`server/voiceTools.sdk.ts`). It is not a thin UI
on top of an existing chat agent.

Reason: voice's lifecycle differs from chat in ways that don't
generalize. The input is a continuous audio stream, not a
discrete message; segmentation happens server-side after STT;
barge-in interrupts in-flight TTS; ambient announcements
(another card finishing a turn) get auto-read or gated by the
per-card `autoReadAmbient` setting. Treating voice as a
parameter on the chat handler would force every chat handler to
carry that lifecycle. Instead, voice is a peer — and its
distinguishing capability is **dispatching** user intent to chat
cards (`send_to_card`) rather than performing the work itself.
This is what makes "ask the agent to do X" a useful primitive:
the voice agent doesn't need to be a coding agent; it needs to
know which card on the canvas is.

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

- **Canvas-artifact-naming resolver.** The predicates in
  `server/toolPrerequisites.ts` hardcode the spec / research
  artifact layout: `canvas/<className>-spec.md`,
  `canvas/<className>-research.md`. That same convention is
  encoded in the develop / research-candidates skill prose at
  `templates/dgx-spark-local/.qwen/skills/*` — dual-owned
  coupling. Change either and the other has to follow. Works
  today because card classes can't be renamed (`<className>`
  is a stable identity handle), so the paths are pinned. When
  rename support lands, OR when non-default skill suites need
  a different layout, OR when a project has multiple specs
  per class (e.g. v2 alongside v1), this becomes a wall.
  The fix: a small resolver (`server/canvasPaths.ts`) backed
  by `.mica/config.json` `naming` — every predicate goes
  through the resolver; skills read the same config. Defer
  until rename support or a concrete second-naming-need
  triggers it; the in-file note at
  `server/toolPrerequisites.ts:70` documents the constraint
  for the next reader.

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
