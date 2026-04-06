# Card Class: mermaid

Renders Mermaid diagram syntax as SVG using the Mermaid.js library.

## Rendering
Displays a centered SVG diagram rendered from Mermaid syntax. Uses `mermaid.render()` with a unique ID per card instance to avoid global state collisions. SVG is forced to 100% container width. Shows "Rendering diagram..." placeholder while loading, or an error message on parse failure. Dark theme.

## Interactions
Read-only display. Automatically refreshes when its file changes via `file-changed` event listener. Mermaid is initialized once globally (`window.__mermaidInitialized` flag) to prevent re-initialization from blanking previously rendered diagrams.

## Data Format
Primary file: `diagram.mmd` -- Mermaid diagram syntax (flowcharts, sequence diagrams, etc.).

## Dependencies
- Mermaid.js 11 (CDN): `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js`
