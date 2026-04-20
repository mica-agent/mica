// Mermaid diagram card with pan/zoom
// container and mica are provided by CARD_SHIM
// mermaid is loaded as an npm dependency (available via import in the app)

const viewport = container.querySelector('#mmd-viewport');
const svgContainer = container.querySelector('#mmd-svg');
const zoomLabel = container.querySelector('#mmd-zoom-label');
const content = await mica.getContent();

let transform = { x: 0, y: 0, scale: 1 };
let altHeld = false;
let dragging = false;
let dragStart = { x: 0, y: 0, origX: 0, origY: 0 };

// Fit the rendered SVG inside the viewport. Called on initial render, Reset,
// and whenever the containing card expands/contracts. Returns true if fit was
// applied (SVG + viewport both had non-zero dimensions).
//
// Trade-off: for small cards with wide `flowchart LR` diagrams (very common),
// a strict fit-both yields unreadable <30% scales. We floor the scale at
// MIN_FIT_SCALE so the initial view is always legible — overflow gets clipped
// by the viewport, and the user can pan (Option+drag) to explore it. Expanded
// cards are large enough that the floor almost never kicks in.
const MIN_FIT_SCALE = 0.6;

function fitToViewport() {
  const svgEl = svgContainer.querySelector('svg');
  if (!svgEl) return false;
  // Prefer viewBox (logical) dimensions — the SVG's actual drawing area —
  // over bounding rect which reflects the already-transformed element.
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  const svgW = (vb && vb.width) || svgEl.getBoundingClientRect().width;
  const svgH = (vb && vb.height) || svgEl.getBoundingClientRect().height;
  const vpW = viewport.clientWidth;
  const vpH = viewport.clientHeight;
  if (!(svgW > 0 && svgH > 0 && vpW > 0 && vpH > 0)) return false;

  // Biggest scale that keeps BOTH dims inside, capped at 1 so small diagrams
  // don't balloon, then floored at MIN_FIT_SCALE for readability on tiny cards.
  const natural = Math.min(1, vpW / svgW, vpH / svgH);
  const scale = Math.max(MIN_FIT_SCALE, natural);

  // Centre if the scaled SVG fits; otherwise pin to top-left so the diagram's
  // root is visible (user pans from there to explore the rest).
  transform.scale = scale;
  transform.x = svgW * scale <= vpW ? Math.max(0, (vpW - svgW * scale) / 2) : 0;
  transform.y = svgH * scale <= vpH ? Math.max(0, (vpH - svgH * scale) / 2) : 0;
  applyTransform();
  return true;
}

// Render mermaid
async function renderDiagram() {
  try {
    // mermaid loaded via CDN dependency in metadata.json
    const mermaid = window.mermaid;
    mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' });

    const id = `mmd-${Date.now()}`;
    const { svg } = await mermaid.render(id, content);
    svgContainer.innerHTML = svg;

    // Initial auto-fit (after next paint so the SVG has measurable dimensions).
    requestAnimationFrame(() => { fitToViewport(); });
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
  fitToViewport();
});

// Sync from external changes
const unsub = mica.on('file-changed', function(e) {
  if (e.filename === mica.filename && e.source !== mica.windowId) {
    mica.refresh();
  }
});

// Re-fit when the containing card expands or contracts. The outer .wb-card's
// class list toggles .wb-card--expanded via the canvas's expand button; size
// changes land before the MutationObserver fires, but we still wait one rAF
// for the browser to commit the new clientWidth/clientHeight before refitting.
const cardEl = container.closest('.wb-card');
let wasExpanded = cardEl ? cardEl.classList.contains('wb-card--expanded') : false;
const cardObserver = cardEl ? new MutationObserver(function() {
  const isExpanded = cardEl.classList.contains('wb-card--expanded');
  if (isExpanded === wasExpanded) return;
  wasExpanded = isExpanded;
  requestAnimationFrame(function() { fitToViewport(); });
}) : null;
if (cardObserver) cardObserver.observe(cardEl, { attributes: true, attributeFilter: ['class'] });

mica.onDestroy(function() {
  unsub();
  if (cardObserver) cardObserver.disconnect();
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup', onKeyUp);
});

// Initial render
renderDiagram();
