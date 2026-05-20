// Shared-library card — browse and pin/unpin workspace-shared docs.
//
// Shared docs live at /workspaces/shared/ and carry YAML frontmatter
// (title, description, tags). This card lists them, filters them, and
// pins/unpins them into the current project's canvas via the
// /api/canvas/shared-pin endpoint.
//
// The shared-pin REST endpoint accepts {source: "user"} so this card's
// clicks don't trigger the agent-pinned toast — the user already saw
// their own click.

var listEl = container.querySelector('#shared-list');
var emptyEl = container.querySelector('#shared-empty');
var searchEl = container.querySelector('#shared-search');
var countEl = container.querySelector('#shared-count');
var statusEl = container.querySelector('#shared-status');

var docs = [];          // [{ name, virtualName, title, description, tags, size, modifiedAt }]
var pinned = new Set(); // names currently pinned in this project

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function projectHeaders(extra) {
  var h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

function setStatus(text, isError) {
  statusEl.textContent = text || '';
  statusEl.style.color = isError ? '#f87171' : '#6e7681';
}

function reload() {
  Promise.all([
    fetch('/api/shared-docs').then(function(r) { return r.json(); }),
    fetch('/api/canvas/config', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
  ]).then(function(results) {
    docs = Array.isArray(results[0]) ? results[0] : [];
    var sp = (results[1] && Array.isArray(results[1].sharedPinned)) ? results[1].sharedPinned : [];
    pinned = new Set(sp);
    render();
  }).catch(function(err) {
    listEl.innerHTML = '';
    setStatus('Failed to load: ' + err.message, true);
  });
}

function render() {
  var q = (searchEl.value || '').toLowerCase().trim();
  var filtered = docs.filter(function(d) {
    if (!q) return true;
    if ((d.title || '').toLowerCase().indexOf(q) >= 0) return true;
    if ((d.description || '').toLowerCase().indexOf(q) >= 0) return true;
    if ((d.tags || []).some(function(t) { return t.toLowerCase().indexOf(q) >= 0; })) return true;
    if ((d.name || '').toLowerCase().indexOf(q) >= 0) return true;
    return false;
  });

  countEl.textContent = docs.length === 0 ? '' : (filtered.length + ' of ' + docs.length);

  if (docs.length === 0) {
    emptyEl.style.display = '';
    listEl.innerHTML = '';
    return;
  }
  emptyEl.style.display = 'none';

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:#8b949e;font-size:12px;text-align:center">No shared docs match this filter</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var d = filtered[i];
    var isPinned = pinned.has(d.name);
    var tags = (d.tags || []).map(function(t) {
      return '<span style="background:rgba(59,130,246,0.12);color:#79b8ff;border-radius:3px;padding:1px 6px;font-size:10px;margin-right:4px;">' + escHtml(t) + '</span>';
    }).join('');
    html += '<div style="padding:8px 12px;border-bottom:1px solid rgba(48,54,61,0.5);display:flex;align-items:flex-start;gap:8px;">' +
      '<div style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:6px;">' +
          '<span style="color:#e6edf3;font-size:13px;font-weight:600;">' + escHtml(d.title || d.name) + '</span>' +
          (isPinned ? '<span style="color:#56d364;font-size:10px;background:rgba(86,211,100,0.12);border-radius:3px;padding:1px 5px;">PINNED</span>' : '') +
        '</div>' +
        '<div style="color:#8b949e;font-size:11px;margin-top:2px;line-height:1.5;">' + escHtml(d.description || '') + '</div>' +
        '<div style="margin-top:4px;">' + tags +
          '<span style="color:#484f58;font-size:10px;margin-left:2px;">' + escHtml(d.name) + '</span>' +
        '</div>' +
      '</div>' +
      '<button data-name="' + escHtml(d.name) + '" data-action="' + (isPinned ? 'unpin' : 'pin') + '" ' +
        'style="background:' + (isPinned ? 'transparent' : '#3b82f6') + ';color:' + (isPinned ? '#8b949e' : '#fff') +
        ';border:1px solid ' + (isPinned ? '#30363d' : '#3b82f6') + ';border-radius:4px;padding:3px 10px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;flex-shrink:0;">' +
        (isPinned ? 'Unpin' : 'Pin') + '</button>' +
      '</div>';
  }
  listEl.innerHTML = html;

  var btns = listEl.querySelectorAll('button[data-name]');
  for (var bi = 0; bi < btns.length; bi++) {
    btns[bi].addEventListener('click', function(e) {
      e.stopPropagation();
      var name = e.currentTarget.getAttribute('data-name');
      var action = e.currentTarget.getAttribute('data-action');
      togglePin(name, action);
    });
  }
}

function togglePin(name, action) {
  setStatus(action === 'pin' ? 'Pinning ' + name + '...' : 'Unpinning ' + name + '...');
  var url = '/api/canvas/shared-pin';
  var opts = {
    method: action === 'pin' ? 'POST' : 'DELETE',
    headers: projectHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: name, source: 'user' }),
  };
  fetch(url, opts).then(function(r) {
    if (!r.ok) return r.json().then(function(j) { throw new Error(j.error || ('HTTP ' + r.status)); });
    return r.json();
  }).then(function(j) {
    pinned = new Set(j.sharedPinned || []);
    setStatus(action === 'pin' ? 'Pinned ' + name : 'Unpinned ' + name);
    render();
  }).catch(function(err) {
    setStatus('Error: ' + err.message, true);
  });
}

searchEl.addEventListener('input', function(e) { e.stopPropagation(); render(); });
searchEl.addEventListener('click', function(e) { e.stopPropagation(); });
searchEl.addEventListener('keydown', function(e) { e.stopPropagation(); });

// React to pin-added / file-created events from agent-initiated pins so
// the card reflects state immediately without a manual refresh.
mica.on('file-created', function(ev) {
  if (typeof ev.filename === 'string' && ev.filename.indexOf('shared/') === 0) reload();
});
mica.on('file-deleted', function(ev) {
  if (typeof ev.filename === 'string' && ev.filename.indexOf('shared/') === 0) reload();
});

reload();
