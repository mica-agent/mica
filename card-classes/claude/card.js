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

function addMessage(role, content, agent) {
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
    case "thinking":
      busy = true;
      sendBtn.disabled = true;
      sendBtn.style.display = "none";
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
      busy = false;
      sendBtn.disabled = false;
      sendBtn.style.display = "";
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(`${doneMsg} (${elapsedSec}s, ${stepCount} steps)`, "#3fb950", false);
      addDetailLine(`Completed in ${elapsedSec}s with ${stepCount} steps`);
      addMessage("assistant", data.content, data.agent || "Claude");
      break;
    case "error":
      busy = false;
      sendBtn.disabled = false;
      sendBtn.style.display = "";
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
  if (!text || busy) return;
  inputEl.value = "";
  ch.send({ message: text });
}

sendBtn.addEventListener("click", send);

stopBtn.addEventListener("click", function() {
  ch.send({ type: "interrupt" });
  busy = false;
  sendBtn.disabled = false;
  sendBtn.style.display = "";
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

mica.onDestroy(function() {
  ch.close();
  if (elapsedTimer) clearInterval(elapsedTimer);
});
