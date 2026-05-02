// Markdown card — WYSIWYG editor using Toast UI Editor
// container and mica are provided by CARD_SHIM

const content = await mica.getContent();

// Strip YAML frontmatter (--- ... ---) before editing, preserve for save.
// Must be anchored to the very start of the file (NO /m flag) — otherwise it
// would match a mid-file `---` horizontal rule and eat content up to the next
// `---` (which can be inside a table row like `|---|---|`).
let frontmatter = '';
const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
if (fmMatch) frontmatter = fmMatch[0];
const body = fmMatch ? content.slice(fmMatch[0].length) : content;

const editorEl = container.querySelector('#editor');

// Initialize mermaid for rendering diagrams in code blocks
mermaid.initialize({ startOnLoad: false, theme: 'dark' });
var mermaidId = 0;

// Preserve scroll position across re-renders
const scrollParent = container.closest('.canvas-freeform') || container.closest('.wb-freeform');
const scrollX = scrollParent ? scrollParent.scrollLeft : 0;
const scrollY = scrollParent ? scrollParent.scrollTop : 0;

const editor = new toastui.Editor({
  el: editorEl,
  height: '100%',
  initialEditType: 'wysiwyg',
  previewStyle: 'vertical',
  initialValue: body,
  theme: 'dark',
  usageStatistics: false,
  autofocus: false,
  toolbarItems: [
    ['heading', 'bold', 'italic', 'strike'],
    ['ul', 'ol', 'task'],
    ['table', 'link'],
    ['code', 'codeblock']
  ],
  customHTMLRenderer: {
    codeBlock: function(node) {
      if (node.info === 'mermaid') {
        var id = 'mmd-' + mica.filename.replace(/\W/g, '') + '-' + (mermaidId++);
        // Render async — mermaid.render returns a promise
        setTimeout(function() {
          var el = container.querySelector('#' + id);
          if (!el) return;
          mermaid.render(id + '-svg', node.literal || '').then(function(result) {
            el.innerHTML = result.svg;
          }).catch(function() {
            el.textContent = node.literal || '';
            el.style.color = '#f87171';
          });
        }, 0);
        return [
          { type: 'openTag', tagName: 'div', attributes: { id: id, style: 'background:rgba(0,0,0,0.2);padding:8px;border-radius:6px;overflow-x:auto' } },
          { type: 'html', content: '<pre style="color:#888;font-size:11px">Loading diagram...</pre>' },
          { type: 'closeTag', tagName: 'div' }
        ];
      }
      return [
        { type: 'openTag', tagName: 'pre' },
        { type: 'openTag', tagName: 'code' },
        { type: 'text', content: node.literal || '' },
        { type: 'closeTag', tagName: 'code' },
        { type: 'closeTag', tagName: 'pre' }
      ];
    }
  }
});

if (scrollParent) {
  requestAnimationFrame(function() {
    scrollParent.scrollLeft = scrollX;
    scrollParent.scrollTop = scrollY;
  });
}

// Auto-resize editor when container changes size
const ro = new ResizeObserver(function() {
  const h = editorEl.clientHeight;
  if (h > 0) editor.setHeight(h + 'px');
});
ro.observe(editorEl);
mica.onDestroy(function() { ro.disconnect(); });

// Debounced auto-save on change (800ms)
let saveTimer = null;
let justSaved = false;
// Toast UI fires `change` on EVERY content mutation, including our own
// `editor.setMarkdown(...)` calls from applyExternalChange below. Without
// this guard, a programmatic external sync triggers an immediate auto-
// save that reads `editor.getMarkdown()` — which can return stale text
// from the editor's hidden mode-switch UI ("Write\nPreview\nMarkdown\n
// WYSIWYG") if the change handler fires before the editor's content tree
// is fully initialized. That bug overwrites the file with the toolbar
// labels and a self-perpetuating loop ensues. The timestamp window
// suppresses save scheduling for 200ms after any programmatic setMarkdown,
// long enough for ProseMirror to settle but short enough not to block
// real user input afterward.
// Initialize to "now" so the editor constructor's own first `change` event
// (fired when initialValue lands) is also treated as programmatic and
// doesn't trigger a redundant write-back of the just-loaded content.
let lastProgrammaticChangeAt = Date.now();
const PROGRAMMATIC_QUIET_MS = 200;

editor.on('change', function() {
  if (Date.now() - lastProgrammaticChangeAt < PROGRAMMATIC_QUIET_MS) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(function() {
    justSaved = true;
    const md = frontmatter + editor.getMarkdown();
    mica.files.write(mica.filename, md)
      .catch(function(err) { console.error('[markdown] save failed:', err); });
    setTimeout(function() { justSaved = false; }, 1000);
  }, 800);
});

