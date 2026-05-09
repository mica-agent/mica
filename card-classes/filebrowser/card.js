// File browser card — list PROJECT files (not just canvas), preview on
// click, upload via drag-drop, pin/unpin to canvas. Static: no channel,
// direct API calls via the mica.* bridge.
//
// State persisted to the card's own instance file (mica.filename) as JSON:
//   { expanded: [folderPath, ...], showHidden: boolean }
// Both expand-state and show-hidden survive reloads.

const treeBodyEl = container.querySelector('#fb-tree-body');
const treePaneEl = container.querySelector('#fb-tree');
const resizerEl = container.querySelector('#fb-resizer');
const rootEl = container.querySelector('#fb-root');
const refreshBtn = container.querySelector('#fb-refresh');
const uploadBtn = container.querySelector('#fb-upload');
const uploadInput = container.querySelector('#fb-upload-input');
const activeFolderEl = container.querySelector('#fb-active-folder');
const showHiddenInput = container.querySelector('#fb-show-hidden');
const previewNameEl = container.querySelector('#fb-preview-name');
const previewMetaEl = container.querySelector('#fb-preview-meta');
const previewBodyEl = container.querySelector('#fb-preview-body');

// Extensions we treat as image (inline preview) — everything else in
// BINARY_EXTS (tracked by server) falls to a download affordance.
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico']);
// Matches server/files.ts BINARY_EXTS — duplicated here to avoid a round
// trip. If the server's list changes, binary-ness is still double-checked
// by isLikelyBinary's NUL scan at read time.
const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.m4a', '.wav', '.ogg', '.webm', '.mov', '.avi',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.exe', '.dll', '.so', '.dylib', '.o', '.a',
]);
const PREVIEW_LINE_CAP = 200;
const PREVIEW_BYTE_CAP = 500 * 1024;

let entries = [];            // flat list from mica.files.listAll()
let pinned = new Set();      // filenames currently in canvas config.pinned
let expanded = new Set();    // folder paths the user has opened
let selected = null;         // currently-previewed file path
let dropTarget = null;       // folder path the next drop will target (null = active folder fallback)
let activeFolder = null;     // folder path the upload button writes into; null = canvasRoot
let showHidden = false;      // toggle: surface .mica/.qwen/.claude (always hides .git, node_modules, etc.)
let treeWidth = null;        // px width of tree pane; null = use CSS default (40%); set by drag

// Folder-level glow when files land via the watcher. We deliberately
// glow the PARENT directory rather than the individual file — agent
// codegen / git pulls / multi-file uploads commonly land 10–50 files
// in a few directories. Highlighting the folder gives one calm signal
// per active dir regardless of how many files arrived inside it. The
// per-file events the server emits are reused as-is; we just collapse
// them down by dirname client-side.
const GLOW_DURATION_MS = 2200;
const GLOW_CAP = 8;        // worst-case cap on simultaneously glowing folders
const newPaths = new Set();
const glowTimers = new Map();
// Mark a folder as recently-active. Each fresh hit re-arms the timer so
// a sustained burst keeps the glow alive instead of flickering off mid-stream.
function markNew(path) {
  // Skip root-level entries (parentDir === ''): the project root has no
  // tree node to attach a glow to. Watcher-level signal still arrives;
  // it just doesn't get a visual badge.
  if (!path) return;
  if (!newPaths.has(path)) {
    if (newPaths.size >= GLOW_CAP) return;
    newPaths.add(path);
  }
  if (glowTimers.has(path)) clearTimeout(glowTimers.get(path));
  glowTimers.set(path, setTimeout(() => {
    newPaths.delete(path);
    glowTimers.delete(path);
    const escaped = window.CSS && window.CSS.escape ? window.CSS.escape(path) : path.replace(/"/g, '\\"');
    const node = treeBodyEl.querySelector('[data-path="' + escaped + '"]');
    if (node) node.classList.remove('fb-node--new');
  }, GLOW_DURATION_MS));
}
function parentDir(filename) {
  if (!filename) return '';
  const slash = filename.lastIndexOf('/');
  return slash === -1 ? '' : filename.slice(0, slash);
}

function ext(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot).toLowerCase();
}

