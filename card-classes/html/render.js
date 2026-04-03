/**
 * HTML card class — renders raw HTML content directly.
 */

export default function render(content, config) {
  return `<div class="html-widget">${content}</div>
    <script>
      mica.on('file-changed', (e) => {
        if (e.filename === mica.filename) mica.refresh();
      });
    </script>`;
}
