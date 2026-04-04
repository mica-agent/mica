# Mica Architecture: Project-First Model

## Core Principle

**Projects are sovereign.** They exist as independent git repos that work fine without Mica. Mica *connects* to projects and adds value — card-based views, AI agents, extensible canvas — without creating lock-in. Remove `.mica/` and the project is untouched.

This is analogous to `.vscode/` or `.github/` — a lightweight footprint that enhances but doesn't own. See [SPEC.md](SPEC.md) for the product definition and card model.

## Key Design Tenets

These principles guide all architectural decisions in Mica.

**1. Understand root cause before coding.** Read the docs. Trace the lifecycle. Draw the state diagram. Don't guess at fixes — diagnose. If we're playing whack-a-mole, the mental model is wrong.

**2. Infrastructure provides pipes, not policy.** The framework doesn't define what "chat" or "terminal" means. It provides connections, state management, and lifecycle events. Card code implements the semantics of its own backend. Adding a new card type should never require changes to framework code.

**3. Don't constrain the user's tools.** Let Claude Code, plugins, and user settings work as designed. The container is a blast radius boundary — it limits what things can touch, not what features are available. Don't second-guess the security models of integrated tools.

**4. Lifecycle bound to explicit user intent.** Sessions start when a user creates a card file and end when a user deletes it. Don't infer teardown from transport state (connection count hitting zero, WebSocket disconnects). These are transient events, not user intent.

**5. One mechanism, not per-type special cases.** Prefer a single unified model (one ChannelManager, one expansion mechanism, one card class system) over growing if/else chains with type-specific logic. When a pattern emerges across card types, extract it into infrastructure.

**6. Card class is the unit of extension.** Adding a new AI agent, visualization, or interactive widget should be a new `render.js` file — not new TypeScript modules, not new server routes, not new React components. The card class system is the extension point.

**7. Transport-agnostic infrastructure.** The ChannelManager doesn't know about WebSockets. The card class system doesn't know about React. Each layer can evolve independently. See [ARCHITECTURE-DETAILS.md](ARCHITECTURE-DETAILS.md) for deep dives on subsystem design.

---

## How It Works

### 1. Connecting a Project

Any directory (ideally a git repo) can be connected to Mica:

```
POST /api/projects/connect  { "path": "/home/user/repos/my-app" }
```

