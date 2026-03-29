# Mica Architecture: Project-First Model

## Core Principle

**Projects are sovereign.** They exist as independent git repos that work fine without Mica. Mica *connects* to projects and adds value — card-based views, AI agents, extensible canvas — without creating lock-in. Remove `.mica/` and the project is untouched.

This is analogous to `.vscode/` or `.github/` — a lightweight footprint that enhances but doesn't own. See [SPEC.md](SPEC.md) for the product definition and card model.

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

### 2. The `.mica/` Directory

```
my-project/
├── src/                    ← project's own files (untouched)
├── README.md
├── .git/
└── .mica/                  ← Mica's footprint
    ├── .config.json        # Project manifest (agent provider, reactive settings, worker config)
    ├── .chat-history.json  # Chat persistence
    ├── .layout.json        # Card layout state
    ├── _project.project    # Project card (top-level canvas card)
    ├── _brief.brief        # Agent personality/instructions
    ├── _goal.goal          # Project objectives
    ├── _todo.todo          # Task tracker
    ├── _log.log            # Activity log
    ├── _chat.chat          # Chat card
    └── .card-classes/      # Project-specific card classes
        └── my-widget/
            └── render.py
```

The project card (`_project.project`) is the top-level canvas card — it's what you see when you open the project. Its children are the other files in `.mica/` (goal, todo, brief, log, chat, plus any user-created content cards). For complex projects, subdirectories can hold nested canvas cards with their own children.

**`.mica/` holds Mica metadata only** — agent briefs, goals, chat history, card state. The project's actual source code stays in the project root. Agents read/write both: project files for real work, `.mica/` files for coordination. In the card model (see SPEC.md), this metadata represents the serialized state of project-scoped cards.

#### Three-tier file naming convention

Files in `.mica/` follow a three-tier naming convention:

| Prefix | Meaning | Visible to agents? | Examples |
|--------|---------|-------------------|----------|
| `.` (dot) | Internal data — not cards | No | `.config.json`, `.chat-history.json`, `.layout.json` |
| `_` (underscore) | System card — seeded by Mica | Yes | `_goal.goal`, `_todo.todo`, `_brief.brief` |
| (none) | User card — created by humans/agents | Yes | `notes.md`, `architecture.mmd`, `tasks.todo` |

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
| `brief` | `.brief` | Markdown | Mica-native |
| `log` | `.log` | Markdown | Mica-native |
| `chat` | `.chat` | Managed | Mica-native |
| `agent` | `.agent` | Managed | Mica-native |
| `canvas` | `.canvas` | Managed | Mica-native |
| `simple-project` | `.project` | Markdown | Mica-native |
| `terminal` | `.terminal` | Managed | Mica-native |

The content format is independent of the extension. A `.todo` file contains markdown internally — the `todo` card class renders it with interactive checkboxes. The extension determines *behavior*, not format.

Multiple cards of the same class are natural: `backend.todo` and `frontend.todo` are both rendered by the `todo` class. The `_` prefix on system cards is a convention, not a constraint.

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

Each project runs in its own Docker container. No cross-project interference.

| Endpoint | Operation |
|----------|-----------|
| `POST /api/projects/:id/container/start` | Build image, allocate port, run |
| `POST /api/projects/:id/container/stop` | Stop + remove |
| `GET /api/projects/:id/container/status` | Running state, ports, uptime |
| `GET /api/projects/:id/container/logs` | Recent stdout/stderr |

Container setup:
- **Image**: `mica-sandbox:base` with dependencies parsed from `_brief.brief`
- **Volume**: Project repo mounted at `/workspace`
- **Ports**: Dynamic allocation from 9000–9099 range
- **Limits**: 1GB memory, 2 CPUs default
- **Entrypoint**: From `.mica/.config.json` runtime section, or auto-detected (app.py → python3, package.json → npm start)

### 6. Disconnecting

```
POST /api/projects/:id/disconnect
```

Removes the project from `workspaces.json`. The `.mica/` directory is **left intact** so the project can reconnect later with all its history preserved.

### 7. Card Class Runtime

Card classes are Python `render.py` files that produce interactive HTML. They use three decorators:

| Decorator | Purpose |
|-----------|---------|
| `@mica.render` | Returns HTML string from `(content, config)` |
| `@mica.export` | Exposes a server-side function callable from the browser |
| `@mica.channel` | Opens a persistent bidirectional stream (for terminals, real-time data) |

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

