/**
 * Markdown card class — rich markdown editor using Toast UI Editor.
 *
 * Uses declarative dependencies to preload the editor library and CSS
 * before the card's inline scripts run. This guarantees the editor
 * is fully available (JS loaded, CSS applied) when we create it.
 */

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
  // Escape content for safe embedding in a data attribute
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

      const editor = new toastui.Editor({
        el: editorEl,
        height: '240px',
        initialEditType: 'wysiwyg',
        previewStyle: 'tab',
        initialValue: initialContent,
        theme: 'dark',
        usageStatistics: false,
        toolbarItems: [
          ['heading', 'bold', 'italic', 'strike'],
          ['ul', 'ol', 'task'],
          ['table', 'link'],
          ['code', 'codeblock'],
        ],
      });

      // Debounced save — write back to file after user stops typing
      let saveTimer = null;
      editor.on('change', () => {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
          const md = editor.getMarkdown();
          mica.send('save', { content: md });
        }, 800);
      });

      mica.onDestroy(() => {
        if (saveTimer) clearTimeout(saveTimer);
        editor.destroy();
      });
    })();
    </script>
  `;
}

export async function save(content, args, mica) {
  const newContent = args.content || "";
  await mica.write(newContent);
  return { ok: true };
}
