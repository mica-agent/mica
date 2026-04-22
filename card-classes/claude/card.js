// Chat card — Claude Code agentic coding assistant
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

// Toggle the busy flag AND a .wb-card--busy class on the outer card wrapper.
// Drives the breathing halo defined in whiteboard.css (same one the qwen
// chat card uses). Rings the completion chime on busy→idle so any path
// that ends a turn triggers it without needing per-branch playChime calls.
function setBusy(b) {
  const wasBusy = busy;
  busy = b;
  const card = container.closest('.wb-card');
  if (card) card.classList.toggle('wb-card--busy', b);
  if (wasBusy && !b) playChime();
}
let queuedCount = 0;  // user messages typed during busy — server queues them
let elapsedSec = 0;
let elapsedTimer = null;
let stepCount = 0;

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
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
}

// Open channel to server agent
const ch = mica.openChannel("agent_session");

// Claude Code uses the cloud — no local model-loading status to poll.
inputEl.placeholder = 'Ask Claude Code...';
sendBtn.disabled = false;

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

// Two-note chime played when a turn finishes (success or error). One
// AudioContext per card, lazily created. resume() flips a suspended ctx to
// running once a user gesture has occurred.
let _audioCtx = null;
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    const ac = _audioCtx;
    const fire = function() {
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
      ac.resume().then(fire).catch(function() {});
    } else {
      fire();
    }
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
        messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start Claude Code.</div>';
      }
      setStatus("Ready", "#3fb950", false);
      break;
    case "user":
      addMessage("user", data.content);
      break;
    case "user_question": {
      // Mid-turn structured question from the agent. Broadcast immediately
      // by server when ask_user_question is intercepted so it surfaces even
      // if the agent misinterprets the deny message and keeps running.
      const qs = data.questions || [];
      const content = qs.map(function(q) { return "**" + (q.question || "") + "**"; }).join("\n\n");
      addMessage("assistant", content, "Claude", qs);
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
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(`${doneMsg} (${elapsedSec}s, ${stepCount} steps)`, "#3fb950", false);
      addDetailLine(`Completed in ${elapsedSec}s with ${stepCount} steps`);
      addMessage("assistant", data.content, data.agent || "Claude");
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

const _projectHeaders = { "X-Mica-Project": (typeof mica !== "undefined" && mica.project) || "" };

function loadContextInfo() {
  const url = "/api/claude-agent/context-preview?filename=" + encodeURIComponent(mica.filename);
  fetch(url, { headers: _projectHeaders }).then(function(r) { return r.json(); }).then(function(data) {
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

mica.onDestroy(function() {
  ch.close();
  if (elapsedTimer) clearInterval(elapsedTimer);
});
