// Chat card — Qwen Agent agentic coding assistant
// container and mica are provided by CARD_SHIM

const messagesEl = container.querySelector("#chat-messages");
const inputEl = container.querySelector("#chat-input");
const sendBtn = container.querySelector("#chat-send");
const attachBtn = container.querySelector("#chat-attach-btn");
const attachRow = container.querySelector("#chat-attach-row");
const attachChip = container.querySelector("#chat-attach-chip");
const attachFilenameEl = container.querySelector("#chat-attach-filename");
const attachClearBtn = container.querySelector("#chat-attach-clear");
const attachPicker = container.querySelector("#chat-attach-picker");
const attachOptionsEl = container.querySelector("#chat-attach-options");
const stopBtn = container.querySelector("#chat-stop");
const statusBar = container.querySelector("#chat-statusbar");
const statusMain = container.querySelector("#chat-status-main");
const statusDot = container.querySelector("#chat-dot");
const statusLabel = container.querySelector("#chat-status-label");
const statusMeta = container.querySelector("#chat-status-meta");
const statusToggle = container.querySelector("#chat-status-toggle");
const statusDetail = container.querySelector("#chat-status-detail");
// Fuel gauge (B — future: capacity trajectory) + header actions
const fuelEl = container.querySelector("#chat-fuel");
const fuelFill = fuelEl ? fuelEl.querySelector(".fuel-fill") : null;
const fuelBaselineMarker = fuelEl ? fuelEl.querySelector(".fuel-baseline-marker") : null;
const fuelHeadroomLabel = container.querySelector("#chat-fuel-headroom");
// Rolling buffers for the gauge. `recentBaselines` is misnamed for legacy
// reasons — it actually stores the turn's PEAK input_tokens (last tool-loop
// iteration), not the turn-start baseline. Drives the fill width + headroom
// projection. `recentBaselinesActual` is the parallel buffer for the actual
// turn-start baseline (canvas-back + skills + history + user message,
// pre-tool-loop) — drives the visible marker on the track that shows where
// the prompt naturally starts. Gap between marker and fill = how much the
// turn's tool calls accumulated.
//
// Hydrated from /api/agent/turn-history on mount (peaks only — the endpoint
// doesn't return baseline today); appended on each live assistant event.
// Cap modest: long-ago turns aren't predictive.
const FUEL_HISTORY_CAP = 5;
const recentBaselines = [];
const recentBaselinesActual = [];
let lastContextWindow = 0;

// Subagent visibility (paired with server's subagent_started/event/finished
// broadcasts). Per-subagent live state, keyed by tool_use_id. Drives the
// active-subagent strip + the status-line "N subagents" badge.
//   agent_type   — task-decomposer / component-coder / repo-module-analyst …
//   description  — original dispatch description (the parent's hint)
//   status       — "running" | "done" | "failed"
//   lastActivity — most recent event description (what it's doing right now)
//   lastEventTs  — Date.now() of the most recent event, used for stalled marker
//   startTs      — Date.now() at subagent_started, used for elapsed timer
// Cleared on assistant turn-end + on cursor-advance — same lifecycle as the
// fuel-gauge rolling buffer.
const subagentStates = new Map();
// Stalled threshold = "no event broadcast in N ms → mark stalled."
// Tuning history (all observed against local Qwen 35B):
//   30s   — flagged every long-prompt decompose-task. False positive.
//   120s  — flagged component-coder mid-build (its 'Read spec.md' event
//           fired at 31s, then model thought for 200+s producing the
//           build response; 120s timer tripped well before the next
//           assistant event arrived).
//   240s  — current. Tolerates a 4-minute model-thinking gap between
//           subagent assistant events. Local Qwen on a saturated
//           subagent prompt (decomposition memory + spec + interfaces +
//           per-component context) can take 3-5 minutes to produce its
//           next assistant message; the SDK doesn't yield mid-inference
//           without `includePartialMessages: true`. 4 minutes of TRUE
//           silence remains a strong signal of stuck (SDK deadlock,
//           orphaned subprocess, network drop). Genuine stalls still
//           caught; routine inference doesn't trip it.
const SUBAGENT_STALL_MS = 240_000;
const subagentStripEl = container.querySelector("#chat-subagent-strip");
const clearBtn = container.querySelector("#chat-clear-btn");
const horizonBtn = container.querySelector("#chat-horizon-btn");
const archiveBtn = container.querySelector("#chat-archive-btn");
const archivePanel = container.querySelector("#chat-archive-panel");
const archiveListEl = container.querySelector("#chat-archive-list");
const queuePanel = container.querySelector("#chat-queue-panel");
const queueListEl = container.querySelector("#chat-queue-list");
const queueCountEl = container.querySelector("#chat-queue-count");
const queueClearAllBtn = container.querySelector("#chat-queue-clear-all");

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
  inputEl.classList.toggle('chat-input--busy', b);
  inputEl.classList.toggle('chat-input--ready', !b);
  inputEl.placeholder = b ? "Working…" : "Your turn — ask Qwen Agent…";
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

function addDetailLine(text, fullText) {
  const line = window.document.createElement("div");
  line.style.cssText = "padding:1px 0;border-bottom:1px solid rgba(48,54,61,0.3);";
  line.textContent = text;
  // Hover-tooltip with the longer-form text when the server attached a
  // `details` field to the broadcast. Native title="" — no popover state,
  // text is copy-pasteable. Cursor shifts to `help` over hoverable lines.
  // Held in DOM only; cleared when the line ages out of the 200-line cap
  // or when the detail panel is cleared at next turn.
  if (fullText && fullText !== text) {
    line.title = fullText;
    line.style.cursor = "help";
  }
  statusDetail.appendChild(line);
  while (statusDetail.children.length > 200) statusDetail.removeChild(statusDetail.firstChild);
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
}

// Voice INPUT and speech output both live in the .voice card class, not
// here. Per CLAUDE.md tenet 3 (pipes, not policy): chat cards are pure
// text. To hear agent replies aloud, drop a .voice card on the canvas —
// Mica's voice agent subscribes to all chat-card broadcasts and renders
// announcements via Kokoro. To talk TO the agent by voice, same.

const ch = mica.openChannel("agent_session");

// Hydrate the fuel gauge's rolling buffer from recent turn history. Lets
// the gauge project headroom immediately after a card refresh instead of
// waiting for the first new assistant event.
hydrateFuelGauge();

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
// local engine (vLLM or llama-server) is actually serving (from /api/llm/status)
// over any override in this card's settings — the override takes effect inside
// the engine's routing but the served model is the source of truth the user
// cares about.
var modelLabelEl = container.querySelector('#chat-model-label');
var serverModel = '';   // populated from /api/llm/status
var serverEngine = '';  // 'vllm' or 'llama-server', also from /api/llm/status
function renderModelLabel() {
  var provider = currentSettings.provider || 'local';
  var providerShort;
  if (provider === 'openrouter') providerShort = 'OpenRouter';
  else if (provider === 'openai-compat') providerShort = 'OpenAI';
  else providerShort = 'Local';
  var model = provider === 'local'
    ? (serverModel || currentSettings.model || '')
    : (currentSettings.model || '');
  var display = model ? providerShort + ' · ' + model : providerShort;
  modelLabelEl.textContent = display;
  modelLabelEl.title = display;  // full text on hover (the CSS ellipsis hides the tail)
}

