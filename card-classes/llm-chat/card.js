// LLM Chat card — streaming chat against the user-picked provider.
//
// Model + provider are configured via the gear icon (same UX as the qwen /
// opencode agent cards). Card sidecar settings + workspace .env defaults
// are the single source of truth: per-card settings (provider, model)
// persist via /api/cards/settings, OpenRouter key via /api/openrouter-key,
// openai-compat baseUrl+key via /api/openai-config. On send, the backend
// reads those via ctx.project / ctx.filename and routes accordingly.
// MICA_DEFAULT_PROVIDER + {OPENROUTER,OPENAI,LOCAL}_DEFAULT_MODEL fill in
// when a card hasn't been configured.

var messagesEl = container.querySelector('#llm-messages');
var inputEl = container.querySelector('#llm-input');
var sendBtn = container.querySelector('#llm-send');
var stopBtn = container.querySelector('#llm-stop');
var clearBtn = container.querySelector('#llm-clear-btn');
var modelLabel = container.querySelector('#llm-model-label');
var fileInput = container.querySelector('#llm-file-input');
var attachmentsEl = container.querySelector('#llm-attachments');
var attachBtn = container.querySelector('#llm-attach-btn');

// Settings panel elements
var settingsBtn = container.querySelector('#llm-settings-btn');
var settingsPanel = container.querySelector('#llm-settings-panel');
var settingsClose = container.querySelector('#llm-settings-close');
var settingsCancel = container.querySelector('#llm-settings-cancel');
var settingsSave = container.querySelector('#llm-settings-save');
var settingsModel = container.querySelector('#llm-settings-model');
var settingsModelHint = container.querySelector('#llm-settings-model-hint');
var settingsModelDropdown = container.querySelector('#llm-settings-model-dropdown');
var settingsKeyRow = container.querySelector('#llm-settings-key-row');
var settingsKey = container.querySelector('#llm-settings-key');
var settingsKeyStatus = container.querySelector('#llm-settings-key-status');
var settingsKeyLabel = container.querySelector('#llm-settings-key-label');
var settingsBaseurlRow = container.querySelector('#llm-settings-baseurl-row');
var settingsBaseurl = container.querySelector('#llm-settings-baseurl');
var providerRadios = container.querySelectorAll('input[name="llm-provider"]');

function projectHeaders(extra) {
  var h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
  if (extra) { for (var k in extra) h[k] = extra[k]; }
  return h;
}

function settingsUrl(qs) {
  var sep = qs && qs.length > 1 ? '&' : '?';
  qs = qs || '';
  return '/api/cards/settings' + qs + sep + 'path=' + encodeURIComponent(mica.filename);
}

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
    var sizeKb = att.dataUrl ? Math.round(att.dataUrl.length * 0.75 / 1024) : 0;
    var sizeStr = sizeKb > 1024 ? (sizeKb / 1024).toFixed(1) + 'MB' : sizeKb + 'KB';
    return '<div style="display:flex;align-items:center;gap:4px;background:rgba(59,130,246,0.15);border:1px solid rgba(59,130,246,0.3);border-radius:4px;padding:2px 6px;font-size:11px;color:#ccc">' +
      thumb +
      ' <span>' + att.name + '</span>' +
      ' <span style="color:#6e7681">(' + sizeStr + ')</span>' +
      ' <button data-idx="' + i + '" class="llm-att-remove" style="background:none;border:none;color:#f87171;cursor:pointer;padding:0 2px;font-size:14px;line-height:1">×</button>' +
      '</div>';
  }).join('');
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
  fileInput.value = '';
});

var busy = false;
var currentBubble = null;
var currentText = '';
var streamStart = 0;
var firstTokenTime = 0;
var tokenCount = 0;

var ch = mica.openChannel('llm_session');

