/**
 * Generic card class render.js — reads card.html and serves it.
 * DO NOT MODIFY this file. Write your card UI in card.html instead.
 * Add server-side functions (mica.call targets) as exports below.
 */
import fs from 'fs';
import path from 'path';

export const metadata = {
  extension: ".EXTENSION",
  badge: "BADGE",
  primaryFile: "data.json",
  defaultTitle: "TITLE"
};

export default function render(content, config) {
  const dir = path.dirname(import.meta.url.replace('file://', '').replace(/\?.*$/, ''));
  const htmlPath = path.join(dir, 'card.html');
  let html = fs.readFileSync(htmlPath, 'utf-8');
  // Inject card data and config as globals the script can read
  const inject = '<script>var CARD_DATA=' + JSON.stringify(content) + ';var CARD_CONFIG=' + JSON.stringify(config) + ';</script>';
  // Insert before first <script> or at end of <head> or at start
  if (html.includes('<script')) {
    html = html.replace(/<script/, inject + '<script');
  } else if (html.includes('</head>')) {
    html = html.replace('</head>', inject + '</head>');
  } else {
    html = inject + html;
  }
  return html;
}

// ── Server exports (optional) ─────────────────────────────
// Add functions here that the browser calls via mica.call()
// Example:
// export async function save(content, args, mica) {
//   await mica.write('data.json', JSON.stringify(args, null, 2));
//   return { ok: true };
// }
