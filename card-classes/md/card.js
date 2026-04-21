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

editor.on('change', function() {
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

async function applyExternalChange() {
  try {
    // Don't gate on focus: a user can click into the editor to read without
    // typing, and skipping sync while focused made external writes invisible
    // until refresh. Active typing is already protected by the `justSaved`
    // flag (set for 1s after every autosave), and scroll position is
    // restored across setMarkdown, so a non-typing focused reader sees the
    // update without losing their place.
    const newContent = await mica.getContent();
    const fmMatchNew = newContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    frontmatter = fmMatchNew ? fmMatchNew[0] : '';
    const newBody = fmMatchNew ? newContent.slice(fmMatchNew[0].length) : newContent;
    if (newBody === lastSyncedBody) return;
    // Intentionally no `newBody === editor.getMarkdown()` check here —
    // getMarkdown() serializes the whole document (~10-50ms on long docs),
    // and the false-positive rate (agent wrote literally-identical content)
    // is negligible compared to the cost of running it on every broadcast.

    const scrollers = snapshotScrollers();
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
