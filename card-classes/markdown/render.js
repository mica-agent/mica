/**
 * Markdown card class — rich markdown editor using Toast UI Editor.
 */

import { marked } from 'marked';

export const metadata = { extension: ".md", badge: "MD", primaryFile: "document.md" };

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
  const escaped = content
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  return `
    <div class="card-markdown-editor">
      <div id="editor" data-content="${escaped}"></div>
    </div>

    <style>
    .card-markdown-editor {
      min-height: 200px;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .card-markdown-editor #editor {
      flex: 1;
      min-height: 0;
      overflow: hidden;
    }
    .card-markdown-editor .toastui-editor-defaultUI {
      border: none;
      background: transparent;
    }
    .card-markdown-editor .toastui-editor-defaultUI .toastui-editor-md-tab-container,
    .card-markdown-editor .toastui-editor-mode-switch {
      display: none;
    }
    .card-markdown-editor .ProseMirror {
      font-size: 0.9rem;
      line-height: 1.6;
    }
    </style>

    <script>
    (function() {
      const editorEl = container.querySelector('#editor');
      const initialContent = editorEl.dataset.content
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"');

      // Prevent Toast UI from scrolling the canvas when it initializes
      const scrollParent = container.closest('.wb-freeform') || container.closest('.wb-grid');
      const scrollX = scrollParent ? scrollParent.scrollLeft : 0;
      const scrollY = scrollParent ? scrollParent.scrollTop : 0;

      const editor = new toastui.Editor({
        el: editorEl,
        height: '100%',
        initialEditType: 'wysiwyg',
        previewStyle: 'tab',
        initialValue: initialContent,
        theme: 'dark',
        usageStatistics: false,
        autofocus: false,
        toolbarItems: [
          ['heading', 'bold', 'italic', 'strike'],
          ['ul', 'ol', 'task'],
          ['table', 'link'],
          ['code', 'codeblock'],
        ],
      });

      // Restore scroll position after init
      if (scrollParent) {
        requestAnimationFrame(() => {
          scrollParent.scrollLeft = scrollX;
          scrollParent.scrollTop = scrollY;
        });
      }

      // Force editor to recalculate when card gets its final size
      const ro = new ResizeObserver(() => {
        editor.setHeight('100%');
      });
      ro.observe(container);
      mica.onDestroy(() => ro.disconnect());

      // Debounced save
      let saveTimer = null;
      let justSaved = false;
      editor.on('change', () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          justSaved = true;
          mica.send('save', { content: editor.getMarkdown() });
          setTimeout(() => { justSaved = false; }, 1000);
        }, 800);
      });

      // Sync from other windows
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename && !justSaved) {
          mica.refresh();
        }
      });

      mica.onDestroy(() => {
        unsub();
        if (saveTimer) clearTimeout(saveTimer);
        editor.destroy();
      });
    })();
    </script>
  `;
}

export async function save(content, args, mica) {
  await mica.write('document.md', args.content || "");
  return { ok: true };
}
