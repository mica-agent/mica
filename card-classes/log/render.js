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
  `;
}