This does three things:
1. Creates a `.mica/` directory inside the project (if not already present)
2. Initializes git if the directory isn't already a repo
3. Registers the project in `workspaces.json` (Mica's side)

### 2. Project Layout

```
my-project/
├── .git/
├── .mica/                  ← infrastructure (config, chat history, layout, card classes)
│   ├── .config.json        # Project manifest (agent provider, reactive settings)
│   ├── .chat-history.json  # Chat persistence
│   ├── .layout.json        # Card layout state
│   └── .card-classes/      # Project-specific card class definitions
│       └── my-widget/
│           └── render.js
│
├── project.project         ← root canvas card (what you see when you open the project)
├── goal.goal               ← seed cards (created on project setup)
├── todo.todo
├── brief.md                ← agent identity (markdown)
├── log.md                  ← activity log (markdown)
├── welcome.md              ← user/agent-created cards
├── architecture.mmd
└── research/               ← nested canvas (a card that contains cards)
    ├── project.project
    ├── hypotheses.md
    └── findings.md
```

**Card files live at the project root** — they are the work, not metadata. System cards, user-created cards, and nested canvases (subdirectories) are all visible and first-class in the project directory.

**`.mica/` holds infrastructure only** — agent config, chat history, layout state, and custom card class definitions. This is the machinery, not the work.

For nested canvases, the canvas directory is at the project root (`research/`) and its infrastructure is at `.mica/research/` (for `.chat-history.json`, `.layout.json`, etc.).

#### Three-tier file naming convention

Card files follow a three-tier naming convention:

| Prefix | Meaning | Visible to agents? | Examples |
|--------|---------|-------------------|----------|
| `.` (dot) | Internal data — not cards | No | `.config.json`, `.chat-history.json`, `.layout.json` |
| (none) | Card — system-seeded or user-created | Yes | `goal.goal`, `todo.todo`, `brief.md`, `notes.md`, `tasks.todo` |

#### Extension-as-class convention

The file extension determines the card class. Standard file formats keep standard extensions; Mica-native types use the class name as extension:

| Class | Extension | Content format | Standard? |
|-------|-----------|---------------|-----------|
| `markdown` | `.md` | Markdown | Yes |
| `mermaid` | `.mmd` | Mermaid syntax | Yes |
| `text` | `.txt` | Plain text | Yes |
| `html` | `.html` | HTML | Yes |
| `goal` | `.goal` | Markdown | Mica-native |
| `todo` | `.todo` | Markdown | Mica-native |
| `chat` | `.chat` | Managed | Mica-native |
| `agent` | `.agent` | Managed | Mica-native |
| `canvas` | `.canvas` | Managed | Mica-native |
| `simple-project` | `.project` | Markdown | Mica-native |
| `terminal` | `.terminal` | Managed | Mica-native |

The content format is independent of the extension. A `.todo` file contains markdown internally — the `todo` card class renders it with interactive checkboxes. The extension determines *behavior*, not format.

Multiple cards of the same class are natural: `backend.todo` and `frontend.todo` are both rendered by the `todo` class.

Note that `brief` and `log` are plain `.md` files rendered by the `markdown` card class. They were originally Mica-native extensions but graduated to standard markdown — their semantics come from their filename and content, not a custom renderer.

### 3. Workspace Registry

`workspaces.json` lives in Mica's own directory (not inside any project):

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "path": "/home/user/repos/my-app",
      "canvases": ["workspace"],
      "connectedAt": "2026-03-26T..."
    }
  ]
}
```

A workspace is simply a collection of connected projects. Projects can join and leave freely.

### 4. Per-Project Git Integration

Each project has its own `.git/`. Mica wraps standard git operations per-project:

| Endpoint | Operation |
|----------|-----------|
| `GET /api/projects/:id/git/status` | Working tree status |
| `POST /api/projects/:id/git/commit` | Stage all + commit |
| `GET /api/projects/:id/git/log` | Commit history |
| `GET /api/projects/:id/git/diff` | Diff output |
| `GET /api/projects/:id/git/branches` | List branches + current |
| `POST /api/projects/:id/git/checkout` | Switch/create branch |

A per-project mutex prevents concurrent git operations on the same repo.

After an agent makes changes, Mica auto-commits: `mica: {canvas} agent update`.

### 5. Per-Project Container Isolation

Each project runs in its own Docker container. The container is a **blast radius boundary** — filesystem scoping and resource limits, not a full sandbox. Card classes run as Node.js modules on the host (see §7.8). Agents run inside the container with full network access.

| Endpoint | Operation |
|----------|-----------|
| `POST /api/projects/:id/container/start` | Start container, allocate port, run |
| `POST /api/projects/:id/container/stop` | Stop + remove |
| `GET /api/projects/:id/container/status` | Running state, ports, uptime |
| `GET /api/projects/:id/container/logs` | Recent stdout/stderr |

Container setup:
- **Image**: `mica-sandbox:base` (built from `docker/agent-sandbox/`)
- **User**: `sandbox` (UID 1000, non-root)
- **HOME**: `/home/sandbox`
- **Ports**: Dynamic allocation from 9000–9099 range
- **Limits**: 1GB memory, 2 CPUs default
- **Network**: Containers keep network access (agents need it for API calls, tool use, etc.)
- **No special capabilities**: No `SYS_ADMIN`, no two-phase runtime, no Python dependency install phase

#### Container volume mounts

All mounts are defined in `server/dockerSpawn.ts` (`getProjectMounts()`):

| Host path | Container path | Mode | Purpose |
|-----------|---------------|------|---------|
| `~/.claude/` | `/home/sandbox/.claude/` | rw | Claude Code state — credentials, settings, sessions, plugins, memory |
| `{project-path}/` | `{project-path}/` | rw | Project repo (1:1 path mapping so agent file paths match host) |
| `card-classes/` | `card-classes/` | ro | Built-in card class definitions |
| `server/mica_bridge/` | `/opt/mica/mica_bridge/` | ro | Mica bridge API (mica.js) for V8 isolates |
| `node_modules/` | `node_modules/` | ro | Node packages (Claude Agent SDK CLI available inside container) |

The `~/.claude/` mount gives the Claude Code CLI subprocess full access to the user's Claude environment:
- **Authentication**: `.credentials.json` (rw — OAuth tokens need refresh)
- **User settings**: `settings.json` (plugins, preferences, permissions)
- **Plugin blocklist**: `plugins/blocklist.json`
- **Session persistence**: `projects/<sanitized-cwd>/` (conversation transcripts for `resume`)
- **Auto-memory**: `projects/<sanitized-cwd>/memory/` (learned project context)

The container is the blast radius boundary — not the settings filter. Claude Code works exactly as designed; the container limits *what files and network it can reach*, not what SDK features are available.

#### Container environment

| Variable | Value | Purpose |
|----------|-------|---------|
| `HOME` | `/home/sandbox` | Points Claude Code to mounted `~/.claude/` |
| `PATH` | Standard Linux paths | Shell command resolution |
| `TERM` | `xterm-256color` | Terminal rendering |
| Auth tokens | Forwarded from host | SDK env vars (filtered: `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` are blocked) |

### 6. Disconnecting

```
POST /api/projects/:id/disconnect
```

Removes the project from `workspaces.json`. The `.mica/` directory is **left intact** so the project can reconnect later with all its history preserved.

### 7. Card Class Runtime

Card classes are Node.js ES module `render.js` files that produce interactive HTML. They can `import` any npm package. They use named exports:

| Export | Purpose |
|--------|---------|
| `export default function render(content, config)` | Returns HTML string |
| `export async function myExport(content, args, mica)` | Exposes a server-side function callable from the browser |
| `export function onConnect(mica, args)` | Called when a bidirectional channel session starts |
| `export function onMessage(msg, mica)` | Called when the browser sends data through a channel |
| `export function onDisconnect(mica)` | Called when the channel session is destroyed |

**Resolution order**: YAML frontmatter `card: name` → extension lookup via manifest (`.goal` → goal, `.md` → markdown) → fallback to `text`.

The manifest (`card-classes/_manifest.json`) maps each card class to its extension. Valid file extensions are determined dynamically from the manifest at runtime — no hardcoded extension list.

See `card-classes/CREATING_CARDS.md` for the full API reference for writing card classes.

#### 7.1 Card Types

Two types of cards, both using the same card class system:

- **Simple card** — renders content, no children. Examples: markdown, chat, todo, goal, a Three.js visualization, an xterm terminal.
- **Canvas card** — has children and layout logic. Renders a layout shell with slots; the runtime fills slots with individually isolated child cards. Examples: the project card, the portfolio card, component-canvas cards for complex projects.

The distinction is structural: a canvas card declares `data-slot` elements in its HTML where children are mounted. A simple card does not.

#### 7.2 Card Isolation Model

Each card runs in its own isolated sandbox. This is how a Three.js card, an xterm terminal card, and a mermaid diagram card coexist on the same canvas without interfering with each other. Adding or removing a card cannot break other cards.

**Isolation guarantees:**

- **Own container div** — all DOM queries use `container.querySelector()`, never `document.querySelector()`. A card cannot see or modify another card's DOM.
- **Own script scope** — inline `<script>` blocks execute in IIFEs with `mica` and `container` injected as arguments. No globals leak between cards.
- **Own mica bridge** — each card gets a bridge instance scoped to its `(project, canvas, filename)`. Calls and events are per-card.
- **Own CSS strategy** — use inline `style` attributes for widget layout (not `<style>` rules that bleed across cards). Third-party library CSS should be inlined in `<style>` tags within the card.
- **External resources deduplicated** — `<script src>` and `<link rel="stylesheet">` tags are hoisted to `<head>`, loaded once, and cached globally. Multiple cards using the same CDN library share the download.

#### 7.3 Canvas Card Composition

A canvas card's `render.js` produces an HTML layout shell with slot markers. The frontend fills those slots with individually isolated child cards.

**Server side** — the canvas card's `render()` returns layout HTML:

```html
<div class="project-header">
  <h1>My Project</h1>
  <div class="toolbar">...</div>
