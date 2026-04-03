/**
 * Goal card class — renders project goals with checklist progress.
 */

import { marked } from 'marked';

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
  `;
}