function checkLlmStatus() {
  // Skip llama-server status polling for remote providers — the local server
  // is irrelevant to them, so don't show "Model loading..." or block Send.
  if (currentSettings.provider === 'openrouter' || currentSettings.provider === 'openai-compat') {
    sendBtn.disabled = false;
    // Don't clobber the busy placeholder if a turn is in flight — this fetch
    // resolves async and can race with a "thinking" event that already wrote
    // "Working — please wait…". setBusy(false) re-establishes the ready
    // placeholder at turn end.
    if (!busy) inputEl.placeholder = 'Your turn — ask Qwen Agent…';
    return;
  }
  fetch('/api/llm/status').then(function(r) { return r.json(); }).then(function(s) {
    if (s.model && s.model !== serverModel) { serverModel = s.model; renderModelLabel(); }
    if (typeof s.engine === 'string') serverEngine = s.engine;
    if (s.ready) {
      sendBtn.disabled = false;
      // Same async-race guard as the remote-provider branch above.
      if (!busy) inputEl.placeholder = 'Your turn — ask Qwen Agent…';
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
  // Trim leading/trailing whitespace before any rendering. Without this,
  // a reply starting with "\n\nFoo" (common — models emit a leading
  // paragraph break) becomes "<br/><br/>Foo" after the \n\n→<br/><br/>
  // pass below, leaving visible empty space at the top of the bubble.
  text = text.replace(/^\s+|\s+$/g, "");
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

// Build a horizon separator DOM node. Single instance — we move it, not
// recreate it, when the cursor advances mid-session.
function buildHorizonEl() {
  const horizon = window.document.createElement("div");
  horizon.className = "chat-horizon";
  horizon.style.cssText =
    "align-self:stretch;display:flex;align-items:center;gap:8px;color:#6e7681;" +
    "font-size:10px;font-family:monospace;margin:6px 0;opacity:0.7;";
  horizon.innerHTML =
    '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>' +
    '<span style="flex-shrink:0;">↑ earlier conversation (not in agent context)</span>' +
    '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>';
  return horizon;
}

// Apply the current cursor position to every message already in the scroll.
// Greys out messages with index < contextCursor and positions the single
// horizon separator so it sits just before the message at index contextCursor.
// Called after a live cursor advance (assistant event with data.cursor > old
// cursor). Append-time rendering in addMessage covers the initial history
// load; this covers mid-session changes.
function applyCursorDisplay() {
  // Remove any stale horizon — we re-insert at the current position below.
  const existing = messagesEl.querySelector(".chat-horizon");
  if (existing) existing.remove();

  const msgs = messagesEl.querySelectorAll("[data-msg-index]");
  let inserted = false;
  for (const m of msgs) {
    const idx = parseInt(m.getAttribute("data-msg-index"), 10);
    m.style.opacity = idx < contextCursor ? "0.55" : "";
    // The horizon goes just before the first message at or after the cursor.
    if (!inserted && contextCursor > 0 && idx >= contextCursor) {
      messagesEl.insertBefore(buildHorizonEl(), m);
      inserted = true;
    }
  }
}

// Render the horizon right before the next appended message if we're about to
// cross the cursor. Used during the initial history load where messages are
// appended sequentially.
function maybeRenderHorizon() {
  if (contextCursor > 0 && messageIndex === contextCursor && !messagesEl.querySelector(".chat-horizon")) {
    messagesEl.appendChild(buildHorizonEl());
  }
}

function addMessage(role, content, agent, questions, turnId) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  maybeRenderHorizon();
  const msg = window.document.createElement("div");
  // Greyscale messages above the cursor — they exist for user reference but
  // the agent doesn't see them. Tag with data-msg-index so applyCursorDisplay()
  // can re-evaluate every message after a mid-session cursor advance.
  msg.setAttribute("data-msg-index", String(messageIndex));
  const aboveHorizon = messageIndex < contextCursor;
  if (aboveHorizon) msg.style.opacity = "0.55";
  messageIndex++;
  if (role === "user") {
    msg.style.cssText = "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";
    msg.innerHTML = `<div style="color:#e6edf3;font-size:13px;line-height:1.5;">${escapeHtml(content)}</div>`;
  } else {
    msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
    // A — past, per-turn: when this assistant bubble has a turn_id, render
    // a chevron next to the agent name. Click to expand a footer with chips
    // (skills, subagents, tools, elapsed) + a "view snapshot" link to the
    // captured rendered system prompt for this turn. Old chats lack
    // turn_id → no chevron renders → footer unavailable (graceful no-op).
    const chevron = turnId ? `<span class="chat-bubble-toggle" data-turn-id="${escapeHtml(turnId)}" title="Show turn details" style="cursor:pointer;color:#8b949e;font-size:13px;font-weight:600;margin-left:8px;padding:1px 5px;border-radius:3px;display:inline-block;line-height:1;transition:transform 120ms ease, background-color 120ms ease;">▸</span>` : "";
    const header = agent ? `<div style="color:${ACCENT};font-size:11px;font-weight:600;margin-bottom:4px;">${escapeHtml(agent)}${chevron}</div>` : "";
    msg.innerHTML = `${header}<div class="chat-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">${renderMarkdown(content)}</div>`;
    if (questions && questions.length > 0) {
      // Per-question grouping: each question gets its own header + chip row.
      // Single-question case auto-submits on click (preserves prior UX).
      // Multi-question case stages selections per question; user clicks
      // "Send answers" once all questions have a selection. Selecting in
      // one question doesn't disable chips in other questions. multiSelect
      // questions toggle on click.
      const renderable = questions.filter(function(q) { return q.options && q.options.length > 0; });
      if (renderable.length > 0) {
        const isMulti = renderable.length > 1;
        const selections = {};  // qi -> string (single) or [string] (multiSelect)
        const allBtns = [];
        let sendBtn = null;
        function btnBase() {
          return "color:#e6edf3;border:1px solid rgba(124,58,237,0.4);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;";
        }
        function btnUnselected() { return btnBase() + "background:rgba(124,58,237,0.15);"; }
        function btnSelected() { return btnBase() + "background:rgba(124,58,237,0.55);"; }
        function isSel(qi, label) {
          const sel = selections[qi];
          if (Array.isArray(sel)) return sel.indexOf(label) >= 0;
          return sel === label;
        }
        function updateSendEnabled() {
          if (!sendBtn) return;
          const ok = renderable.every(function(q, qi) {
            const sel = selections[qi];
            if (q.multiSelect) return Array.isArray(sel) && sel.length > 0;
            return typeof sel === "string" && sel.length > 0;
          });
          sendBtn.disabled = !ok;
          sendBtn.style.opacity = ok ? "1" : "0.5";
          sendBtn.style.cursor = ok ? "pointer" : "default";
        }
        function disableAll() {
          for (let i = 0; i < allBtns.length; i++) {
            allBtns[i].disabled = true;
            allBtns[i].style.opacity = "0.4";
            allBtns[i].style.cursor = "default";
          }
          if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.style.opacity = "0.4";
            sendBtn.style.cursor = "default";
          }
        }
        function submitMulti() {
          const lines = renderable.map(function(q, qi) {
            const sel = selections[qi];
            const ans = q.multiSelect
              ? (Array.isArray(sel) ? sel.join(", ") : "")
              : (sel || "");
            return (q.question || "Question " + (qi + 1)) + " -> " + ans;
          });
          disableAll();
          inputEl.value = lines.join("\n");
          send();
        }
        const groups = window.document.createElement("div");
        groups.style.cssText = "display:flex;flex-direction:column;gap:14px;margin-top:6px;";
        renderable.forEach(function(q, qi) {
          const group = window.document.createElement("div");
          group.style.cssText = "display:flex;flex-direction:column;gap:6px;";
          if (q.question) {
            const qText = window.document.createElement("div");
            qText.style.cssText = "color:#e6edf3;font-size:13px;font-weight:500;line-height:1.4;";
            qText.textContent = q.question;
            group.appendChild(qText);
          }
          const row = window.document.createElement("div");
          row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
          q.options.forEach(function(opt) {
            const btn = window.document.createElement("button");
            btn.textContent = opt.label;
            btn.title = opt.description || opt.label;
            btn.style.cssText = btnUnselected();
            btn.addEventListener("mouseenter", function() {
              if (btn.disabled) return;
              if (!isSel(qi, opt.label)) btn.style.background = "rgba(124,58,237,0.3)";
            });
            btn.addEventListener("mouseleave", function() {
              if (btn.disabled) return;
              btn.style.background = isSel(qi, opt.label) ? "rgba(124,58,237,0.55)" : "rgba(124,58,237,0.15)";
            });
            btn.addEventListener("click", function() {
              if (!isMulti) {
                disableAll();
                btn.style.cssText = btnSelected();
                inputEl.value = opt.label;
                send();
                return;
              }
              if (q.multiSelect) {
                const arr = Array.isArray(selections[qi]) ? selections[qi] : [];
                const idx = arr.indexOf(opt.label);
                if (idx >= 0) {
                  arr.splice(idx, 1);
                  btn.style.cssText = btnUnselected();
                } else {
                  arr.push(opt.label);
                  btn.style.cssText = btnSelected();
                }
                selections[qi] = arr;
              } else {
                selections[qi] = opt.label;
                const rowBtns = row.querySelectorAll("button");
                for (let i = 0; i < rowBtns.length; i++) rowBtns[i].style.cssText = btnUnselected();
                btn.style.cssText = btnSelected();
              }
              updateSendEnabled();
            });
            allBtns.push(btn);
            row.appendChild(btn);
          });
          group.appendChild(row);
          groups.appendChild(group);
        });
        if (isMulti) {
          sendBtn = window.document.createElement("button");
          sendBtn.textContent = "Send answers";
          sendBtn.style.cssText = "background:rgba(124,58,237,0.6);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:default;font-family:inherit;align-self:flex-start;margin-top:4px;opacity:0.5;";
          sendBtn.disabled = true;
          sendBtn.addEventListener("click", function() {
            if (!sendBtn.disabled) submitMulti();
          });
          groups.appendChild(sendBtn);
        }
        msg.appendChild(groups);
      }
    }
  }
  messagesEl.appendChild(msg);
  scrollBottom();
}

// A — past, per-turn footer.
//
// Delegated click handler on the messages container: when a chevron is
// clicked, fetch the turn record (skills, subagents, tool counts, duration)
// and lazy-build a chip-strip footer below the bubble's content. Subsequent
// clicks toggle visibility without re-fetching. The chevron rotates 90° on
// expand. A "view snapshot" link in the footer opens the captured rendered
// system prompt for that turn in a new browser tab.
//
// Lazy-built: most bubbles never expand, so the default cost is one chevron
// + one delegated handler, not one footer per bubble.
function formatChips(turn, subagents) {
  const tc = turn.tool_calls || {};
  const skillsList = Array.isArray(turn.skills_invoked) ? turn.skills_invoked : [];
  const subList = Array.isArray(subagents) ? subagents : [];
  // Top 3 tool names by count for the hover detail.
  const toolEntries = Object.keys(tc).map(function(k) { return [k, tc[k]]; }).sort(function(a, b) { return b[1] - a[1]; });
  const totalToolCalls = toolEntries.reduce(function(s, e) { return s + e[1]; }, 0);
  const topTools = toolEntries.slice(0, 3).map(function(e) { return e[0] + " " + e[1]; }).join(" · ");
  const skillsTitle = skillsList.length > 0 ? skillsList.join(", ") : "(none)";
  const subsTitle = subList.length > 0
    ? subList.map(function(s) { return s.subagent_name + " · " + Math.round(s.duration_ms / 100) / 10 + "s"; }).join("\n")
    : "(none)";
  const durationSec = turn.duration_ms ? Math.round(turn.duration_ms / 100) / 10 : 0;
  // Text-only chips (no emoji per project style).
  function chip(label, title) {
    return '<span class="chat-turn-chip" title="' + escapeHtml(title) + '">' + escapeHtml(label) + '</span>';
  }
  const parts = [];
  parts.push(chip(skillsList.length + " skills", skillsTitle));
  parts.push(chip(subList.length + " subagents", subsTitle));
  parts.push(chip(totalToolCalls + " tools", topTools || "(none)"));
  parts.push(chip(durationSec + "s", "elapsed"));
  return parts.join("");
}

messagesEl.addEventListener("click", function(e) {
  const toggle = e.target.closest && e.target.closest(".chat-bubble-toggle");
  if (!toggle) return;
  e.stopPropagation();
  const bubble = toggle.closest("[data-msg-index]");
  if (!bubble) return;
  const turnId = toggle.getAttribute("data-turn-id");
  if (!turnId) return;
  let footer = bubble.querySelector(".chat-turn-footer");
  if (footer) {
    // Toggle existing footer
    const isHidden = footer.style.display === "none";
    footer.style.display = isHidden ? "flex" : "none";
    toggle.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
    return;
  }
  // First expand: fetch + build
  toggle.textContent = "…";
  fetch("/api/agent/turn-record/" + encodeURIComponent(mica.cardId) + "/" + encodeURIComponent(turnId), {
    headers: projectHeaders(),
  }).then(function(r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }).then(function(data) {
    toggle.textContent = "▸";
    toggle.style.transform = "rotate(90deg)";
    footer = window.document.createElement("div");
    footer.className = "chat-turn-footer";
    footer.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(48,54,61,0.5);font-size:11px;color:#8b949e;";
    const chipsHtml = formatChips(data.turn || {}, data.subagents || []);
    // Pass project as a query param — opening in a new tab via <a target="_blank">
    // strips the X-Mica-Project header that the fetch path sets via projectHeaders().
    // Server's getRequestProject() accepts either header or ?project=.
    const snapHref = "/api/agent/turn-snapshot/" + encodeURIComponent(mica.cardId) + "/" + encodeURIComponent(turnId)
      + "?project=" + encodeURIComponent(mica.project || "");
    footer.innerHTML = chipsHtml +
      '<a class="chat-turn-snapshot-link" href="' + snapHref + '" target="_blank" rel="noopener" ' +
      'style="color:#7c3aed;text-decoration:none;font-size:11px;margin-left:auto;" ' +
      'title="Open the captured rendered system prompt for this turn">view snapshot →</a>';
    bubble.appendChild(footer);
  }).catch(function(err) {
    toggle.textContent = "▸";
    toggle.title = "Failed to load: " + err.message;
  });
});

// Card-error events used to render a red bubble in the chat. Removed:
// the agent auto-receives the error via validatorErrorBuffer (next-turn
// buildContext injection), and the same error already surfaces in the
// detail panel as a `progress` event (warning + filename + preview) via
// cardErrorBuffer's milestone-based flush at agent turn-end. A bubble
// would just duplicate what's already visible. `card-error` /
// `card-error-cleared` broadcasts still flow over the project channel
// for other surfaces (CardRuntime's in-card overlay).


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
  const subBadge = computeSubagentBadge();
  if (subBadge) parts.push(subBadge);
  statusMeta.textContent = parts.join(" . ");
}

// Status-line badge: counts running subagents, marks stalled (no event for
// >30s). Returns "" when nothing's running so the badge disappears between
// turns. Recomputed on every event AND on the elapsedTimer's 1s tick (so a
// silent stall transitions to "stalled" without external trigger).
function computeSubagentBadge() {
  if (subagentStates.size === 0) return "";
  const now = Date.now();
  let active = 0;
  let stalled = 0;
  for (const s of subagentStates.values()) {
    if (s.status === "running") {
      active++;
      if (now - s.lastEventTs > SUBAGENT_STALL_MS) stalled++;
    }
  }
  if (active === 0) return "";
  if (stalled > 0) return active + " subagent" + (active === 1 ? "" : "s") + " (" + stalled + " stalled)";
  return active + " subagent" + (active === 1 ? "" : "s");
}

// Strip render: per-subagent line above the chat-input area, showing
// running state + elapsed time + latest activity. Hides when empty.
function renderSubagentStrip() {
  if (!subagentStripEl) return;
  if (subagentStates.size === 0) {
    subagentStripEl.style.display = "none";
    subagentStripEl.innerHTML = "";
    return;
  }
  const lines = [];
  const now = Date.now();
  const all = Array.from(subagentStates.values());
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    const elapsed = Math.round((now - s.startTs) / 1000);
    const stalled = s.status === "running" && (now - s.lastEventTs > SUBAGENT_STALL_MS);
    const icon = s.status === "running"
      ? (stalled ? "&#9208;" : "&#9881;")  // ⏸ : ⚙
      : (s.status === "done" ? "&#10003;" : "&#10007;");  // ✓ : ✗
    const color = stalled
      ? "#fbbf24"
      : (s.status === "running" ? "#a78bfa" : (s.status === "done" ? "#3fb950" : "#f87171"));
    // Tree connector visualizes "child of parent's most recent action".
    // ├─ for non-last, └─ for last. Combined with the strip's left
    // border + extra left-padding (in card.html), the relationship is
    // unambiguous: the indent says "below the parent," the connector
    // says "this is one of N children," and the icon says state.
    const connector = (i === all.length - 1) ? "&#9492;&#9472;" : "&#9500;&#9472;";  // └─ : ├─
    const rawActivity = s.lastActivity || "starting...";
    const activity = rawActivity.length > 80 ? rawActivity.slice(0, 80) + "…" : rawActivity;
    lines.push(
      '<div style="color:' + color + ';">' +
        '<span style="color:#6e7681;">' + connector + '</span> ' +
        icon + " <span style=\"font-weight:600;\">" + escapeHtml(s.agent_type) + "</span> " +
        "<span style=\"color:#6e7681;\">(" + elapsed + "s)</span> &mdash; " +
        escapeHtml(activity) +
      "</div>"
    );
  }
  subagentStripEl.innerHTML = lines.join("");
  subagentStripEl.style.display = "flex";
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

// Compact token count: 1234 → "1.2K", 65536 → "65K".
function formatK(n) {
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}

// B (future) — fuel gauge with capacity trajectory.
//
// Renders the topbar gauge from new (peak, baseline) readings and the
// rolling buffer of recent turns. The gauge shows TWO datapoints from
// the latest turn:
//   - Fill (colored bar 0→peak) — how much was actually sent at the
//     turn's high-water mark. Color zones flag overflow risk.
//   - Marker (vertical line at baseline%) — where the prompt naturally
//     starts (canvas-back + skills + chat history + user message,
//     pre-tool-loop). Gap between marker and fill = tool-call accumulation.
// The headroom projection still uses peak (since that's what determines
// when the next turn overflows).
//
// Inputs:
//   - peakTokens:     turn's peak input_tokens (last tool-loop iteration)
//   - baselineTokens: turn-start baseline (pre-tool-loop). May be 0 if
//                     the caller doesn't have it (hydration path).
//   - contextWindow:  the model's window (from server)
function updateFuelGauge(peakTokens, baselineTokens, contextWindow) {
  if (typeof peakTokens === "number" && peakTokens > 0) {
    recentBaselines.push(peakTokens);
    while (recentBaselines.length > FUEL_HISTORY_CAP) recentBaselines.shift();
  }
  if (typeof baselineTokens === "number" && baselineTokens > 0) {
    recentBaselinesActual.push(baselineTokens);
    while (recentBaselinesActual.length > FUEL_HISTORY_CAP) recentBaselinesActual.shift();
  }
  if (typeof contextWindow === "number" && contextWindow > 0) lastContextWindow = contextWindow;
  renderFuelGauge();
}

// Pure render from the rolling buffer + lastContextWindow. Split out so
// the post-mount /turn-history hydration can call this once after seeding
// the buffer without needing fresh server-side numbers.
function renderFuelGauge() {
  if (!fuelEl || !fuelFill) return;
  const cw = lastContextWindow;
  const latest = recentBaselines.length > 0 ? recentBaselines[recentBaselines.length - 1] : 0;
  if (!latest || !cw || cw <= 0) { fuelEl.style.display = "none"; return; }
  fuelEl.style.display = "inline-flex";
  const pct = Math.max(0, Math.min(100, Math.round((latest / cw) * 100)));
  fuelFill.style.width = pct + "%";
  let color = "#4ade80";       // green — comfortable
  if (pct >= 80) color = "#f87171";
  else if (pct >= 50) color = "#fbbf24";
  fuelFill.style.background = color;
  // Baseline marker: vertical line at baseline%, hidden if no baseline
  // available (e.g. hydration path with peak-only history). Marker color
  // stays white-ish regardless of fill color — it represents "where
  // the prompt naturally starts," independent of overflow risk.
  const latestBaseline = recentBaselinesActual.length > 0
    ? recentBaselinesActual[recentBaselinesActual.length - 1]
    : 0;
  let baselinePct = 0;
  if (fuelBaselineMarker) {
    if (latestBaseline > 0) {
      baselinePct = Math.max(0, Math.min(100, Math.round((latestBaseline / cw) * 100)));
      fuelBaselineMarker.style.left = baselinePct + "%";
      fuelBaselineMarker.style.opacity = "1";
    } else {
      fuelBaselineMarker.style.opacity = "0";
    }
  }
  // Headroom: mean per-turn growth across the buffer projected to the cap.
  // Negative or zero growth (cursor advanced, baseline shrank) → "stable".
  let headroomText = "";
  let headroomTitle = "";
  if (recentBaselines.length >= 2) {
    const oldest = recentBaselines[0];
    const delta = (latest - oldest) / (recentBaselines.length - 1);
    if (delta > 0) {
      const turnsToCap = Math.max(0, Math.floor((cw - latest) / delta));
      headroomText = "~" + turnsToCap + " turns";
      headroomTitle = "~" + turnsToCap + " turns to cap";
    } else {
      headroomText = "—";
      headroomTitle = "headroom stable";
    }
  } else {
    headroomText = "—";
    headroomTitle = "tracking…";
  }
  fuelHeadroomLabel.textContent = formatK(latest) + "/" + formatK(cw) + " · " + headroomText;
  fuelHeadroomLabel.style.color = color;
  // Hover title: peak / baseline / recent peaks / projection. Multi-line
  // via \n; the browser renders title attribute newlines as line breaks.
  const peakList = recentBaselines.map(formatK).join(", ");
  let title = "Peak: " + formatK(latest) + " / " + formatK(cw) + " (" + pct + "%)\n";
  if (latestBaseline > 0) {
    title += "Baseline: " + formatK(latestBaseline) + " (" + baselinePct + "%)\n";
  }
  title += "Recent peaks: " + peakList + "\n" + headroomTitle;
  fuelEl.title = title;
}

// Hydrate the rolling buffer from server-side turn history on mount so the
// gauge can project trajectory immediately after a card refresh. Cheap GET;
// failure is swallowed (gauge just stays hidden until the first live turn).
function hydrateFuelGauge() {
  fetch("/api/agent/turn-history/" + encodeURIComponent(mica.cardId) + "?limit=" + FUEL_HISTORY_CAP, {
    headers: projectHeaders(),
  }).then(function(r) { return r.json(); }).then(function(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    // Server returns most-recent first; reverse so push order matches turn order.
    items.reverse();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      // Prefer input_tokens (the turn's peak, set from SDK usage) over
      // baseline_tokens (turn-start). See the live-update path: peak is
      // what tells you "did we get close to overflow."
      const peak = (typeof it.input_tokens === "number" && it.input_tokens > 0)
        ? it.input_tokens
        : (typeof it.baseline_tokens === "number" ? it.baseline_tokens : 0);
      if (peak > 0) recentBaselines.push(peak);
      if (typeof it.context_window === "number" && it.context_window > 0) {
        lastContextWindow = it.context_window;
      }
    }
    while (recentBaselines.length > FUEL_HISTORY_CAP) recentBaselines.shift();
    renderFuelGauge();
  }).catch(function() { /* swallow — gauge stays hidden */ });
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

// Server-pushed queue state (push/cancel/clear/initial-snapshot). The
// chat card just renders whatever the server sends — single source of
// truth so ambient voice dispatches show up the same as local sends.
function renderQueuePanel(items) {
  const list = Array.isArray(items) ? items : [];
  queuedCount = list.length;
  updateSendButton();
  if (list.length === 0) {
    queuePanel.style.display = "none";
    queueListEl.innerHTML = "";
    return;
  }
  queuePanel.style.display = "flex";
  queueCountEl.textContent = String(list.length);
  queueListEl.innerHTML = "";
  const now = Date.now();
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const ageMs = typeof it.queuedAt === "number" ? now - it.queuedAt : 0;
    const ageStr =
      ageMs < 5_000 ? "just now"
      : ageMs < 60_000 ? Math.floor(ageMs / 1000) + "s ago"
      : ageMs < 3_600_000 ? Math.floor(ageMs / 60_000) + "m ago"
      : Math.floor(ageMs / 3_600_000) + "h ago";
    const sourceLabel = it.source === "voice" ? "VOICE"
      : it.source === "file-changes" ? "FILES"
      : "YOU";
    const sourceColor = it.source === "voice" ? "#c4b5fd"
      : it.source === "file-changes" ? "#fcd34d"
      : "#8b949e";
    const sourceBg = it.source === "voice" ? "rgba(124,58,237,0.18)"
      : it.source === "file-changes" ? "rgba(252,211,77,0.12)"
      : "rgba(255,255,255,0.05)";
    const row = window.document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:6px;padding:4px 6px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);border-radius:4px;font-size:11px;";
    row.dataset.queuedId = String(it.id || "");
    const chip = window.document.createElement("span");
    chip.style.cssText = "flex-shrink:0;font-size:9px;font-weight:600;letter-spacing:0.04em;padding:1px 5px;border-radius:3px;color:" + sourceColor + ";background:" + sourceBg + ";";
    chip.textContent = sourceLabel;
    row.appendChild(chip);
    const text = window.document.createElement("span");
    text.style.cssText = "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d1d9;";
    text.textContent = String(it.text || "");
    text.title = String(it.text || "");
    row.appendChild(text);
    if (it.attach) {
      const att = window.document.createElement("span");
      att.style.cssText = "flex-shrink:0;color:#c9aef7;font-size:10px;";
      att.textContent = "📷";
      att.title = "Attached: " + it.attach;
      row.appendChild(att);
    }
    const age = window.document.createElement("span");
    age.style.cssText = "flex-shrink:0;color:#6e7681;font-size:10px;font-family:monospace;";
    age.textContent = ageStr;
    row.appendChild(age);
    const cancel = window.document.createElement("button");
    cancel.style.cssText = "flex-shrink:0;background:transparent;border:none;color:#8b949e;cursor:pointer;font-size:14px;padding:0 4px;line-height:1;font-family:inherit;";
    cancel.textContent = "×";
    cancel.title = "Cancel this queued message";
    cancel.addEventListener("click", function() {
      ch.send({ type: "cancel_queued", id: it.id });
    });
    row.appendChild(cancel);
    queueListEl.appendChild(row);
  }
}
queueClearAllBtn.addEventListener("click", function() {
  if (!queuedCount) return;
  ch.send({ type: "clear_queue" });
});

