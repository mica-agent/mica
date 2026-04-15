// Markdown card — WYSIWYG editor using Toast UI Editor
// container and mica are provided by CARD_SHIM

const content = await mica.getContent();

// Strip YAML frontmatter (--- ... ---) before editing, preserve for save
let frontmatter = '';
const fmMatch = content.match(/^(---[\s\S]*?---\n*)/m);
if (fmMatch) frontmatter = fmMatch[1];
const body = fmMatch ? content.slice(fmMatch[0].length) : content;

const editorEl = container.querySelector('#editor');

// Preserve scroll position across re-renders
const scrollParent = container.closest('.canvas-freeform') || container.closest('.wb-freeform');
const scrollX = scrollParent ? scrollParent.scrollLeft : 0;
const scrollY = scrollParent ? scrollParent.scrollTop : 0;

const editor = new toastui.Editor({
  el: editorEl,
  height: '100%',
  initialEditType: 'wysiwyg',
  previewStyle: 'tab',
  initialValue: body,
  theme: 'dark',
  usageStatistics: false,
  autofocus: false,
  toolbarItems: [
    ['heading', 'bold', 'italic', 'strike'],
    ['ul', 'ol', 'task'],
    ['table', 'link'],
    ['code', 'codeblock']
  ]
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
    fetch('/api/files/' + encodeURIComponent(mica.filename), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: md, source: mica.windowId })
    }).catch(function(err) { console.error('[markdown] save failed:', err); });
    setTimeout(function() { justSaved = false; }, 1000);
  }, 800);
});

// Sync from other windows — refresh if someone else changed the file
const unsub = mica.on('file-changed', function(e) {
  if (e.filename === mica.filename && e.source !== mica.windowId && !justSaved) {
    mica.refresh();
  }
});

mica.onDestroy(function() {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
  editor.destroy();
});
