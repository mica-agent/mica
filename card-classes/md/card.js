// Markdown card — WYSIWYG editor using Toast UI Editor
// container and mica are provided by CARD_SHIM

const content = await mica.getContent();

// Strip YAML frontmatter (--- ... ---) before editing, preserve for save
let frontmatter = '';
const fmMatch = content.match(/^(---[\s\S]*?---\n*)/m);
if (fmMatch) frontmatter = fmMatch[1];
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
  console.log('[md-card] file-changed event', { filename: e.filename, expected: mica.filename, source: e.source, windowId: mica.windowId, justSaved: justSaved });
  if (e.filename === mica.filename && e.source !== mica.windowId && !justSaved) {
    console.log('[md-card] refresh firing for', e.filename);
    mica.refresh();
  }
});

mica.onDestroy(function() {
  unsub();
  if (saveTimer) clearTimeout(saveTimer);
  editor.destroy();
});
