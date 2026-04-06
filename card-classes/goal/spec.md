# Card Class: goal

Displays project goals as rendered markdown with a checklist progress bar.

## Rendering
Renders the primary file as GitHub-flavored markdown via `marked`. If the content contains checklist items (`- [x]` / `- [ ]`), a progress bar and "N/M complete" label appear above the content.

## Interactions
Read-only display. Automatically refreshes when its file changes via `file-changed` event listener.

## Data Format
Primary file: `goals.md` -- Markdown with optional GFM checklists (`- [ ]` and `- [x]` items).

## Dependencies
- `marked` (npm, server-side rendering)
