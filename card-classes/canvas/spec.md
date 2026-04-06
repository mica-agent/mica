# Card Class: canvas

A generic container card that holds and lays out child cards.

## Rendering
Renders a titled header and two slot regions: `data-slot="system-cards"` (vertical stack) and `data-slot="content-cards"` (auto-fill grid with 300px minimum columns). The React host (CanvasCardRuntime) portals child card components into these slots.

## Interactions
None directly. This card is a passive layout shell. Child card management (creation, deletion) is handled by the host infrastructure. The `data-children` attribute on the root div communicates the child list to the host.

## Data Format
Primary file: `canvas.json`. The card receives `config.children` (array of child card names) and `config.title` from the host.

## Dependencies
None. Pure HTML/CSS output.