</div>
<div data-slot="system-cards"></div>
<div data-slot="content-cards"></div>
```

The `config` dict includes child metadata (filenames, card classes, titles, badges) but **not** child HTML. The parent card decides layout and chrome; it never touches children's content.

**Frontend** — the `CanvasCardRuntime` component:

1. Renders the parent card's HTML into a container (with its own WidgetRuntime for the parent's scripts/bridge)
2. Finds `data-slot` elements in the parent's DOM
3. For each child card, creates an isolated child container inside the appropriate slot
4. Mounts a separate WidgetRuntime per child — own bridge, own scripts, own container

This preserves full card isolation while giving the parent control over arrangement.

#### 7.4 Inter-Card Communication

Two mechanisms cover all coordination needs between cards:

**File system (persistent state changes):**

When any card writes a file (`mica.write()`, `mica.write_file()`), the file watcher detects the change and broadcasts `file-changed`, `file-created`, or `file-deleted` events to all connected cards via WebSocket. Cards subscribe with `mica.on('file-changed', cb)`.

Examples: an agent creates a document → the canvas card updates to show the new child; a todo item is written → the log card refreshes.

**Broadcast (ephemeral UI events):**

- `mica.broadcast(event, data)` — browser-side, one card signals all others
- `mica.on(event, cb)` — subscribe to broadcasts from other cards
- `mica.emit(event, data)` — Server-side, server pushes to all browser cards

Examples: selection sync between a list card and a detail card; hover highlighting across a diagram and a data table; navigation events when entering/leaving a canvas card.

Broadcasts are scoped to the current browser session. They are not persisted and not visible to other users.

#### 7.5 Card Class Scoping and Promotion

Card classes live at three scopes. Resolution checks most specific first:

```
Project .mica/.card-classes/  →  Workspace ~/.mica/card-classes/  →  Built-in card-classes/
```

| Scope | Location | Travels via | Use case |
|-------|----------|-------------|----------|
| **Project** | `.mica/.card-classes/{name}/` | git (shared with team) | Cards specific to this project |
| **Workspace** | `~/.mica/card-classes/{name}/` | local to this machine | Cards shared across your projects |
| **Built-in** | `card-classes/{name}/` | ships with Mica | Standard cards (markdown, chat, todo, etc.) |

**Promotion is copying a directory.** A card class is just a folder with a `render.js`. No package manager, no registry, no install step.

- Project → Workspace: `cp -r .mica/.card-classes/my-widget ~/.mica/card-classes/my-widget`
- Workspace → Built-in: contribute upstream to Mica

**Top-level cards** at each scope are canvas cards:

| Scope | Top-level card | Card class | What it shows |
|-------|---------------|------------|---------------|
| **Project** | `project.project` (project root) | `simple-project` | Project's child cards in a grid |
| **Workspace** | `~/.mica/_portfolio.md` | `portfolio` | Connected projects as child cards |
| **User** | (future) | (future) | Cross-workspace, identity-level |

#### 7.6 Navigation Model

Navigation is entering and leaving canvas cards:

- **Enter**: click into a canvas card → see its children
- **Leave**: ascend → return to parent canvas card

The hierarchy emerges naturally from card nesting:

```
Portfolio card (workspace scope)
  └── Project card (project scope)
        ├── goal.goal (simple card)
        ├── todo.todo (simple card)
        ├── design.md (simple card)
        ├── tasks.todo (simple card — second todo instance)
        └── Component A (canvas card)
              ├── goal.goal
              └── api-spec.mmd
