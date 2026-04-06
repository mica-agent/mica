# Card Class: markdown

Rich WYSIWYG markdown editor using Toast UI Editor.

## Rendering
Embeds Toast UI Editor in dark theme with WYSIWYG mode as default. Toolbar includes: heading, bold, italic, strike, unordered/ordered lists, task lists, tables, links, code, and code blocks. The markdown tab switcher and mode switch are hidden via CSS.

## Interactions
- Full WYSIWYG editing with toolbar controls.
- Auto-saves on change with 800ms debounce via `mica.send('save', ...)`.
- Cross-window sync: refreshes when `file-changed` fires (skips if the change was from own save).
- Preserves canvas scroll position on editor initialization to prevent autofocus-induced panning.

## Data Format
Primary file: `document.md` -- Standard markdown text.

## Dependencies
- Toast UI Editor 3.2.2 (CDN):
  - `https://uicdn.toast.com/editor/3.2.2/toastui-editor-all.min.js`
  - `https://uicdn.toast.com/editor/3.2.2/toastui-editor.min.css`
  - `https://uicdn.toast.com/editor/3.2.2/theme/toastui-editor-dark.min.css`
- `marked` (npm, server-side for initial rendering)
