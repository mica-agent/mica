const contentEl = container.querySelector('#text-content');

async function load() {
  const text = await mica.getContent();
  contentEl.textContent = text ?? '';
}

await load();

const unsub = mica.on('file-changed', (e) => {
  if (e.filename === mica.filename && !mica.isSelfEcho(e)) {
    load();
  }
});

mica.onDestroy(() => unsub());
