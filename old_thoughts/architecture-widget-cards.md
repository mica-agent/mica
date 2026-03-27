# Widget Card Architecture

Mica's whiteboard renders **widget cards** — self-describing components backed by reusable **card classes**. A card class is a Python script that defines a **view** (HTML+JS via `@mica.render`) and optionally a **controller** (callable functions via `@mica.export`). Card instances are data files on the whiteboard that reference their class. Update a class and all instances re-render. Even the chat interface is a widget.

---

## Core Concepts

### Card Class

A reusable widget definition. Lives in `card-classes/<name>/render.py`.

```python
import mica

@mica.render
def render(content, config):
    """Takes the file's content + config, returns an HTML+JS fragment."""
    return "<div>...</div>"

@mica.export
def some_action(content, args):
    """Browser JS can call this via mica.call('some_action', {...})."""
    mica.write(updated_content)
    return {"ok": True}
```

**Built-in classes:**

| Class | Resolves from | What it renders |
|-------|--------------|-----------------|
| `markdown` | `*.md` files | Markdown to HTML via Python `markdown` lib |
| `mermaid` | `*.mmd` files | Wraps in `<pre class="mermaid">`, browser mermaid.js renders |
| `text` | `*.txt` files | `<pre>` with HTML escaping |
| `goal` | `_goal.md` | Markdown + checklist progress bar |
| `todo` | `_todo.md` | Markdown + active/blocked/done badge counts |
| `brief` | `_brief.md` | Markdown with brief styling |
| `log` | `_log.md` | Markdown with log styling |
| `chat` | `_chat.md` | Interactive chat UI with `@export send_message`, `@export check_in` |

Classes are registered in `card-classes/_manifest.json` which provides metadata (badge text, system flag, default title).

### Card Instance

A data file on the whiteboard. The system resolves which class renders it through a three-tier chain:

1. **YAML frontmatter** — explicit class declaration in the file:
   ```markdown
   ---
   card: kanban
   priority: high
   ---
   ## Backlog
   - [ ] Design API
   ```
2. **Filename convention** — `_goal.md` maps to the `goal` class, `_todo.md` to `todo`, etc.
3. **Extension fallback** — `.md` → `markdown`, `.mmd` → `mermaid`, `.txt` → `text`

Resolution happens in `server/cardManager.ts` → `resolveCardClass()`.

### System vs Content Cards

- **System cards** (`_goal.md`, `_todo.md`, `_brief.md`, `_log.md`, `_chat.md`) are marked `isSystem: true` in the manifest. They appear in a dedicated full-width section above the masonry grid. Both users and agents can edit them. They cannot be deleted from the UI.
- **Content cards** are user- or agent-created files (e.g., `persona-alex.md`, `competitive-analysis.md`). They appear in the masonry grid and can be deleted.
- Files prefixed with `_` that aren't system cards (like `_chat-history.json`) are hidden from card rendering.

---

## System Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Browser (React)                        │
│                                                              │
│  WhiteboardView                                              │
│    ├─ useLayerSocket ──── WebSocket (/ws/cards) ────────┐    │
│    ├─ FileCard                                          │    │
│    │    └─ WidgetRuntime ── renders HTML, mica.call() ──┤    │
│    └─ ExpandedCardView                                  │    │
│         └─ WidgetRuntime                                │    │
└─────────────────────────────────────────────────────────┼────┘
                                                          │
                                                          ▼
