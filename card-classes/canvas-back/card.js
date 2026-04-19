// Canvas-back card — viewer/editor for `.mica/canvas-back.md`.
// container and mica are provided by CARD_SHIM.
//
// Special: this card doesn't render its own instance file. The instance
// file (e.g. `docs/canvas-back.canvas-back`) is just a stub that triggers
// the card class to mount. The actual content lives at `.mica/canvas-back.md`
// and is read/written via the existing /api/canvas-back endpoint.

const editor = container.querySelector('#cb-editor');
const status = container.querySelector('#cb-status');

let lastSaved = '';
let saveTimer = null;

function setStatus(text, color) {
  status.textContent = text;
  status.style.color = color || '#6e7681';
}

// Initial load
fetch('/api/canvas-back')
  .then(function(r) { return r.ok ? r.json() : { content: '' }; })
  .then(function(data) {
    const content = data.content || '';
    editor.value = content;
    lastSaved = content;
    editor.placeholder = '';
    setStatus('');
  })
  .catch(function(err) {
    console.error('[canvas-back] load failed:', err);
    setStatus('load failed', '#f87171');
  });

// Debounced save (800ms after last keystroke)
editor.addEventListener('input', function() {
  if (saveTimer) clearTimeout(saveTimer);
  setStatus('editing\u2026');
  saveTimer = setTimeout(function() {
    saveTimer = null;
    const content = editor.value;
    if (content === lastSaved) { setStatus(''); return; }
    setStatus('saving\u2026');
    fetch('/api/canvas-back', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content })
    })
      .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        lastSaved = content;
        setStatus('saved', '#3fb950');
        setTimeout(function() { setStatus(''); }, 1500);
      })
      .catch(function(err) {
        console.error('[canvas-back] save failed:', err);
        setStatus('save failed', '#f87171');
      });
  }, 800);
});

mica.onDestroy(function() {
  if (saveTimer) clearTimeout(saveTimer);
});
