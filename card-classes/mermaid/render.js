/**
 * Mermaid card class — renders mermaid diagrams using mermaid.js CDN.
 * Each card renders its own diagram independently via mermaid.render()
 * with a unique ID, avoiding global state collisions between cards.
 */

export const dependencies = {
  scripts: ['https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js']
};

let idCounter = 0;

export default function render(content, config) {
  const id = `mmd-${++idCounter}-${Date.now()}`;
  // Escape content for safe embedding in a data attribute
  const escaped = content.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `
<div id="${id}-container" style="width:100%;overflow:auto;">
  <div id="${id}-output" style="width:100%;display:flex;justify-content:center;color:#8b949e;font-size:12px;">Rendering diagram...</div>
  <pre id="${id}-source" style="display:none;" data-content="${escaped}"></pre>
</div>

<script>
(() => {
  const containerId = '${id}-container';
  const outputId = '${id}-output';
  const sourceId = '${id}-source';
  const outputEl = container.querySelector('#' + outputId);
  const sourceEl = container.querySelector('#' + sourceId);
  if (!outputEl || !sourceEl) return;

  // Decode the content from data attribute
  const syntax = sourceEl.dataset.content
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&');

  if (!syntax.trim()) {
    outputEl.textContent = '(empty diagram)';
    return;
  }

  // Use window.mermaid explicitly — CDN sets globalThis["mermaid"]
  const mermaidLib = window.mermaid;
  if (mermaidLib) {
    // Only initialize once — re-initializing resets mermaid's internal state
    // and can blank out previously rendered diagrams.
    if (!window.__mermaidInitialized) {
      mermaidLib.initialize({ startOnLoad: false, theme: 'dark', maxTextSize: 100000, flowchart: { useMaxWidth: true }, sequence: { useMaxWidth: true } });
      window.__mermaidInitialized = true;
    }

    mermaidLib.render('${id}', syntax)
      .then(({ svg }) => {
        outputEl.innerHTML = svg;
        // Force SVG to fill container width
        const svgEl = outputEl.querySelector('svg');
        if (svgEl) {
          svgEl.setAttribute('width', '100%');
          svgEl.removeAttribute('height');
          svgEl.style.maxWidth = 'none';
          svgEl.style.width = '100%';
        }
      })
      .catch((err) => {
        outputEl.innerHTML = '<div style="color:#f87171;font-size:12px;padding:8px;">Diagram error: ' + (err.message || err) + '</div>';
      });
  } else {
    outputEl.textContent = 'mermaid.js not loaded';
  }
})();
</script>
  `;
}