```

A simple project uses a single project card with flat children. A complex project nests canvas cards for sub-components. There is no separate navigation system — it falls out from the card tree.

#### 7.7 WebSocket Communication

Rendered cards get a `mica` bridge object with five communication patterns:

| Pattern | Browser API | Use case |
|---------|-------------|----------|
| Request/response | `mica.call(fn, args)` → Promise | Toggle a checkbox, submit a form |
| Fire-and-forget | `mica.send(fn, args)` | Log an event, no response needed |
| Server push | `mica.on(event, cb)` | React to file changes (metadata only), agent updates |
| Bidirectional channel | `mica.openChannel(fn, args)` | Terminal PTY, streaming data |
| Widget broadcast | `mica.broadcast(event, data)` | Cross-card coordination |

Server-side export and stream handlers receive a `mica` bridge with minimal infrastructure: `mica.send(data)`, `mica.reply(data)`, `mica.read(filename)`, `mica.write(content)`, `mica.exec(command)`, `mica.log(message)`. Card classes import anything else they need directly (agent SDKs, node-pty, etc.).

File-change events (`file-changed`, `file-created`, `file-deleted`) carry metadata only (filename, event type) — no rendered HTML. The server does not re-render cards on file changes. Card scripts subscribe via `mica.on('file-changed', cb)` and decide whether to update by calling `mica.refresh()`, which fetches fresh HTML from the server and re-injects the card.

#### 7.8 ModuleLoader

Card classes run as standard Node.js ES modules loaded via dynamic `import()`. They have full access to `require()`, `import`, `fs`, `process`, and all Node.js APIs. Card classes can import any npm package directly (e.g., `node-pty` for terminal PTY, `marked` for markdown parsing, `@anthropic-ai/claude-agent-sdk` for agent calls).

**Runtime model:**
- Card classes are the unit of extension — all behavior lives in `render.js`, including server-side stream handlers
- `render()` runs once for initial HTML. The server does not re-render on file changes. Card scripts own their update lifecycle: they subscribe to `mica.on('file-changed')` events and call `mica.refresh()` to fetch fresh HTML when needed
- The `mica` bridge provides minimal infrastructure (file I/O, channel messaging, exec, logging) — card classes import everything else they need directly
- Blast radius is the Docker container (per-project isolation), not runtime sandboxing

**Lifecycle:**
- Modules are loaded on first render and cached by class name
- When a `render.js` file changes, the cached module is invalidated and re-imported on next render (cache-bust via timestamp)
- Stream handlers (`onConnect`/`onMessage`/`onDisconnect`) are auto-detected and registered with the ChannelManager

**Stream handler pattern** (mirrors WebSocket semantics):
- `onConnect(mica, args)` — session created, first client attached
- `onMessage(msg, mica)` — data received from any connected browser
- `onDisconnect(mica)` — session destroyed (card file deleted or server shutdown)
- `mica.send(data)` pushes to all connected browsers; `mica.reply(data)` targets the sender
- Sessions persist across browser reconnects — the ChannelManager delivers a synthetic `{ type: "attached" }` message to `onMessage` so card classes can replay state (scrollback, history)

#### 7.9 Creating Card Classes

Agents and users can create new card classes at runtime:

1. Write a `render.js` file to `.mica/.card-classes/{name}/` in the project (via the agent's `write_file` tool with `.card-classes/` prefix)
2. Create a card file — either use the class name as extension (`mycard.{name}`) or use frontmatter `card: name` in a `.md` file
3. The file watcher picks up the new class and renders it immediately

See `card-classes/CREATING_CARDS.md` for the full API reference including all five communication patterns, HTML structure, external resource loading, and complete examples.

#### 7.10 Agent Context Model

Agents in Mica operate within a three-part context model:

**Brief = agent identity.** Each agent card has a `brief.md` file in its card directory that defines who the agent is — its role, personality, constraints, and instructions. The brief is the agent's identity document. Brief templates ship with the card class (e.g., `card-classes/claude-chat/brief.md`) and are copied into the card instance directory on creation. Users and other agents can edit the brief to reshape the agent's behavior.

**Card class = SDK adapter.** The card class (`claude-chat`, `pi-chat`, etc.) is the "back of the card" — it handles the mechanics of connecting to an LLM provider, managing conversation state, and translating between the Mica bridge protocol and the provider's API. The front of the card is the instance (the user's conversation, the agent's brief, the accumulated context). Two sides of the same card: the class defines *how* it works, the instance defines *who* it is and *what* it knows.

**Canvas = shared context.** Agents read the same cards that humans see. The canvas is the shared work surface — goal, todo, brief, markdown documents, diagrams, code files. When an agent needs context, it reads the canvas. When it produces work, it writes to the canvas. There is no separate "agent memory" or "agent context window" — the canvas *is* the context, shared between humans and agents.

#### 7.11 Cards as Tools

Cards can invoke other cards programmatically via `mica.callCard(cardName, fn, args)`. This turns any card with exported functions into a reusable tool that other cards (including agent cards) can call.

```javascript
// From an agent card's server-side code:
const result = await mica.callCard('research.claude-chat', 'summarize', { topic: 'authentication' });
```

This enables composition: an orchestrator agent can delegate work to specialist agent cards, a dashboard card can pull data from multiple source cards, and card classes can be designed as reusable services.

#### 7.12 Local LLM Agent

Mica can run agents against a local LLM instead of Claude, enabling fully offline operation.

**llama-server lifecycle** (`server/llamaServer.ts`):
- Singleton process managed by Mica — starts on first agent request, stays running until shutdown
- Exposes OpenAI-compatible API at `http://127.0.0.1:8012`
- Default model: Qwen3-Coder-Next 80B MXFP4 (configurable via `MODEL_PATH`)
- Launch flags: 32K context, flash-attn, GPU offloading (`--n-gpu-layers 999`), 2 parallel slots
- Health check polling (500ms intervals, 120s timeout) before marking ready
- Graceful shutdown: SIGTERM → 5s grace → SIGKILL

