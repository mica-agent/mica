/**
 * Brief card class — renders the agent brief.
 * Uses the `marked` library (injected by the isolate pool).
 */

export default function render(content, config) {
  const html = marked.parse(content, { breaks: false, gfm: true });
  return `
    <div class="card-brief">
      <div class="card-markdown">${html}</div>
    </div>
  `;
}