function basename(path) {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

function formatSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Persisted state (folder expansion + showHidden) ─────────────────
async function loadState() {
  try {
    const raw = await mica.getContent();
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.expanded)) expanded = new Set(parsed.expanded);
    if (typeof parsed.showHidden === 'boolean') showHidden = parsed.showHidden;
    if (typeof parsed.treeWidth === 'number' && parsed.treeWidth > 0) treeWidth = parsed.treeWidth;
    if (typeof parsed.activeFolder === 'string') activeFolder = parsed.activeFolder;
  } catch (_) { /* fresh card, no state */ }
}

let persistTimer = null;
function persistState() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const payload = JSON.stringify({ expanded: [...expanded], showHidden, treeWidth, activeFolder });
    mica.files.write(mica.filename, payload).catch(() => { /* best effort */ });
  }, 400);
}

// Active folder = upload destination. Updated when the user clicks any
// folder in the tree, OR implicitly when a file is selected (its parent
// becomes active). The label badge in the header reflects the current
// target so the upload button isn't a guessing game.
function setActiveFolder(folder) {
  const next = folder || null;
  if (activeFolder === next) return;
  activeFolder = next;
  updateActiveFolderLabel();
  persistState();
  renderTree();  // refresh outline on the active row
}
function updateActiveFolderLabel() {
  if (!activeFolderEl) return;
  // No active folder → uploads go to PROJECT ROOT (not canvasRoot).
  // The badge reflects that with "in /" so the destination isn't a
  // mystery. canvasRoot is still where canvas-card content lives, but
  // it's not a sensible default for ad-hoc uploads (would create the
  // canvas dir on a fresh project, surprise).
  const target = activeFolder || '';
  activeFolderEl.textContent = target ? 'in ' + target + '/' : 'in / (project root)';
  if (uploadBtn) uploadBtn.title = 'Upload to ' + (target || 'project root');
}

// ── Data loading ────────────────────────────────────────────────────
// Project-wide listing (mica.files.listAll), not canvas-only — the file
// browser is meant to surface the whole project, with optional hidden-file
// reveal via the toggle in the header.
async function loadData() {
  const [fileList, cfg] = await Promise.allSettled([
    mica.files.listAll({ showHidden }),
    fetch('/api/canvas/config').then((r) => r.json()),
  ]);
  if (fileList.status === 'fulfilled') {
    // Build a path → mtime map of the previous listing so we can detect
    // BOTH net-new entries AND existing entries whose content was just
    // updated (same path, newer modifiedAt). Both classes glow via the
    // same .fb-node--new class — "activity" is the unified signal.
    const prevMtimes = new Map();
    for (const e of entries) prevMtimes.set(e.path, e.modifiedAt);
    const next = fileList.value || [];
    // Skip diffing on the very first load (prev is empty) — otherwise
    // the initial render would flash everything.
    if (prevMtimes.size > 0) {
      for (const e of next) {
        // Suppress self-glow on the card's own state file (we write to
        // it on every state persist; would otherwise glow on every save).
        if (e.path === mica.filename) continue;
        const prevMt = prevMtimes.get(e.path);
        const isNew = prevMt === undefined;
        const isUpdated = !isNew && e.modifiedAt && prevMt && e.modifiedAt !== prevMt;
        if (isNew || isUpdated) {
          markNew(e.path);
          markNew(parentDir(e.path));
        }
      }
    }
    entries = next;
  }
  if (cfg.status === 'fulfilled' && cfg.value && Array.isArray(cfg.value.pinned)) {
    pinned = new Set(cfg.value.pinned);
  }
  renderTree();
}

