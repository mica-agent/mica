# Card Class: simple-project

A canvas card that provides the full project workspace: toolbar, header, and freeform card layout surface.

## Rendering
Renders a project header (name, card count), optional markdown description from the primary file, a dynamic toolbar with card creation buttons, and a freeform absolute-positioned layout container (`#canvas-freeform`). Child cards are portaled by React into the freeform container and positioned via persisted layout data.

## Interactions
- **Toolbar**: Dynamically populated from `/api/card-classes`. Each available card class gets a "+ {name}" button (excludes `simple-project` and `canvas`). Creates cards via POST to the cards API with auto-generated names.
- **Drag**: Pointer-based drag on card headers (`.wb-card-header`). Updates layout on drop.
- **Resize**: Pointer-based resize via `.wb-card-resize-handle`. Minimum 200x120px.
- **Tidy**: Auto-arranges cards in a left-to-right grid, wrapping at container width. Seed cards (goal, todo) sort first.
- **Layout persistence**: Loads/saves layout (`{ cards: { filename: { x, y, w, h } } }`) via `/api/projects/:project/canvases/_root/layout`.
- **Cross-window sync**: Listens for `layout-changed` events to sync layout across browser tabs.
- **MutationObserver**: Watches for React-portaled child cards and auto-positions them.

## Data Format
Primary file: `project.md` -- Markdown. First `# heading` is used as display title (from config), remaining body is rendered as project description.

## Dependencies
- `marked` (npm, server-side for description rendering)