// Per-card settings (provider, model). Reload on mount and after every save
// so the topbar label + backend's sidecar reads agree.
var currentSettings = { provider: 'local', model: '' };
// Env-resolved provider defaults — refreshed when the gear opens so the
// placeholder reflects what the BACKEND will use when settings.model is empty.
var MODEL_DEFAULTS = { local: '', openrouter: '', 'openai-compat': '' };

function renderModelLabel() {
  var provider = currentSettings.provider || 'local';
  var providerShort = provider === 'openrouter' ? 'OpenRouter'
    : provider === 'openai-compat' ? 'OpenAI'
    : 'Local';
  var model = currentSettings.model || MODEL_DEFAULTS[provider] || '(default)';
  var display = providerShort + ' · ' + model;
  modelLabel.textContent = display;
  modelLabel.title = display;
}

function loadSettings() {
  return fetch(settingsUrl(''), { headers: projectHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(s) {
      currentSettings = { provider: s.provider || 'local', model: s.model || '' };
      renderModelLabel();
    })
    .catch(function() { renderModelLabel(); });
}
loadSettings();
// Also refresh defaults so the topbar shows the env-resolved default model
// even before the user opens the gear.
fetch('/api/inference/defaults', { headers: projectHeaders() })
  .then(function(r) { return r.json(); })
  .then(function(d) {
    if (d && d.local) MODEL_DEFAULTS.local = d.local;
    if (d && d.openrouter) MODEL_DEFAULTS.openrouter = d.openrouter;
    if (d && d['openai-compat']) MODEL_DEFAULTS['openai-compat'] = d['openai-compat'];
    renderModelLabel();
  })
  .catch(function() { /* network or backend down — fall back to whatever was loaded */ });

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

function getModelLabel() {
  return (currentSettings.model || MODEL_DEFAULTS[currentSettings.provider || 'local'] || 'LLM');
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
  var wasBusy = busy;
  busy = val;
  sendBtn.style.display = val ? 'none' : '';
  stopBtn.style.display = val ? '' : 'none';
  sendBtn.disabled = val;
  if (wasBusy && !val) playChime();
}

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
        messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Click the gear to pick a provider and model, then start chatting.</div>';
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
      if (currentBubble && tokenCount > 0) {
        var elapsed = (Date.now() - firstTokenTime) / 1000;
        var ttft = (firstTokenTime - streamStart) / 1000;
        var tps = elapsed > 0 ? (tokenCount / elapsed).toFixed(1) : '?';
        var stat = window.document.createElement('div');
        stat.style.cssText = 'color:#6e7681;font-size:10px;margin-top:6px;font-family:monospace;';
        // Append cost + billed-input when the server returned a cost estimate.
        // For local turns cost is $0; for openai-compat (no public rate card)
        // it's null and we surface tokens only.
        var costPart = '';
        if (data.cost && typeof data.cost.total_usd === 'number') {
          var c = data.cost.total_usd;
          var costLabel = c === 0 ? '$0'
            : c < 0.01 ? '<$0.01'
            : c < 1 ? '$' + c.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
            : '$' + c.toFixed(2);
          costPart = ' . ' + costLabel;
        }
        var billedPart = '';
        if (typeof data.promptTokens === 'number' && data.promptTokens > 0) {
          billedPart = ' . ' + data.promptTokens + ' in';
        }
        stat.textContent = tokenCount + ' tok . ' + tps + ' tok/s . ttft ' + ttft.toFixed(2) + 's' + billedPart + costPart;
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
    case 'info':
      // Soft signal from the backend (e.g. "model X not found, fell back to Y"). Render as
      // a subtle inline note without setting busy state.
      var info = window.document.createElement('div');
      info.style.cssText = 'align-self:center;color:#d29922;font-size:11px;font-family:monospace;padding:4px 8px;background:rgba(210,153,34,0.08);border:1px solid rgba(210,153,34,0.25);border-radius:6px;margin:2px 0;';
      info.textContent = data.message || '';
      messagesEl.appendChild(info);
      scrollBottom();
      break;
  }
});