// ── Cascade-edit proposals (propose_changes tool) ─────────────────────
// The agent calls propose_changes when it spots a cascade. The server
// stores the proposal and broadcasts the event; this card renders an
// Apply / Dismiss UI. Per-hunk select is intentionally out of scope —
// users can iterate via chat ("propose a smaller version").
var proposalBubbles = {};  // proposalId → DOM container

function renderProposeChanges(data) {
  if (!data || !data.proposalId) return;
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  maybeRenderHorizon();
  var bubble = window.document.createElement("div");
  bubble.style.cssText = "align-self:flex-start;background:rgba(252,211,77,0.06);border:1px solid rgba(252,211,77,0.25);border-radius:12px 12px 12px 4px;padding:10px 12px;max-width:90%;";
  bubble.dataset.proposalId = data.proposalId;
  proposalBubbles[data.proposalId] = bubble;

  var hdr = window.document.createElement("div");
  hdr.style.cssText = "color:#fcd34d;font-size:11px;font-weight:600;margin-bottom:6px;letter-spacing:0.02em;";
  var fileCount = (data.files || []).length;
  var hunkCount = (data.files || []).reduce(function(n, f) { return n + (f.hunks ? f.hunks.length : 0); }, 0);
  hdr.textContent = "PROPOSED CASCADE EDITS · " + hunkCount + " hunk" + (hunkCount === 1 ? "" : "s") + " · " + fileCount + " file" + (fileCount === 1 ? "" : "s");
  bubble.appendChild(hdr);

  if (data.reason) {
    var reason = window.document.createElement("div");
    reason.style.cssText = "color:#e6edf3;font-size:12px;line-height:1.5;margin-bottom:8px;font-style:italic;";
    reason.textContent = data.reason;
    bubble.appendChild(reason);
  }

  (data.files || []).forEach(function(f) {
    var fileBlock = window.document.createElement("div");
    fileBlock.style.cssText = "margin-bottom:8px;";
    var fpath = window.document.createElement("div");
    fpath.style.cssText = "color:#8b949e;font-size:11px;font-family:monospace;margin-bottom:4px;";
    fpath.textContent = f.file;
    fileBlock.appendChild(fpath);
    (f.hunks || []).forEach(function(hunk) {
      if (hunk.label) {
        var lbl = window.document.createElement("div");
        lbl.style.cssText = "color:#c9d1d9;font-size:11px;margin:4px 0 2px 0;";
        lbl.textContent = hunk.label;
        fileBlock.appendChild(lbl);
      }
      var diff = window.document.createElement("pre");
      diff.style.cssText = "font-family:'SF Mono','Monaco','Cascadia Code','Menlo',monospace;font-size:11px;line-height:1.4;background:rgba(0,0,0,0.25);border-radius:4px;padding:6px 8px;margin:0 0 4px 0;overflow-x:auto;white-space:pre;color:#e6edf3;";
      var oldLines = String(hunk.old_string || "").split("\n");
      var newLines = String(hunk.new_string || "").split("\n");
      oldLines.forEach(function(line) {
        var span = window.document.createElement("div");
        span.style.cssText = "color:#fca5a5;background:rgba(248,113,113,0.08);";
        span.textContent = "- " + line;
        diff.appendChild(span);
      });
      newLines.forEach(function(line) {
        var span = window.document.createElement("div");
        span.style.cssText = "color:#86efac;background:rgba(134,239,172,0.08);";
        span.textContent = "+ " + line;
        diff.appendChild(span);
      });
      fileBlock.appendChild(diff);
    });
    bubble.appendChild(fileBlock);
  });

  // Action row.
  var actions = window.document.createElement("div");
  actions.style.cssText = "display:flex;gap:8px;margin-top:8px;";
  var applyBtn = window.document.createElement("button");
  applyBtn.style.cssText = "background:rgba(134,239,172,0.18);border:1px solid rgba(134,239,172,0.45);color:#86efac;padding:6px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;";
  applyBtn.textContent = "Apply all";
  var dismissBtn = window.document.createElement("button");
  dismissBtn.style.cssText = "background:transparent;border:1px solid rgba(255,255,255,0.18);color:#8b949e;padding:6px 14px;border-radius:6px;font-size:12px;cursor:pointer;font-family:inherit;";
  dismissBtn.textContent = "Dismiss";
  applyBtn.addEventListener("click", function() {
    applyBtn.disabled = true;
    dismissBtn.disabled = true;
    applyBtn.textContent = "Applying…";
    fetch("/api/proposals/apply", {
      method: "POST",
      headers: projectHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ proposalId: data.proposalId }),
    }).then(function(r) { return r.json(); }).then(function(res) {
      // The server also broadcasts propose_changes_applied which triggers
      // markProposalApplied — but apply latency on the click side feels
      // better with a same-tab update too. The broadcast is idempotent
      // against the same bubble.
      if (res && res.ok) {
        markProposalApplied({ proposalId: data.proposalId, totalApplied: res.totalApplied, results: res.results });
      } else {
        applyBtn.disabled = false;
        dismissBtn.disabled = false;
        applyBtn.textContent = "Apply all";
        bubble.appendChild(buildErrorRow("Apply failed: " + (res && res.error ? res.error : "unknown")));
      }
    }).catch(function(err) {
      applyBtn.disabled = false;
      dismissBtn.disabled = false;
      applyBtn.textContent = "Apply all";
      bubble.appendChild(buildErrorRow("Apply failed: " + err.message));
    });
  });
  dismissBtn.addEventListener("click", function() {
    applyBtn.disabled = true;
    dismissBtn.disabled = true;
    fetch("/api/proposals/dismiss", {
      method: "POST",
      headers: projectHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ proposalId: data.proposalId }),
    }).then(function() {
      markProposalDismissed({ proposalId: data.proposalId });
    }).catch(function() {
      // Even if dismiss fails server-side, the UI should reflect the user's intent.
      markProposalDismissed({ proposalId: data.proposalId });
    });
  });
  actions.appendChild(applyBtn);
  actions.appendChild(dismissBtn);
  bubble.appendChild(actions);

  messagesEl.appendChild(bubble);
  bubble.scrollIntoView({ behavior: "smooth", block: "end" });
}

