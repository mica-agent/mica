/**
 * Markdown card class -- WYSIWYG editor using Toast UI Editor.
 * Always editable. Auto-saves on change (debounced 800ms).
 * Syncs from other windows via file-changed events.
 */

export const metadata = { extension: ".md", badge: "MD", primaryFile: "document.md", defaultTitle: "Document" };

export const dependencies = {
  scripts: [
    "https://uicdn.toast.com/editor/3.2.2/toastui-editor-all.min.js",
  ],
  styles: [
    "https://uicdn.toast.com/editor/3.2.2/toastui-editor.min.css",
    "https://uicdn.toast.com/editor/3.2.2/theme/toastui-editor-dark.min.css",
  ],
};

export default function render(content, config) {
  // Strip YAML frontmatter (--- ... ---) before editing, preserve for save
  var frontmatter = '';
  var fmMatch = content.match(/^(---[\s\S]*?---\n*)/m);
  if (fmMatch) frontmatter = fmMatch[1];
  var body = fmMatch ? content.slice(fmMatch[0].length) : content;

  var escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  var escapedFm = frontmatter
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return '<div class="card-markdown-editor">' +
    '<div id="editor" data-content="' + escaped + '" data-frontmatter="' + escapedFm + '"></div>' +
  '</div>' +

  '<style>' +
    '.card-markdown-editor {' +
      'min-height: 200px;' +
      'height: 100%;' +
      'display: flex;' +
      'flex-direction: column;' +
      'overflow: hidden;' +
    '}' +
    '.card-markdown-editor #editor {' +
      'flex: 1;' +
      'min-height: 150px;' +
      'overflow: hidden;' +
    '}' +
    '.card-markdown-editor .toastui-editor-defaultUI {' +
      'border: none;' +
      'background: transparent;' +
    '}' +
    '.card-markdown-editor .toastui-editor-defaultUI .toastui-editor-md-tab-container,' +
    '.card-markdown-editor .toastui-editor-mode-switch {' +
      'display: none;' +
    '}' +
    '.card-markdown-editor .ProseMirror {' +
      'font-size: 0.9rem;' +
      'line-height: 1.6;' +
    '}' +
  '</style>' +

  '<script>' +
  '(function() {' +
    'function loadToastUI(cb) {' +
      'if (typeof window.toastui !== "undefined" && window.toastui.Editor) { cb(); return; }' +
      'var css1 = window.document.createElement("link");' +
      'css1.rel = "stylesheet";' +
      'css1.href = "https://uicdn.toast.com/editor/3.2.2/toastui-editor.min.css";' +
      'window.document.head.appendChild(css1);' +
      'var css2 = window.document.createElement("link");' +
      'css2.rel = "stylesheet";' +
      'css2.href = "https://uicdn.toast.com/editor/3.2.2/theme/toastui-editor-dark.min.css";' +
      'window.document.head.appendChild(css2);' +
      'var s = window.document.createElement("script");' +
      's.src = "https://uicdn.toast.com/editor/3.2.2/toastui-editor-all.min.js";' +
      's.onload = cb;' +
      's.onerror = function() { console.error("[markdown] Failed to load Toast UI"); };' +
      'window.document.head.appendChild(s);' +
    '}' +
    'loadToastUI(function() {' +
    'var editorEl = container.querySelector("#editor");' +
    'var initialContent = editorEl.dataset.content' +
      '.replace(/&amp;/g, "&")' +
      '.replace(/&lt;/g, "<")' +
      '.replace(/&gt;/g, ">")' +
      '.replace(/&quot;/g, \'"\');' +
    'var frontmatter = (editorEl.dataset.frontmatter || "")' +
      '.replace(/&amp;/g, "&")' +
      '.replace(/&lt;/g, "<")' +
      '.replace(/&gt;/g, ">")' +
      '.replace(/&quot;/g, \'"\');' +

    'var scrollParent = container.closest(".canvas-freeform") || container.closest(".wb-freeform");' +
    'var scrollX = scrollParent ? scrollParent.scrollLeft : 0;' +
    'var scrollY = scrollParent ? scrollParent.scrollTop : 0;' +

    'var editor = new toastui.Editor({' +
      'el: editorEl,' +
      'height: "100%",' +
      'initialEditType: "wysiwyg",' +
      'previewStyle: "tab",' +
      'initialValue: initialContent,' +
      'theme: "dark",' +
      'usageStatistics: false,' +
      'autofocus: false,' +
      'toolbarItems: [' +
        '["heading", "bold", "italic", "strike"],' +
        '["ul", "ol", "task"],' +
        '["table", "link"],' +
        '["code", "codeblock"]' +
      ']' +
    '});' +

    'if (scrollParent) {' +
      'requestAnimationFrame(function() {' +
        'scrollParent.scrollLeft = scrollX;' +
        'scrollParent.scrollTop = scrollY;' +
      '});' +
    '}' +

    'var ro = new ResizeObserver(function() {' +
      'var h = editorEl.clientHeight;' +
      'if (h > 0) editor.setHeight(h + "px");' +
    '});' +
    'ro.observe(editorEl);' +
    'mica.onDestroy(function() { ro.disconnect(); });' +

    'var saveTimer = null;' +
    'var justSaved = false;' +
    'editor.on("change", function() {' +
      'if (saveTimer) clearTimeout(saveTimer);' +
      'saveTimer = setTimeout(function() {' +
        'justSaved = true;' +
        'var md = frontmatter + editor.getMarkdown();' +
        'fetch("/api/files/" + encodeURIComponent(mica.filename), {' +
          'method: "PUT",' +
          'headers: { "Content-Type": "application/json" },' +
          'body: JSON.stringify({ content: md })' +
        '}).catch(function(err) { console.error("[markdown] save failed:", err); });' +
        'setTimeout(function() { justSaved = false; }, 1000);' +
      '}, 800);' +
    '});' +

    'var unsub = mica.on("file-changed", function(e) {' +
      'if (e.filename === mica.filename && e.source !== mica.windowId && !justSaved) {' +
        'mica.refresh();' +
      '}' +
    '});' +

    'mica.onDestroy(function() {' +
      'unsub();' +
      'if (saveTimer) clearTimeout(saveTimer);' +
      'editor.destroy();' +
    '});' +
    '});' +
  '})();' +
  '</script>';
}
