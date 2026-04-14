# Mica Lite -- Specification

## What Mica Lite Is

A planning canvas that sits alongside your coding agent (Claude Code, Cline, Cursor). You think and plan in Mica, you code in your preferred tool. Both see the same project files.

Mica runs as a standalone Docker container scoped to one project directory.

## Design Principles

1. **Files are files.** Plain markdown, mermaid, JSON, text -- wherever the user puts them. No Mica-imposed structure.
2. **Mica is a lens.** It renders user files on a spatial canvas with rich interactive UIs. The file is always the source of truth.
3. **Mica sees and collaborates on all project files.** Mica reads and writes user files -- it's a collaborator, not a viewer. `.mica/` holds operational metadata (layout, AI context, chat history, config), not project documentation.
4. **Minimum friction.** Mica adapts to the user's existing file structure. It's a new team member, not a new workflow.
5. **Live sources become snapshots.** External data (JIRA, GitHub, shell output) gets materialized to files. Everything on canvas is file-backed, versionable in git.
6. **Flip the card.** The back of a card shows how it works -- how it was generated, what AI guidance was provided. Transparent and inspectable.
7. **AI generates the UI.** The Mica AI agent generates card classes using the card.html + card.js + card.css format. `mica.*` provides only the infrastructure the AI cannot do alone.

## Card Classes

A card class is a directory containing `card.html`, `card.js`, `card.css`, and `metadata.json`. Built-in classes ship with Mica. The AI generates new ones at runtime. Promotion from AI-generated to built-in is just moving the directory.

### Card Class Files

| File | Purpose | Required |
|---|---|---|
| `card.html` | HTML template for the card | Yes |
| `card.js` | Client-side behavior. Normal JS (const/let, template literals). CARD_SHIM injects `container` and `mica`. | Yes |
| `card.css` | Scoped styles | Optional |
| `metadata.json` | `{ extension, badge, defaultTitle, dependencies }` | Yes |
| `context.md` | Class-level AI context | Optional |

### metadata.json

```json
{
  "extension": ".md",
  "badge": "MD",
  "primaryFile": "document.md",
  "defaultTitle": "Document",
  "dependencies": {
    "scripts": ["https://cdn.jsdelivr.net/..."],
    "styles": ["https://cdn.jsdelivr.net/..."]
  }
}
```

### Two Locations

```
card-classes/                      # Built-in, ships with Mica
  canvas/                          # Layout surface
  chat/                            # Qwen agent chat
  md/                              # Markdown editor
  mmd/                             # Mermaid diagrams
  terminal/                        # PTY terminal
  todo/                            # Task list

.mica/card-classes/                # AI-generated, same contract
  calendar/                        # Created by AI during session
```

Resolution order: `.mica/card-classes/` first (project-scoped), then `card-classes/` (built-in).

Promotion: `mv .mica/card-classes/calendar/ card-classes/calendar/` -- no code changes.

### How Cards Are Hosted

**CardRuntime** (React component) hosts card classes:

1. Loads `card.html`, `card.js`, `card.css` from the card class directory
2. Preloads declared dependencies (scripts, styles)
3. Injects HTML into the card container
4. Wraps `card.js` with **CARD_SHIM**, which provides:
   - `container` -- scoped DOM element
   - `mica` -- bridge to server APIs and events
   - Auto-cleanup of timers, intervals, event listeners on destroy
   - Error catching and reporting

## Canvas as a Card Class

The canvas is a card class (`card-classes/canvas/`). It:

- Produces `#canvas-freeform` container element
- Owns drag/resize via event delegation on the container
- Owns layout persistence (debounced, includes `source: mica.windowId`)
- Owns toolbar (+ New File, + AI Chat, etc.)
- Handles cross-window sync via `mica.on('layout-changed')` with source filtering

React's `CanvasCardRuntime` is a thin host -- it portals child `CardFrame` components into `#canvas-freeform`. It does NOT own layout, drag, resize, or toolbar.

Config-driven: `.mica/config.json` has a `canvasClass` field (default: `"canvas"`). Different seeds can provide different canvas card classes (kanban, grid, etc.).

## AI Context (Three Levels)

