/**
 * HTML card class — renders raw HTML content directly.
 */

export const metadata = { extension: ".html", badge: "HTML", primaryFile: "page.html" };

export default function render(content, config) {
  // If the content is a full HTML document, extract body + styles from head.
  // Agents often generate <!DOCTYPE><html><head><style>...</style></head><body>...</body></html>
  // but innerHTML can't handle nested document structure.
  let body = content;
  let headStyles = "";
  const bodyMatch = content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    body = bodyMatch[1].trim();
    // Preserve <style> tags from <head>
    const styleMatches = content.match(/<style[^>]*>[\s\S]*?<\/style>/gi);
    if (styleMatches) headStyles = styleMatches.join("\n");
  }

  return `${headStyles}<div class="html-widget">${body}</div>
    <script>
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename) mica.refresh();
      });
      mica.onDestroy(() => unsub());
    </script>`;
}
