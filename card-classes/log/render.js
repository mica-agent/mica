/**
 * Log card class — renders the activity log.
 * Uses the `marked` library (injected by the isolate pool).
 */

export default function render(content, config) {
  const html = marked.parse(content, { breaks: false, gfm: true });
  return `
    <div class="card-log">
      <div class="card-markdown">${html}</div>
    </div>
  `;
}
