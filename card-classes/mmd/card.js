// Mermaid diagram card with pan/zoom
// container and mica are provided by CARD_SHIM
// mermaid is loaded as an npm dependency (available via import in the app)

const viewport = container.querySelector('#mmd-viewport');
const svgContainer = container.querySelector('#mmd-svg');
const zoomLabel = container.querySelector('#mmd-zoom-label');
const content = mica.getContent();

let transform = { x: 0, y: 0, scale: 1 };
let altHeld = false;
let dragging = false;
let dragStart = { x: 0, y: 0, origX: 0, origY: 0 };

// Render mermaid
async function renderDiagram() {
  try {
    // mermaid loaded via CDN dependency in metadata.json
    const mermaid = window.mermaid;
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });

    const id = `mmd-${Date.now()}`;
    const { svg } = await mermaid.render(id, content);
    svgContainer.innerHTML = svg;

    // Auto-fit to viewport width
    requestAnimationFrame(() => {
      const svgEl = svgContainer.querySelector('svg');
      if (!svgEl) return;
      const svgW = svgEl.viewBox?.baseVal?.width || svgEl.getBoundingClientRect().width;
      const vpW = viewport.clientWidth;
      if (svgW > 0 && vpW > 0) {
        transform.scale = Math.min(1, vpW / svgW);
        transform.x = 0;
        transform.y = 0;
        applyTransform();
      }
    });
  } catch (err) {
    svgContainer.innerHTML = `<pre style="color:#f66;font-size:12px;padding:16px;">${err.message}</pre>`;
  }
}

function applyTransform() {
  svgContainer.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
  zoomLabel.textContent = `${Math.round(transform.scale * 100)}%`;
}

// Alt key tracking for cursor
function onKeyDown(e) { if (e.altKey) { altHeld = true; viewport.style.cursor = 'grab'; } }
function onKeyUp(e) { if (!e.altKey) { altHeld = false; viewport.style.cursor = 'default'; } }
window.addEventListener('keydown', onKeyDown);
window.addEventListener('keyup', onKeyUp);

// Wheel zoom (only with Alt/Option)
viewport.onwheel = function(e) {
  if (!altHeld) return;
  e.preventDefault();

  const rect = viewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const factor = e.deltaY > 0 ? 1.04 : 0.96;
  const newScale = Math.max(0.05, Math.min(20, transform.scale * factor));
  const ratio = newScale / transform.scale;

  transform.x = mx - ratio * (mx - transform.x);
  transform.y = my - ratio * (my - transform.y);
  transform.scale = newScale;
  applyTransform();
};

// Pan via drag (only with Alt/Option)
viewport.addEventListener('pointerdown', function(e) {
  if (!altHeld) return;
  if (e.button !== 0) return;
  if (e.target.closest('button')) return;
  e.preventDefault();
  dragging = true;
  dragStart = { x: e.clientX, y: e.clientY, origX: transform.x, origY: transform.y };
  viewport.style.cursor = 'grabbing';
  viewport.setPointerCapture(e.pointerId);
});

viewport.addEventListener('pointermove', function(e) {
  if (!dragging) return;
  transform.x = dragStart.origX + (e.clientX - dragStart.x);
  transform.y = dragStart.origY + (e.clientY - dragStart.y);
  applyTransform();
});

viewport.addEventListener('pointerup', function(e) {
  if (!dragging) return;
  dragging = false;
  viewport.style.cursor = altHeld ? 'grab' : 'default';
});

// Toolbar buttons
container.querySelector('#mmd-zoomin').addEventListener('click', function(e) {
  e.stopPropagation();
  transform.scale = Math.min(20, transform.scale * 1.3);
  applyTransform();
});

container.querySelector('#mmd-zoomout').addEventListener('click', function(e) {
  e.stopPropagation();
  transform.scale = Math.max(0.05, transform.scale * 0.7);
  applyTransform();
});

container.querySelector('#mmd-reset').addEventListener('click', function(e) {
  e.stopPropagation();
  transform = { x: 0, y: 0, scale: 1 };
  applyTransform();
  // Re-fit to width
  const svgEl = svgContainer.querySelector('svg');
  if (svgEl) {
    const svgW = svgEl.viewBox?.baseVal?.width || svgEl.getBoundingClientRect().width;
    const vpW = viewport.clientWidth;
    if (svgW > 0 && vpW > 0) {
      transform.scale = Math.min(1, vpW / svgW);
      applyTransform();
    }
  }
});

// Sync from external changes
const unsub = mica.on('file-changed', function(e) {
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

mica.onDestroy(function() {
  unsub();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
});

// Initial render
renderDiagram();
