// Chat card — Qwen Agent agentic coding assistant
// container and mica are provided by CARD_SHIM

const messagesEl = container.querySelector("#chat-messages");
const inputEl = container.querySelector("#chat-input");
const sendBtn = container.querySelector("#chat-send");
const stopBtn = container.querySelector("#chat-stop");
const statusBar = container.querySelector("#chat-statusbar");
const statusMain = container.querySelector("#chat-status-main");
const statusDot = container.querySelector("#chat-dot");
const statusLabel = container.querySelector("#chat-status-label");
const statusMeta = container.querySelector("#chat-status-meta");
const statusToggle = container.querySelector("#chat-status-toggle");
const statusDetail = container.querySelector("#chat-status-detail");

let detailExpanded = false;
const ACCENT = "#7c3aed";
let busy = false;
let queuedCount = 0;  // user messages typed during busy — server queues them
let elapsedSec = 0;
let elapsedTimer = null;
let stepCount = 0;

// Toggle the busy flag AND a .wb-card--busy class on the outer card wrapper.
// The class drives the "breathing" halo defined in whiteboard.css; card classes
// opt in by calling this helper, no React changes needed. Uses closest() to
// climb out of the card's own DOM up to the React-managed .wb-card element.
function setBusy(b) {
  busy = b;
  const card = container.closest('.wb-card');
  if (card) card.classList.toggle('wb-card--busy', b);
}

// Toggle detail panel
statusMain.addEventListener("click", function(e) {
  e.stopPropagation();
  detailExpanded = !detailExpanded;
  statusDetail.style.display = detailExpanded ? "block" : "none";
  statusToggle.innerHTML = detailExpanded ? "&#9650;" : "&#9660;";
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
});

function addDetailLine(text) {
  const line = window.document.createElement("div");
  line.style.cssText = "padding:1px 0;border-bottom:1px solid rgba(48,54,61,0.3);";
  line.textContent = text;
  statusDetail.appendChild(line);
  while (statusDetail.children.length > 200) statusDetail.removeChild(statusDetail.firstChild);
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
}

// Open channel to server agent
const ch = mica.openChannel("agent_session");

// Poll LLM server status until ready, show progress in input placeholder
var startupSummaryShown = false;
function showStartupSummaryQwen(text) {
  if (startupSummaryShown || !text) return;
  startupSummaryShown = true;
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
    messagesEl.innerHTML = '';
  }
  var el = window.document.createElement('div');
  el.style.cssText = 'align-self:center;color:#6e7681;font-size:11px;font-family:monospace;padding:6px 10px;background:rgba(124,58,237,0.06);border:1px solid rgba(124,58,237,0.2);border-radius:6px;margin:4px 0;';
  el.textContent = '✓ ' + text;
  messagesEl.appendChild(el);
  scrollBottom();
}
// Top-bar model/provider label (truncated via CSS). Updated whenever settings load,
// status polls return, or save fires. For local provider we prefer the model the
// llama-server is actually serving (from /api/llm/status) over any override in
// this card's settings — the override takes effect inside llama-server's routing
// but the served model is the source of truth the user cares about.
var modelLabelEl = container.querySelector('#chat-model-label');
var serverModel = '';  // populated from /api/llm/status
function renderModelLabel() {
  var provider = currentSettings.provider || 'local';
  var providerShort = provider === 'openrouter' ? 'OpenRouter' : 'Local';
  var model = provider === 'openrouter'
    ? (currentSettings.model || '')
    : (serverModel || currentSettings.model || '');
  var display = model ? providerShort + ' · ' + model : providerShort;
  modelLabelEl.textContent = display;
  modelLabelEl.title = display;  // full text on hover (the CSS ellipsis hides the tail)
}

function checkLlmStatus() {
  // Skip llama-server status polling for OpenRouter cards — the local server
  // is irrelevant to them, so don't show "Model loading..." or block Send.
  if (currentSettings.provider === 'openrouter') {
    sendBtn.disabled = false;
    inputEl.placeholder = 'Ask Qwen Agent...';
    return;
  }
  fetch('/api/llm/status').then(function(r) { return r.json(); }).then(function(s) {
    if (s.model && s.model !== serverModel) { serverModel = s.model; renderModelLabel(); }
    if (s.ready) {
      sendBtn.disabled = false;
      inputEl.placeholder = 'Ask Qwen Agent...';
      if (s.startupSummary) showStartupSummaryQwen(s.startupSummary);
    } else {
      sendBtn.disabled = true;
      inputEl.placeholder = s.progress || 'Model loading...';
      setTimeout(checkLlmStatus, 3000);
    }
  }).catch(function() { setTimeout(checkLlmStatus, 5000); });
}

