/**
 * Mermaid card class — wraps mermaid syntax for browser-side rendering.
 * Content is NOT escaped — mermaid.js needs the raw syntax
 * and WidgetRuntime reads pre.textContent for rendering.
 */

export default function render(content, config) {
  return `<pre class="mermaid">${content}</pre>`;
}