ch.onClose(function() {});

function send() {
  var text = inputEl.value.trim();
  if ((!text && pendingAttachments.length === 0) || busy) return;
  inputEl.value = '';

  var payload = {};
  if (pendingAttachments.length > 0) {
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
    payload.message = text || (hasVideo ? '[video]' : '[image]');
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
  ch.send({ type: 'clear' });
  pendingAttachments = [];
  renderAttachments();
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Click the gear to pick a provider and model, then start chatting.</div>';
});

mica.onDestroy(function() { ch.close(); });

// ── Settings panel ──────────────────────────────────────────────────
//
// Lazy-loaded OpenRouter model catalog so the user can pick from a typeahead
// of available ids when provider=openrouter is selected. Cached in-process so
// open/close doesn't re-fetch; the server also caches.
var openrouterModels = null;
var openrouterFetchInflight = null;

function formatPricePerM(usdPerM) {
  if (typeof usdPerM !== 'number' || !isFinite(usdPerM)) return null;
  if (usdPerM === 0) return '$0';
  if (usdPerM < 0.01) return '$' + usdPerM.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (usdPerM < 1) return '$' + usdPerM.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (usdPerM < 10) return '$' + usdPerM.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + Math.round(usdPerM);
}

function formatContextLen(n) {
  if (typeof n !== 'number' || n <= 0) return null;
  if (n >= 1000000) return (n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M ctx';
  if (n >= 1000) return Math.round(n / 1000) + 'K ctx';
  return n + ' ctx';
}

function formatModelMeta(m) {
  var parts = [];
  var pIn = formatPricePerM(m.promptPerM);
  var pOut = formatPricePerM(m.completionPerM);
  if (m.promptPerM === 0 && m.completionPerM === 0) parts.push('free');
  else if (pIn || pOut) parts.push((pIn || '?') + '/M in · ' + (pOut || '?') + '/M out');
  var ctx = formatContextLen(m.contextLength);
  if (ctx) parts.push(ctx);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function fetchOpenrouterModels() {
  if (openrouterModels !== null) return Promise.resolve(openrouterModels);
  if (openrouterFetchInflight) return openrouterFetchInflight;
  openrouterFetchInflight = fetch('/api/openrouter/models', { headers: projectHeaders() })
    .then(function(r) { return r.ok ? r.json() : { models: [] }; })
    .then(function(j) { openrouterModels = Array.isArray(j.models) ? j.models : []; return openrouterModels; })
    .catch(function() { openrouterModels = []; return openrouterModels; })
    .finally(function() { openrouterFetchInflight = null; });
  return openrouterFetchInflight;
}

function renderModelDropdown(query) {
  if (!Array.isArray(openrouterModels) || openrouterModels.length === 0) {
    settingsModelDropdown.style.display = 'none';
    settingsModelDropdown.innerHTML = '';
    return;
  }
  var q = (query || '').trim().toLowerCase();
  var matches = [];
  for (var i = 0; i < openrouterModels.length; i++) {
    var m = openrouterModels[i];
    var id = m.id || '';
    var idLow = id.toLowerCase();
    var name = m.name || '';
    var nameLow = name.toLowerCase();
    if (!q) { matches.push({ m: m, rank: 0 }); continue; }
    if (idLow.startsWith(q)) matches.push({ m: m, rank: 0 });
    else if (idLow.includes(q)) matches.push({ m: m, rank: 1 });
    else if (nameLow.includes(q)) matches.push({ m: m, rank: 2 });
  }
  if (matches.length === 0) {
    settingsModelDropdown.innerHTML = '<div style="padding:8px;color:#6e7681;font-size:11px;">No matches. The id is still saved as-is — useful for private/preview models.</div>';
    settingsModelDropdown.style.display = 'block';
    return;
  }
  matches.sort(function(a, b) { return a.rank - b.rank || a.m.id.localeCompare(b.m.id); });
  var top = matches.slice(0, 50);
  settingsModelDropdown.innerHTML = '';
  top.forEach(function(entry) {
    var m = entry.m;
    var row = window.document.createElement('div');
    row.className = 'or-model-row';
    row.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.04);';
    row.dataset.modelId = m.id;
    var idEl = window.document.createElement('div');
    idEl.style.cssText = 'color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
    idEl.textContent = m.id;
    row.appendChild(idEl);
    if (m.name && m.name !== m.id) {
      var nameEl = window.document.createElement('div');
      nameEl.style.cssText = 'color:#8b949e;font-size:11px;margin-top:1px;';
      nameEl.textContent = m.name;
      row.appendChild(nameEl);
    }
    var meta = formatModelMeta(m);
    if (meta) {
      var metaEl = window.document.createElement('div');
      metaEl.style.cssText = 'color:#7ec699;font-size:11px;margin-top:1px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
      metaEl.textContent = meta;
      row.appendChild(metaEl);
    }
    row.addEventListener('mouseenter', function() { row.style.background = 'rgba(59,130,246,0.18)'; });
    row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });
    row.addEventListener('mousedown', function(e) {
      e.preventDefault();
      settingsModel.value = m.id;
      hideModelDropdown();
    });
    settingsModelDropdown.appendChild(row);
  });
  if (matches.length > top.length) {
    var more = window.document.createElement('div');
    more.style.cssText = 'padding:6px 8px;color:#6e7681;font-size:11px;';
    more.textContent = '+ ' + (matches.length - top.length) + ' more — refine to narrow.';
    settingsModelDropdown.appendChild(more);
  }
  settingsModelDropdown.style.display = 'block';
}

