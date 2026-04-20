// HTML card — renders the file as a sandboxed iframe scaled to fit the card.
// Scripts run inside the iframe but `sandbox="allow-scripts"` (no
// allow-same-origin) keeps them isolated from the page and from Mica.

const root = container.querySelector('#html-card-root');
const frame = container.querySelector('#html-card-frame');
const toolbar = container.querySelector('#html-card-toolbar');
const interactBtn = container.querySelector('#html-card-interact');
const openBtn = container.querySelector('#html-card-open');

const DESIGN_WIDTH = 1280;
const DESIGN_HEIGHT = 900;

function applyScale() {
  const w = root.clientWidth || 1;
  const h = root.clientHeight || 1;
  // Fit by width — height overflows if the page is taller than its design,
  // which is the natural thumbnail look for long pages.
  const scale = w / DESIGN_WIDTH;
  frame.style.transform = `scale(${scale})`;
  // Reserve viewport so wide screenshots don't crop horizontally.
  frame.style.height = Math.max(DESIGN_HEIGHT, h / scale) + 'px';
}

async function loadHtml() {
  let content = '';
  try { content = await mica.getContent(); } catch { /* leave blank */ }
  // srcdoc handles relative URLs as document.baseURI. Most simple pages work;
  // pages that fetch from same-origin paths will fail under `sandbox=allow-scripts`
  // because the sandbox makes the iframe a unique origin — that's the price of
  // safety. Open-in-new-tab gives the user the full original-origin experience.
  frame.srcdoc = content;
}

loadHtml();
applyScale();

const ro = new ResizeObserver(() => applyScale());
ro.observe(root);

root.addEventListener('mouseenter', () => { toolbar.style.opacity = '1'; });
root.addEventListener('mouseleave', () => { toolbar.style.opacity = '0'; });

let interactive = false;
interactBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  interactive = !interactive;
  frame.style.pointerEvents = interactive ? 'auto' : 'none';
  interactBtn.textContent = interactive ? 'Lock' : 'Interact';
});

openBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  window.open(mica.files.url(mica.filename), '_blank', 'noopener');
});

const unsub = mica.on('file-changed', (msg) => {
  if (msg.filename === mica.filename && msg.source !== mica.windowId) {
    loadHtml();
  }
});

mica.onDestroy(() => {
  ro.disconnect();
  unsub();
});
