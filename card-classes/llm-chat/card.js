// LLM Chat card — direct streaming chat with model switcher
// Uses WebSocket channel to server, which streams from SGLang

var messagesEl = container.querySelector('#llm-messages');
var inputEl = container.querySelector('#llm-input');
var sendBtn = container.querySelector('#llm-send');
var stopBtn = container.querySelector('#llm-stop');
var modelSelect = container.querySelector('#llm-model');
var clearBtn = container.querySelector('#llm-clear');
var fileInput = container.querySelector('#llm-file-input');
var attachmentsEl = container.querySelector('#llm-attachments');
var attachBtn = container.querySelector('#llm-attach-btn');

// Pending attachments: [{ name, mime, dataUrl }]
var pendingAttachments = [];

function renderAttachments() {
  if (pendingAttachments.length === 0) {
    attachmentsEl.style.display = 'none';
    attachmentsEl.innerHTML = '';
    return;
  }
  attachmentsEl.style.display = 'flex';
  attachmentsEl.innerHTML = pendingAttachments.map(function(att, i) {
    var thumb;
    if (att.mime.startsWith('image/')) {
      thumb = '<img src="' + att.dataUrl + '" style="width:24px;height:24px;object-fit:cover;border-radius:2px"/>';
    } else if (att.mime.startsWith('video/')) {
      thumb = '<span style="font-size:14px">🎬</span>';
    } else {
      thumb = '<span style="font-size:14px">📎</span>';
    }
    var sizeKb = att.dataUrl ? Math.round(att.dataUrl.length * 0.75 / 1024) : 0;  // base64 → bytes
    var sizeStr = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + 'MB' : sizeKb + 'KB';
    return '<div style="display:flex;align-items:center;gap:4px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:4px;padding:2px 6px;font-size:11px;color:#ccc">' +
      thumb +
      ' <span>' + att.name + '</span>' +
      ' <span style="color:#6e7681">(' + sizeStr + ')</span>' +
      ' <button data-idx="' + i + '" class="llm-att-remove" style="background:none;border:none;color:#f87171;cursor:pointer;padding:0 2px;font-size:14px;line-height:1">×</button>' +
      '</div>';
  }).join('');
  // Wire remove buttons
  var btns = attachmentsEl.querySelectorAll('.llm-att-remove');
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = parseInt(e.currentTarget.getAttribute('data-idx'));
      pendingAttachments.splice(idx, 1);
      renderAttachments();
    });
  }
}

fileInput.addEventListener('change', function(e) {
  var files = Array.from(e.target.files || []);
  files.forEach(function(file) {
    var reader = new FileReader();
    reader.onload = function() {
      pendingAttachments.push({ name: file.name, mime: file.type || 'image/jpeg', dataUrl: reader.result });
      renderAttachments();
    };
    reader.readAsDataURL(file);
  });
  fileInput.value = '';  // allow same file again
});

var busy = false;
var currentBubble = null;
var currentText = '';
var streamStart = 0;
var firstTokenTime = 0;
var tokenCount = 0;

var ch = mica.openChannel('llm_session');

// Poll LLM server status until ready
var llmReady = false;
var startupShown = false;
function showStartupSummary(text) {
  if (startupShown || !text) return;
  startupShown = true;
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
    messagesEl.innerHTML = '';
  }
  var el = window.document.createElement('div');
  el.style.cssText = 'align-self:center;color:#6e7681;font-size:11px;font-family:monospace;padding:6px 10px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:6px;margin:4px 0;';
  el.textContent = '✓ ' + text;
  messagesEl.appendChild(el);
  // Re-add the "select a model" hint below if no real conversation yet
  if (messagesEl.children.length === 1) {
    var hint = window.document.createElement('div');
    hint.style.cssText = 'color:#8b949e;font-size:12px;text-align:center;padding:16px 0;';
    hint.textContent = 'Select a model and start chatting.';
    messagesEl.appendChild(hint);
  }
  scrollBottom();
}
function checkLlmStatus() {
  fetch('/api/llm/status').then(function(r) { return r.json(); }).then(function(s) {
    if (s.ready) {
      llmReady = true;
      sendBtn.disabled = false;
      inputEl.placeholder = 'Message...';
      if (s.startupSummary) showStartupSummary(s.startupSummary);
    } else {
      llmReady = false;
      sendBtn.disabled = true;
      inputEl.placeholder = s.progress || 'Model loading...';
      setTimeout(checkLlmStatus, 3000);
    }
  }).catch(function() { setTimeout(checkLlmStatus, 5000); });
}
checkLlmStatus();

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMd(text) {
  var fenced = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    fenced.push('<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0"><code style="font-size:12px;font-family:monospace">' + escHtml(code) + '</code></pre>');
    return '__FENCED__' + (fenced.length - 1) + '__';
  });
  text = escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
  for (var i = 0; i < fenced.length; i++) {
    text = text.replace('__FENCED__' + i + '__', fenced[i]);
  }
  return text;
}

function scrollBottom() {
  requestAnimationFrame(function() { messagesEl.scrollTop = messagesEl.scrollHeight; });
}