// ── Tree building ───────────────────────────────────────────────────
// listFiles() returns both files AND directories as separate entries with
// type: "file" | "directory". Build a map from parentPath → children.
function buildChildMap() {
  const byParent = new Map();      // parentPath (or '') → [{name, path, isFile, size}]
  for (const e of entries) {
    const path = e.path;
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push({
      name,
      path,
      isFile: e.isFile,
      size: e.size,
    });
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;  // folders first
      return a.name.localeCompare(b.name);
    });
  }
  return byParent;
}

function renderTree() {
  const byParent = buildChildMap();
  treeBodyEl.innerHTML = '';
  const roots = byParent.get('') || [];
  if (roots.length === 0) {
    const empty = window.document.createElement('div');
    empty.className = 'fb-preview-empty';
    empty.textContent = 'Project is empty.';
    treeBodyEl.appendChild(empty);
    return;
  }
  roots.forEach((node) => treeBodyEl.appendChild(renderNode(node, byParent, 0)));
}

function renderNode(node, byParent, depth) {
  const row = window.document.createElement('div');
  row.className = 'fb-node';
  row.dataset.path = node.path;
  row.dataset.kind = node.isFile ? 'file' : 'folder';
  if (selected === node.path) row.classList.add('fb-node--selected');
  if (!node.isFile && activeFolder === node.path) row.classList.add('fb-node--active-folder');
  if (newPaths.has(node.path)) row.classList.add('fb-node--new');

  const chev = window.document.createElement('span');
  chev.className = 'fb-chev';
  chev.textContent = node.isFile ? '' : (expanded.has(node.path) ? '▾' : '▸');
  row.appendChild(chev);

  const icon = window.document.createElement('span');
  icon.className = 'fb-icon' + (node.isFile ? '' : ' fb-icon--folder');
  icon.textContent = node.isFile ? '•' : '▣';
  row.appendChild(icon);

  const label = window.document.createElement('span');
  label.className = 'fb-label';
  label.textContent = node.name;
  row.appendChild(label);

  if (node.isFile) {
    const size = window.document.createElement('span');
    size.className = 'fb-size';
    size.textContent = formatSize(node.size || 0);
    row.appendChild(size);

    const pin = window.document.createElement('span');
    const isPinned = pinned.has(node.path);
    pin.className = 'fb-pin' + (isPinned ? ' fb-pin--active' : '');
    pin.textContent = isPinned ? '★' : '☆';
    pin.title = isPinned ? 'Unpin from canvas' : 'Pin to canvas';
    pin.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePin(node.path);
    });
    row.appendChild(pin);
  }

  row.addEventListener('click', () => {
    if (node.isFile) {
      selected = node.path;
      // File click: parent folder becomes the active upload target so the
      // upload button writes alongside the file the user just opened.
      const slash = node.path.lastIndexOf('/');
      setActiveFolder(slash === -1 ? null : node.path.slice(0, slash));
      renderTree();
      showPreview(node);
    } else {
      if (expanded.has(node.path)) expanded.delete(node.path);
      else expanded.add(node.path);
      persistState();
      // Folder click also marks it active for upload — single click does
      // both because the user usually wants those two things together.
      // setActiveFolder() re-renders + persists, but only when the active
      // folder actually changes; force a render here for the expand toggle.
      if (activeFolder === node.path) renderTree();
      else setActiveFolder(node.path);
    }
  });

  // Drag-drop: folders are drop targets; files implicitly target their parent.
  if (!node.isFile) {
    row.addEventListener('dragenter', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      clearDropTargets();
      row.classList.add('fb-node--drop-target');
      dropTarget = node.path;
    });
    row.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    row.addEventListener('dragleave', (ev) => {
      ev.stopPropagation();
      row.classList.remove('fb-node--drop-target');
      if (dropTarget === node.path) dropTarget = null;
    });
  }

  const wrap = window.document.createElement('div');
  wrap.appendChild(row);

  if (!node.isFile && expanded.has(node.path)) {
    const children = byParent.get(node.path) || [];
    if (children.length > 0) {
      const childrenBox = window.document.createElement('div');
      childrenBox.className = 'fb-children';
      children.forEach((c) => childrenBox.appendChild(renderNode(c, byParent, depth + 1)));
      wrap.appendChild(childrenBox);
    }
  }
  return wrap;
}

