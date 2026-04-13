# Mica Lite — Specification

## What Mica Lite Is

A planning canvas that sits alongside your coding agent (Claude Code, Cline, Cursor). You think and plan in Mica, you code in your preferred tool. Both see the same project files.

Mica runs as a standalone Docker container scoped to one project directory.

## Design Principles

1. **Files are files.** Plain markdown, mermaid, JSON, text — wherever the user puts them. No Mica-imposed structure.
2. **Mica is a lens.** It renders user files on a spatial canvas with rich interactive UIs. The file is always the source of truth.
3. **Mica sees and collaborates on all project files.** Mica reads and writes user files — it's a collaborator, not a viewer. `.mica/` holds Mica's operational metadata (layout, AI context, chat history, config), not project documentation.
4. **Minimum friction.** Mica adapts to the user's existing file structure. It's a new team member, not a new workflow.
5. **Live sources become snapshots.** External data (JIRA, GitHub, shell output) gets materialized to files. Everything on canvas is file-backed, versionable in git.
6. **Flip the card.** The back of a card shows how it works — how it was generated, what AI guidance was provided, its rendering logic. Transparent and inspectable.
7. **AI generates the UI.** The Mica AI agent generates card classes (render.js). mica.* provides only the infrastructure the AI can't do alone.

## Card Classes

A card class is a directory with a `render.js` file. Built-in classes ship with Mica. The AI generates new ones at runtime. Promotion from AI-generated to built-in is just moving the directory.

### One Mechanism, Two Locations

```
card-classes/                      # Built-in, ships with Mica
  canvas/render.js                 # Layout surface (drag, resize, toolbar, sync)
  terminal/render.js               # PTY terminal
  markdown/render.js               # Markdown viewer/editor
  mermaid/render.js                # Diagram renderer

.mica/card-classes/                # AI-generated, same contract
  todo/render.js                   # Created by AI during session
  kanban/render.js                 # Created by AI during session
```

Resolution order: `.mica/card-classes/` first (project-scoped), then `card-classes/` (built-in).

Promotion: `mv .mica/card-classes/todo/ card-classes/todo/` — no code changes.

### render.js Contract

```js
// Required: produce HTML for the card
export default function render(content, config) {
  return `
    <div class="my-card">...</div>
    <style>...</style>
    <script>
      // 'container' = this card's scoped DOM element (injected by CARD_SHIM)
      // 'mica' = bridge to server (injected by CARD_SHIM)
      
      mica.on('file-changed', function(e) {
        if (e.source === mica.windowId) return; // skip self
        mica.refresh();
      });
    </script>
  `;
}

// Optional: server-side export functions (callable via mica.call)
export async function save(content, args, mica) {
  await mica.write('document.md', args.content);
  return { ok: true };
}

// Optional: metadata
export const metadata = {
  extension: ".md",
  badge: "MD",
  primaryFile: "document.md",
  defaultTitle: "Document"
};

// Optional: external dependencies
export const dependencies = {
  scripts: ["https://cdn.jsdelivr.net/..."],
  styles: ["https://cdn.jsdelivr.net/..."]
};
```

### How Cards Are Hosted

**CardRuntime** (React component) hosts card classes:

1. Loads `render.js` from card class directory
2. Calls `render(content, config)` → gets HTML string
3. Injects HTML into card container
4. Preloads declared dependencies (scripts, styles)
5. Wraps inline `<script>` blocks with **CARD_SHIM**
6. CARD_SHIM provides:
   - `container` — scoped DOM element (querySelector/getElementById scoped to this card)
   - `mica` — bridge to server APIs
   - Auto-cleanup of timers, intervals, event listeners on destroy
   - Error catching and reporting

### Canvas Is a Card Class

The canvas itself is a card class (`card-classes/canvas/render.js`). It:

- Produces `#canvas-freeform` container element
- Owns drag/resize via event delegation on the container
- Owns layout persistence (debounced 500ms, includes `source: mica.windowId`)
- Owns toolbar (+ New File, + AI Chat, etc.)
- Handles cross-window sync via `mica.on('layout-changed')` with source filtering

React's `CanvasCardRuntime` is a thin host — it portals child `CardFrame` components into `#canvas-freeform`. It does NOT own layout, drag, resize, or toolbar.

Different seeds can provide different canvas card classes (freeform, grid, kanban, etc.).

