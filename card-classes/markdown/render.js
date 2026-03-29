/**
 * Markdown card class — converts markdown content to HTML.
 * Uses the `marked` library (injected by the isolate pool).
 */

export default function render(content, config) {
  const html = marked.parse(content, { breaks: true, gfm: true });
  return `<div class="card-markdown">${html}</div>`;
}