function buildErrorRow(text) {
  var el = window.document.createElement("div");
  el.style.cssText = "color:#fca5a5;font-size:11px;margin-top:6px;";
  el.textContent = text;
  return el;
}

function markProposalApplied(data) {
  var bubble = proposalBubbles[data.proposalId];
  if (!bubble) return;
  // Replace the action row with a status row. Keep the diffs above
  // so the user can still see what was applied.
  var actions = bubble.querySelector("div:last-child");
  if (actions) bubble.removeChild(actions);
  var status = window.document.createElement("div");
  status.style.cssText = "color:#86efac;font-size:12px;font-weight:600;margin-top:8px;display:flex;align-items:center;gap:6px;";
  var totalApplied = typeof data.totalApplied === "number" ? data.totalApplied : 0;
  status.textContent = "✓ Applied " + totalApplied + " hunk" + (totalApplied === 1 ? "" : "s");
  bubble.appendChild(status);
  // If any per-file errors, list them.
  var errs = (data.results || []).filter(function(r) { return r.error; });
  if (errs.length > 0) {
    var errBlock = window.document.createElement("div");
    errBlock.style.cssText = "color:#fcd34d;font-size:11px;margin-top:4px;";
    errBlock.textContent = "Skipped: " + errs.map(function(e) { return e.file + " (" + e.error + ")"; }).join("; ");
    bubble.appendChild(errBlock);
  }
  delete proposalBubbles[data.proposalId];
}

