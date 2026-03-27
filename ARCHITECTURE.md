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
    ├── workspace/          # Default layer
    │   ├── _brief.md       # Agent personality/instructions
    │   ├── _goal.md        # Layer objectives
    │   ├── _todo.md        # Task tracker
    │   ├── _log.md         # Activity log
    │   └── _chat-history.json
    ├── architecture/       # Additional layers as needed
    └── _card-classes/      # Custom widget classes
```

**Layer directories hold Mica metadata only** — agent briefs, goals, chat history, card state. The project's actual source code stays in the project root. Agents read/write both: project files for real work, `.mica/` files for coordination. In the card model (see SPEC.md), this metadata represents the serialized state of project-scoped cards.

### 3. Workspace Registry

`workspaces.json` lives in Mica's own directory (not inside any project):

```json
{
  "projects": [
    {
      "id": "my-app",
      "name": "My App",
      "path": "/home/user/repos/my-app",
      "layers": ["workspace"],
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

After an agent makes changes, Mica auto-commits: `mica: {layer} agent update`.

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
| `server/layerFiles.ts` | Path resolution via `getProjectPath()` instead of `layers/` |
| `server/seedLayers.ts` | `seedNewProject()` → `initMicaDir()` |
| `server/index.ts` | New connect/disconnect/git/container endpoints |
| `server/agents.ts` | Read from repo root + `.mica/`, auto-commit after changes |
| `server/fileWatcher.ts` | Watch project root + `.mica/`, skip `.git/` |
| `server/dockerSpawn.ts` | Export `parseDependencies` and `getOrBuildImage` for reuse |

---

## Migration from Legacy `layers/`

Existing projects in `layers/{project}/` can be migrated via `migrateLegacyProjects()`:

1. For each project in `layers/_projects.json`:
   - Create a new directory (default: `~/mica-projects/{id}/`)
   - Copy layer metadata files into `.mica/{layer}/`
   - Copy `_card-classes/` if present
   - Write `.mica/config.json`
   - `git init` the new directory
   - Register in `workspaces.json`
2. Original `layers/` directory preserved as fallback

---

## Design Decisions

**Why `.mica/` inside the project?** So the project carries its Mica context with it. Clone the repo and Mica can reconnect with all card state intact. Team members share briefs, goals, and todos through git. This is the "project" persistence tier (see SPEC.md §2.4).

**Why `workspaces.json` outside projects?** The workspace is a local concern — which projects *this* Mica instance is connected to. Different machines can have different workspace compositions. This is the "workspace" persistence tier. Cross-project cards (like the portfolio view) live here.

**Why per-project containers?** An errant process in Project A shouldn't crash Project B. Docker isolation means each project's runtime is independent — separate filesystem, network, resource limits.

**Why per-project git?** Projects have their own commit history, branches, and workflow. Mica doesn't impose a shared repo or monorepo structure. Each project's version control is self-contained.

**What about `.gitignore`?** Recommend adding `.mica/_chat-history.json` and `.mica/*/_chat-history.json` to the project's `.gitignore`. Everything else in `.mica/` (briefs, goals, todos, card layouts) should be committed — it's valuable shared project context.