// Sync from other windows — update content in place instead of full rebuild.
// mica.refresh() tears down and reconstructs the Toast UI Editor from scratch,
// which is brutally expensive on long docs and cascades when an agent makes a
// burst of edits. editor.setMarkdown() updates content in place and preserves
// the mount. Debounced so a burst of file-changed events only applies the last.
let syncTimer = null;
let lastSyncedBody = body;

// Snapshot scroll state on the known Toast UI scroll containers. Tree-walking
// the whole editor DOM on every sync is O(N) element reads which itself
// starves paint on long docs. These four selectors cover all modes/versions
// we care about — missing one is cheap (scroll just resets on that container).
const SCROLL_SELECTORS = [
  '.toastui-editor-ww-container',
  '.toastui-editor-md-container',
  '.toastui-editor-contents',
  '.ProseMirror',
];
function snapshotScrollers() {
  const out = [];
  for (const sel of SCROLL_SELECTORS) {
    const el = editorEl.querySelector(sel);
    if (el && el.scrollHeight > el.clientHeight + 1) {
      out.push({ el: el, top: el.scrollTop });
    }
  }
  return out;
}

// ── Δ change-summary badge ───────────────────────────────────────────────
// Computes a line-diff from the previous synced body to the new one and
// exposes it via a top-right Δ chip in card.html. Persists until the next
// external change overwrites it (or the card unmounts) — gives the user
// an always-in-view answer to "what just changed?" that complements the
// whole-card glow signal. Implementation: jsdiff Diff.diffLines via the
// CDN script in metadata.json. Failure modes (lib not loaded, malformed
// input) silently skip the update; the editor still syncs normally.

const badgeEl = container.querySelector('.md-delta-badge');
const countsEl = container.querySelector('.md-delta-counts');
const listEl = container.querySelector('.md-delta-list');
const triggerEl = container.querySelector('.md-delta-trigger');
console.info('[md-delta] mount', {
  badge: !!badgeEl,
  counts: !!countsEl,
  list: !!listEl,
  trigger: !!triggerEl,
  diffLib: typeof Diff !== 'undefined',
});

// Click-to-toggle popover. The popover is PORTALED to document.body to
// escape two things in the ancestor chain:
//   1. .card-markdown-editor's `overflow: hidden` (clips children).
//   2. .wb-panzoom-inner's `will-change: transform` — which makes that
//      element a containing block for `position: fixed` descendants, so
//      naive `position: fixed` on the popover would still anchor INSIDE
//      the panzoom subtree (and follow pan/zoom transforms off-screen).
// Body has neither problem; the popover renders at viewport coordinates
// computed from the trigger's bounding rect.
//
// Toggle uses `is-open` class directly on the popoverEl (not on badgeEl)
// because the popover is no longer a descendant of badgeEl — the CSS
// descendant selector wouldn't match.
const popoverEl = container.querySelector('.md-delta-popover');
if (popoverEl) {
  document.body.appendChild(popoverEl);
  mica.onDestroy(function() {
    if (popoverEl.parentNode === document.body) document.body.removeChild(popoverEl);
  });
}

function _positionPopover() {
  if (!triggerEl || !popoverEl) return;
  const rect = triggerEl.getBoundingClientRect();
  // Right-align the popover to the trigger's right edge; place 4px below.
  // 360px is the popover-body's intrinsic width (from card.css).
  popoverEl.style.top = (rect.bottom + 4) + 'px';
  popoverEl.style.left = (rect.right - 360) + 'px';
}
if (triggerEl && badgeEl && popoverEl) {
  triggerEl.addEventListener('click', function(ev) {
    ev.stopPropagation();
    const willOpen = !popoverEl.classList.contains('is-open');
    if (willOpen) _positionPopover();
    popoverEl.classList.toggle('is-open');
  });
  // Reposition on scroll/resize while open — the trigger moves; the popover
  // must follow. No-op when closed.
  const _reposition = function() {
    if (popoverEl.classList.contains('is-open')) _positionPopover();
  };
  window.addEventListener('scroll', _reposition, true);
  window.addEventListener('resize', _reposition);
  mica.onDestroy(function() {
    window.removeEventListener('scroll', _reposition, true);
    window.removeEventListener('resize', _reposition);
  });
  // Close on outside click. Listening on document with capture=false is
  // fine because triggerEl's handler stops propagation, so this fires
  // only for clicks elsewhere. Clicks on popover items also bubble here,
  // so check whether the click originated inside the trigger or popover.
  document.addEventListener('click', function(ev) {
    if (!popoverEl.classList.contains('is-open')) return;
    if (!triggerEl.contains(ev.target) && !popoverEl.contains(ev.target)) {
      popoverEl.classList.remove('is-open');
    }
  });
  // Esc closes too.
  document.addEventListener('keydown', function(ev) {
    if (ev.key === 'Escape' && popoverEl.classList.contains('is-open')) {
      popoverEl.classList.remove('is-open');
    }
  });
}