function hideModelDropdown() {
  settingsModelDropdown.style.display = 'none';
}

function showModelDropdownIfOpenrouter() {
  var provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') { hideModelDropdown(); return; }
  fetchOpenrouterModels().then(function() { renderModelDropdown(settingsModel.value); });
}

settingsModel.addEventListener('focus', showModelDropdownIfOpenrouter);
settingsModel.addEventListener('input', function() {
  var provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') return;
  if (openrouterModels === null) fetchOpenrouterModels().then(function() { renderModelDropdown(settingsModel.value); });
  else renderModelDropdown(settingsModel.value);
});
settingsModel.addEventListener('blur', function() { setTimeout(hideModelDropdown, 120); });

function updateProviderUI(provider) {
  if (provider === 'openrouter') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'none';
    settingsKeyLabel.innerHTML = 'OpenRouter API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = (MODEL_DEFAULTS.openrouter || 'qwen/qwen3.6-35b-a3b') + ' (default)';
    settingsModelHint.textContent = 'Pick from the list or type any OpenRouter model id (e.g. anthropic/claude-sonnet-4.5, openai/gpt-4o).';
    fetchOpenrouterModels();
  } else if (provider === 'openai-compat') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'block';
    settingsKeyLabel.innerHTML = 'API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = (MODEL_DEFAULTS['openai-compat'] || 'gpt-4o-mini') + ' (default)';
    settingsModelHint.textContent = 'Type the model id your endpoint expects (e.g. gpt-4o-mini, mistralai/Mixtral-8x7B-Instruct-v0.1, your-vllm-model-name).';
    hideModelDropdown();
  } else {
    settingsKeyRow.style.display = 'none';
    settingsBaseurlRow.style.display = 'none';
    settingsModel.placeholder = (MODEL_DEFAULTS.local || 'qwen3-vl-local') + ' (default)';
    settingsModelHint.textContent = 'Model name on your local engine. The engine serves whatever it was started with — match that name here.';
    hideModelDropdown();
  }
}

providerRadios.forEach(function(r) {
  r.addEventListener('change', function() { updateProviderUI(r.value); });
});

