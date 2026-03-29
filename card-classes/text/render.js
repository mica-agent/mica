/**
 * Text card class — renders plain text in a pre block.
 */

export default function render(content, config) {
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
  return `<pre class="card-text">${escaped}</pre>`;
}