// Load this card's settings before first status check so we know which
// provider to poll against. Defaults to local on any failure.
var currentSettings = { provider: 'local', model: '' };
function settingsUrl(qs) {
  var sep = qs.indexOf('?') === -1 ? '?' : '&';
  return '/api/cards/settings' + qs + sep + 'path=' + encodeURIComponent(mica.filename);
}
fetch(settingsUrl('')).then(function(r) { return r.json(); }).then(function(s) {
  currentSettings = { provider: s.provider || 'local', model: s.model || '' };
}).catch(function() { /* defaults */ }).finally(function() {
  renderModelLabel();
  checkLlmStatus();
});

function scrollBottom() {
  requestAnimationFrame(function() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function escapeHtml(s) {
  const d = window.document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function renderMarkdown(text) {
  text = text.replace(/^```markdown\n([\s\S]*?)```$/gm, function(m, inner) { return inner; });

  // Extract fenced code blocks
  const fenced = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    fenced.push(`<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0"><code style="font-size:12px;font-family:monospace">${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`);
    return `__FENCED__${fenced.length - 1}__`;
  });

  // Extract tables (consecutive lines starting with |)
  const tables = [];
  text = text.replace(/(^\|.+\|\n?)+/gm, function(block) {
    const rows = block.trim().split("\n");
    let html = '<table style="border-collapse:collapse;margin:6px 0;font-size:12px;width:100%">';
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri].trim();
      if (/^\|[\s-:|]+\|$/.test(row)) continue; // skip separator row
      const cells = row.split("|").filter(function(c, i, a) { return i > 0 && i < a.length - 1; });
      const tag = ri === 0 ? "th" : "td";
      html += "<tr>";
      for (let ci = 0; ci < cells.length; ci++) {
        const style = tag === "th" ? "background:rgba(255,255,255,0.05);font-weight:600;" : "";
        html += `<${tag} style="border:1px solid #333;padding:4px 8px;${style}">${cells[ci].trim()}</${tag}>`;
      }
      html += "</tr>";
    }
    html += "</table>";
    tables.push(html);
    return `__TABLE__${tables.length - 1}__`;
  });

  text = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");

  // Wrap consecutive <li> runs in <ul> so browsers render bullet markers
  // inside the content box (otherwise markers leak outside the chat bubble).
  text = text.replace(/(?:<li>[\s\S]*?<\/li>(?:<br\/>)?)+/g, (m) => {
    return "<ul>" + m.replace(/<br\/>/g, "") + "</ul>";
  });

  // Restore fenced blocks and tables
  for (let fi = 0; fi < fenced.length; fi++) {
    text = text.replace(`__FENCED__${fi}__`, fenced[fi]);
  }
  for (let ti = 0; ti < tables.length; ti++) {
    text = text.replace(`__TABLE__${ti}__`, tables[ti]);
  }
  return text;
}

function addMessage(role, content, agent, questions) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  const msg = window.document.createElement("div");
  if (role === "user") {
    msg.style.cssText = "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";
    msg.innerHTML = `<div style="color:#e6edf3;font-size:13px;line-height:1.5;">${escapeHtml(content)}</div>`;
  } else {
    msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
    const header = agent ? `<div style="color:${ACCENT};font-size:11px;font-weight:600;margin-bottom:4px;">${escapeHtml(agent)}</div>` : "";
    msg.innerHTML = `${header}<div class="chat-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">${renderMarkdown(content)}</div>`;
    if (questions && questions.length > 0) {
      const buttonRows = window.document.createElement("div");
      buttonRows.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:10px;";
      for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        if (!q.options || q.options.length === 0) continue;
        const row = window.document.createElement("div");
        row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
        for (let oi = 0; oi < q.options.length; oi++) {
          const opt = q.options[oi];
          const btn = window.document.createElement("button");
          btn.textContent = opt.label;
          btn.title = opt.description || opt.label;
          btn.style.cssText = "background:rgba(124,58,237,0.15);color:#e6edf3;border:1px solid rgba(124,58,237,0.4);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;";
          btn.addEventListener("mouseenter", function() { btn.style.background = "rgba(124,58,237,0.3)"; });
          btn.addEventListener("mouseleave", function() { btn.style.background = "rgba(124,58,237,0.15)"; });
          btn.addEventListener("click", function() {
            // Disable the entire button row to prevent double-answers; the user's choice
            // gets sent immediately as a normal message so the agent sees it as their reply.
            const rowButtons = buttonRows.querySelectorAll("button");
            for (let i = 0; i < rowButtons.length; i++) {
              rowButtons[i].disabled = true;
              rowButtons[i].style.opacity = "0.4";
              rowButtons[i].style.cursor = "default";
            }
            btn.style.background = "rgba(124,58,237,0.5)";
            inputEl.value = opt.label;
            send();
          });
          row.appendChild(btn);
        }
        buttonRows.appendChild(row);
      }
      msg.appendChild(buttonRows);
    }
  }
  messagesEl.appendChild(msg);
  scrollBottom();
}