**Local agent** (`server/localAgent.ts`):
- Mirrors `chatWithAgent()` from `agents.ts` but calls llama-server's HTTP API
- Tool loop (max 5 turns): `list_files`, `read_file`, `write_file`, `delete_file`
- Per-canvas conversation memory with history trimming (system prompt + last 20 messages)
- Text-embedded tool call parsing: XML fallback (`<tool_call><function=name>...`) for models that don't populate the `tool_calls` array
- Mermaid syntax sanitization: auto-quotes special characters in node labels
- Truncation detection: if `finish_reason === "length"` mid-tool-call, discards broken tool JSON and retries
- Final turn forces a text response (no tools) to guarantee a reply

**Agent routing** (`server/index.ts`):
- `routedChat()` reads `agentProvider` from `.mica/.config.json`
- `"local"` → `chatWithLocalAgent()`, `"claude"` (default) → `chatWithAgent()`
- UI toggle in `ProjectNav.tsx` sets `agentProvider` at project creation

#### 7.13 Reactive Behavior

Agents can react to human file edits and propose updates to related artifacts. This is implemented as a reactive layer (`server/reactiveAgent.ts`) that triggers the project's configured agent.

**Two-phase pipeline:**

| Phase | Model | Purpose |
|-------|-------|---------|
| **Triage** | Claude Haiku | Cheap check: does this change affect other files? Returns `{shouldReact, reason, affectedFiles}` |
| **Reaction** | Project's configured agent | Full tool-using agent call to read affected files and make/propose updates |