## mica.* API

mica.* is the security boundary between client-side card code and the server. Card classes run unrestricted in the browser. Server-side capabilities are limited to registered built-in plugins.

### Request/Response Methods

Accessed via the mica bridge in card scripts, proxied to server via `POST /api/mica/:namespace/:method`.

| Namespace | Method | Backend Plugin | Security |
|---|---|---|---|
| `mica.file` | read, write, list | files.ts | Scoped to /project |
| `mica.chat` | send, history, clear | micaChat.ts | Proxies to llama-server |
| `mica.state` | bind, update, sync | stateMgr.ts (TBD) | In-memory + file persist |
| `mica.source` | fetch (MCP), exec (shell) | sourceMgr.ts (TBD) | MCP config in .mica/ |

### Events

Delivered via WebSocket broadcast. All events carry `source` for loop prevention.

| Event | Payload | Typical Source |
|---|---|---|
| `file-changed` | `{ filename, source }` | windowId or card name |
| `file-created` | `{ filename, content, source }` | windowId or card name |
| `file-deleted` | `{ filename, source }` | windowId or card name |
| `layout-changed` | `{ source }` | windowId |

### Source ID Pattern

Every event carries `source` — the windowId, card name, or "user" that originated the change. Listeners compare `event.source === mica.windowId` to skip self-originated events. This prevents loops:

1. Card A writes a file → server broadcasts `file-changed` with `source: "card-A"`
2. Card A sees `source === myName` → skips
3. Card B sees a different source → processes the update
4. Browser 2 sees a different windowId → processes the update

### Lifecycle Methods

| Method | Purpose |
|---|---|
| `mica.on(event, callback)` | Subscribe to events (returns unsub function) |
| `mica.onDestroy(callback)` | Register cleanup for card unmount |
| `mica.openChannel(fn, args)` | Bidirectional stream (terminal, etc.) |
| `mica.refresh()` | Re-fetch and re-render this card |
| `mica.call(fn, args)` | Call server-side export function |
| `mica.send(fn, args)` | Fire-and-forget to server export |

### Properties

| Property | Value |
|---|---|
| `mica.windowId` | Unique ID for this browser window |
| `mica.filename` | This card's filename |

## Deployment

**One Docker container per project.**

```bash
docker run --gpus all \
  -v ~/dev/myproject:/project \
  -v ~/.cache/huggingface:/home/mica/.cache/huggingface \
  -p 5173:5173 \
  mica
```

User workflow:
1. Clone a project repo to their machine (e.g. `~/dev/myproject`)
2. Run the docker command above
3. Open browser at `http://localhost:5173` (Mica canvas)
4. Open their editor (VS Code, Cursor) on the same `~/dev/myproject`
5. Both Mica and the editor see the same files

Container includes: Node server + Vite frontend + llama-server (Qwen3). Model weights cached on host via bind mount for fast loading.

No multi-project management. One container = one project. To switch, stop and start with a different `-v` mount.

## `.mica/` Directory

```
.mica/
  card-classes/          # AI-generated card classes (same contract as built-in)
    todo/render.js
  canvas-back.md         # Project-level AI context (canvas back side)
  cards/                 # Per-card back sides
    TODO.md              # Back of TODO.md
  layout.json            # Card positions, sizes on canvas
  chats/                 # AI chat histories
    chat-1.json
  config.json            # Preferences, MCP server config
```

User decides whether to gitignore `.mica/` or commit it.

## Project Seeds

A seed bootstraps a new project's canvas:

1. **AI context** (most important) — canvas-back.md teaches the AI how to participate
2. **Canvas card class** — determines the layout type
3. **Starter files** — template docs with frontmatter hints
4. **Layout** — pre-arranged card positions
5. **Card classes** — project-type-specific renderers

Creating seeds:
- **From scratch**: author a seed directory
- **From existing project**: snapshot + AI refinement into reusable template
- **AI-generated**: describe the project type, AI creates everything

## Security

Client-side card code (render.js) is unrestricted browser JS. Server-side is locked to built-in mica.* plugins. New backend capabilities require a new plugin written by us.

Container security (practical defaults):
- Non-root user inside container
- `--cap-drop=ALL`
- Project-only mount (`-v path:/project`)
- HF cache mount for model weights
- GPU via `--gpus`
- Full network (for MCP servers calling external APIs)
