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
// Context meter + Clear/Spawn/Archive header actions
const ctxMeterEl = container.querySelector("#chat-ctx-meter");
const ctxMeterFill = container.querySelector("#chat-ctx-meter-fill");
const ctxMeterLabel = container.querySelector("#chat-ctx-meter-label");
const clearBtn = container.querySelector("#chat-clear-btn");
const spawnBtn = container.querySelector("#chat-spawn-btn");
const archiveBtn = container.querySelector("#chat-archive-btn");
const archivePanel = container.querySelector("#chat-archive-panel");
const archiveListEl = container.querySelector("#chat-archive-list");

let detailExpanded = false;
const ACCENT = "#7c3aed";
let busy = false;
let queuedCount = 0;  // user messages typed during busy — server queues them
let elapsedSec = 0;
let elapsedTimer = null;
let stepCount = 0;

// Context cursor. Messages at indices [0, cursor) are history the user can
// still scroll through, but the agent does NOT see them on the next turn.
// Server persists the cursor; UI renders a horizon marker at this position.
let contextCursor = 0;
// Message index counter tracking where the NEXT appended message will land.
// Used to decide whether to render the horizon marker above the new message.
let messageIndex = 0;
// Last capacity / context-window reported by server. Used by the overflow
// prompt heuristics at turn-end.
let lastCapacity = 0;