**Feedback loop prevention:**
- Agent-originated writes are tracked via `markAgentWrite()` — the file watcher suppresses reactions to those files
- Entries auto-expire after 5s as a safety net

**Rate limiting:**
- Per-canvas cooldown: 60s default (configurable via `config.reactive.cooldownMs`)
- Per-canvas busy lock: skips events while an agent is already working on the canvas
- Ignored files: dot-prefixed files (`.chat-history.json`, `.config.json`, etc.) are skipped by naming convention; `log.md` is explicitly skipped to avoid feedback loops
- Deletes are skipped (triage only makes sense for content changes)

**Configuration** (`.mica/.config.json`):
```json
{
  "reactive": {
    "enabled": true,
    "cooldownMs": 60000
  }
}
```

Reaction results appear in chat history tagged with `reactive: true` and `trigger: filename`.

#### 7.14 Sandbox Lifecycle Hardening

Per-project container management (`server/projectSandbox.ts`) includes several reliability guarantees:

| Guarantee | Mechanism |
|-----------|-----------|
| **Stale cleanup** | On first `getPool()` call, removes all `mica-project-*` containers from previous server runs |
| **Liveness check** | Before dispatching work, verifies container is running via `docker inspect` |
| **Auto-recreate** | If a container is found dead, tears down the sandbox and starts a fresh one |
| **Startup backoff** | Exponential backoff on container start failures: 5s, 10s, 20s, 40s, 60s cap. Tracks per-project failure count. Clears on success |

Containers are simple blast radius boundaries — filesystem scoping and resource limits. No two-phase runtime, no network toggling.

---

## File Map

### New files (project-first infrastructure)

| File | Purpose |
|------|---------|
| `server/projectConnection.ts` | Connect/disconnect projects, `.mica/` lifecycle, workspace registry, migration |
| `server/projectGit.ts` | Per-project git operations with mutex locking |
| `server/projectContainer.ts` | Per-project Docker container lifecycle |
| `server/projectSandbox.ts` | Per-project Docker sandbox with liveness checks, backoff, stale cleanup |
| `server/llamaServer.ts` | llama-server singleton lifecycle (start, health check, stop) |
| `server/localAgent.ts` | Local LLM agent with tool loop, XML fallback parsing, mermaid sanitization |
| `server/reactiveAgent.ts` | Two-phase reactive agent (triage → reaction) with cooldowns |
| `server/cardManager.ts` | Card rendering orchestration via ModuleLoader, cache management |
| `server/moduleLoader.ts` | Loads card classes as Node.js ES modules, exposes render/callExport/getStreamHandlers |
| `server/channelHandlers/module.ts` | Generic handler factory bridging card class stream exports to ChannelManager |
| `server/channelManager.ts` | Unified, transport-agnostic session manager for bidirectional channels |
| `src/api/projectGit.ts` | Frontend git API client |
| `src/api/projectContainer.ts` | Frontend container API client |