function _previewLine(hunkValue) {
  // First non-blank line, capped at 120 chars. Diff hunks frequently
  // start with a blank — the trailing newline of the preceding hunk —
  // and using that as the preview produces empty list entries.
  const line = (hunkValue || '').split('\n').find(function(l) { return l.trim().length > 0; }) || '';
  return line.slice(0, 120);
}

function _escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function updateDeltaBadge(priorBody, newBody) {
  if (!badgeEl || !countsEl || !listEl) {
    console.warn('[md-delta] missing DOM nodes — skipping update');
    return;
  }
  if (typeof Diff === 'undefined' || typeof Diff.diffLines !== 'function') {
    console.warn('[md-delta] Diff lib not loaded — skipping update');
    return;
  }
  if (priorBody === newBody) {
    console.info('[md-delta] no change (prior===new) — skipping');
    return;
  }
  let changes;
  try {
    changes = Diff.diffLines(priorBody || '', newBody || '');
  } catch (err) {
    console.warn('[md-delta] diffLines failed:', err);
    return;
  }
  let added = 0, modified = 0, removed = 0;
  const items = [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (c.removed) {
      const nx = changes[i + 1];
      if (nx && nx.added) {
        // remove-then-add pair = modification; show the new text as the
        // preview, stash the prior text on the title attribute for hover.
        modified++;
        items.push({ kind: 'mod', preview: _previewLine(nx.value), prior: _previewLine(c.value) });
        i++;
      } else {
        removed++;
        items.push({ kind: 'del', preview: _previewLine(c.value) });
      }
    } else if (c.added) {
      added++;
      items.push({ kind: 'add', preview: _previewLine(c.value) });
    }
  }
  // Skip updates that produced no real hunks — diffLines occasionally
  // returns trailing-newline-only segments that shouldn't surface.
  const visibleItems = items.filter(function(it) { return it.preview.trim().length > 0; });
  console.info('[md-delta] update', { added: added, modified: modified, removed: removed, items: visibleItems.length });
  if (added + modified + removed === 0 || visibleItems.length === 0) return;

  const parts = [];
  if (added) parts.push('+' + added);
  if (modified) parts.push('~' + modified);
  if (removed) parts.push('−' + removed);
  countsEl.textContent = parts.join(' ');

  listEl.innerHTML = visibleItems.map(function(it) {
    const sigil = it.kind === 'add' ? '+' : it.kind === 'mod' ? '~' : '−';
    const cls = 'md-delta-' + it.kind;
    const titleParts = [];
    if (it.kind === 'mod' && it.prior) titleParts.push('was: ' + it.prior);
    if (it.kind !== 'del') titleParts.push('Click to jump to this block');
    const titleAttr = titleParts.length
      ? ' title="' + _escapeHtml(titleParts.join(' — ')) + '"'
      : '';
    // data-preview carries the matching anchor so the click handler can
    // search the WYSIWYG pane without re-parsing the diff.
    const dataAttr = it.kind !== 'del'
      ? ' data-preview="' + _escapeHtml(it.preview) + '"'
      : '';
    return '<li class="' + cls + '"' + titleAttr + dataAttr + '>' +
      '<span class="sigil">' + sigil + '</span>' +
      '<span class="preview">' + _escapeHtml(it.preview) + '</span>' +
      '</li>';
  }).join('');

  badgeEl.hidden = false;
}

