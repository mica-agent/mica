/**
 * HTML card class — renders raw HTML content directly.
 */

export const metadata = { extension: ".html", badge: "HTML", primaryFile: "page.html" };

export default function render(content, config) {
  // If the content is a full HTML document, extract just the body content.
  // Agents often generate <!DOCTYPE><html><body>...</body></html> but
  // innerHTML can't handle nested document structure.
  let body = content;
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) body = bodyMatch[1].trim();

  return `<div class="html-widget">${body}</div>
    <script>
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename && e.source !== mica.filename) mica.refresh();
      });
      mica.onDestroy(() => unsub());
    </script>`;
}