### Modified files

| File | Changes |
|------|---------|
| `server/canvasFiles.ts` | Path resolution via `getProjectPath()` instead of `canvases/` |
| `server/seedCanvases.ts` | `seedNewProject()` accepts `agentProvider`, writes to config |
| `server/index.ts` | Agent routing (`routedChat`), reactive agent integration, llama-server shutdown hook |
| `server/agents.ts` | Read from repo root + `.mica/`, exported shared prompts for local agent reuse |
| `server/workerPool.ts` | Legacy worker pool (retained for sandbox manager compatibility, scheduled for removal) |
| `server/fileWatcher.ts` | Watch project root + `.mica/`, skip `.git/` |
| `server/dockerSpawn.ts` | Export `parseDependencies` and `getOrBuildImage` for reuse |
| `src/ProjectNav.tsx` | Agent provider toggle (Claude / Local) in project creation UI |

---

## Migration from Legacy `canvases/`

Existing projects in `canvases/{project}/` can be migrated via `migrateLegacyProjects()`:

1. For each project in `canvases/_projects.json`:
   - Create a new directory (default: `~/mica-projects/{id}/`)
   - Copy canvas metadata files into `.mica/{canvas}/`
   - Copy `.card-classes/` if present
   - Write `.mica/.config.json`
   - `git init` the new directory
   - Register in `workspaces.json`
2. Original `canvases/` directory preserved as fallback

---

## Design Decisions

**Why card files at the project root?** Cards are the work, not metadata. They should be visible, navigable, and first-class — not hidden inside a dot-directory. `.mica/` holds infrastructure (config, chat history, layout, card class definitions). Card files live alongside everything else in the project.

**Why `workspaces.json` outside projects?** The workspace is a local concern — which projects *this* Mica instance is connected to. Different machines can have different workspace compositions. This is the "workspace" persistence tier. Cross-project cards (like the portfolio view) live here.

**Why per-project containers?** Containers are blast radius boundaries. An errant agent in Project A shouldn't touch Project B's files or consume all system resources. The container scopes filesystem access and enforces resource limits — it doesn't sandbox card code (V8 isolates handle that).

**Why raw HTML, not a widget framework?** Card classes return plain HTML strings. This means any library works — Three.js, D3, Leaflet, xterm.js — without framework wrappers or compatibility layers. It's also the most natural output for AI code generation: LLMs produce HTML fluently, and there's no abstraction layer to hallucinate wrong.

**Why per-project git?** Projects have their own commit history, branches, and workflow. Mica doesn't impose a shared repo or monorepo structure. Each project's version control is self-contained.

**What about `.gitignore`?** Recommend adding `.mica/.chat-history.json` and `.mica/*/.chat-history.json` to the project's `.gitignore`. Card files (at project root) and `.mica/` infrastructure (`.config.json`, `.layout.json`, `.card-classes/`) should be committed — it's valuable shared project context. `.chat-history.json` is the exception since it's ephemeral conversation state.

## Security Model

Card classes are code — they run as Node.js modules on the server and as inline scripts in the browser. The security model uses two layers of defense.

### Two-layer model

```
┌─────────────────────────────────────────────────┐
│  Mica Server (host, trusted)                    │
│    ├── Network policy + proxy                   │
│    ├── /proxy/cdn/*  (allowlisted CDN fetch)    │
│    ├── /api/agent/chat (proxies Claude API)     │
│    │                                            │
│    ├── ModuleLoader (card class runtime)        │
│    │    ├── Card class A  (Node.js module)      │
│    │    └── Card class B  (Node.js module)      │
│    │                                            │
│    ├──→ Project A Container (blast radius)      │
│    │      ├── Agent Bash sessions               │
│    │      └── Project app                       │
│    │                                            │
│    └──→ Project B Container (blast radius)      │
└─────────────────────────────────────────────────┘
```

