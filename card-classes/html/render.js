/**
 * HTML card class — renders raw HTML content directly.
 */

export const metadata = { extension: ".html", badge: "HTML", primaryFile: "page.html" };

export default function render(content, config) {
  return `<div class="html-widget">${content}</div>
    <script>
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename) mica.refresh();
      });
      mica.onDestroy(() => unsub());
    </script>`;
}
