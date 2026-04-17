// LLM Chat card — direct streaming chat with model switcher
// Uses WebSocket channel to server, which streams from SGLang

var messagesEl = container.querySelector('#llm-messages');
var inputEl = container.querySelector('#llm-input');
var sendBtn = container.querySelector('#llm-send');
var stopBtn = container.querySelector('#llm-stop');
var modelSelect = container.querySelector('#llm-model');
var clearBtn = container.querySelector('#llm-clear');

var busy = false;
var currentBubble = null;
var currentText = '';
var streamStart = 0;
var firstTokenTime = 0;
var tokenCount = 0;

var ch = mica.openChannel('llm_session');

// Poll LLM server status until ready
var llmReady = false;
function checkLlmStatus() {
  fetch('/api/llm/status').then(function(r) { return r.json(); }).then(function(s) {
    if (s.ready) {
      llmReady = true;
      sendBtn.disabled = false;
      inputEl.placeholder = 'Message...';
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
      break;
    case 'error':
      setBusy(false);
      addBubble('assistant', 'Error: ' + (data.error || 'Unknown'), 'System');
      currentBubble = null;
      currentText = '';
      break;
  }
});

ch.onClose(function() {});

function send() {
  var text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = '';
  ch.send({ message: text, model: modelSelect.value });
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
  // TODO: clear server-side history too
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Select a model and start chatting.</div>';
});

mica.onDestroy(function() {
  ch.close();
});