function clearDropTargets() {
  const marked = treeBodyEl.querySelectorAll('.fb-node--drop-target');
  for (let i = 0; i < marked.length; i++) marked[i].classList.remove('fb-node--drop-target');
}

// ── Preview ─────────────────────────────────────────────────────────
async function showPreview(node) {
  const e = ext(node.path);
  previewNameEl.textContent = node.path;
  previewMetaEl.textContent = formatSize(node.size || 0);
  previewBodyEl.innerHTML = '';
  previewBodyEl.classList.remove('fb-preview-empty');

  // listAll returns project-relative paths; reads/urls use the leading-/
  // project-root-absolute escape so canvas-relative resolution doesn't try
  // to interpret these as canvas-rooted paths.
  const absPath = '/' + node.path;

  if (IMAGE_EXTS.has(e)) {
    const img = window.document.createElement('img');
    img.className = 'fb-preview-img';
    img.src = mica.files.url(absPath);
    img.alt = node.path;
    previewBodyEl.appendChild(img);
    return;
  }

  if (BINARY_EXTS.has(e)) {
    renderBinaryPreview(node);
    return;
  }

  // Attempt a text read. If server returns binary bytes, we'll detect via
  // NUL check. Cap the read so a huge file doesn't blow memory.
  let text;
  try {
    text = await mica.files.read(absPath);
  } catch (err) {
    previewBodyEl.textContent = 'Failed to read: ' + (err && err.message ? err.message : err);
    return;
  }
  if (text.length > PREVIEW_BYTE_CAP) {
    text = text.slice(0, PREVIEW_BYTE_CAP);
  }
  if (text.indexOf('\0') !== -1) {
    renderBinaryPreview(node);
    return;
  }
  renderTextPreview(text);
}

function renderTextPreview(text) {
  const lines = text.split('\n');
  if (lines.length <= PREVIEW_LINE_CAP) {
    previewBodyEl.textContent = text;
    return;
  }
  const head = window.document.createElement('div');
  head.textContent = lines.slice(0, PREVIEW_LINE_CAP).join('\n');
  previewBodyEl.appendChild(head);
  const btn = window.document.createElement('button');
  btn.className = 'fb-show-more';
  btn.textContent = `Show remaining ${lines.length - PREVIEW_LINE_CAP} lines`;
  btn.addEventListener('click', () => {
    btn.remove();
    const rest = window.document.createElement('div');
    rest.textContent = lines.slice(PREVIEW_LINE_CAP).join('\n');
    previewBodyEl.appendChild(rest);
  });
  previewBodyEl.appendChild(btn);
}

function renderBinaryPreview(node) {
  const wrap = window.document.createElement('div');
  wrap.className = 'fb-preview-binary';
  const absPath = '/' + node.path;
  wrap.innerHTML = `Binary file — ${formatSize(node.size || 0)}<br/><a href="${mica.files.url(absPath)}" target="_blank" rel="noopener">Open in new tab</a>`;
  previewBodyEl.appendChild(wrap);
}

// ── Pin / unpin ─────────────────────────────────────────────────────
async function togglePin(path) {
  const wasPinned = pinned.has(path);
  try {
    const res = await fetch('/api/canvas/pin', {
      method: wasPinned ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: path }),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    pinned = new Set(data.pinned || []);
    renderTree();
  } catch (err) {
    console.error('[filebrowser] pin toggle failed:', err);
  }
}

// ── Drag-drop upload ────────────────────────────────────────────────
// Target:
//   - dropTarget set (hovered a folder row) → upload into that folder
//   - else → upload into canvas root (config.canvasRoot)
// Canvas root is fetched on mount alongside pinned so we know the
// default upload location.
let canvasRoot = 'canvas';
async function loadCanvasRoot() {
  try {
    const r = await fetch('/api/canvas/config');
    if (r.ok) {
      const cfg = await r.json();
      if (cfg.canvasRoot) canvasRoot = cfg.canvasRoot;
    }
  } catch (_) { /* default */ }
}