function openSettings() {
  Promise.allSettled([
    fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openrouter-key', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openai-config', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/inference/defaults', { headers: projectHeaders() }).then(function(r) { return r.json(); })
  ]).then(function(results) {
    var s = results[0].status === 'fulfilled' ? results[0].value : {};
    var k = results[1].status === 'fulfilled' ? results[1].value : { hasKey: false };
    var oc = results[2].status === 'fulfilled' ? results[2].value : { baseUrl: null, hasKey: false };
    var d = results[3].status === 'fulfilled' ? results[3].value : null;
    if (d) {
      if (d.local) MODEL_DEFAULTS.local = d.local;
      if (d.openrouter) MODEL_DEFAULTS.openrouter = d.openrouter;
      if (d['openai-compat']) MODEL_DEFAULTS['openai-compat'] = d['openai-compat'];
    }
    var provider = s.provider || 'local';
    providerRadios.forEach(function(r) { r.checked = (r.value === provider); });
    settingsModel.value = s.model || '';
    settingsKey.value = '';
    settingsBaseurl.value = oc.baseUrl || '';
    var hasKeyForProvider, keyHint;
    if (provider === 'openai-compat') {
      hasKeyForProvider = !!oc.hasKey;
      keyHint = hasKeyForProvider ? 'sk-••••••••••••••••' : 'sk-... (or any token your endpoint expects)';
    } else {
      hasKeyForProvider = !!k.hasKey;
      keyHint = hasKeyForProvider ? 'sk-or-••••••••••••••••' : 'sk-or-...';
    }
    settingsKey.placeholder = keyHint;
    settingsKeyStatus.style.color = '#6e7681';
    settingsModelHint.style.color = '#6e7681';
    settingsKeyStatus.textContent = hasKeyForProvider
      ? 'Key set ✓ — paste a new one to replace, or clear it to remove.'
      : 'No key set yet.';
    updateProviderUI(provider);
    settingsPanel.style.display = 'flex';
    setTimeout(function() {
      (provider === 'openrouter' || provider === 'openai-compat' ? settingsKey : settingsModel).focus();
    }, 0);
  });
}

function closeSettings() { settingsPanel.style.display = 'none'; }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);

settingsSave.addEventListener('click', function() {
  var provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  var model = settingsModel.value.trim();
  var keyValue = settingsKey.value;
  var baseurlValue = settingsBaseurl.value.trim();
  settingsSave.disabled = true;
  settingsSave.textContent = 'Saving...';
  settingsKeyStatus.style.color = '#6e7681';
  settingsModelHint.style.color = '#6e7681';

  if (provider === 'openai-compat' && !baseurlValue) {
    settingsModelHint.textContent = 'Base URL required (e.g., https://api.openai.com/v1).';
    settingsModelHint.style.color = '#f87171';
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
    return;
  }

  var cardP = fetch(settingsUrl(''), {
    method: 'PUT',
    headers: projectHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ provider: provider, model: model })
  }).then(function(r) { return r.json(); });
  var credP;
  if (provider === 'openrouter' && keyValue.length > 0) {
    credP = fetch('/api/openrouter-key', {
      method: 'PUT',
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ key: keyValue })
    }).then(function(r) { return r.json(); });
  } else if (provider === 'openai-compat') {
    var body = { baseUrl: baseurlValue };
    if (keyValue.length > 0) body.key = keyValue;
    credP = fetch('/api/openai-config', {
      method: 'PUT',
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body)
    }).then(function(r) { return r.json(); });
  } else {
    credP = Promise.resolve(null);
  }
  Promise.all([cardP, credP]).then(function() {
    currentSettings = { provider: provider, model: model };
    renderModelLabel();
    closeSettings();
  }).catch(function(err) {
    settingsModelHint.textContent = 'Save failed: ' + (err && err.message ? err.message : 'unknown error');
    settingsModelHint.style.color = '#f87171';
  }).finally(function() {
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
  });
});