// Toggle the busy flag AND a .wb-card--busy class on the outer card wrapper.
// The class drives the "breathing" halo defined in whiteboard.css; card classes
// opt in by calling this helper, no React changes needed. Uses closest() to
// climb out of the card's own DOM up to the React-managed .wb-card element.
//
// Rings the completion chime on ANY busy→idle transition so every code path
// that ends a turn (assistant, error, interrupt, empty-response, future
// additions) is covered by a single hook. Previously we put playChime() at
// each "done" branch, which meant any new branch silently missed the chime.
function setBusy(b) {
  const wasBusy = busy;
  busy = b;
  const card = container.closest('.wb-card');
  if (card) card.classList.toggle('wb-card--busy', b);
  if (wasBusy && !b) playChime();
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

// Headers that scope /api/* calls to THIS card's project. Every server
// handler reads project from `X-Mica-Project` (or `?project=` query). Without
// this header the server can't tell two projects' chat cards apart — they
// collide on workspace-level state (card settings, openrouter key).
function projectHeaders(extra) {
  var h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
  if (extra) for (var k in extra) h[k] = extra[k];
  return h;
}

// Load this card's settings before first status check so we know which
// provider to poll against. Defaults to local on any failure.
var currentSettings = { provider: 'local', model: '' };
function settingsUrl(qs) {
  var sep = qs.indexOf('?') === -1 ? '?' : '&';
  return '/api/cards/settings' + qs + sep + 'path=' + encodeURIComponent(mica.filename);
}
fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }).then(function(s) {
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

// Render a faint horizon line when the next appended message crosses the
// cursor boundary. Shows the user where the agent's visible history begins.
function maybeRenderHorizon() {
  if (contextCursor > 0 && messageIndex === contextCursor) {
    const horizon = window.document.createElement("div");
    horizon.className = "chat-horizon";
    horizon.style.cssText =
      "align-self:stretch;display:flex;align-items:center;gap:8px;color:#6e7681;" +
      "font-size:10px;font-family:monospace;margin:6px 0;opacity:0.7;";
    horizon.innerHTML =
      '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>' +
      '<span style="flex-shrink:0;">↑ earlier conversation (not in agent context)</span>' +
      '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>';
    messagesEl.appendChild(horizon);
  }
}

function addMessage(role, content, agent, questions) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  maybeRenderHorizon();
  const msg = window.document.createElement("div");
  // Greyscale messages above the cursor — they exist for user reference but
  // the agent doesn't see them.
  const aboveHorizon = messageIndex < contextCursor;
  if (aboveHorizon) msg.style.opacity = "0.55";
  messageIndex++;
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

// Render an error bubble for a card-error WebSocket event. Distinct red-tinted
// styling so it's not mistaken for a regular assistant message. The "Send to
// agent" button feeds a structured fix-request through the normal send() path.
function addErrorBubble(filename, errorText) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  const wrap = window.document.createElement("div");
  wrap.style.cssText = "align-self:stretch;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.4);border-radius:8px;padding:8px 10px;font-size:12px;";
  const header = window.document.createElement("div");
  header.style.cssText = "color:#fca5a5;font-weight:600;margin-bottom:4px;";
  header.textContent = "\u26A0 Card '" + filename + "' errored";
  const pre = window.document.createElement("pre");
  pre.style.cssText = "background:rgba(0,0,0,0.3);color:#fecaca;padding:6px 8px;border-radius:4px;margin:4px 0 8px;font-family:monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;";
  pre.textContent = errorText;
  const btn = window.document.createElement("button");
  btn.textContent = "Send to agent";
  btn.style.cssText = "background:rgba(248,113,113,0.18);color:#fecaca;border:1px solid rgba(248,113,113,0.5);border-radius:4px;padding:4px 12px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;";
  btn.addEventListener("mouseenter", function() { btn.style.background = "rgba(248,113,113,0.32)"; });
  btn.addEventListener("mouseleave", function() { btn.style.background = "rgba(248,113,113,0.18)"; });
  btn.addEventListener("click", function() {
    btn.disabled = true;
    btn.style.opacity = "0.4";
    btn.style.cursor = "default";
    btn.textContent = "Sent";
    inputEl.value =
      "The card `" + filename + "` errored at runtime:\n\n```\n" + errorText + "\n```\n\n" +
      "Read the card class files for this card, identify the cause, and fix it. " +
      "After applying the fix the card will reload — verify the error is gone.";
    send();
  });
  wrap.appendChild(header);
  wrap.appendChild(pre);
  wrap.appendChild(btn);
  messagesEl.appendChild(wrap);
  scrollBottom();
}

// De-dup card-error events: CARD_SHIM's setInterval / event-handler wrappers
// can fire the same throw N times in a tight burst; one bubble per (filename,
// error) per 2s is plenty.
const _recentCardErrors = new Map();  // key → timestamp
const _CARD_ERROR_DEDUP_MS = 2000;

const _unsubCardError = mica.on("card-error", function(ev) {
  if (!ev || !ev.filename || !ev.error) return;
  // Skip self — the chat card showing its own error risks loops if Send-to-agent
  // re-triggers the same throw, and is confusing UX. Server still logs it.
  if (ev.filename === mica.filename) return;
  const key = ev.filename + "::" + ev.error;
  const now = Date.now();
  const last = _recentCardErrors.get(key);
  if (last && now - last < _CARD_ERROR_DEDUP_MS) return;
  _recentCardErrors.set(key, now);
  // Trim the dedup map so it doesn't grow unbounded over a long session.
  if (_recentCardErrors.size > 200) {
    const cutoff = now - _CARD_ERROR_DEDUP_MS;
    for (const [k, t] of _recentCardErrors) if (t < cutoff) _recentCardErrors.delete(k);
  }
  addErrorBubble(ev.filename, ev.error);
});
mica.onDestroy(_unsubCardError);

function setStatus(text, dot, pulsing) {
  statusBar.style.display = "block";
  statusDot.style.background = dot;
  statusDot.style.animation = pulsing ? "chatpulse 1.2s ease-in-out infinite" : "none";
  statusLabel.textContent = text;
}

// Format elapsed seconds: raw seconds up to 59 ("42s"), h:m:s above a minute
// so long-running turns (3-minute card builds, multi-minute OpenRouter calls)
// stay readable. Drops the hours segment when it's zero.
function formatDuration(s) {
  if (s < 60) return s + "s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return h > 0
    ? h + ":" + pad(m) + ":" + pad(sec)
    : m + ":" + pad(sec);
}

function updateMeta() {
  const parts = [];
  if (elapsedSec > 0) parts.push(formatDuration(elapsedSec));
  if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
  statusMeta.textContent = parts.join(" . ");
}

// Two-note chime played when a turn finishes (success or error — the user
// wants to know "the agent is done", regardless of outcome). One AudioContext
// per card, lazily created. Browser autoplay policy: a fresh context is
// "suspended" until a user gesture; resume() (kicked here on every chime)
// flips it to "running" the moment a gesture has occurred. The first chime
// after page load is silent unless Send has been clicked at least once —
// that click is the gesture.
let _audioCtx = null;
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { console.warn("[chime] AudioContext not supported"); return; }
    if (!_audioCtx) _audioCtx = new Ctx();
    const ac = _audioCtx;
    console.log("[chime] state=" + ac.state);
    const fire = function() {
      console.log("[chime] firing oscillators, currentTime=" + ac.currentTime);
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
    };
    if (ac.state === "suspended") {
      ac.resume().then(function() { console.log("[chime] resumed → state=" + ac.state); fire(); }).catch(function(e) { console.warn("[chime] resume rejected:", e); });
    } else {
      fire();
    }
  } catch (e) { console.warn("[chime] threw:", e); }
}