treePaneEl.addEventListener('dragenter', (ev) => {
  if (ev.dataTransfer && ev.dataTransfer.types && ev.dataTransfer.types.indexOf('Files') !== -1) {
    ev.preventDefault();
    treePaneEl.classList.add('fb-tree--dragover');
  }
});
treePaneEl.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer && ev.dataTransfer.types && ev.dataTransfer.types.indexOf('Files') !== -1) {
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
  }
});
treePaneEl.addEventListener('dragleave', (ev) => {
  if (ev.target === treePaneEl) {
    treePaneEl.classList.remove('fb-tree--dragover');
  }
});
treePaneEl.addEventListener('drop', async (ev) => {
  ev.preventDefault();
  treePaneEl.classList.remove('fb-tree--dragover');
  clearDropTargets();
  const files = ev.dataTransfer && ev.dataTransfer.files ? Array.from(ev.dataTransfer.files) : [];
  if (files.length === 0) return;
  // Drop on a folder row → that folder. Drop in empty pane → activeFolder
  // if set, else project root. Mirrors the upload-button rule so users
  // don't have to remember two different defaults.
  const targetFolder = dropTarget || activeFolder || '';
  dropTarget = null;
  for (const file of files) {
    const projectRel = targetFolder ? (targetFolder.replace(/\/$/, '') + '/' + file.name) : file.name;
    const target = '/' + projectRel;
    try {
      await mica.files.write(target, file);
    } catch (err) {
      console.error('[filebrowser] upload failed:', target, err);
    }
  }
  // file-created broadcast will refresh, but be eager for responsiveness.
  loadData();
});

// ── Refresh on file events + manual ─────────────────────────────────
let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => { refreshTimer = null; loadData(); }, 100);
}

// Watcher events just trigger a refresh; the diff inside loadData()
// decides what to glow. Source-filtering (self-echo) only matters for
// downstream re-render decisions — the diff naturally handles "is this
// path new?" without needing to reason about who wrote it.
//
// `card-class-changed` is the dedicated channel for `.mica/card-classes/*`
// activity — the server routes those through a separate event name, so
// without subscribing here the filebrowser would silently miss any new
// card-class files.
const unsubs = [
  mica.on('file-created', (ev) => { if (!mica.isSelfEcho(ev)) scheduleRefresh(); }),
  mica.on('file-changed', (ev) => { if (!mica.isSelfEcho(ev) && ev.filename !== mica.filename) scheduleRefresh(); }),
  mica.on('file-deleted', () => scheduleRefresh()),
  mica.on('card-class-changed', () => scheduleRefresh()),
];

refreshBtn.addEventListener('click', () => loadData());

// Click the active-folder badge to reset upload target to project root.
// Quick escape hatch for users who clicked into a deep folder and want
// to drop a file at the top level without navigating back.
if (activeFolderEl) {
  activeFolderEl.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    setActiveFolder(null);
  });
}

// Click-to-upload: opens a hidden <input type="file" multiple>, writes each
// chosen file into the active folder (set by clicking a folder / file in
// the tree) or canvasRoot when nothing is active. The hidden input is
// reused across clicks; resetting .value lets the user re-pick the same
// file in a row without the change event being suppressed.
if (uploadBtn && uploadInput) {
  uploadBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    uploadInput.click();
  });
  uploadInput.addEventListener('change', async () => {
    const files = Array.from(uploadInput.files || []);
    uploadInput.value = '';
    if (files.length === 0) return;
    // No active folder → upload at project root (not canvasRoot).
    const targetFolder = activeFolder || '';
    for (const file of files) {
      const projectRel = targetFolder
        ? targetFolder.replace(/\/$/, '') + '/' + file.name
        : file.name;
      try {
        await mica.files.write('/' + projectRel, file);
      } catch (err) {
        console.error('[filebrowser] upload failed:', projectRel, err);
      }
    }
    loadData();
  });
}

