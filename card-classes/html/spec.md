# Card Class: html

Renders raw HTML content directly into the card.

## Rendering
Injects the HTML content into a `div.html-widget`. If the content is a full HTML document (`<!DOCTYPE><html><body>...</body></html>`), it extracts just the `<body>` contents to avoid nested document issues with innerHTML.

## Interactions
Read-only display. Automatically refreshes when its file changes via `file-changed` event listener.

## Data Format
Primary file: `page.html` -- Raw HTML (full document or fragment).

## Dependencies
None.