function addBubble(role, content, label) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
    messagesEl.innerHTML = '';
  }
  var el = window.document.createElement('div');
  if (role === 'user') {
    el.style.cssText = 'align-self:flex-end;background:rgba(59,130,246,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;';
    el.innerHTML = '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + escHtml(content) + '</div>';
  } else {
    el.style.cssText = 'align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;';
    var header = label ? '<div style="color:#3b82f6;font-size:11px;font-weight:600;margin-bottom:4px;">' + escHtml(label) + '</div>' : '';
    el.innerHTML = header + '<div class="llm-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">' + renderMd(content) + '</div>';
  }
  messagesEl.appendChild(el);
  scrollBottom();
  return el;
}

function setBusy(val) {
  busy = val;
  sendBtn.style.display = val ? 'none' : '';
  stopBtn.style.display = val ? '' : 'none';
  sendBtn.disabled = val;
}

function getModelLabel() {
  return modelSelect.options[modelSelect.selectedIndex].text;
}

// Two-note chime played when a response finishes (success or error). One
// AudioContext per card, lazily created. resume() flips a suspended ctx to
// running once a user gesture has occurred.
var _audioCtx = null;
function playChime() {
  try {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    var ac = _audioCtx;
    var fire = function() {
      var now = ac.currentTime;
      [880, 1320].forEach(function(freq, i) {
        var osc = ac.createOscillator();
        var gain = ac.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        var t0 = now + i * 0.08;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
        osc.connect(gain).connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + 0.5);
      });
    };
    if (ac.state === 'suspended') {
      ac.resume().then(fire).catch(function() {});
    } else {
      fire();
    }
  } catch (_) { /* audio unavailable */ }
}

ch.onData(function(data) {
  switch (data.type) {
    case 'history':
      messagesEl.innerHTML = '';
      if (data.messages && data.messages.length > 0) {
        for (var i = 0; i < data.messages.length; i++) {
          var m = data.messages[i];
          addBubble(m.role, m.content, m.role === 'assistant' ? getModelLabel() : null);
        }
      } else {
        messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Select a model and start chatting.</div>';
      }
      break;
    case 'user':
      addBubble('user', data.content);
      break;
    case 'thinking':
      setBusy(true);
      currentText = '';
      currentBubble = null;
      streamStart = Date.now();
      firstTokenTime = 0;
      tokenCount = 0;
      break;
    case 'delta':
      if (firstTokenTime === 0) firstTokenTime = Date.now();
      tokenCount++;
      currentText += data.content;
      if (!currentBubble) {
        currentBubble = addBubble('assistant', currentText, getModelLabel());
      } else {
        var mdEl = currentBubble.querySelector('.llm-md');
        if (mdEl) { mdEl.innerHTML = renderMd(currentText); scrollBottom(); }
      }
      break;
    case 'done':
      setBusy(false);
      // Append tokens/sec stat to the bubble
      if (currentBubble && tokenCount > 0) {
        var elapsed = (Date.now() - firstTokenTime) / 1000;
        var ttft = (firstTokenTime - streamStart) / 1000;
        var tps = elapsed > 0 ? (tokenCount / elapsed).toFixed(1) : '?';
        var stat = window.document.createElement('div');
        stat.style.cssText = 'color:#6e7681;font-size:10px;margin-top:6px;font-family:monospace;';
        stat.textContent = tokenCount + ' tok . ' + tps + ' tok/s . ttft ' + ttft.toFixed(2) + 's';
        currentBubble.appendChild(stat);
      }
      currentBubble = null;
      currentText = '';
      playChime();
      break;
    case 'error':
      setBusy(false);
      addBubble('assistant', 'Error: ' + (data.error || 'Unknown'), 'System');
      currentBubble = null;
      currentText = '';
      playChime();
      break;
  }
});

ch.onClose(function() {});

function send() {
  var text = inputEl.value.trim();
  if ((!text && pendingAttachments.length === 0) || busy) return;
  inputEl.value = '';

  var payload = { model: modelSelect.value };
  if (pendingAttachments.length > 0) {
    // OpenAI-style multimodal content: array of {type:"text"|"image_url"|"video_url", ...}
    var content = [];
    var hasVideo = false;
    for (var i = 0; i < pendingAttachments.length; i++) {
      var att = pendingAttachments[i];
      if (att.mime.startsWith('video/')) {
        content.push({ type: 'video_url', video_url: { url: att.dataUrl } });
        hasVideo = true;
      } else {
        content.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      }
    }
    if (text) content.push({ type: 'text', text: text });
    payload.content = content;
    payload.message = text || (hasVideo ? '[video]' : '[image]');  // for display in history
  } else {
    payload.message = text;
  }
  pendingAttachments = [];
  renderAttachments();
  ch.send(payload);
}

sendBtn.addEventListener('click', function(e) { e.stopPropagation(); send(); });
stopBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  ch.send({ type: 'interrupt' });
  setBusy(false);
});
inputEl.addEventListener('keydown', function(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
inputEl.addEventListener('click', function(e) { e.stopPropagation(); });

clearBtn.addEventListener('click', function(e) {
  e.stopPropagation();
  // Clear server-side history (vLLM gets full history each request — old
  // images/videos in history count toward the per-prompt limit)
  ch.send({ type: 'clear' });
  pendingAttachments = [];
  renderAttachments();
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Select a model and start chatting.</div>';
});

mica.onDestroy(function() {
  ch.close();
});