A canvas card's `render.py` produces an HTML layout shell with slot markers. The frontend fills those slots with individually isolated child cards.

**Server side** — the canvas card's `@mica.render` returns layout HTML:

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
- `mica.emit(event, data)` — Python-side, server pushes to all browser cards

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

**Promotion is copying a directory.** A card class is just a folder with a `render.py`. No package manager, no registry, no install step.

- Project → Workspace: `cp -r .mica/.card-classes/my-widget ~/.mica/card-classes/my-widget`
- Workspace → Built-in: contribute upstream to Mica

**Top-level cards** at each scope are canvas cards:

| Scope | Top-level card | Card class | What it shows |
|-------|---------------|------------|---------------|
| **Project** | `.mica/_project.project` | `simple-project` | Project's child cards in a grid |
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
        ├── _goal.goal (simple card)
        ├── _todo.todo (simple card)
        ├── design.md (simple card)
        ├── tasks.todo (simple card — second todo instance)
        └── Component A (canvas card)
              ├── _goal.goal
              └── api-spec.mmd
```

A simple project uses a single project card with flat children. A complex project nests canvas cards for sub-components. There is no separate navigation system — it falls out from the card tree.

#### 7.7 WebSocket Communication

Rendered cards get a `mica` bridge object with five communication patterns:

| Pattern | Browser API | Use case |
|---------|-------------|----------|
| Request/response | `mica.call(fn, args)` → Promise | Toggle a checkbox, submit a form |
| Fire-and-forget | `mica.send(fn, args)` | Log an event, no response needed |
| Server push | `mica.on(event, cb)` | React to file changes, agent updates |
| Bidirectional channel | `mica.openChannel(fn, args)` | Terminal PTY, streaming data |
| Widget broadcast | `mica.broadcast(event, data)` | Cross-card coordination |

Server-side export handlers can call back into Mica: `mica.write()`, `mica.read_file()`, `mica.emit()`, `mica.agent.chat()`.

#### 7.8 Worker Pool

Card classes run in a pool of long-lived Python worker processes (configurable `warm` and `max` count per project). Workers communicate with the server via JSON lines on stdin/stdout. Class modules are cached per-worker and invalidated when the source file changes.

**Lifecycle:**
- `warm` workers (default 1) start when the project sandbox initializes and stay alive
- Extra workers spawn on demand up to `max` (default 6)
- Idle extra workers are evicted after 30s of inactivity
- Channel workers (terminal PTY, etc.) are never idle-evicted

**Restart backoff:**
- When a worker exits unexpectedly, it restarts with exponential backoff: 1s, 2s, 4s, ... up to 30s cap
- After 8 consecutive failures, the worker stops automatic restarts
- Backoff resets on successful startup (worker sends `ready` message)

**Work dispatch:**
- Renders prefer idle workers, then spawn extras, then round-robin across alive workers
- Export calls and channel opens require an idle worker (will wait up to 60s)
- Each worker tracks busy/idle state; request contexts are scoped per `(project, canvas, filename)`

#### 7.9 Creating Card Classes

Agents and users can create new card classes at runtime:

1. Write a `render.py` file to `.mica/.card-classes/{name}/` in the project
2. Create a card file — either use the class name as extension (`mycard.{name}`) or use frontmatter `card: name` in a `.md` file
3. The file watcher picks up the new class and renders it immediately

See `card-classes/CREATING_CARDS.md` for the full API reference including all five communication patterns, HTML structure, external resource loading, and complete examples.

#### 7.10 Local LLM Agent

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

#### 7.11 Reactive Behavior

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
- Ignored files: dot-prefixed files (`.chat-history.json`, `.config.json`, etc.) are skipped by naming convention; `_log.log` is explicitly skipped to avoid feedback loops
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

#### 7.12 Sandbox Lifecycle Hardening

Per-project container management (`server/projectSandbox.ts`) includes several reliability guarantees:

| Guarantee | Mechanism |
|-----------|-----------|
| **Stale cleanup** | On first `getPool()` call, removes all `mica-project-*` containers from previous server runs |
| **Liveness check** | Before dispatching work, verifies container is running via `docker inspect` |
| **Auto-recreate** | If a container is found dead, tears down the sandbox and starts a fresh one |
| **Startup backoff** | Exponential backoff on container start failures: 5s, 10s, 20s, 40s, 60s cap. Tracks per-project failure count. Clears on success |

The two-phase container runtime (setup with network → execute without network) is unchanged — see Section 5 and the Security Model.

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
| `server/cardManager.ts` | Card rendering dispatch through sandbox/global worker pools |
| `src/api/projectGit.ts` | Frontend git API client |
| `src/api/projectContainer.ts` | Frontend container API client |

### Modified files

| File | Changes |
|------|---------|
| `server/canvasFiles.ts` | Path resolution via `getProjectPath()` instead of `canvases/` |
| `server/seedCanvases.ts` | `seedNewProject()` accepts `agentProvider`, writes to config |
| `server/index.ts` | Agent routing (`routedChat`), reactive agent integration, llama-server shutdown hook |
| `server/agents.ts` | Read from repo root + `.mica/`, exported shared prompts for local agent reuse |
| `server/workerPool.ts` | Exponential restart backoff, configurable warm/max, idle eviction |
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

**Why `.mica/` inside the project?** So the project carries its Mica context with it. Clone the repo and Mica can reconnect with all card state intact. Team members share briefs, goals, and todos through git. This is the "project" persistence tier (see SPEC.md §2.4).

**Why `workspaces.json` outside projects?** The workspace is a local concern — which projects *this* Mica instance is connected to. Different machines can have different workspace compositions. This is the "workspace" persistence tier. Cross-project cards (like the portfolio view) live here.

**Why per-project containers?** An errant process in Project A shouldn't crash Project B. Docker isolation means each project's runtime is independent — separate filesystem, network, resource limits.

**Why per-project git?** Projects have their own commit history, branches, and workflow. Mica doesn't impose a shared repo or monorepo structure. Each project's version control is self-contained.

**What about `.gitignore`?** Recommend adding `.mica/.chat-history.json` and `.mica/*/.chat-history.json` to the project's `.gitignore`. Everything else in `.mica/` (briefs, goals, todos, card layouts) should be committed — it's valuable shared project context. Dot-prefixed data files (`.config.json`, `.layout.json`) are project config and should be committed; `.chat-history.json` is the exception since it's ephemeral conversation state.

## Security Model

Card classes are code — they run Python on the server and JavaScript in the browser. The security model prevents data exfiltration while allowing cards full local compute (PTY, GPU, filesystem).

### Principle: Network is the key boundary

A card can spawn a shell, read project files, render with Three.js or xterm.js. It cannot send data to the internet. Network egress is the threat; local access is a feature.

### Per-project container isolation

Each project runs all untrusted code inside a Docker container:

```
Mica Server (host, trusted)
  ├── /proxy/cdn/*          (allowlisted CDN fetch)
  ├── /api/agent/chat       (proxies Claude API)
  │
  ├──→ Project A Container  (--network=none, always-on)
  │      ├── Python workers (elastic pool)
  │      ├── Agent Bash sessions
  │      └── Project app
  │
  └──→ Project B Container  (--network=none, always-on)
```

Container properties:
- **Filesystem**: project directory (rw) + card class libraries (ro). No `~/.ssh`, `~/.aws`, other projects.
- **Network**: `--network=none`. Zero outbound. Communication to Mica server via Unix socket only.
- **Env vars**: filtered allowlist (PATH, HOME, TERM, PYTHONPATH). No API keys or tokens.
- **Always-on**: containers run while the project is registered, supporting multi-endpoint access.

### Two-phase runtime

Follows the Codex model:
1. **Setup phase**: container starts with network. Installs dependencies from `_brief.brief`, caches CDN resources.
2. **Execute phase**: network is removed. Cards render offline. CDN resources served from cache. Agent API calls proxied through the Mica server.

### Browser-side defense (CSP)

Content Security Policy blocks `fetch()` to external origins from card JavaScript:
- `connect-src 'self'` — cards can only talk to the Mica server
- `script-src` / `style-src` allowlist trusted CDNs only
- Defense in depth: even if container isolation were bypassed, browser-side exfiltration is blocked

### Elastic worker pool

Per-project workers with configurable warm/max policy (`.mica/.config.json`):
- `warm` (default 1): idle workers kept alive with hot card class cache
- `max` (default 6): upper bound; additional workers spawn on demand, die after 30s idle
- Memory pressure: when container exceeds 80% memory, idle workers beyond `warm` are evicted
- Channel workers (terminal PTY, etc.) are never idle-evicted

### Portfolio and workspace scope

Built-in card classes (portfolio, project chrome) run on the host — they're trusted code that ships with Mica. They only read project metadata, never execute project-scoped card classes. Per-project isolation doesn't affect the portfolio view.
