/**
 * Goal card class — renders project goals with checklist progress.
 */

import { marked } from 'marked';

export const metadata = { extension: ".goal", badge: "GOAL", primaryFile: "goals.md", seed: true, defaultTitle: "Project Goal" };

export default function render(content, config) {
  const html = marked.parse(content, { breaks: false, gfm: true });

  // Count checklist items
  const total = (content.match(/- \[/g) || []).length;
  const done = (content.match(/- \[x\]/gi) || []).length;

  let progressHtml = "";
  if (total > 0) {
    const pct = Math.round((done / total) * 100);
    progressHtml = `
      <div class="card-progress">
        <div class="card-progress-bar" style="width: ${pct}%"></div>
      </div>
      <div class="card-progress-label">${done}/${total} complete</div>
    `;
  }

  return `
    <div class="card-goal">
      ${progressHtml}
      <div class="card-markdown">${html}</div>
    </div>
    <script>
      const unsub = mica.on('file-changed', (e) => {
        if (e.filename === mica.filename && e.source !== mica.filename) mica.refresh();
      });
      mica.onDestroy(() => unsub());
    </script>
  `;
}
