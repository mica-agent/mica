// Canvas-back card — viewer/editor for `.mica/canvas-back.md` with
// agent-assisted propose-then-apply editing + reset-to-template-default.
//
// State machine: 'idle' (manual editing, debounced auto-save) | 'pending'
// (proposed change visible alongside current; awaiting Apply/Reject).
//
// Safety invariants:
// - Agent NEVER writes canvas-back directly. It only streams a proposal to
//   the right-hand pane; user must click Apply.
// - Reset replaces the proposed pane with the template default; same
//   apply/reject gate before anything is written.
// - The card class itself ships with Mica (this file lives in the repo,
//   not in the project). Reset is always reachable even if canvas-back's
//   content is corrupted.

var currentEl = container.querySelector('#cb-current');
var proposedEl = container.querySelector('#cb-proposed');
var proposedPane = container.querySelector('#cb-proposed-pane');
var currentLabel = container.querySelector('#cb-current-label');
var statusEl = container.querySelector('#cb-status');
var idleActions = container.querySelector('#cb-idle-actions');
var pendingActions = container.querySelector('#cb-pending-actions');
var resetBtn = container.querySelector('#cb-reset');
var applyBtn = container.querySelector('#cb-apply');
var rejectBtn = container.querySelector('#cb-reject');
var promptEl = container.querySelector('#cb-prompt');
var sendBtn = container.querySelector('#cb-send');
var stopBtn = container.querySelector('#cb-stop');
var chatEl = container.querySelector('#cb-chat');
var chatEmpty = container.querySelector('#cb-chat-empty');

var state = 'idle';            // 'idle' | 'pending'
var lastSaved = '';            // last on-disk version (for the manual debounced save path)
var saveTimer = null;
var composeChannel = null;
var composeBusy = false;
var currentChatBubble = null;
var docFlushTimer = null;
var docBuffer = '';

function setStatus(text, color) {
  statusEl.textContent = text || '';
  statusEl.style.color = color || '#6e7681';
}

// Scope /api/* calls to this card's project. Without X-Mica-Project the server
// can't tell one project's canvas-back from another's — reads/writes collide.
function projectHeaders(extra) {
  var h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setState(next) {
  state = next;
  if (state === 'pending') {
    proposedPane.style.display = 'flex';
    currentLabel.style.display = 'block';
    currentEl.readOnly = true;
    currentEl.style.opacity = '0.7';
    idleActions.style.display = 'none';
    pendingActions.style.display = 'flex';
  } else {
    proposedPane.style.display = 'none';
    currentLabel.style.display = 'none';
    currentEl.readOnly = false;
    currentEl.style.opacity = '1';
    idleActions.style.display = 'flex';
    pendingActions.style.display = 'none';
    proposedEl.value = '';
  }
}

// ── Initial load ──────────────────────────────────────────
fetch('/api/canvas-back', { headers: projectHeaders() })
  .then(function(r) { return r.ok ? r.json() : { content: '' }; })
  .then(function(data) {
    var content = data.content || '';
    currentEl.value = content;
    lastSaved = content;
    currentEl.placeholder = '';
    setStatus('');
  })
  .catch(function(err) {
    console.error('[canvas-back] load failed:', err);
    setStatus('load failed', '#f87171');
  });

// ── Manual editing path: debounced auto-save in idle state ──
currentEl.addEventListener('input', function() {
  if (state !== 'idle') return;
  if (saveTimer) clearTimeout(saveTimer);
  setStatus('editing\u2026');
  saveTimer = setTimeout(function() {
    saveTimer = null;
    var content = currentEl.value;
    if (content === lastSaved) { setStatus(''); return; }
    setStatus('saving\u2026');
    fetch('/api/canvas-back', {
      method: 'PUT',
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
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

// ── Reset to template default ─────────────────────────────
resetBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (state === 'pending') {
    setStatus('reject the current proposal first', '#fbbf24');
    return;
  }
  if (!confirm('Load the template\u2019s default canvas-back as a proposed change? You\u2019ll review and click Apply or Reject before anything is saved.')) return;
  setStatus('loading template default\u2026');
  fetch('/api/canvas-back/template-default', { headers: projectHeaders() })
    .then(function(r) {
      if (r.status === 404) throw new Error('no template recorded');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      proposedEl.value = data.content || '';
      setState('pending');
      appendChat('user', 'Reset to template default (' + (data.template || 'unknown') + ')');
      appendChat('agent', 'Loaded template default. Review and Apply or Reject.');
      setStatus('reviewing reset', '#fbbf24');
    })
    .catch(function(err) {
      setStatus('reset failed: ' + err.message, '#f87171');
    });
});

// ── Apply / Reject ────────────────────────────────────────
applyBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (state !== 'pending') return;
  var newContent = proposedEl.value;
  setStatus('applying\u2026');
  fetch('/api/canvas-back', {
    method: 'PUT',
    headers: projectHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ content: newContent })
  })
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      currentEl.value = newContent;
      lastSaved = newContent;
      setState('idle');
      setStatus('applied', '#3fb950');
      setTimeout(function() { setStatus(''); }, 2000);
    })
    .catch(function(err) {
      setStatus('apply failed: ' + err.message, '#f87171');
    });
});

rejectBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (state !== 'pending') return;
  setState('idle');
  setStatus('rejected', '#8b949e');
  setTimeout(function() { setStatus(''); }, 1500);
});

// ── Agent compose channel ─────────────────────────────────
function ensureComposeChannel() {
  if (composeChannel) return;
  composeChannel = mica.openChannel('compose');
  composeChannel.onData(function(data) {
    handleComposeMessage(data);
  });
  composeChannel.onClose(function() {
    composeChannel = null;
  });
}

function appendChat(role, content) {
  if (chatEmpty) { chatEmpty.style.display = 'none'; }
  var div = window.document.createElement('div');
  div.style.cssText = role === 'user'
    ? 'align-self:flex-end;background:rgba(59,130,246,0.18);border-radius:8px 8px 2px 8px;padding:5px 8px;max-width:90%;color:#e6edf3;font-size:11px;line-height:1.4;'
    : 'align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:8px 8px 8px 2px;padding:5px 8px;max-width:95%;color:#ccc;font-size:11px;line-height:1.4;white-space:pre-wrap;';
  div.textContent = content;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
  return div;
}

function flushDocBuffer() {
  if (!docBuffer) return;
  proposedEl.value += docBuffer;
  docBuffer = '';
  proposedEl.scrollTop = proposedEl.scrollHeight;
}

function scheduleDocFlush() {
  if (docFlushTimer) return;
  docFlushTimer = setTimeout(function() {
    docFlushTimer = null;
    flushDocBuffer();
  }, 50);
}

function setComposeBusy(busy) {
  composeBusy = busy;
  sendBtn.disabled = busy;
  sendBtn.style.opacity = busy ? '0.5' : '1';
  stopBtn.style.display = busy ? 'inline-block' : 'none';
}

function handleComposeMessage(data) {
  switch (data.type) {
    case 'thinking':
      currentChatBubble = appendChat('agent', '\u2026');
      setStatus('agent drafting\u2026', '#3b82f6');
      break;
    case 'chat-delta':
      if (currentChatBubble) {
        if (currentChatBubble.textContent === '\u2026') currentChatBubble.textContent = '';
        currentChatBubble.textContent += data.text;
        chatEl.scrollTop = chatEl.scrollHeight;
      }
      break;
    case 'doc-start':
      // Switch to pending state and clear the proposed pane to receive new doc
      proposedEl.value = '';
      setState('pending');
      break;
    case 'doc-delta':
      docBuffer += data.text;
      scheduleDocFlush();
      break;
    case 'doc-end':
      if (docFlushTimer) { clearTimeout(docFlushTimer); docFlushTimer = null; }
      flushDocBuffer();
      break;
    case 'done':
      currentChatBubble = null;
      setComposeBusy(false);
      if (data.aborted) setStatus('stopped', '#fbbf24');
      else setStatus('proposal ready \u2014 review and Apply or Reject', '#3b82f6');
      break;
    case 'error':
      appendChat('agent', 'Error: ' + (data.error || 'unknown'));
      currentChatBubble = null;
      setComposeBusy(false);
      setStatus('error', '#f87171');
      break;
    case 'reset-ack':
      // ignore
      break;
  }
}

function sendPrompt() {
  if (composeBusy) return;
  var text = (promptEl.value || '').trim();
  if (!text) return;
  ensureComposeChannel();
  appendChat('user', text);
  currentChatBubble = null;
  promptEl.value = '';
  setComposeBusy(true);
  composeChannel.send({ type: 'prompt', prompt: text });
}

sendBtn.addEventListener('click', function(e) { e.stopPropagation(); sendPrompt(); });
stopBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  if (composeChannel) composeChannel.send({ type: 'interrupt' });
});
promptEl.addEventListener('click', function(e) { e.stopPropagation(); });
promptEl.addEventListener('keydown', function(e) {
  e.stopPropagation();
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});

// Open the compose channel eagerly (avoids a channel_data-before-channel_open
// race on first send — same idiom as the skills card).
ensureComposeChannel();

mica.onDestroy(function() {
  if (saveTimer) clearTimeout(saveTimer);
  if (docFlushTimer) clearTimeout(docFlushTimer);
  if (composeChannel) { try { composeChannel.destroy(); } catch (_) {} composeChannel = null; }
});