| Layer | What it protects | Mechanism |
|-------|-----------------|-----------|
| **Container** | Blast radius — filesystem scoping + resource limits | Docker: project dir (rw), `~/.claude/` (rw for agent functionality), no `~/.ssh`/`~/.aws`/other projects. 1GB mem, 2 CPU default |
| **Mica server** | Network policy + proxy | Per-card network permissions, CDN allowlist proxy, agent API proxy |

### Card class trust model

Card classes run as Node.js modules with full access to the runtime — `import`, `fs`, `process`, `child_process`, and all Node.js APIs. There is no runtime sandboxing of card code. Security relies on:

- **Trusted source**: Built-in card classes ship with Mica. Project-level classes (`.mica/.card-classes/`) are committed to the project repo and reviewed like any other code.
- **Container blast radius**: Agent-spawned processes (including any card-initiated `mica.exec()` calls) run inside the per-project Docker container with filesystem and resource limits.
- **Browser-side CSP**: Content Security Policy blocks browser-side card scripts from reaching external origins (see below).

### Per-card network permissions

Card classes declare network access in their manifest:

```json
{
  "my-widget": {
    "extension": ".my-widget",
    "badge": "WIDGET",
    "network": true
  }
}
```

- **Default: deny all.** Cards with no `network` field (or `network: false`) have no network-gated features surfaced
- Cards with `network: true` are surfaced in the UI so users know which cards may reach the internet
- Card classes can use Node.js `fetch` or any HTTP library directly (they have full Node.js access)

### Agent trust model

Agents (Claude, local LLM) run inside the per-project container with full power — same trust model as Claude Code. They can read/write files, run shell commands, and make network requests within the container's blast radius. The container limits *what they can touch*, not *what they can do*.

### Claude Code integration and `~/.claude/`

The Claude Agent SDK spawns a **Claude Code CLI** subprocess for each agent call. The CLI reads from `~/.claude/` on every startup for authentication, settings, and session state. Mica mounts the host's `~/.claude/` into the container so Claude Code works identically to running on the host.

**What `~/.claude/` contains and why it's mounted:**

| Data | Path | Why the agent needs it |
|------|------|----------------------|
| OAuth credentials | `.credentials.json` | Authentication with Claude API (rw — tokens refresh) |
| User settings | `settings.json` | Plugins, preferences, permissions, model config |
| Plugin blocklist | `plugins/blocklist.json` | Safety blocklist fetched from Anthropic |
| Marketplace cache | `cache/` | Cached marketplace manifests for plugins |
| Session transcripts | `projects/<key>/*.jsonl` | Conversation history for `resume` (multi-turn continuity) |
| Auto-memory | `projects/<key>/memory/` | Learned project context across conversations |
| Feature flags | `statsig/` | A/B test flags for Claude Code features |

**What is NOT mounted:**

| Data | Why excluded |
|------|-------------|
| `~/.ssh/` | No SSH key access — agents use HTTPS for git |
| `~/.aws/`, `~/.config/gcloud/` | No cloud credentials beyond Claude API |
| Other project dirs | Each container sees only its own project |
| Host system files | Container runs as non-root `sandbox` user |

**Design rationale:** The SDK's own documentation suggests `persistSession: false` and `settingSources: []` for ephemeral container deployments. Mica takes a different approach: mount `~/.claude/` so the user's full Claude Code environment is available — plugins, settings, session resume, auto-memory. The container enforces the blast radius (filesystem + resource limits), not the settings filter. This follows Mica's principle: *don't constrain the user's tools, protect them if things go awry.*

**Session isolation by project:** The SDK keys session storage by `cwd`. Each project's agent runs with `cwd` set to the project path, so sessions are stored at `~/.claude/projects/<sanitized-project-path>/`. Different projects have separate session directories automatically.

### Browser-side defense (CSP)

Content Security Policy blocks `fetch()` to external origins from card JavaScript:
- `connect-src 'self'` — cards can only talk to the Mica server
- `script-src` / `style-src` allowlist trusted CDNs only
- Defense in depth: even if isolate sandboxing were bypassed, browser-side exfiltration is blocked

### Portfolio and workspace scope

Built-in card classes (portfolio, project chrome) run on the host — they're trusted code that ships with Mica. They only read project metadata, never execute project-scoped card classes. Per-project isolation doesn't affect the portfolio view.