function setStatus(text, dot, pulsing) {
  statusBar.style.display = "block";
  statusDot.style.background = dot;
  statusDot.style.animation = pulsing ? "chatpulse 1.2s ease-in-out infinite" : "none";
  statusLabel.textContent = text;
}

function updateMeta() {
  const parts = [];
  if (elapsedSec > 0) parts.push(elapsedSec + "s");
  if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
  statusMeta.textContent = parts.join(" . ");
}

// Two-note chime played when the agent finishes a turn. Browsers require a
// user gesture before audio can start; the user's first Send click satisfies
// that, so chimes from then on play fine. Errors silently no-op (audio
// unavailable, autoplay blocked, etc.).
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const now = ac.currentTime;
    [880, 1320].forEach(function(freq, i) {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + i * 0.08;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
      osc.connect(gain).connect(ac.destination);
      osc.start(t0);
      osc.stop(t0 + 0.5);
    });
    setTimeout(function() { try { ac.close(); } catch (_) {} }, 1000);
  } catch (_) { /* audio unavailable */ }
}

// Handle channel data from server
ch.onData(function(data) {
  switch (data.type) {
    case "history":
      messagesEl.innerHTML = "";
      if (data.messages && data.messages.length > 0) {
        for (let i = 0; i < data.messages.length; i++) {
          addMessage(data.messages[i].role, data.messages[i].content, data.messages[i].agent);
        }
      } else {
        messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start the Qwen Code agent.</div>';
      }
      setStatus("Ready", "#3fb950", false);
      break;
    case "user":
      addMessage("user", data.content);
      break;
    case "thinking":
      setBusy(true);
      // One queued message just started processing; decrement.
      if (queuedCount > 0) queuedCount--;
      updateSendButton();
      // Keep send button visible/clickable so user can queue more.
      stopBtn.style.display = "";
      stepCount = 0;
      elapsedSec = 0;
      statusDetail.innerHTML = "";
      addDetailLine("Starting...");
      setStatus("Thinking...", ACCENT, true);
      elapsedTimer = setInterval(function() { elapsedSec++; updateMeta(); }, 1000);
      break;
    case "progress":
      if (data.description) {
        stepCount++;
        setStatus(data.description, ACCENT, true);
        updateMeta();
        addDetailLine(`[${stepCount}] ${data.description}`);
      }
      break;
    case "assistant":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(doneMsg, "#3fb950", false);
      // Final stats go on the RIGHT (statusMeta), replacing the live "Xs · N steps"
      // that was ticking there during the turn. Append tokens + tok/s when the
      // server forwarded usage; skip silently on tool-only turns / errors /
      // "No action needed" paths that lack usage.
      {
        const parts = [];
        if (elapsedSec > 0) parts.push(elapsedSec + "s");
        if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
        const outTok = data.usage && (data.usage.output_tokens || data.usage.completion_tokens);
        if (outTok && outTok > 0) {
          const tps = Math.round(outTok / Math.max(1, elapsedSec));
          parts.push(outTok + " tok");
          parts.push(tps + " tok/s");
        }
        statusMeta.textContent = parts.join(" · ");
        addDetailLine("Completed: " + parts.join(" · "));
      }
      addMessage("assistant", data.content, data.agent || "Qwen", data.questions);
      playChime();
      break;
    case "error":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      setStatus("Error", "#f87171", false);
      addDetailLine("ERROR: " + (data.error || "Unknown"));
      addMessage("assistant", "Error: " + (data.error || "Unknown"), "System");
      break;
  }
});

ch.onClose(function() {});