// Show-hidden toggle. Persisted alongside expand state so the choice
// survives reloads. Re-fetches because /api/files needs the showHidden
// query param to relax the dot-prefix filter server-side.
showHiddenInput.addEventListener('change', () => {
  showHidden = showHiddenInput.checked;
  persistState();
  loadData();
});

// ── Resizable tree pane ─────────────────────────────────────────────
// Drag the vertical handle between tree and preview to resize. Width is
// stored as px, persisted with expand-state, and clamped to a reasonable
// range relative to the card's current width on each drag (so the user
// can't drag the tree wider than the card or down to invisibility).
function applyTreeWidth() {
  if (!treePaneEl) return;
  if (typeof treeWidth === 'number' && treeWidth > 0) {
    treePaneEl.style.flex = '0 0 ' + treeWidth + 'px';
  } else {
    treePaneEl.style.flex = '';  // fall back to CSS default (40%)
  }
}
applyTreeWidth();

if (resizerEl && rootEl) {
  let startX = 0;
  let startWidth = 0;
  let rootWidth = 0;
  let activePointerId = null;

  // Pointer events with setPointerCapture — required because the canvas
  // card class (parent shell) listens for pointerdown on its freeform layer
  // to initiate card drag/resize. Without capture-on-the-resizer, the
  // canvas would receive the gesture and our mousemove listener would
  // never fire. stopPropagation on pointerdown prevents the canvas's own
  // pointerdown handler from matching and starting a card-level drag.
  function onMove(ev) {
    if (ev.pointerId !== activePointerId) return;
    const dx = ev.clientX - startX;
    // Clamp: at least 140px (matches CSS min-width); at most rootWidth - 200px
    // so the preview pane keeps room for the header + a sliver of body.
    const max = Math.max(200, rootWidth - 200);
    treeWidth = Math.max(140, Math.min(max, startWidth + dx));
    applyTreeWidth();
  }
  function onUp(ev) {
    if (ev.pointerId !== activePointerId) return;
    try { resizerEl.releasePointerCapture(activePointerId); } catch (_) { /* already released */ }
    activePointerId = null;
    resizerEl.removeEventListener('pointermove', onMove);
    resizerEl.removeEventListener('pointerup', onUp);
    resizerEl.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('fb-resizing');
    resizerEl.classList.remove('is-dragging');
    persistState();
  }
  resizerEl.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();  // Don't let the canvas's pointerdown handler claim this gesture.
    activePointerId = ev.pointerId;
    startX = ev.clientX;
    startWidth = treePaneEl.getBoundingClientRect().width;
    rootWidth = rootEl.getBoundingClientRect().width;
    document.body.classList.add('fb-resizing');
    resizerEl.classList.add('is-dragging');
    try { resizerEl.setPointerCapture(activePointerId); } catch (_) { /* old browser */ }
    resizerEl.addEventListener('pointermove', onMove);
    resizerEl.addEventListener('pointerup', onUp);
    resizerEl.addEventListener('pointercancel', onUp);
  });
  // Double-click resets to the CSS default — quick escape if a drag went weird.
  resizerEl.addEventListener('dblclick', (ev) => {
    ev.stopPropagation();
    treeWidth = null;
    applyTreeWidth();
    persistState();
  });
}

mica.onDestroy(() => {
  if (refreshTimer) clearTimeout(refreshTimer);
  if (persistTimer) clearTimeout(persistTimer);
  for (const t of glowTimers.values()) clearTimeout(t);
  glowTimers.clear();
  newPaths.clear();
  for (const u of unsubs) u();
  // Failsafe: if the card is destroyed mid-drag, clear the global cursor.
  document.body.classList.remove('fb-resizing');
});

// ── Boot ────────────────────────────────────────────────────────────
await loadState();
showHiddenInput.checked = showHidden;
applyTreeWidth();  // Apply persisted width AFTER loadState populated treeWidth.
await loadCanvasRoot();
updateActiveFolderLabel();  // Apply persisted activeFolder + canvasRoot fallback.
await loadData();
