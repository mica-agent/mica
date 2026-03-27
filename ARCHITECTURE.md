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
    ├── config.json         # Project manifest
    ├── _project.md         # Project card (top-level canvas card)
    ├── _brief.md           # Agent personality/instructions
    ├── _goal.md            # Project objectives
    ├── _todo.md            # Task tracker
    ├── _log.md             # Activity log
    ├── _chat.md            # Chat card
    ├── _chat-history.json  # Chat persistence
    └── _card-classes/      # Project-specific card classes
        └── my-widget/
            └── render.py
```

The project card (`_project.md`) is the top-level canvas card — it's what you see when you open the project. Its children are the other files in `.mica/` (goal, todo, brief, log, chat, plus any user-created content cards). For complex projects, subdirectories can hold nested canvas cards with their own children.

**`.mica/` holds Mica metadata only** — agent briefs, goals, chat history, card state. The project's actual source code stays in the project root. Agents read/write both: project files for real work, `.mica/` files for coordination. In the card model (see SPEC.md), this metadata represents the serialized state of project-scoped cards.

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
- **Image**: `mica-sandbox:base` with dependencies parsed from `_brief.md`
- **Volume**: Project repo mounted at `/workspace`
- **Ports**: Dynamic allocation from 9000–9099 range
- **Limits**: 1GB memory, 2 CPUs default
- **Entrypoint**: From `.mica/config.json` runtime section, or auto-detected (app.py → python3, package.json → npm start)

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

**Resolution order**: YAML frontmatter `card: name` → filename convention (`_goal.md` → goal) → extension fallback (`.md` → markdown).

See `card-classes/CREATING_WIDGETS.md` for the full API reference for writing card classes.

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
Project .mica/_card-classes/  →  Workspace ~/.mica/card-classes/  →  Built-in card-classes/
```

| Scope | Location | Travels via | Use case |
|-------|----------|-------------|----------|
| **Project** | `.mica/_card-classes/{name}/` | git (shared with team) | Cards specific to this project |
| **Workspace** | `~/.mica/card-classes/{name}/` | local to this machine | Cards shared across your projects |
| **Built-in** | `card-classes/{name}/` | ships with Mica | Standard cards (markdown, chat, todo, etc.) |

**Promotion is copying a directory.** A card class is just a folder with a `render.py`. No package manager, no registry, no install step.

- Project → Workspace: `cp -r .mica/_card-classes/my-widget ~/.mica/card-classes/my-widget`
- Workspace → Built-in: contribute upstream to Mica

**Top-level cards** at each scope are canvas cards:

| Scope | Top-level card | Card class | What it shows |
|-------|---------------|------------|---------------|
| **Project** | `.mica/_project.md` | `project` | Project's child cards in a grid |
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
        ├── _goal.md (simple card)
        ├── _todo.md (simple card)
        ├── design.md (simple card)
        └── Component A (canvas card)
              ├── _goal.md
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

Card classes run in a pool of 8 long-lived Python worker processes. Workers communicate with the server via JSON lines on stdin/stdout. Class modules are cached per-worker and invalidated when the source file changes.

#### 7.9 Creating Card Classes

Agents and users can create new card classes at runtime:

1. Write a `render.py` file to `.mica/_card-classes/{name}/` in the project
2. Create a `.md` file that references the class (via frontmatter `card: name` or filename convention `_{name}.md`)
3. The file watcher picks up the new class and renders it immediately

See `card-classes/CREATING_WIDGETS.md` for the full API reference including all five communication patterns, HTML structure, external resource loading, and complete examples.

---

## File Map

### New files (project-first infrastructure)

| File | Purpose |
|------|---------|
| `server/projectConnection.ts` | Connect/disconnect projects, `.mica/` lifecycle, workspace registry, migration |
| `server/projectGit.ts` | Per-project git operations with mutex locking |
| `server/projectContainer.ts` | Per-project Docker container lifecycle |
| `src/api/projectGit.ts` | Frontend git API client |
| `src/api/projectContainer.ts` | Frontend container API client |

### Modified files

| File | Changes |
|------|---------|
| `server/canvasFiles.ts` | Path resolution via `getProjectPath()` instead of `canvases/` |
| `server/seedCanvases.ts` | `seedNewProject()` → `initMicaDir()` |
| `server/index.ts` | New connect/disconnect/git/container endpoints |
| `server/agents.ts` | Read from repo root + `.mica/`, auto-commit after changes |
| `server/fileWatcher.ts` | Watch project root + `.mica/`, skip `.git/` |
| `server/dockerSpawn.ts` | Export `parseDependencies` and `getOrBuildImage` for reuse |

---

## Migration from Legacy `canvases/`

Existing projects in `canvases/{project}/` can be migrated via `migrateLegacyProjects()`:

1. For each project in `canvases/_projects.json`:
   - Create a new directory (default: `~/mica-projects/{id}/`)
   - Copy canvas metadata files into `.mica/{canvas}/`
   - Copy `_card-classes/` if present
   - Write `.mica/config.json`
   - `git init` the new directory
   - Register in `workspaces.json`
2. Original `canvases/` directory preserved as fallback

---

## Design Decisions

**Why `.mica/` inside the project?** So the project carries its Mica context with it. Clone the repo and Mica can reconnect with all card state intact. Team members share briefs, goals, and todos through git. This is the "project" persistence tier (see SPEC.md §2.4).

**Why `workspaces.json` outside projects?** The workspace is a local concern — which projects *this* Mica instance is connected to. Different machines can have different workspace compositions. This is the "workspace" persistence tier. Cross-project cards (like the portfolio view) live here.

**Why per-project containers?** An errant process in Project A shouldn't crash Project B. Docker isolation means each project's runtime is independent — separate filesystem, network, resource limits.

**Why per-project git?** Projects have their own commit history, branches, and workflow. Mica doesn't impose a shared repo or monorepo structure. Each project's version control is self-contained.

**What about `.gitignore`?** Recommend adding `.mica/_chat-history.json` and `.mica/*/_chat-history.json` to the project's `.gitignore`. Everything else in `.mica/` (briefs, goals, todos, card layouts) should be committed — it's valuable shared project context.