// Update the context meter (fill width + color + label). Called on every
// assistant turn (server broadcasts baselineTokens + contextWindow). Green
// < 50%, amber 50–85%, red > 85%.
function updateCtxMeter(baselineTokens, contextWindow) {
  if (!baselineTokens || !contextWindow || contextWindow <= 0) {
    ctxMeterEl.style.display = "none";
    return;
  }
  ctxMeterEl.style.display = "inline-flex";
  const pct = Math.max(0, Math.min(100, Math.round((baselineTokens / contextWindow) * 100)));
  ctxMeterFill.style.width = pct + "%";
  let color = "#4ade80";       // green — comfortable
  if (pct >= 85) color = "#f87171";
  else if (pct >= 50) color = "#fbbf24";
  ctxMeterFill.style.background = color;
  ctxMeterLabel.textContent = pct + "%";
  ctxMeterLabel.title =
    "Next turn's baseline prompt: " + formatK(baselineTokens) + " / " + formatK(contextWindow) +
    " (" + pct + "% of context window)";
}

// Inline suggestion card offering Clear / Spawn buttons. Rendered after an
// arc-complete turn that hit >80% capacity or an overflow event. The user's
// choice runs the corresponding action via the same send path as the header
// buttons.
function addContextSuggestion(text, opts) {
  opts = opts || {};
  const wrap = window.document.createElement("div");
  wrap.className = "chat-suggestion";
  wrap.style.cssText =
    "align-self:stretch;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.35);" +
    "border-radius:8px;padding:10px 12px;font-size:12px;color:#cdd6f4;";
  const msg = window.document.createElement("div");
  msg.style.cssText = "margin-bottom:8px;line-height:1.4;";
  msg.textContent = text;
  wrap.appendChild(msg);

  const row = window.document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
  const mkBtn = function(label, primary, onClick) {
    const b = window.document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "background:" + (primary ? "#7c3aed" : "transparent") + ";color:#fff;" +
      "border:1px solid " + (primary ? "#7c3aed" : "#30363d") + ";" +
      "border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;";
    b.addEventListener("click", function() {
      const siblings = row.querySelectorAll("button");
      for (let i = 0; i < siblings.length; i++) {
        siblings[i].disabled = true;
        siblings[i].style.opacity = "0.4";
        siblings[i].style.cursor = "default";
      }
      onClick();
    });
    return b;
  };
  row.appendChild(mkBtn("Clear this card", true, function() { clearCard({ fromSuggestion: true }); }));
  row.appendChild(mkBtn("Spawn new card", false, function() { spawnSiblingCard(); }));
  if (!opts.forceChoice) {
    row.appendChild(mkBtn("Keep going", false, function() { /* no-op — dismissed inline */ }));
  }
  wrap.appendChild(row);
  messagesEl.appendChild(wrap);
  scrollBottom();
}