| Level | File | Scope |
|---|---|---|
| Project | `.mica/canvas-back.md` | Global context for the AI across the whole project |
| Class | `card-classes/<name>/context.md` | How this card type works and should be used |
| Instance | `.mica/cards/<filename>.context.md` | What this specific card is for |

The agent reads all three levels (project + class + instance) when responding.

## mica.* API

`mica.*` is the boundary between client-side card code and the server. Card classes are always client-only. Server capabilities are limited to registered built-in plugins.

### Request/Response Methods

Proxied to server via `POST /api/mica/:namespace/:method`.

| Namespace | Method | Purpose |
|---|---|---|
| `mica.file` | `read(filename)`, `write(filename, content)` | File I/O, scoped to /project |
| `mica.chat` | `send(chatId, message)`, `history(chatId)`, `clear(chatId)` | Qwen Code agent |
| `mica.exec` | `run(command, options)` | One-shot shell commands |

### Events

Delivered via WebSocket broadcast. All events carry `source` for loop prevention.

| Event | Payload |
|---|---|
| `file-changed` | `{ filename, source }` |
| `file-created` | `{ filename, content, source }` |
| `file-deleted` | `{ filename, source }` |
| `layout-changed` | `{ source }` |

Source ID pattern: every event carries `source` (windowId or card name). Listeners compare `event.source === mica.windowId` to skip self-originated events, preventing update loops.

### Lifecycle and Properties

| Method/Property | Purpose |
|---|---|
| `mica.on(event, callback)` | Subscribe to events (returns unsub function) |
| `mica.onDestroy(callback)` | Register cleanup for card unmount |
| `mica.openChannel(type, args)` | Bidirectional stream (terminal PTY, agent chat) |
| `mica.getContent()` | Returns the instance file's content |
| `mica.refresh()` | Re-fetch and re-render this card |
| `mica.windowId` | Unique ID for this browser window |
| `mica.filename` | This card's filename |

## Project File Structure

```
~/dev/myproject/
+-- spec.md                              user files at root
+-- tasks.todo
+-- architecture.mmd
+-- agent-xxx.chat                       agent card stub
+-- .mica/
|   +-- config.json                      { canvasClass, name }
|   +-- canvas-back.md                   project AI context
|   +-- layout.json                      per-device layouts
|   +-- cards/
|   |   +-- <filename>.context.md        instance AI context
|   +-- chats/
|   |   +-- agent-xxx.json               chat histories
|   +-- card-classes/                    AI-generated card classes
|       +-- calendar/
|           +-- card.html
|           +-- card.js
|           +-- card.css
|           +-- metadata.json
|           +-- context.md               class AI context
+-- .qwen/skills/                        Qwen Code CLI skills
+-- .git/
```

## Seeds

Flat project templates. A seed directory mirrors a project structure. Copy to project root on init.

Seeds provide:

- **Canvas class** via `config.json` `canvasClass` field
- **AI context** via `canvas-back.md`
- **Starter files** with frontmatter hints
- **Layout** with pre-arranged card positions
- **Card classes** for project-type-specific renderers

Creating seeds:
- **From scratch**: author a seed directory
- **From existing project**: snapshot + AI refinement into reusable template
- **AI-generated**: describe the project type, AI creates everything

## Deployment

One Docker container per project.

```bash
docker run --gpus all \
  -v ~/dev/myproject:/project \
  -v ~/.cache/huggingface:/home/mica/.cache/huggingface \
  -p 5173:5173 \
  mica
```

Container includes: Node server + Vite frontend + llama-server (Qwen3). Model weights cached on host via bind mount.

Per-device layouts: phone, tablet, desktop, display. Layout stored in `.mica/layout.json` keyed by device class.

No multi-project management. One container = one project. To switch, stop and start with a different `-v` mount.

## Security

Card classes run client-side only (browser JS). Server-side capabilities are limited to built-in `mica.*` plugins. New backend capabilities require a new plugin written by us -- the AI cannot add server-side code.

Container is the blast radius:
- Non-root user inside container
- `--cap-drop=ALL`
- Project-only mount (`-v path:/project`)
- HF cache mount for model weights
- GPU via `--gpus`
- Full network (for external API calls)
