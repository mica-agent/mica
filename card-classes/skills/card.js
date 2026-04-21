// Skills card — browse, edit, create project-scoped skills at <project>/.qwen/skills/<name>/SKILL.md.
// Skills are bundled by project templates; the agent (Qwen Code) loads them at runtime.

var listEl = container.querySelector('#skills-list');
var searchEl = container.querySelector('#skills-search');
var newBtn = container.querySelector('#skills-new');
var editorEl = container.querySelector('#skills-editor');
var editTitleEl = container.querySelector('#skills-edit-title');
var contentEl = container.querySelector('#skills-content');
var saveBtn = container.querySelector('#skills-save');
var deleteBtn = container.querySelector('#skills-delete');
var backBtn = container.querySelector('#skills-back');
var statusEl = container.querySelector('#skills-status');

var skills = [];           // [{ name, description, hasContent }]
var current = null;        // { name } when editing

// Compose sidebar
var composeInputEl = container.querySelector('#skills-compose-input');
var composeSendBtn = container.querySelector('#skills-compose-send');
var composeStopBtn = container.querySelector('#skills-compose-stop');
var chatEl = container.querySelector('#skills-chat');
var chatEmptyEl = container.querySelector('#skills-chat-empty');
var composeBusy = false;
var currentChatBubble = null;
var docBuffer = '';
var docFlushTimer = null;
var savedScrollTop = 0;
var composeChannel = null;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Scope /api/* calls to this card's project. Skills live per-project at
// .mica/skills/<name>/; without this header we'd collide across projects.
function projectHeaders(extra) {
  var h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

function loadSkills() {
  fetch('/api/skills', { headers: projectHeaders() }).then(function(r) { return r.json(); }).then(function(data) {
    skills = data || [];
    render();
  }).catch(function(err) {
    listEl.innerHTML = '<div style="padding:16px;color:#f87171;font-size:12px">Failed to load skills</div>';
    console.error('[skills] load failed:', err);
  });
}

function render() {
  var filter = (searchEl.value || '').toLowerCase().trim();
  var filtered = filter
    ? skills.filter(function(s) {
        return s.name.toLowerCase().indexOf(filter) >= 0
            || (s.description || '').toLowerCase().indexOf(filter) >= 0;
      })
    : skills;

  if (filtered.length === 0) {
    listEl.innerHTML = '<div style="padding:16px;color:#8b949e;font-size:12px;text-align:center">No skills' + (filter ? ' match filter' : ' in this project') + '</div>';
    return;
  }

  var html = '';
  for (var i = 0; i < filtered.length; i++) {
    var item = filtered[i];
    var desc = item.description || '<em style="color:#6e7681">no description</em>';
    html += '<div data-name="' + escHtml(item.name) + '" ' +
      'style="padding:8px 12px;cursor:pointer;border-left:2px solid transparent" ' +
      'onmouseover="this.style.background=\'rgba(255,255,255,0.04)\';this.style.borderLeftColor=\'#3b82f6\'" ' +
      'onmouseout="this.style.background=\'transparent\';this.style.borderLeftColor=\'transparent\'">' +
      '<div style="color:#e6edf3;font-size:13px;font-weight:500">' + escHtml(item.name) + '</div>' +
      '<div style="color:#8b949e;font-size:11px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + desc + '</div>' +
      '</div>';
  }
  listEl.innerHTML = html;

  var skEls = listEl.querySelectorAll('[data-name]');
  for (var ji = 0; ji < skEls.length; ji++) {
    skEls[ji].addEventListener('click', function(e) {
      e.stopPropagation();
      openSkill(e.currentTarget.getAttribute('data-name'));
    });
  }
}

function openSkill(name) {
  current = { name: name };
  editTitleEl.textContent = name;
  statusEl.textContent = 'Loading...';
  editorEl.style.display = 'flex';
  contentEl.value = '';
  resetChat();
  fetch('/api/skills/' + encodeURIComponent(name), { headers: projectHeaders() })
    .then(function(r) { return r.text(); })
    .then(function(text) {
      contentEl.value = text;
      statusEl.textContent = '';
    })
    .catch(function() { statusEl.textContent = 'Failed to load'; });
}

function closeEditor() {
  current = null;
  editorEl.style.display = 'none';
  if (composeBusy && composeChannel) {
    composeChannel.send({ type: 'interrupt' });
  }
  resetChat();
}

// ── Compose sidebar ──────────────────────────────────────

function ensureComposeChannel() {
  if (composeChannel) return composeChannel;
  composeChannel = mica.openChannel('skill_compose');
  composeChannel.onData(handleComposeData);
  return composeChannel;
}

function resetChat() {
  chatEmptyEl.style.display = '';
  // Remove all chat children except the empty hint
  var nodes = chatEl.querySelectorAll('.skill-chat-msg');
  for (var i = 0; i < nodes.length; i++) nodes[i].remove();
  currentChatBubble = null;
  docBuffer = '';
  if (docFlushTimer) { clearTimeout(docFlushTimer); docFlushTimer = null; }
  composeInputEl.value = '';
  if (composeChannel) composeChannel.send({ type: 'reset' });
  setComposeBusy(false);
}

function setComposeBusy(busy) {
  composeBusy = busy;
  composeSendBtn.disabled = busy;
  composeSendBtn.style.opacity = busy ? '0.5' : '1';
  composeSendBtn.style.cursor = busy ? 'default' : 'pointer';
  composeStopBtn.style.display = busy ? '' : 'none';
}

function appendChatMsg(role, text) {
  chatEmptyEl.style.display = 'none';
  var el = window.document.createElement('div');
  el.className = 'skill-chat-msg';
  if (role === 'user') {
    el.style.cssText = 'align-self:flex-end;background:rgba(59,130,246,0.18);border-radius:8px 8px 2px 8px;padding:5px 9px;max-width:90%;color:#e6edf3;font-size:12px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;';
  } else {
    el.style.cssText = 'align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:8px 8px 8px 2px;padding:5px 9px;max-width:95%;color:#e6edf3;font-size:12px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;';
  }
  el.textContent = text;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}

function flushDocBuffer() {
  docFlushTimer = null;
  contentEl.value = docBuffer;
}

function scheduleDocFlush() {
  if (docFlushTimer) return;
  docFlushTimer = setTimeout(flushDocBuffer, 50);  // ~20Hz; textarea writes are cheap
}

function handleComposeData(data) {
  switch (data.type) {
    case 'thinking':
      // Stream begun. Bubble created lazily on first chat-delta.
      break;
    case 'chat-delta':
      if (!currentChatBubble) currentChatBubble = appendChatMsg('assistant', '');
      currentChatBubble.textContent += data.text;
      chatEl.scrollTop = chatEl.scrollHeight;
      break;
    case 'doc-start':
      savedScrollTop = contentEl.scrollTop || 0;
      docBuffer = '';
      contentEl.value = '';
      break;
    case 'doc-delta':
      docBuffer += data.text;
      scheduleDocFlush();
      break;
    case 'doc-end':
      if (docFlushTimer) { clearTimeout(docFlushTimer); docFlushTimer = null; }
      flushDocBuffer();
      contentEl.scrollTop = savedScrollTop;
      break;
    case 'done':
      currentChatBubble = null;
      setComposeBusy(false);
      statusEl.textContent = data.aborted ? 'Stopped' : 'Draft updated — review and Save';
      break;
    case 'error':
      appendChatMsg('assistant', 'Error: ' + (data.error || 'unknown'));
      currentChatBubble = null;
      setComposeBusy(false);
      break;
  }
}

function sendComposePrompt() {
  if (!current || composeBusy) return;
  var text = (composeInputEl.value || '').trim();
  if (!text) return;
  ensureComposeChannel();
  appendChatMsg('user', text);
  currentChatBubble = null;
  composeInputEl.value = '';
  setComposeBusy(true);
  statusEl.textContent = 'Agent thinking...';
  composeChannel.send({
    type: 'prompt',
    prompt: text,
    currentDoc: contentEl.value,
    name: current.name,
  });
}

function saveSkill() {
  if (!current) return;
  statusEl.textContent = 'Saving...';
  fetch('/api/skills/' + encodeURIComponent(current.name), {
    method: 'PUT',
    headers: projectHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: contentEl.value }),
  }).then(function(r) {
    if (!r.ok) throw new Error('Save failed');
    statusEl.textContent = 'Saved';
    loadSkills();
  }).catch(function(err) {
    statusEl.textContent = 'Error: ' + err.message;
  });
}

function deleteSkill() {
  if (!current) return;
  if (!confirm('Delete skill "' + current.name + '"?')) return;
  fetch('/api/skills/' + encodeURIComponent(current.name), {
    method: 'DELETE',
    headers: projectHeaders(),
  }).then(function() { closeEditor(); loadSkills(); })
    .catch(function(err) { statusEl.textContent = 'Delete failed: ' + err.message; });
}

function newSkill() {
  var name = prompt('Skill name (kebab-case, e.g. "code-review"):');
  if (!name) return;
  name = name.trim();
  if (!name) return;
  var stub = '---\nname: ' + name + '\ndescription: \n---\n\n# ' + name + '\n\n';
  fetch('/api/skills/' + encodeURIComponent(name), {
    method: 'PUT',
    headers: projectHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: stub }),
  }).then(function() {
    loadSkills();
    setTimeout(function() { openSkill(name); }, 100);
  }).catch(function(err) { console.error('[skills] create failed:', err); });
}

searchEl.addEventListener('input', function(e) { e.stopPropagation(); render(); });
searchEl.addEventListener('click', function(e) { e.stopPropagation(); });
newBtn.addEventListener('click', function(e) { e.stopPropagation(); newSkill(); });
saveBtn.addEventListener('click', function(e) { e.stopPropagation(); saveSkill(); });
deleteBtn.addEventListener('click', function(e) { e.stopPropagation(); deleteSkill(); });
backBtn.addEventListener('click', function(e) { e.stopPropagation(); closeEditor(); });

composeSendBtn.addEventListener('click', function(e) { e.stopPropagation(); sendComposePrompt(); });
composeStopBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (composeChannel) composeChannel.send({ type: 'interrupt' });
});
composeInputEl.addEventListener('click', function(e) { e.stopPropagation(); });
composeInputEl.addEventListener('keydown', function(e) {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendComposePrompt(); }
});

mica.onDestroy(function() {
  if (composeChannel) { try { composeChannel.destroy(); } catch (e) {} composeChannel = null; }
});

// Open the compose channel eagerly so it's established before any send.
// (If we open lazily at first send, the channel_data can race ahead of
// channel_open's async setup on the server and be silently dropped.)
ensureComposeChannel();

loadSkills();
