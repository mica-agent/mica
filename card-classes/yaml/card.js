const contentEl = container.querySelector('#text-content');

// Use mica.files.read() for reloads — NOT mica.getContent(). getContent caches
// at card mount time and never re-fetches, so file-changed handlers would
// silently display stale content. files.read does a fresh GET each call.
async function load() {
  try {
    const text = await mica.files.read(mica.filename);
    contentEl.textContent = text ?? '';
  } catch {
    contentEl.textContent = '';
  }
}

await load();

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    load();
  }
});

mica.onDestroy(() => unsub());