// Handle channel data from server
ch.onData(function(data) {
  switch (data.type) {
    case "history":
      messagesEl.innerHTML = "";
      contextCursor = typeof data.cursor === "number" ? data.cursor : 0;
      messageIndex = 0;
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
    case "user_question": {
      // Mid-turn structured question with clickable options. Renders an
      // assistant-styled bubble with the question text + button row. Server
      // broadcasts this immediately when the agent calls ask_user_question,
      // decoupled from the turn-end assistant event — so the question
      // surfaces even if the agent misinterprets the deny message and
      // continues running tools. Click → fills input + sends as normal
      // user reply.
      const qs = data.questions || [];
      const content = qs.map(function(q) { return "**" + (q.question || "") + "**"; }).join("\n\n");
      addMessage("assistant", content, "Qwen", qs);
      break;
    }
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
      // Advance cursor locally if the server moved it at this turn. The user
      // already sees their messages and the new assistant turn below; we
      // don't re-render. The horizon marker will show on the NEXT appended
      // message because messageIndex may now be < contextCursor.
      if (typeof data.cursor === "number") contextCursor = data.cursor;
      updateCtxMeter(data.baselineTokens || 0, data.contextWindow || 0);
      lastCapacity = typeof data.capacity === "number" ? data.capacity : 0;
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(doneMsg, "#3fb950", false);
      // Final stats go on the RIGHT (statusMeta), replacing the live
      // "Xs · N steps" ticker. The SDK accumulates usage across every LLM
      // call in the turn (20 tool rounds → 20 prompt sends summed together),
      // so input_tokens is NOT "current context size" — it's cumulative
      // tokens shipped this turn. We report it as "sent XK" so users aren't
      // misled into thinking they're over the model's context window.
      {
        const parts = [];
        if (elapsedSec > 0) parts.push(formatDuration(elapsedSec));
        if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
        const usage = data.usage || {};
        const outTok = usage.output_tokens || usage.completion_tokens;
        if (outTok && outTok > 0) {
          const tps = Math.round(outTok / Math.max(1, elapsedSec));
          parts.push("out " + formatK(outTok) + " tok");
          parts.push(tps + " tok/s");
        }
        const inTok = usage.input_tokens || usage.prompt_tokens;
        if (inTok && inTok > 0) {
          parts.push("sent " + formatK(inTok) + " tok");
        }
        // Baseline prompt size going into next turn's first LLM call — this
        // IS comparable to contextWindow (single-call, not cumulative).
        // Shows how much context you're starting with + headroom before the
        // tool-loop accumulation that exceeded 65K before auto-compress.
        if (data.baselineTokens && data.contextWindow && data.contextWindow > 0) {
          const pct = Math.round((data.baselineTokens / data.contextWindow) * 100);
          parts.push("next " + formatK(data.baselineTokens) + "/" + formatK(data.contextWindow) + " (" + pct + "%)");
        }
        // Cache hit: only meaningful for providers that return it (OpenRouter
        // does, local llama-server doesn't). Suppress when zero or missing.
        const cacheRead = usage.cache_read_input_tokens;
        if (cacheRead && inTok && cacheRead > 0) {
          const hit = Math.round((cacheRead / inTok) * 100);
          if (hit > 0) parts.push("cache " + hit + "%");
        }
        statusMeta.textContent = parts.join(" · ");
        addDetailLine("Completed: " + parts.join(" · "));
      }
      addMessage("assistant", data.content, data.agent || "Qwen", data.questions);
      // Proactive Clear/Spawn suggestion at natural arc breaks when the
      // conversation is getting long. Green zone (<50%) never suggests; amber
      // with arc-complete shows a soft nudge; red always surfaces the choice.
      if (data.arcComplete && lastCapacity >= 0.80) {
        addContextSuggestion(
          "Arc complete. This conversation is at " + Math.round(lastCapacity * 100) +
          "% of the context window. Clearing or spawning a new card keeps the agent sharp.",
          { forceChoice: false }
        );
      } else if (!data.arcComplete && lastCapacity >= 0.95) {
        addContextSuggestion(
          "Context is almost full (" + Math.round(lastCapacity * 100) +
          "% of the window). Clear this card or spawn a new one before continuing.",
          { forceChoice: true }
        );
      }
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

// ── Clear / Spawn / Archive browser ────────────────────────
//
// Clear: archives the live transcript to .mica/chats/archived/<cardId>/<ts>.json
// and resets the live file + cursor. The card stays on canvas. The server
// broadcasts chat-cleared; this card + any peer windows on the same project
// reset their scroll.
//
// Spawn: writes a new .chat file next to this one with a user-chosen name.
// The canvas picks it up via the file watcher and lays it out as a sibling.
//
// Archive browser: dropdown listing per-card archived conversations. Clicking
// one opens a read-only modal. Nothing is ever loaded back into the agent's
// context — these are user-only references.

function clearCard(opts) {
  opts = opts || {};
  if (!opts.fromSuggestion) {
    const ok = window.confirm(
      "Archive this card's conversation and start fresh? The previous messages " +
      "will still be browsable from the clock icon."
    );
    if (!ok) return;
  }
  fetch("/api/chats/" + encodeURIComponent(mica.cardId) + "/clear", {
    method: "POST",
    headers: projectHeaders({ "Content-Type": "application/json" }),
  }).then(function(r) { return r.json(); }).then(function() {
    // Server will also broadcast chat-cleared; we reset locally for instant UX.
    messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared. Send a message to start a new one.</div>';
    contextCursor = 0;
    messageIndex = 0;
    ctxMeterEl.style.display = "none";
    lastCapacity = 0;
  }).catch(function(err) {
    console.error("[chat] clear failed:", err);
  });
}

function spawnSiblingCard() {
  const suggested = (mica.filename || "")
    .replace(/\.chat$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = window.prompt(
    "Name for the new chat card (without .chat extension):",
    suggested ? (suggested + "-next") : "new-chat"
  );
  if (!base) return;
  const name = base.trim().replace(/\.chat$/i, "");
  if (!name) return;
  // Default canvasRoot to the dirname of this card so the sibling lands in
  // the same folder.
  const parts = mica.filename.split("/");
  parts.pop();
  const dir = parts.join("/");
  const target = (dir ? dir + "/" : "") + name + ".chat";
  mica.files.write(target, "").catch(function(err) {
    console.error("[chat] spawn failed:", err);
    window.alert("Could not create " + target + ": " + (err && err.message ? err.message : "unknown"));
  });
}

function loadArchiveList() {
  archiveListEl.innerHTML = "Loading...";
  fetch("/api/chats/" + encodeURIComponent(mica.cardId) + "/archived", {
    headers: projectHeaders(),
  }).then(function(r) { return r.json(); }).then(function(data) {
    const entries = data.entries || [];
    if (entries.length === 0) {
      archiveListEl.innerHTML = '<div style="color:#6e7681;font-style:italic;">No previous conversations.</div>';
      return;
    }
    archiveListEl.innerHTML = "";
    entries.forEach(function(e) {
      const row = window.document.createElement("div");
      row.style.cssText =
        "padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;" +
        "justify-content:space-between;gap:8px;";
      row.addEventListener("mouseenter", function() { row.style.background = "rgba(255,255,255,0.05)"; });
      row.addEventListener("mouseleave", function() { row.style.background = ""; });
      const when = new Date(e.archivedAt);
      const left = window.document.createElement("span");
      left.textContent = when.toLocaleString();
      const right = window.document.createElement("span");
      right.style.cssText = "color:#6e7681;font-size:10px;";
      right.textContent = e.messageCount + (e.messageCount === 1 ? " msg" : " msgs");
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", function() { openArchiveViewer(e.filename); });
      archiveListEl.appendChild(row);
    });
  }).catch(function(err) {
    archiveListEl.innerHTML = '<div style="color:#f87171;">Failed to load: ' + escapeHtml(err.message || "") + '</div>';
  });
}

function openArchiveViewer(archiveName) {
  fetch(
    "/api/chats/" + encodeURIComponent(mica.cardId) + "/archived/" + encodeURIComponent(archiveName),
    { headers: projectHeaders() }
  ).then(function(r) { return r.json(); }).then(function(data) {
    const modal = window.document.createElement("div");
    modal.style.cssText =
      "position:absolute;inset:0;background:rgba(13,17,23,0.96);backdrop-filter:blur(2px);" +
      "z-index:25;display:flex;flex-direction:column;padding:12px 16px;font-size:12px;color:#e6edf3;";
    const header = window.document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
    const title = window.document.createElement("div");
    title.style.cssText = "font-weight:600;";
    title.textContent = "Archived: " + archiveName.replace(/\.json$/, "");
    const closeBtn = window.document.createElement("span");
    closeBtn.style.cssText = "cursor:pointer;color:#8b949e;font-size:18px;padding:0 4px;";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function() { modal.remove(); });
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    const scroller = window.document.createElement("div");
    scroller.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;";
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      const empty = window.document.createElement("div");
      empty.style.cssText = "color:#6e7681;font-style:italic;text-align:center;padding:24px 0;";
      empty.textContent = "(empty)";
      scroller.appendChild(empty);
    } else {
      msgs.forEach(function(m) {
        const bubble = window.document.createElement("div");
        const isUser = m.role === "user";
        bubble.style.cssText = isUser
          ? "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;"
          : "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
        if (isUser) {
          bubble.innerHTML = '<div style="color:#e6edf3;line-height:1.5;">' + escapeHtml(m.content || "") + '</div>';
        } else {
          const agentHdr = m.agent
            ? '<div style="color:' + ACCENT + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(m.agent) + '</div>'
            : "";
          bubble.innerHTML = agentHdr + '<div class="chat-md" style="color:#e6edf3;line-height:1.5;">' + renderMarkdown(m.content || "") + '</div>';
        }
        scroller.appendChild(bubble);
      });
    }
    modal.appendChild(scroller);
    container.appendChild(modal);
  }).catch(function(err) {
    console.error("[chat] archive viewer failed:", err);
  });
}

clearBtn.addEventListener("click", function() { clearCard(); });
spawnBtn.addEventListener("click", function() { spawnSiblingCard(); });

let archiveOpen = false;
archiveBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  archiveOpen = !archiveOpen;
  archivePanel.style.display = archiveOpen ? "block" : "none";
  if (archiveOpen) loadArchiveList();
});
window.addEventListener("click", function(e) {
  if (!archiveOpen) return;
  if (archivePanel.contains(e.target) || archiveBtn.contains(e.target)) return;
  archiveOpen = false;
  archivePanel.style.display = "none";
});