// Find a top-level WYSIWYG block whose textContent starts with (or contains)
// the delta item's preview text, scroll it into view, and pulse-highlight.
// Tied to the markdown card's WYSIWYG pane only — the hidden markdown-source
// pane shows the same content with raw markup that won't match cleanly.
function _normalizeBlockText(s) {
  return String(s || '')
    .replace(/^\s*[#>]+\s*/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _findBlockByPreview(preview) {
  const wwContainer = editorEl.querySelector('.toastui-editor-ww-container');
  const proseMirror = wwContainer && wwContainer.querySelector('.ProseMirror');
  if (!proseMirror) return null;
  const needle = _normalizeBlockText(preview).slice(0, 60);
  if (needle.length < 4) return null;

  function tryMatch(els) {
    for (const b of els) {
      const hay = _normalizeBlockText(b.textContent || '');
      if (hay && hay.startsWith(needle)) return b;
    }
    for (const b of els) {
      const hay = _normalizeBlockText(b.textContent || '');
      if (hay && hay.indexOf(needle) >= 0) return b;
    }
    return null;
  }

  // First pass: top-level blocks (paragraphs, headings — direct children
  // of .ProseMirror). Fast and precise for the common case.
  const topLevel = Array.from(proseMirror.querySelectorAll(':scope > *'));
  let hit = tryMatch(topLevel);
  if (hit) return hit;

  // Second pass: leaf-level text-bearing elements. Catches list items,
  // blockquote children, table cells — diff items often correspond to a
  // single bullet that isn't a direct child of .ProseMirror, so the
  // top-level search misses them.
  const leaves = Array.from(proseMirror.querySelectorAll(
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, dt, dd'
  ));
  hit = tryMatch(leaves);
  if (hit) return hit;

  return null;
}

if (listEl) {
  listEl.addEventListener('click', function(ev) {
    const li = ev.target.closest('li');
    if (!li || !li.dataset.preview) return;
    const block = _findBlockByPreview(li.dataset.preview);
    if (!block) {
      console.info('[md-delta] click: no matching block for', li.dataset.preview.slice(0, 60));
      return;
    }
    block.scrollIntoView({ behavior: 'smooth', block: 'center' });
    block.classList.remove('md-delta-nav-target');
    void block.offsetWidth;  // force reflow so the animation restarts on rapid clicks
    block.classList.add('md-delta-nav-target');
    setTimeout(function() {
      block.classList.remove('md-delta-nav-target');
    }, 1700);
    // Close popover after navigation so the highlighted block is visible.
    if (badgeEl) badgeEl.classList.remove('is-open');
  });
}

async function applyExternalChange() {
  try {
    // Use mica.files.read() — NOT mica.getContent(). getContent caches the
    // content at card mount time and never re-fetches; calling it here
    // returns stale data and applyExternalChange silently no-ops with
    // "body matches lastSyncedBody". files.read does a fresh GET and
    // bypasses the mount-time cache.
    const newContent = await mica.files.read(mica.filename);
    const fmMatchNew = newContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    frontmatter = fmMatchNew ? fmMatchNew[0] : '';
    const newBody = fmMatchNew ? newContent.slice(fmMatchNew[0].length) : newContent;
    if (newBody === lastSyncedBody) return;
    // Intentionally no `newBody === editor.getMarkdown()` check here —
    // getMarkdown() serializes the whole document (~10-50ms on long docs),
    // and the false-positive rate (agent wrote literally-identical content)
    // is negligible compared to the cost of running it on every broadcast.

    const priorBody = lastSyncedBody;  // capture before reassignment for diff
    const scrollers = snapshotScrollers();
    // Mark the change as programmatic so the change handler skips the
    // auto-save it would otherwise schedule (which could read stale
    // editor state and write back garbage). See PROGRAMMATIC_QUIET_MS.
    lastProgrammaticChangeAt = Date.now();
    editor.setMarkdown(newBody, false); // false = don't move cursor to end
    // Restore scroll on the next two frames — setMarkdown triggers a layout
    // pass on the first frame; our restore has to happen after that.
    requestAnimationFrame(function() {
      for (const s of scrollers) s.el.scrollTop = s.top;
      requestAnimationFrame(function() {
        for (const s of scrollers) s.el.scrollTop = s.top;
      });
    });
    lastSyncedBody = newBody;
    try { updateDeltaBadge(priorBody, newBody); }
    catch (err) { console.warn('[md-delta] badge update failed:', err); }
  } catch (err) {
    console.error('[markdown] external sync failed:', err);
  }
}
// Debounce external updates aggressively. Agent edit bursts arrive every
// ~1-2s; a short debounce fires a full setMarkdown on every hit, which on
// long docs (100ms+ per parse) starves paint and freezes card glow animations
// and scroll. 1500ms collapses an agent burst into one final update without
// making IDE-save updates feel laggy.
const EXTERNAL_SYNC_DEBOUNCE_MS = 1500;
const unsub = mica.on('file-changed', function(e) {
  if (e.filename !== mica.filename) return;
  if (mica.isSelfEcho(e)) return;
  if (justSaved) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(applyExternalChange, EXTERNAL_SYNC_DEBOUNCE_MS);
});

mica.onDestroy(function() {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
  if (syncTimer) clearTimeout(syncTimer);
  // Toast UI Editor's destroy() walks its mounted DOM. When the parent
  // subtree has already been removed (e.g. file delete → React unmount),
  // removeChild throws NotFoundError. Swallow — there's nothing left to clean.
  try { editor.destroy(); } catch (_) { /* DOM already gone */ }
});
