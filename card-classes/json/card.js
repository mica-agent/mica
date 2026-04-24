const contentEl = container.querySelector('#text-content');

// mica.files.read() — fresh GET each call. See txt/card.js for the gotcha.
async function load() {
  let raw = '';
  try {
    raw = (await mica.files.read(mica.filename)) ?? '';
  } catch {
    raw = '';
  }
  // Try to pretty-print valid JSON; fall back to raw text if it doesn't parse
  // (partial writes, invalid JSON, empty file). No error surfacing — a JSON
  // card is a text viewer with formatting nicety.
  try {
    contentEl.textContent = JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    contentEl.textContent = raw;
  }
}

await load();

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    load();
  }
});

mica.onDestroy(() => unsub());