// Listen for chat-cleared broadcasts (e.g. when another window cleared this
// same card). Filter by chatId to ignore other cards' events.
const _unsubChatCleared = mica.on("chat-cleared", function(ev) {
  if (!ev || ev.chatId !== mica.cardId) return;
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared.</div>';
  contextCursor = 0;
  messageIndex = 0;
  ctxMeterEl.style.display = "none";
  lastCapacity = 0;
});
mica.onDestroy(_unsubChatCleared);

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

// Compact token count: 1234 → "1.2K", 65536 → "65K".
function formatK(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}

function loadContextInfo() {
  ctxLoaded = false;
  // Single source of truth: /api/agent/context-preview uses the same
  // buildContext() the agent uses at turn time. Per-file sizes are the
  // actual chars injected into the prompt (not raw disk bytes). Binaries
  // are flagged. Prompt-level soft cap is reported so we can warn when
  // the canvas has grown past what the model can comfortably hold.
  const url = "/api/agent/context-preview?filename=" + encodeURIComponent(mica.filename);
  fetch(url, { headers: projectHeaders() }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.error) {
      ctxFiles.textContent = "Failed to load: " + data.error;
      return;
    }
    const files = data.files || [];
    const extras = data.extras || [];
    const promptSize = data.promptSizeChars || 0;
    const tokens = data.estimatedTokens || Math.round(promptSize / 4);
    const cap = data.softCapChars || 0;
    const over = !!data.oversized;
    const fileLines = files.map(function(f) {
      if (f.binary) return f.name + '  <span style="color:#888">(binary, ' + (f.size || 0) + ' B)</span>';
      if (f.unreadable) return f.name + '  <span style="color:#f87171">(unreadable)</span>';
      return f.name + '  ' + formatSize(f.chars || 0);
    });
    const extraLines = extras.map(function(e) {
      return e.name + '  ' + formatSize(e.chars || 0) + '  <span style="color:#888">(' + (e.kind || 'context') + ')</span>';
    });
    const header = '<div style="color:' + (over ? '#f59e0b' : '#4ade80') + ';margin-bottom:4px">'
      + files.length + ' file' + (files.length === 1 ? '' : 's')
      + (extras.length ? ' + ' + extras.length + ' context source' + (extras.length === 1 ? '' : 's') : '')
      + ' · prompt ' + formatSize(promptSize) + ' (~' + tokens + ' tokens)'
      + (over ? ' · <b>over ' + formatSize(cap) + ' cap — split large cards</b>' : '')
      + '</div>';
    ctxFiles.innerHTML = header
      + extraLines.map(function(l) { return '<div>' + l + '</div>'; }).join('')
      + fileLines.map(function(l) { return '<div>' + l + '</div>'; }).join('');
    ctxLoaded = true;
  }).catch(function() { ctxFiles.textContent = "Failed to load"; });
}

ctxBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  ctxVisible = !ctxVisible;
  ctxTooltip.style.display = ctxVisible ? "block" : "none";
  // Always reload — the file list can change between opens (new card added,
  // file deleted). The fetch is cheap; staleness is the worse failure mode.
  if (ctxVisible) loadContextInfo();
});

ctxBtn.addEventListener("mouseenter", function() {
  if (!ctxVisible) {
    ctxTooltip.style.display = "block";
    loadContextInfo();
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
    fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openrouter-key', { headers: projectHeaders() }).then(function(r) { return r.json(); })
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
        headers: projectHeaders({ 'Content-Type': 'application/json' }),
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
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ provider: provider, model: model })
    }).then(function(r) { return r.json(); });
    const keyP = keyValue.length > 0
      ? fetch('/api/openrouter-key', {
          method: 'PUT',
          headers: projectHeaders({ 'Content-Type': 'application/json' }),
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