function markProposalDismissed(data) {
  var bubble = proposalBubbles[data.proposalId];
  if (!bubble) return;
  var actions = bubble.querySelector("div:last-child");
  if (actions) bubble.removeChild(actions);
  var status = window.document.createElement("div");
  status.style.cssText = "color:#8b949e;font-size:11px;margin-top:6px;font-style:italic;";
  status.textContent = "Dismissed";
  bubble.appendChild(status);
  delete proposalBubbles[data.proposalId];
}

// Handle channel data from server
ch.onData(function(data) {
  switch (data.type) {
    case "queue":
      renderQueuePanel(data.items || []);
      break;
    case "history":
      messagesEl.innerHTML = "";
      contextCursor = typeof data.cursor === "number" ? data.cursor : 0;
      messageIndex = 0;
      if (data.messages && data.messages.length > 0) {
        for (let i = 0; i < data.messages.length; i++) {
          addMessage(data.messages[i].role, data.messages[i].content, data.messages[i].agent, undefined, data.messages[i].turn_id);
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
      // Mid-turn structured question with clickable options. Server
      // broadcasts this immediately when the agent calls ask_user_question,
      // decoupled from the turn-end assistant event — so the question
      // surfaces even if the agent misinterprets the deny message and
      // continues running tools. The chip widget renders each question's
      // text as a header above its row of options, so we don't pre-format
      // the question text into the markdown content (would duplicate).
      // Single question: click a chip and the answer sends. Multi-question:
      // stage selections per question, click "Send answers" to submit.
      const qs = data.questions || [];
      addMessage("assistant", "", "Qwen", qs);
      break;
    }
    case "thinking":
      setBusy(true);
      // The server's `queue` broadcast (fired when dequeueNext shifts the
      // item) already updated queuedCount + the panel. Nothing to do here
      // beyond entering the busy state.
      // Keep send button visible/clickable so user can queue more.
      stopBtn.style.display = "";
      stepCount = 0;
      elapsedSec = 0;
      statusDetail.innerHTML = "";
      addDetailLine("Starting...");
      setStatus("Thinking...", ACCENT, true);
      // Tick every second: bumps the parent's elapsed timer + recomputes
      // the status badge (so the stalled marker can transition without
      // requiring an external event) + re-renders the subagent strip
      // (so per-subagent elapsed counters stay current — they were
      // freezing at the last subagent_event snapshot, e.g. "(31s)" while
      // 200+ seconds had actually passed since the last broadcast).
      elapsedTimer = setInterval(function() {
        elapsedSec++;
        updateMeta();
        if (subagentStates.size > 0) renderSubagentStrip();
      }, 1000);
      break;
    case "progress":
      if (data.description) {
        stepCount++;
        setStatus(data.description, ACCENT, true);
        updateMeta();
        // `data.details` is the optional full-text payload — full thinking
        // string, pretty-printed tool input, full error list. Drives the
        // hover-tooltip in addDetailLine when present.
        addDetailLine(`[${stepCount}] ${data.description}`, data.details);
      }
      break;
    case "subagent_started":
      if (data.tool_use_id) {
        subagentStates.set(data.tool_use_id, {
          agent_type: data.agent_type || "unknown",
          description: data.description || "",
          status: "running",
          lastActivity: "starting...",
          lastEventTs: Date.now(),
          startTs: Date.now(),
        });
        renderSubagentStrip();
        updateMeta();
      }
      break;
    case "subagent_event":
      if (data.tool_use_id && subagentStates.has(data.tool_use_id)) {
        const s = subagentStates.get(data.tool_use_id);
        s.lastActivity = data.kind === "thinking"
          ? ("thinking: " + (data.summary || ""))
          : (data.description || data.kind || "...");
        s.lastEventTs = Date.now();
        renderSubagentStrip();
        updateMeta();
      }
      break;
    case "subagent_finished":
      if (data.tool_use_id && subagentStates.has(data.tool_use_id)) {
        const s = subagentStates.get(data.tool_use_id);
        s.status = data.status || "done";
        s.lastActivity = data.summary || s.lastActivity || "";
        s.lastEventTs = Date.now();
        renderSubagentStrip();
        updateMeta();
      }
      break;
    // assistant_speech / assistant_speech_text events removed: speech
    // rendering moved to the .voice card class. Server no longer emits
    // these for chat cards (see server/micaAgent.ts).
    case "assistant":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      // Subagent strip + badge clear on turn-end. The strip was a live
      // view of in-flight work; once the parent turn returns, the
      // subagent transcripts are part of the chat-bubble's expandable
      // detail anyway, so the strip's job is done.
      subagentStates.clear();
      renderSubagentStrip();
      // Advance cursor locally if the server moved it. Trigger a re-render
      // of cursor-dependent display state (greyed messages above the line,
      // horizon separator at the cursor position) so the change is visible
      // immediately — not only when the next message appends.
      {
        const prevCursor = contextCursor;
        if (typeof data.cursor === "number") contextCursor = data.cursor;
        if (contextCursor !== prevCursor) applyCursorDisplay();
      }
      // Prefer the turn's PEAK input tokens (last tool-loop iteration) over
      // turn-start baseline for the fill — the SDK appends every tool
      // result into each subsequent request and never shrinks the prompt,
      // so a turn that started "comfortable" can finish at 124% of cap.
      // The peak is what determines whether overflow happened or is about
      // to. Baseline goes alongside as the marker on the track.
      updateFuelGauge(
        data.inputTokens || data.baselineTokens || 0,
        data.baselineTokens || 0,
        data.contextWindow || 0,
      );
      lastCapacity = typeof data.capacity === "number" ? data.capacity : 0;
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(doneMsg, "#3fb950", false);
      // Final stats go on the RIGHT (statusMeta), replacing the live
      // "Xs · N steps" ticker. The SDK accumulates usage across every LLM
      // call in the turn (20 tool rounds → 20 prompt sends summed together),
      // so input_tokens is NOT "current context size" — it's cumulative
      // tokens shipped this turn. We report it as "sent XK" so users aren't
      // misled into thinking they're over the model's context window.
      //
      // Throughput display: we show TTFT (prefill wall time to first token)
      // and a decode-only tok/s computed over the post-TTFT window. Wall
      // tok/s is misleading on long-prompt / short-output turns because most
      // of elapsedSec is prefill, not decode. TTFT + decode tok/s matches
      // the OpenAI / Anthropic / llama.cpp convention and llama-server's
      // own per-request eval-time numbers.
      {
        const parts = [];
        if (elapsedSec > 0) parts.push(formatDuration(elapsedSec));
        if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
        const usage = data.usage || {};
        const outTok = usage.output_tokens || usage.completion_tokens;
        if (outTok && outTok > 0) {
          parts.push("out " + formatK(outTok) + " tok");
        }
        // Prefill: time to first token of the turn (cold prefill of initial
        // prompt → first assistant byte). For multi-step tool-loop turns,
        // this measures only the FIRST LLM call's prefill — subsequent calls
        // each re-prefill their growing context but aren't surfaced here.
        if (typeof data.ttftMs === "number" && data.ttftMs > 0) {
          parts.push("prefill " + (data.ttftMs / 1000).toFixed(1) + "s");
        }
        // Generation rate = output_tokens / wall_time_after_first_token.
        // For a simple chat reply (no tools) this matches llama-server's
        // eval_time rate and the web-UI "recipe for pizza" baseline.
        // For tool-loop turns (like 15-step Jira work) the denominator also
        // includes tool execution time + inter-call prefill time, so this
        // UNDER-estimates pure model decode speed — it's the user-perceived
        // generation throughput, not the model's raw token rate. Labelled
        // "gen" to distinguish from the theoretical decode rate you'd see
        // in llama-server's per-request eval_time log.
        if (outTok && outTok > 0 && typeof data.durationMs === "number" && typeof data.ttftMs === "number") {
          const genMs = Math.max(1, data.durationMs - data.ttftMs);
          const genTps = Math.round(outTok / (genMs / 1000));
          parts.push("gen " + genTps + " tok/s");
        }
        const inTok = usage.input_tokens || usage.prompt_tokens;
        if (inTok && inTok > 0) {
          parts.push("sent " + formatK(inTok) + " tok");
        }
        // Peak prompt size during this turn (last tool-loop iteration) —
        // single-call, comparable to contextWindow. This is the turn's
        // high-water mark; the value that overflow checks against.
        const peakTok = data.inputTokens || data.baselineTokens;
        if (peakTok && data.contextWindow && data.contextWindow > 0) {
          const pct = Math.round((peakTok / data.contextWindow) * 100);
          parts.push("peak " + formatK(peakTok) + "/" + formatK(data.contextWindow) + " (" + pct + "%)");
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
      addMessage("assistant", data.content, data.agent || "Qwen", data.questions, data.turn_id);
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
    case "propose_changes":
      renderProposeChanges(data);
      break;
    case "propose_changes_applied":
      markProposalApplied(data);
      break;
    case "propose_changes_dismissed":
      markProposalDismissed(data);
      break;
    case "error":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      // Subagent strip clears on any turn-end path. The server's drain
      // broadcasts subagent_finished:failed for tasks that didn't return,
      // but if the parent's error path is reached without a drain (e.g.,
      // socket disconnect), this defensively clears the strip too.
      subagentStates.clear();
      renderSubagentStrip();
      setStatus("Error", "#f87171", false);
      addDetailLine("ERROR: " + (data.error || "Unknown"));
      addMessage("assistant", "Error: " + (data.error || "Unknown"), "System");
      // retry:true marks a recoverable config failure (the health-gated
      // initialize scan was skipped because the model endpoint was
      // unreachable). Offer a Retry button that re-probes after the user fixes
      // settings in the ⚙️ gear; the server (retry_init) fires the pending
      // scan if the endpoint is now healthy.
      if (data.retry) {
        const retryWrap = window.document.createElement("div");
        retryWrap.style.cssText = "align-self:flex-start;margin:2px 0 6px;";
        const retryBtn = window.document.createElement("button");
        retryBtn.textContent = "Retry";
        retryBtn.style.cssText = "color:#e6edf3;background:rgba(124,58,237,0.25);border:1px solid rgba(124,58,237,0.5);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;";
        retryBtn.addEventListener("click", function() {
          retryBtn.disabled = true;
          retryBtn.textContent = "Retrying…";
          ch.send({ type: "retry_init" });
        });
        retryWrap.appendChild(retryBtn);
        messagesEl.appendChild(retryWrap);
        scrollBottom();
      }
      // Detect "turn exceeded the model's context window" — distinct from
      // baseline-driven capacity (which the >=80%/>=95% triggers above
      // measure). Cumulative tool-loop input can blow the per-call slot
      // even when baseline is at 8%, so the assistant-path triggers won't
      // catch it. Pattern-match the well-known phrasings from llama.cpp,
      // OpenAI, Anthropic, OpenRouter and force a Clear/Spawn prompt so
      // the user has a one-click escape.
      {
        const errMsg = String(data.error || "");
        const isContextOverflow =
          /exceeds (the )?(available )?context (size|length|window)/i.test(errMsg) ||
          /maximum context length/i.test(errMsg) ||
          /reduce the length of (either|the)/i.test(errMsg) ||
          /context_length_exceeded/i.test(errMsg);
        if (isContextOverflow) {
          addContextSuggestion(
            "Last turn exceeded the model's context window. The thread accumulated more tokens during tool use than the model can read in one call. Clearing or spawning a new card resets the working memory so you can continue.",
            { forceChoice: true }
          );
        }
      }
      break;
  }
});

ch.onClose(function() {});

// Pending screenshot attachment — set when the user picks a canvas file via
// the 📷 picker, cleared on send or on 'x'. When set, the send() below
// includes `attachmentFilename` in the outgoing message, and the server
// bypasses the Qwen SDK to call llama-server directly with the rendered
// card image as user-role content (see processImageMessage in micaAgent.ts).
// The tool-result image path via the MCP render_capture tool remains for
// agent-triggered verification during card authoring; this UI path is for
// the user's own "look at this and tell me what you see" queries.
let pendingAttachment = null;

function updateAttachChip() {
  if (pendingAttachment) {
    attachFilenameEl.textContent = pendingAttachment;
    attachRow.style.display = "flex";
  } else {
    attachRow.style.display = "none";
  }
}

function clearAttachment() {
  pendingAttachment = null;
  updateAttachChip();
}

attachClearBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  clearAttachment();
});

function hidePicker() { attachPicker.style.display = "none"; }

async function openPicker() {
  // Fetch the project's canvas files. The chat card itself is one of these;
  // filter it out along with other meta cards. Result is a short list of
  // pinned canvas content the user might want to screenshot.
  attachOptionsEl.innerHTML = '<div style="color:#6e7681;font-size:11px;padding:6px 8px;">Loading…</div>';
  attachPicker.style.display = "block";
  try {
    const res = await fetch(`/api/files?canvas=true`, { headers: { "X-Mica-Project": mica.project || "" } });
    const files = await res.json();
    const candidates = (files || []).filter((f) => !f.meta && f.name !== mica.filename);
    if (candidates.length === 0) {
      attachOptionsEl.innerHTML = '<div style="color:#6e7681;font-size:11px;padding:6px 8px;">No other cards on canvas.</div>';
      return;
    }
    attachOptionsEl.innerHTML = "";
    candidates.forEach((f) => {
      const opt = document.createElement("div");
      opt.textContent = f.name;
      opt.style.cssText = "padding:6px 8px;color:#e6edf3;font-size:12px;cursor:pointer;border-radius:3px;";
      opt.addEventListener("mouseenter", () => { opt.style.background = "rgba(124,58,237,0.15)"; });
      opt.addEventListener("mouseleave", () => { opt.style.background = "transparent"; });
      opt.addEventListener("click", () => {
        pendingAttachment = f.name;
        updateAttachChip();
        hidePicker();
        inputEl.focus();
      });
      attachOptionsEl.appendChild(opt);
    });
  } catch (err) {
    attachOptionsEl.innerHTML = `<div style="color:#f87171;font-size:11px;padding:6px 8px;">Failed to load files: ${err && err.message ? err.message : err}</div>`;
  }
}

attachBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (attachPicker.style.display === "block") hidePicker(); else openPicker();
});

