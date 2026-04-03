/**
 * Log card class — renders the activity log.
 */

import { marked } from 'marked';

export default function render(content, config) {
  const html = marked.parse(content, { breaks: false, gfm: true });
  return `
    <div class="card-log">
      <div class="card-markdown">${html}</div>
    </div>
    <script>
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename) mica.refresh();
      });
      mica.onDestroy(() => unsub());
    </script>
  `;
}
