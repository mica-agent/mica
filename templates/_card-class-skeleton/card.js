// Card class skeleton — edit this file, do NOT write it from scratch.
// Runs as top-level code. `container` and `mica` are injected globals.
// No class, no `export`, no `this`, no `Mica.registerCardClass`. Just code.

const bodyEl = container.querySelector('#body');

// Read the instance file's content (the file this card renders).
const content = await mica.getContent();
bodyEl.textContent = content || '(empty)';

// ── Typical patterns you'll want (uncomment/adapt as needed) ──────────────

// Save on some user action — source is auto-injected:
// async function save(newContent) {
//   await mica.files.write(mica.filename, newContent);
// }

// List project files:
// const entries = await mica.files.list();
// const files = entries.filter(e => e.isFile);       // or e.isFolder
// const text  = await mica.files.read('docs/spec.md');
// const url   = mica.files.url('docs/image.png');    // for <img src>, <embed>, downloads

// React to changes from elsewhere:
// const unsubChanged = mica.on('file-changed', (e) => {
//   if (e.filename === mica.filename && e.source !== mica.windowId) {
//     mica.refresh();
//   }
// });
// mica.onDestroy(() => unsubChanged());

// ── Cleanup (required if you add listeners or timers) ─────────────────────
// mica.onDestroy(() => { /* detach / clear / destroy */ });