// Hide picker on outside click.
document.addEventListener("click", (e) => {
  if (attachPicker.style.display !== "block") return;
  if (attachPicker.contains(e.target) || attachBtn.contains(e.target)) return;
  hidePicker();
});

function send() {
  const text = inputEl.value.trim();
  if (!text && !pendingAttachment) return;
  inputEl.value = "";
  // Server queues if busy — let the user keep typing while the agent works.
  // The {type:"queue"} broadcast that follows will update queuedCount + the
  // queue panel UI; no need to optimistically increment here.
  const payload = { message: text || "(no prompt)" };
  if (pendingAttachment) {
    payload.attachmentFilename = pendingAttachment;
    clearAttachment();
  }
  ch.send(payload);
  if (!busy) setBusy(true);
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
// Spawn: writes a new .qwen file next to this one with a user-chosen name.
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
    if (fuelEl) fuelEl.style.display = "none";
    recentBaselines.length = 0;
    lastCapacity = 0;
  }).catch(function(err) {
    console.error("[chat] clear failed:", err);
  });
}

// Spawn a new qwen card as a sibling of this one. Wired today only from
// the Clear/Spawn suggestion panel that appears under context pressure —
// the qwen card's header "+" button now advances the horizon instead
// (see advanceHorizon below). For a deliberate "make a separate qwen
// card" outside the suggestion-panel flow, use the canvas toolbar's
// `+ Qwen` button — that's the canonical path.
function spawnSiblingCard() {
  // Match both .qwen (current) and .chat (legacy, pre-2026-05-20 rename)
  // so suggestions derived from a long-lived card name still strip
  // cleanly. New files always land with .qwen.
  const suggested = (mica.filename || "")
    .replace(/\.(qwen|chat)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-");
  const base = window.prompt(
    "Name for the new qwen card (without .qwen extension):",
    suggested ? (suggested + "-next") : "new-qwen"
  );
  if (!base) return;
  const name = base.trim().replace(/\.(qwen|chat)$/i, "");
  if (!name) return;
  const parts = mica.filename.split("/");
  parts.pop();
  const dir = parts.join("/");
  const target = (dir ? dir + "/" : "") + name + ".qwen";
  mica.files.write(target, "").catch(function(err) {
    console.error("[qwen] spawn failed:", err);
    window.alert("Could not create " + target + ": " + (err && err.message ? err.message : "unknown"));
  });
}

// Force-advance the context cursor to the end of the live history. Renders
// a horizon below the current last message; everything above it stays
// visible (and scrollable) but the agent ignores it on the next turn.
// Use this when you know an arc is done before the agent emits the auto-
// arc-complete marker — e.g. you finished one feature and want to start
// a new topic in the same card. For a literally-new sibling card, use the
// canvas toolbar's `+ Chat` button (we used to mirror that here, but it
// duplicated the toolbar for a 2-second shortcut and crowded the header).
function advanceHorizon() {
  if (messageIndex === 0) return;  // empty card: nothing to fold above
  if (contextCursor >= messageIndex) return;  // already at the end
  const ok = window.confirm(
    "Mark this conversation as a fresh arc? Earlier messages will stay " +
    "visible but the agent won't see them on the next turn. " +
    "(This invalidates the prompt cache — a small cost if you're done with the current task.)"
  );
  if (!ok) return;
  fetch("/api/chats/" + encodeURIComponent(mica.cardId) + "/advance-cursor", {
    method: "POST",
    headers: projectHeaders({ "Content-Type": "application/json" }),
  }).then(function(r) { return r.json(); }).then(function(data) {
    // Server broadcasts cursor-advanced; we apply locally for instant UX.
    if (typeof data.cursor === "number") {
      contextCursor = data.cursor;
      applyCursorDisplay();
    }
    // Cursor advance archives prior messages out of the next turn's
    // prompt baseline. The fuel gauge's rolling buffers still hold the
    // pre-archive numbers, so it would keep showing "full" until a new
    // turn pushes fresh data. Reset both buffers + hide the gauge so
    // the UI honestly reflects "we don't know the new state until the
    // next turn lands." Mirrors the chat-cleared handler in the Claude
    // card.
    recentBaselines.length = 0;
    recentBaselinesActual.length = 0;
    if (fuelEl) fuelEl.style.display = "none";
    // Same reset for the subagent strip (no in-flight subagents survive
    // a cursor advance — but if the user clicked ^ during a stuck turn,
    // they may have orphan strip lines from a prior session).
    subagentStates.clear();
    renderSubagentStrip();
  }).catch(function(err) {
    console.error("[chat] advance-cursor failed:", err);
    window.alert("Could not advance horizon: " + (err && err.message ? err.message : "unknown"));
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
horizonBtn.addEventListener("click", function() { advanceHorizon(); });

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
  if (fuelEl) fuelEl.style.display = "none";
  recentBaselines.length = 0;
  lastCapacity = 0;
});
mica.onDestroy(_unsubChatCleared);

// Mirror cursor advances triggered from peer windows so all open clients
// agree on what's above the horizon. The local-trigger path in
// advanceHorizon() already updated this window optimistically; this
// listener handles the cross-window case.
const _unsubCursorAdvanced = mica.on("cursor-advanced", function(ev) {
  if (!ev || ev.chatId !== mica.cardId) return;
  if (typeof ev.cursor !== "number" || ev.cursor <= contextCursor) return;
  contextCursor = ev.cursor;
  applyCursorDisplay();
  // Same reset as advanceHorizon's local-trigger path: archived messages
  // won't be in the next turn's baseline, so the gauge's rolling buffers
  // are stale. Clear both and hide until the next turn provides accurate
  // data. Covers the cross-window case (advance triggered in tab A, this
  // is tab B) AND the agent-driven case (arc-complete marker advances
  // the cursor server-side without going through advanceHorizon).
  recentBaselines.length = 0;
  recentBaselinesActual.length = 0;
  if (fuelEl) fuelEl.style.display = "none";
  subagentStates.clear();
  renderSubagentStrip();
});
mica.onDestroy(_unsubCursorAdvanced);

stopBtn.addEventListener("click", function() {
  ch.send({ type: "interrupt" });
  setBusy(false);
  stopBtn.style.display = "none";
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatus("Stopped", "#fbbf24", false);
  // Server clears its queue on interrupt and broadcasts an empty queue
  // shortly after, but reset the local state immediately for snappy UI.
  renderQueuePanel([]);
});

inputEl.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
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
const settingsModelDropdown = container.querySelector('#chat-settings-model-dropdown');
const settingsKeyRow = container.querySelector('#chat-settings-key-row');
const settingsKey = container.querySelector('#chat-settings-key');
const settingsKeyStatus = container.querySelector('#chat-settings-key-status');
const settingsKeyLabel = container.querySelector('#chat-settings-key-label');
const settingsBaseurlRow = container.querySelector('#chat-settings-baseurl-row');
const settingsBaseurl = container.querySelector('#chat-settings-baseurl');
const providerRadios = container.querySelectorAll('input[name="chat-provider"]');

// Labels for the gear's "(default)" placeholder. openrouter + openai-compat are
// refreshed from GET /api/inference/defaults when the panel opens, so they
// reflect the server's env-resolved defaults ({OPENROUTER,OPENAI}_DEFAULT_MODEL);
// these literals are just the offline fallback.
const MODEL_DEFAULTS = {
  local: 'openai:local',
  openrouter: 'qwen/qwen3.6-35b-a3b',
  'openai-compat': 'deepseek/deepseek-v4-flash'
};

// Lazy-loaded OpenRouter model catalog. Populated on first openSettings()
// after the user picks the OpenRouter provider. Cached in-process here so
// switching the panel open/closed doesn't refetch; the server also caches
// for an hour. Field is freeform — typing a model id not in the list still
// works (you might have access to a private/preview model).
let openrouterModels = null;        // null = not loaded; [] = loaded empty/failed; [...] = loaded
let openrouterFetchInflight = null; // shared promise to dedupe parallel calls

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
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M ctx';
  if (n >= 1000) return Math.round(n / 1000) + 'K ctx';
  return n + ' ctx';
}

function formatModelMeta(m) {
  const parts = [];
  const pIn = formatPricePerM(m.promptPerM);
  const pOut = formatPricePerM(m.completionPerM);
  // "free" if both rates explicitly 0; otherwise show whichever side(s) we know.
  if (m.promptPerM === 0 && m.completionPerM === 0) {
    parts.push('free');
  } else if (pIn || pOut) {
    parts.push((pIn || '?') + '/M in · ' + (pOut || '?') + '/M out');
  }
  const ctx = formatContextLen(m.contextLength);
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
  const q = (query || '').trim().toLowerCase();
  // Filter: substring on id and name; rank exact-prefix > id-substring > name-substring.
  const matches = [];
  for (const m of openrouterModels) {
    const id = m.id || '';
    const idLow = id.toLowerCase();
    const name = m.name || '';
    const nameLow = name.toLowerCase();
    if (!q) { matches.push({ m, rank: 0 }); continue; }
    if (idLow.startsWith(q)) matches.push({ m, rank: 0 });
    else if (idLow.includes(q)) matches.push({ m, rank: 1 });
    else if (nameLow.includes(q)) matches.push({ m, rank: 2 });
  }
  if (matches.length === 0) {
    settingsModelDropdown.innerHTML = '<div style="padding:8px;color:#6e7681;font-size:11px;">No matches. The id is still saved as-is — useful for private/preview models.</div>';
    settingsModelDropdown.style.display = 'block';
    return;
  }
  matches.sort(function(a, b) { return a.rank - b.rank || a.m.id.localeCompare(b.m.id); });
  const top = matches.slice(0, 50);
  settingsModelDropdown.innerHTML = '';
  top.forEach(function(entry) {
    const m = entry.m;
    const row = document.createElement('div');
    row.className = 'or-model-row';
    row.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.04);';
    row.dataset.modelId = m.id;
    const idEl = document.createElement('div');
    idEl.style.cssText = 'color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
    idEl.textContent = m.id;
    row.appendChild(idEl);
    if (m.name && m.name !== m.id) {
      const nameEl = document.createElement('div');
      nameEl.style.cssText = 'color:#8b949e;font-size:11px;margin-top:1px;';
      nameEl.textContent = m.name;
      row.appendChild(nameEl);
    }
    // Pricing + context summary line. OpenRouter returns prices as USD per
    // token; the proxy converts to USD per million tokens (the universal
    // quote unit). Free models — both rates 0 — display as "free".
    const meta = formatModelMeta(m);
    if (meta) {
      const metaEl = document.createElement('div');
      metaEl.style.cssText = 'color:#7ec699;font-size:11px;margin-top:1px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
      metaEl.textContent = meta;
      row.appendChild(metaEl);
    }
    row.addEventListener('mouseenter', function() { row.style.background = 'rgba(124,58,237,0.18)'; });
    row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });
    // Use mousedown rather than click so the input's blur (which would hide
    // the dropdown) doesn't fire first and cancel the selection.
    row.addEventListener('mousedown', function(e) {
      e.preventDefault();
      settingsModel.value = m.id;
      hideModelDropdown();
    });
    settingsModelDropdown.appendChild(row);
  });
  if (matches.length > top.length) {
    const more = document.createElement('div');
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
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') { hideModelDropdown(); return; }
  fetchOpenrouterModels().then(function() {
    renderModelDropdown(settingsModel.value);
  });
}