function send() {
  const text = inputEl.value.trim();
  if (!text) return;
  inputEl.value = "";
  // Server queues if busy — let the user keep typing while the agent works.
  if (busy) {
    queuedCount++;
    addDetailLine(`Queued: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
  }
  ch.send({ message: text });
  updateSendButton();
}

function updateSendButton() {
  sendBtn.textContent = queuedCount > 0 ? `Send (${queuedCount} queued)` : "Send";
}

sendBtn.addEventListener("click", send);

stopBtn.addEventListener("click", function() {
  ch.send({ type: "interrupt" });
  setBusy(false);
  stopBtn.style.display = "none";
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatus("Stopped", "#fbbf24", false);
});

inputEl.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// Context tooltip
const ctxBtn = container.querySelector("#chat-ctx-btn");
const ctxTooltip = container.querySelector("#chat-context-tooltip");
const ctxFiles = container.querySelector("#chat-context-files");
let ctxVisible = false;
let ctxLoaded = false;

function formatSize(chars) {
  if (chars < 1024) return chars + " chars";
  return (chars / 1024).toFixed(1) + "K chars";
}

function loadContextInfo() {
  fetch("/api/files").then(function(r) { return r.json(); }).then(function(files) {
    const lines = [];
    let totalChars = 0;
    for (let i = 0; i < files.length; i++) {
      const size = files[i].size || 0;
      totalChars += size;
      lines.push(files[i].name + "  " + formatSize(size));
    }
    let canvasBackLine = "";
    fetch("/api/canvas-back").then(function(r) { return r.json(); }).then(function(data) {
      const cbSize = (data.content || "").length;
      if (cbSize > 0) {
        totalChars += cbSize;
        canvasBackLine = "canvas-back.md  " + formatSize(cbSize) + "\n";
      }
      ctxFiles.innerHTML =
        `<div style="color:#4ade80;margin-bottom:4px">${files.length} files, ~${formatSize(totalChars)} total (~${Math.round(totalChars / 4)} tokens)</div>` +
        (canvasBackLine ? `<div>${canvasBackLine}</div>` : "") +
        lines.map(function(l) { return `<div>${l}</div>`; }).join("");
      ctxLoaded = true;
    }).catch(function() {
      ctxFiles.innerHTML = lines.map(function(l) { return `<div>${l}</div>`; }).join("");
      ctxLoaded = true;
    });
  }).catch(function() { ctxFiles.textContent = "Failed to load"; });
}

ctxBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  ctxVisible = !ctxVisible;
  ctxTooltip.style.display = ctxVisible ? "block" : "none";
  if (ctxVisible && !ctxLoaded) loadContextInfo();
});

ctxBtn.addEventListener("mouseenter", function() {
  if (!ctxVisible) {
    ctxTooltip.style.display = "block";
    if (!ctxLoaded) loadContextInfo();
  }
});

ctxBtn.addEventListener("mouseleave", function() {
  if (!ctxVisible) ctxTooltip.style.display = "none";
});

// ── Settings panel ─────────────────────────────────────────
//
// Per-card provider/model config + per-project OpenRouter API key. The key
// is project-scoped so it's typed once across all chat cards in this project;
// provider/model is per-card so different cards can run different models.
const settingsBtn = container.querySelector('#chat-settings-btn');
const settingsPanel = container.querySelector('#chat-settings-panel');
const settingsClose = container.querySelector('#chat-settings-close');
const settingsCancel = container.querySelector('#chat-settings-cancel');
const settingsSave = container.querySelector('#chat-settings-save');
const settingsModel = container.querySelector('#chat-settings-model');
const settingsModelHint = container.querySelector('#chat-settings-model-hint');
const settingsKeyRow = container.querySelector('#chat-settings-key-row');
const settingsKey = container.querySelector('#chat-settings-key');
const settingsKeyStatus = container.querySelector('#chat-settings-key-status');
const providerRadios = container.querySelectorAll('input[name="chat-provider"]');

const MODEL_DEFAULTS = {
  local: 'openai:local',
  openrouter: 'anthropic/claude-3.5-sonnet'
};

function updateProviderUI(provider) {
  if (provider === 'openrouter') {
    settingsKeyRow.style.display = 'block';
    settingsModel.placeholder = MODEL_DEFAULTS.openrouter + ' (default)';
    settingsModelHint.textContent = 'Any OpenRouter model id, e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o';
  } else {
    settingsKeyRow.style.display = 'none';
    settingsModel.placeholder = MODEL_DEFAULTS.local + ' (default)';
    settingsModelHint.textContent = 'For local llama-server the model name is informational; the loaded model is whatever the server started with.';
  }
}

providerRadios.forEach(function(r) {
  r.addEventListener('change', function() { updateProviderUI(r.value); });
});

function openSettings() {
  // Pull fresh state every time so opening the panel after another tab saved
  // shows the current values, not a stale snapshot.
  Promise.allSettled([
    fetch(settingsUrl('')).then(function(r) { return r.json(); }),
    fetch('/api/openrouter-key').then(function(r) { return r.json(); })
  ]).then(function(results) {
    const s = results[0].status === 'fulfilled' ? results[0].value : {};
    const k = results[1].status === 'fulfilled' ? results[1].value : { hasKey: false };
    const provider = s.provider || 'local';
    providerRadios.forEach(function(r) { r.checked = (r.value === provider); });
    settingsModel.value = s.model || '';
    settingsKey.value = '';
    // Swap the input placeholder so the user can tell at a glance whether a
    // key is already stored. Leaving the field blank on save keeps the existing
    // key (see save handler), so the masked placeholder is purely visual.
    settingsKey.placeholder = k.hasKey ? 'sk-or-••••••••••••••••' : 'sk-or-...';
    settingsKeyStatus.style.color = '#6e7681';
    settingsModelHint.style.color = '#6e7681';
    settingsKeyStatus.textContent = k.hasKey
      ? 'Key set ✓ — paste a new one to replace, or clear it to remove.'
      : 'No key set yet.';
    updateProviderUI(provider);
    settingsPanel.style.display = 'block';
    setTimeout(function() {
      (provider === 'openrouter' ? settingsKey : settingsModel).focus();
    }, 0);
  });
}

function closeSettings() { settingsPanel.style.display = 'none'; }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);

settingsSave.addEventListener('click', function() {
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  const model = settingsModel.value.trim();
  const keyValue = settingsKey.value;  // do NOT trim — leading/trailing whitespace in a key is the user's problem to fix, but we preserve the field exactly
  settingsSave.disabled = true;
  settingsSave.textContent = 'Saving...';

  // Clear any stale error styling from a previous attempt.
  settingsKeyStatus.style.color = '#6e7681';
  settingsModelHint.style.color = '#6e7681';

  // For OpenRouter, validate the (key, model) pair with openrouter.ai BEFORE
  // saving anything. If either is rejected we keep the panel open and surface
  // the specific error next to the offending field. Local provider skips this.
  const needsValidation = provider === 'openrouter' && (keyValue.length > 0 || model.length > 0);
  const validateP = needsValidation
    ? fetch('/api/openrouter/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyValue, model: model })
      }).then(function(r) { return r.json(); })
    : Promise.resolve({ ok: true, errors: {} });

  validateP.then(function(v) {
    const errors = v.errors || {};
    if (errors.key) {
      settingsKeyStatus.textContent = errors.key;
      settingsKeyStatus.style.color = '#f87171';
    }
    if (errors.model) {
      settingsModelHint.textContent = errors.model;
      settingsModelHint.style.color = '#f87171';
    }
    if (!v.ok) { var e = new Error('validation failed'); e.validationFailure = true; throw e; }

    // Both valid (or network-unverified) — proceed with the two saves in parallel.
    const cardP = fetch(settingsUrl(''), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: provider, model: model })
    }).then(function(r) { return r.json(); });
    const keyP = keyValue.length > 0
      ? fetch('/api/openrouter-key', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: keyValue })
        }).then(function(r) { return r.json(); })
      : Promise.resolve(null);
    return Promise.all([cardP, keyP]).then(function() {
      return { warning: v.warning };  // forward any "couldn't verify" warning to the toast
    });
  }).then(function(meta) {
    currentSettings = { provider: provider, model: model };
    renderModelLabel();
    closeSettings();
    const saveMsg = meta && meta.warning ? 'Saved. ' + meta.warning : 'Settings saved.';
    statusLabel.textContent = saveMsg;
    statusBar.style.display = 'block';
    statusDot.style.background = meta && meta.warning ? '#d29922' : '#4ade80';
    setTimeout(function() {
      if (statusLabel.textContent === saveMsg) statusBar.style.display = 'none';
    }, 3000);
  }).catch(function(err) {
    // Stay on the settings panel when validation fails — the field-level errors
    // were already rendered above. For other errors surface a generic message.
    if (!err || !err.validationFailure) {
      settingsKeyStatus.textContent = 'Save failed: ' + (err && err.message ? err.message : 'unknown error');
      settingsKeyStatus.style.color = '#f87171';
    }
  }).finally(function() {
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
  });
});

mica.onDestroy(function() {
  ch.close();
  if (elapsedTimer) clearInterval(elapsedTimer);
});