┌──────────────────────────────────────────────────────────────┐
│                   Node.js Server (Express)                    │
│                                                              │
│  REST API (/api/*)                                           │
│    ├─ /api/layers/:layer/cards ──── GET all rendered cards   │
│    ├─ /api/layers/:layer/files ──── CRUD layer files         │
│    ├─ /api/chat/:layer ──────────── Agent chat               │
│    └─ /api/layers/:layer/cards/:file/call/:fn ── export call │
│                                                              │
│  WebSocket (/ws/cards)                                       │
│    ├─ Broadcasts: file-created, file-changed, file-deleted   │
│    └─ Receives:   export_call → routes to CardManager        │
│                                                              │
│  CardManager ── frontmatter parsing, class resolution, cache │
│    └─ WorkerPool ── dispatches render/export to workers      │
│                                                              │
│  FileWatcher ── fs.watch() on layers/ and card-classes/      │
│    ├─ file change → re-render card → broadcast via WS        │
│    └─ class change → invalidate in workers → re-render all   │
│                                                              │
│  Agents (Claude Agent SDK)                                   │
│    └─ chatWithAgent() → Claude query with MCP tools          │
└──────────────────────────────────┬───────────────────────────┘
                                   │ stdin/stdout JSON lines
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│              Python Worker Pool (4 processes)                  │
│                                                              │
│  mica_worker.py × 4                                          │
│    ├─ Loads card classes from card-classes/<name>/render.py   │
│    ├─ Caches loaded modules in-process                       │
│    ├─ Handles: render, export_call, invalidate_class         │
│    └─ RPC callbacks → mica.write(), mica.agent.chat(), etc.  │
│                                                              │
│  mica.py (SDK injected into every class)                     │
│    ├─ @mica.render, @mica.export decorators                  │
│    ├─ mica.write(content), mica.write_file(name, content)    │
│    ├─ mica.read_file(name), mica.log(message)                │
│    └─ mica.agent.chat(message)                               │
│                                                              │
│  Security: blocked imports (subprocess, socket, etc.)         │
└──────────────────────────────────────────────────────────────┘
```

---

## Data Flows

### 1. Card Rendering (file change → visual update)

```
  Data file written (by user, agent, or mica.write())
      │
      ▼
  FileWatcher detects change (fs.watch, 300ms debounce)
      │
      ▼
  Server reads file content → CardManager.renderCard()
      │
      ├─ Resolves card class (frontmatter → filename → extension)
      ├─ Strips frontmatter, extracts config
      └─ Sends render request to WorkerPool
            │
            ▼
      Worker loads class (cached), calls @mica.render(content, config)
            │
            ▼
      Returns { html, exports[] }
      │
      ▼
  Server broadcasts via WebSocket:
  { type: "file-changed", layer, filename, html, exports, meta }
      │
      ▼
  useLayerSocket receives → updates React state
      │
      ▼
  WidgetRuntime renders HTML, executes <script> tags,
  initializes mermaid diagrams, injects mica.call() bridge
```

### 2. Export Call (browser interaction → Python handler → result)

```
  User interacts with widget (clicks button, sends chat message)
      │
      ▼
  Widget JS calls mica.call('send_message', { message: "..." })
      │
      ▼
  WidgetRuntime → callExport() → WebSocket message:
  { type: "export_call", id, layer, filename, fn, args }
      │
      ▼
  Server → CardManager.callExport() → WorkerPool
      │
      ▼
  Worker calls cls["exports"]["send_message"](content, args)
      │
      ├─ Python code may call mica.write(), mica.agent.chat(), etc.
      │   These trigger RPC: worker sends request on stdout,
      │   blocks reading stdin until server responds
      │
      ▼
  Worker returns { type: "export_result", id, result }
      │
      ▼
  Server forwards via WebSocket → WidgetRuntime resolves promise
```

### 3. Agent Chat (via chat widget)

```
  User types message in chat card → mica.call('send_message', {message})
      │
      ▼
  Chat @export handler runs:
    1. Calls mica.agent.chat(message) → RPC to server
    2. Server calls chatWithAgent(layer, message)
    3. Claude Agent SDK spawns query with:
       - Layer system prompt (identity + _brief.md)
       - All layer files as context
       - MCP tools: list_files, read_file, write_file, delete_file, escalate_to_layer
    4. Agent may write files → FileWatcher fires → other cards update in real-time
    5. Response returned: { message, agentName, filesChanged }
    6. Chat handler appends to _chat-history.json (max 100 messages)
    7. Returns { message, agent, filesChanged } to browser
      │
      ▼
  Chat widget JS adds message bubble, updates status indicator
```

### 4. Class Update Propagation

```
  Developer edits card-classes/markdown/render.py
      │
      ▼
  FileWatcher detects class change → emits "class-change" event
      │
      ▼
  Server calls cardManager.invalidateClass("markdown")
      ├─ Clears render cache for all markdown instances
      └─ Sends invalidate_class to all workers (clears cached module)
      │
      ▼
  TODO: re-render all instances and broadcast
  (currently requires manual refresh or file touch)
```

---

## File Map

### Server

| File | Purpose |
|------|---------|
| `server/index.ts` | Express server, WebSocket, card API, RPC handler, file watcher integration |
| `server/workerPool.ts` | Python worker pool — spawn, dispatch, round-robin, crash recovery |
| `server/cardManager.ts` | Card orchestration — class resolution, frontmatter parsing, render cache |
| `server/fileWatcher.ts` | `fs.watch()` on layers/ and card-classes/ with debounce |
| `server/layerFiles.ts` | Filesystem CRUD scoped to `layers/{layerId}/` |
| `server/agents.ts` | Claude Agent SDK integration — 4 layer agents with MCP tools |
| `server/seedLayers.ts` | Seeds initial system files for new layers |
| `server/mica_sdk/mica.py` | Python SDK — decorators + server bridge (write, read, agent.chat, log) |
| `server/mica_sdk/mica_worker.py` | Long-lived Python process — class loading, render/export handling, import sandboxing |

### Card Classes

| File | Class | System? | What it does |
|------|-------|---------|-------------|
| `card-classes/markdown/render.py` | markdown | No | MD → HTML (tables, fenced_code, nl2br, sane_lists, smarty) |
| `card-classes/mermaid/render.py` | mermaid | No | Wraps in `<pre class="mermaid">` for browser rendering |
| `card-classes/text/render.py` | text | No | `<pre>` with HTML escaping |
| `card-classes/goal/render.py` | goal | Yes | MD + checklist progress bar (`X/total complete`) |
| `card-classes/todo/render.py` | todo | Yes | MD + section parsing (Active/Blocked/Done) + badge counts |
| `card-classes/brief/render.py` | brief | Yes | MD with brief wrapper |
| `card-classes/log/render.py` | log | Yes | MD with log wrapper |
| `card-classes/chat/render.py` | chat | Yes | Interactive chat — history, send_message, check_in exports |
| `card-classes/_manifest.json` | — | — | Registry: badge, system flag, defaultTitle per class |

### Frontend

| File | Purpose |
|------|---------|
| `src/whiteboard/WhiteboardView.tsx` | Main view — useLayerSocket, system/content card sections, toolbar |
| `src/whiteboard/FileCard.tsx` | Individual card — header/body/footer, WidgetRuntime, overflow detection |
| `src/whiteboard/ExpandedCardView.tsx` | Fullscreen card overlay with WidgetRuntime |
| `src/whiteboard/WidgetRuntime.tsx` | Renders server HTML, executes scripts, injects mica.call(), init mermaid |
| `src/whiteboard/useLayerSocket.ts` | WebSocket hook — real-time card state, callExport(), auto-reconnect |
| `src/whiteboard/FileEditor.tsx` | Modal editor for creating/editing raw file content |
| `src/whiteboard/DrawingCanvas.tsx` | Freehand drawing → base64 → mermaid conversion via Claude Vision |
| `src/api/layerFiles.ts` | API client — fetchCards, callCardExport, CRUD, types |

### Data

```
layers/
├── mission/           # Strategy & product definition
│   ├── _goal.md       # Checklist of layer objectives
│   ├── _todo.md       # Task tracker (Active/Blocked/Done sections)
│   ├── _brief.md      # Agent personality & instructions
│   ├── _log.md        # Auto-appended activity log
│   ├── _chat.md       # Chat widget instance (renders chat UI)
│   └── *.md, *.mmd, *.txt  # User/agent content cards
├── experience/        # UX & user journey
├── architecture/      # System design & technical decisions
└── implementation/    # Code & delivery
```

---

## Mica Python SDK Reference

The SDK (`server/mica_sdk/mica.py`) is injected into every card class's execution environment.

### Decorators

```python
@mica.render
def render(content: str, config: dict) -> str:
    """Main render function. Called when the card needs to display.

    Args:
        content: The data file's content (frontmatter stripped)
        config: Merged dict of frontmatter values + layer metadata

    Returns:
        HTML string (may include <script> tags for interactivity)
    """

@mica.export
def action_name(content: str, args: dict) -> any:
    """Exported function callable from browser JS via mica.call().

    Args:
        content: The data file's current content
        args: Arguments passed from browser JS

    Returns:
        JSON-serializable result sent back to browser
    """
```

### Server Bridge

```python
mica.write(content)              # Overwrite this card's data file
mica.write_file(name, content)   # Write to another file in the layer
mica.read_file(name) -> str      # Read another file (returns content or None)
mica.log(message)                # Append timestamped entry to _log.md
mica.agent.chat(message) -> dict # Call the layer's AI agent
                                 # Returns: { message, agentName, filesChanged }
```

All I/O goes through RPC to the Node.js server — Python has no direct filesystem or network access.

### Browser Bridge

In widget HTML, inline `<script>` tags can call:

```javascript
// Call an @export function (returns a Promise)
const result = await mica.call('send_message', { message: text });

// List available exports
console.log(mica.exports); // ["send_message", "check_in"]
```

---

## Worker Pool Details

- **Pool size**: 4 long-lived Python 3 processes (configurable)
- **Python path**: `/usr/bin/python3` (system Python, not venv)
- **Communication**: JSON lines on stdin/stdout per worker
- **Dispatch**: Round-robin across workers
- **Timeouts**: 30s for render, 120s for export calls
- **Class caching**: Each worker caches loaded modules in-process. Invalidation via `invalidate_class` message clears the cache entry, forcing reload on next request.
- **RPC interleaving**: When Python calls `mica.write()` during an export, the worker sends an RPC request on stdout. The server processes it and responds on stdin. Meanwhile, other requests that arrive on stdin are queued and processed after the RPC completes.
- **Import sandboxing**: A custom `__import__` blocks dangerous modules (subprocess, socket, shutil, ctypes, multiprocessing, etc.) while allowing stdlib internals needed by the `markdown` library.
- **Memory**: ~100MB total for 4 workers regardless of card count (classes cached, HTML is string data).
- **Crash recovery**: If a worker process dies, pending requests are rejected with errors. The pool does not currently auto-restart dead workers (TODO).

---

## Real-Time Update System

The previous polling-based system (5-second interval) has been replaced with a reactive file-system-driven approach:

1. **FileWatcher** (`server/fileWatcher.ts`) uses `fs.watch()` on all layer directories and the `card-classes/` directory
2. Changes are debounced at 300ms per file to batch rapid writes
3. On change: server reads the file, renders via worker pool, broadcasts the rendered HTML over WebSocket
4. On delete: server broadcasts deletion, frontend removes the card
5. On class file change: server invalidates the class in all workers

The WebSocket at `/ws/cards` carries both:
- **Server → Browser**: file-created, file-changed, file-deleted (with rendered HTML)
- **Browser → Server**: export_call requests (with unique ID for response correlation)

The `useLayerSocket` React hook manages the WebSocket connection, handles reconnection, maintains card state, and provides the `callExport()` function for interactive widgets.

---

## Slate: Layout, Placement, and Widget State

The **slate** is the surface that cards are placed on within a layer. It manages spatial arrangement, per-card display state, and viewport persistence.

### Design Principles

1. **Single canonical layout** — One `_layout.json` per layer is the source of truth for card arrangement. All devices render from the same layout data.
2. **Responsive adaptation** — The renderer adapts the canonical layout to the current viewport. A desktop's 3-column arrangement reflows gracefully on a tablet. Relative ordering and grouping are preserved even when absolute positions can't be honored.
3. **Filesystem-driven** — `_layout.json` is a regular layer file. FileWatcher pushes changes via WebSocket. Agents can read and write it (e.g., "I grouped the risk cards together").
4. **Viewport state is ephemeral** — Scroll position, zoom level, and viewport offset are per-device concerns stored in localStorage. These are cheap to lose and naturally device-specific.

### `_layout.json` Schema

```json
{
  "version": 1,
  "cards": {
    "_goal.md": {
      "position": [0, 0],
      "size": [2, 1],
      "collapsed": false,
      "pinned": true,
      "zIndex": 1
    },
    "_todo.md": {
      "position": [2, 0],
      "size": [1, 1],
      "collapsed": false,
      "pinned": true,
      "zIndex": 1
    },
    "persona-alex.md": {
      "position": [0, 1],
      "size": [1, 2],
      "collapsed": false,
      "pinned": false,
      "zIndex": 0
    }
  },
  "groups": [
    {
      "name": "Research",
      "cards": ["persona-alex.md", "competitive-analysis.md"],
      "color": "#3b82f6"
    }
  ]
}
```

**Per-card fields:**

| Field | Type | Description |
|-------|------|-------------|
| `position` | `[col, row]` | Grid slot (logical, not pixels). Renderer maps to viewport. |
| `size` | `[w, h]` | Span in grid units. `[1,1]` = standard, `[2,1]` = double-wide. |
| `collapsed` | `boolean` | Show header-only (title + badge) vs full rendered content. |
| `pinned` | `boolean` | Pinned cards stay visible when scrolling. System cards default pinned. |
| `zIndex` | `number` | Stacking order for overlapping cards (free-form mode). |

**Groups** define named clusters of cards that move together and share a visual boundary. Agents can create groups to organize related work.

**Cards not in `_layout.json`** (newly created files) get auto-placed: appended to the first available grid slot, standard size, unpinned. The layout file is updated to include them.

### Why Not Per-Device Layouts

Users join and leave across devices and sessions. The key question: should each device have its own layout?

**No — single canonical layout wins because:**
- One source of truth means "where's that card?" has one answer
- Agents can arrange cards meaningfully and every viewer sees it
- Collaborative scenarios work — teammates see the same board
- Simpler implementation, fewer edge cases, fewer files

**Responsive adaptation handles device differences:**
- The `position` grid is logical, not pixel-based. A 4-column desktop grid reflows to 2 columns on tablet, 1 on phone.
- Relative ordering within groups and between cards is preserved.
- `collapsed` state is canonical — if a card is collapsed, it's collapsed for everyone (intentional: this is a board state decision, not a personal preference).

### Viewport State (localStorage)

Per-device, ephemeral state stored in `localStorage` under `mica:viewport:{layerId}`:

```json
{
  "scrollX": 240,
  "scrollY": 800,
  "zoom": 1.0,
  "lastVisited": "2026-03-14T10:30:00Z"
}
```

This is cheap to lose. If you clear your browser or switch devices, you start at the default viewport (top-left, zoom 1.0). The *board content and arrangement* is unchanged because that lives in `_layout.json`.

### Widget State (Non-File Metadata)

Some widgets need to persist UI state that isn't part of their data file. Examples: chat scroll position, a chart's selected time range, a kanban's filter settings. This state lives in `_layout.json` under an optional `widgetState` key per card:

```json
{
  "cards": {
    "_chat.md": {
      "position": [3, 0],
      "size": [1, 3],
      "widgetState": {
        "scrollBottom": true,
        "inputDraft": ""
      }
    },
    "burndown.py": {
      "position": [0, 2],
      "size": [2, 1],
      "widgetState": {
        "timeRange": "7d",
        "showTrend": true
      }
    }
  }
}
```

Widget state is **opaque to the system** — the card class defines what goes in it. The mica SDK provides access:

```python
# In a card class @export handler:
state = mica.get_widget_state()        # returns dict or {}
mica.set_widget_state({"zoom": 1.5})   # merges into _layout.json
```

From browser JS:
```javascript
// Widget scripts can read/write their own state
const state = await mica.call('get_state', {});
await mica.call('set_state', { timeRange: '30d' });
```

This keeps widget preferences canonical (same across devices) and filesystem-driven (agents can inspect/modify widget state if useful).

### Interaction: Layout Changes

When a user drags, resizes, or collapses a card:

```
  User drags card to new position
      │
      ▼
  Frontend updates local state (instant feedback)
      │
      ▼
  Debounced PUT to /api/layers/{layer}/files/_layout.json
      │
      ▼
  FileWatcher detects change → broadcasts via WebSocket
      │
      ▼
  Other connected clients receive updated layout
```

Layout changes are just file writes — same pipeline as everything else.

---

## Adding a New Card Class

To create a new card class (e.g., `kanban`):

1. Create `card-classes/kanban/render.py`:
   ```python
   import mica
   import json

   @mica.render
   def render(content, config):
       data = json.loads(content)
       # ... build HTML ...
       return '<div class="kanban-board">...</div>'

   @mica.export
   def move_card(content, args):
       data = json.loads(content)
       # ... modify data ...
       mica.write(json.dumps(data, indent=2))
       return {"ok": True}
   ```

2. Register in `card-classes/_manifest.json`:
   ```json
   "kanban": {
     "badge": "KANBAN",
     "system": false,
     "defaultTitle": null
   }
   ```

3. Create a data file with frontmatter referencing the class:
   ```markdown
   ---
   card: kanban
   ---
   {"columns": [{"name": "Backlog", "items": [...]}]}
   ```

4. The FileWatcher will detect the new class and data file. The card renders automatically.

---

## Layer Filesystem Layout

Each layer lives at `layers/{layerId}/`. The server enforces:
- **Valid layer IDs**: mission, experience, architecture, implementation
- **Valid extensions**: .txt, .md, .mmd, .py, .json
- **Filename validation**: no path traversal, no subdirectories
- **File operations**: listFiles, readLayerFile, writeLayerFile, deleteLayerFile

The `getAllFilesAsContext()` function serializes all files in a layer into a text block used as context for agent conversations.

---

## Agent Integration

Each layer has a dedicated AI agent (powered by Claude Agent SDK):

| Layer | Agent Name | Role |
|-------|-----------|------|
| mission | Mission Strategist | Product vision, goals, market analysis |
| experience | Experience Designer | UX, user journeys, personas |
| architecture | System Architect | Technical design, system diagrams |
| implementation | Implementation Engineer | Code, delivery, testing |

Agents read `_brief.md` for their personality/instructions and have MCP tools to read/write layer files. When an agent writes a file, the FileWatcher triggers a re-render and the card updates in real-time on the whiteboard.

Agents can escalate to other layers via the `escalate_to_layer` tool, enabling cross-layer collaboration (e.g., the mission strategist asking the architect about technical feasibility).

---

## Security Model

- **Python sandboxing**: Import blocklist prevents subprocess execution, network access, filesystem access. All I/O goes through the mica SDK's RPC bridge.
- **Filename validation**: No path traversal (`..`, `/`), only allowed extensions.
- **Layer scoping**: Each agent and file operation is scoped to its layer directory.
- **Auth**: Claude Agent SDK uses the user's Claude Code subscription (Pro/Max). No API keys stored in the project.