settingsModel.addEventListener('focus', showModelDropdownIfOpenrouter);
settingsModel.addEventListener('input', function() {
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') return;
  if (openrouterModels === null) fetchOpenrouterModels().then(function() { renderModelDropdown(settingsModel.value); });
  else renderModelDropdown(settingsModel.value);
});
// Hide on blur with a small delay so the row's mousedown can complete.
settingsModel.addEventListener('blur', function() {
  setTimeout(hideModelDropdown, 120);
});

function updateProviderUI(provider) {
  if (provider === 'openrouter') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'none';
    settingsKeyLabel.innerHTML = 'OpenRouter API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = MODEL_DEFAULTS.openrouter + ' (default)';
    settingsModelHint.textContent = 'Pick from the list or type any OpenRouter model id, e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o.';
    // Pre-warm the catalog so the dropdown is responsive on first focus.
    fetchOpenrouterModels();
  } else if (provider === 'openai-compat') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'block';
    settingsKeyLabel.innerHTML = 'API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = MODEL_DEFAULTS['openai-compat'] + ' (default)';
    settingsModelHint.textContent = 'Type the model id your endpoint expects (e.g. gpt-4o-mini, mistralai/Mixtral-8x7B-Instruct-v0.1, your-vllm-model-name).';
    hideModelDropdown();
  } else {
    settingsKeyRow.style.display = 'none';
    settingsBaseurlRow.style.display = 'none';
    settingsModel.placeholder = MODEL_DEFAULTS.local + ' (default)';
    var engineLabel = serverEngine === 'vllm' ? 'vLLM'
      : serverEngine === 'llama-server' ? 'llama-server'
      : 'local engine';
    settingsModelHint.textContent = 'Running: ' + engineLabel + '. Model name here is informational; the engine serves whatever model it started with.';
    hideModelDropdown();
  }
}

providerRadios.forEach(function(r) {
  r.addEventListener('change', function() { updateProviderUI(r.value); });
});

function openSettings() {
  // Pull fresh state every time so opening the panel after another tab saved
  // shows the current values, not a stale snapshot. Also re-probe
  // /api/llm/status so the Local hint shows the live engine name on first
  // open — without this it would fall through to "local engine" until the
  // background poller's first response lands.
  Promise.allSettled([
    fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openrouter-key', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openai-config', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/llm/status').then(function(r) { return r.json(); }),
    fetch('/api/inference/defaults', { headers: projectHeaders() }).then(function(r) { return r.json(); })
  ]).then(function(results) {
    const s = results[0].status === 'fulfilled' ? results[0].value : {};
    const k = results[1].status === 'fulfilled' ? results[1].value : { hasKey: false };
    const oc = results[2].status === 'fulfilled' ? results[2].value : { baseUrl: null, hasKey: false };
    const llm = results[3].status === 'fulfilled' ? results[3].value : {};
    if (typeof llm.engine === 'string') serverEngine = llm.engine;
    // Refresh the gear's default-model placeholders from the server's
    // env-resolved values so they don't drift from what the handler actually uses.
    const d = results[4].status === 'fulfilled' ? results[4].value : null;
    if (d) {
      if (d.openrouter) MODEL_DEFAULTS.openrouter = d.openrouter;
      if (d['openai-compat']) MODEL_DEFAULTS['openai-compat'] = d['openai-compat'];
    }
    const provider = s.provider || 'local';
    providerRadios.forEach(function(r) { r.checked = (r.value === provider); });
    settingsModel.value = s.model || '';
    settingsKey.value = '';
    settingsBaseurl.value = oc.baseUrl || '';
    // Swap the input placeholder so the user can tell at a glance whether a
    // key is already stored. Leaving the field blank on save keeps the existing
    // key (see save handler), so the masked placeholder is purely visual.
    // Pick the placeholder that matches the SELECTED provider; the user only
    // ever sees the key field for the active provider.
    let hasKeyForProvider, keyHint;
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
    settingsPanel.style.display = 'block';
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
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  const model = settingsModel.value.trim();
  const keyValue = settingsKey.value;  // do NOT trim — leading/trailing whitespace in a key is the user's problem to fix, but we preserve the field exactly
  const baseurlValue = settingsBaseurl.value.trim();
  settingsSave.disabled = true;
  settingsSave.textContent = 'Saving...';

  // Clear any stale error styling from a previous attempt.
  settingsKeyStatus.style.color = '#6e7681';
  settingsModelHint.style.color = '#6e7681';

  // For OpenAI-compat, require a base URL. The dispatcher will refuse with a
  // confusing error otherwise, so catch it here and surface a clean message.
  if (provider === 'openai-compat' && !baseurlValue) {
    settingsModelHint.textContent = 'Base URL required (e.g., https://api.openai.com/v1).';
    settingsModelHint.style.color = '#f87171';
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
    return;
  }

  // For OpenRouter, validate the (key, model) pair with openrouter.ai BEFORE
  // saving anything. If either is rejected we keep the panel open and surface
  // the specific error next to the offending field. Other providers skip this.
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

    // Valid (or unverified) — save card settings and the matching credential
    // store in parallel. For openrouter the key goes to /api/openrouter-key;
    // for openai-compat the (baseUrl, key) pair goes to /api/openai-config.
    const cardP = fetch(settingsUrl(''), {
      method: 'PUT',
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ provider: provider, model: model })
    }).then(function(r) { return r.json(); });
    let credP;
    if (provider === 'openrouter') {
      credP = keyValue.length > 0
        ? fetch('/api/openrouter-key', {
            method: 'PUT',
            headers: projectHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ key: keyValue })
          }).then(function(r) { return r.json(); })
        : Promise.resolve(null);
    } else if (provider === 'openai-compat') {
      // Always send baseUrl (we required it above). Only send key if user
      // typed one — empty field means "keep the existing key".
      const body = { baseUrl: baseurlValue };
      if (keyValue.length > 0) body.key = keyValue;
      credP = fetch('/api/openai-config', {
        method: 'PUT',
        headers: projectHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body)
      }).then(function(r) { return r.json(); });
    } else {
      credP = Promise.resolve(null);
    }
    return Promise.all([cardP, credP]).then(function() {
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
