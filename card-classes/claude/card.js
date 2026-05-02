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
// Fuel gauge (B — future: capacity trajectory). See chat card for rationale.
// recentBaselines is misnamed — stores PEAK input_tokens; recentBaselinesActual
// stores the turn-start baseline. The gap between them on the gauge shows
// how much tool-result accumulation happened during the turn.
const fuelEl = container.querySelector("#chat-fuel");
const fuelFill = fuelEl ? fuelEl.querySelector(".fuel-fill") : null;
const fuelBaselineMarker = fuelEl ? fuelEl.querySelector(".fuel-baseline-marker") : null;
const fuelHeadroomLabel = container.querySelector("#chat-fuel-headroom");
const FUEL_HISTORY_CAP = 5;
const recentBaselines = [];
const recentBaselinesActual = [];
let lastContextWindow = 0;
const clearBtn = container.querySelector("#chat-clear-btn");
const spawnBtn = container.querySelector("#chat-spawn-btn");
const archiveBtn = container.querySelector("#chat-archive-btn");
const archivePanel = container.querySelector("#chat-archive-panel");
const archiveListEl = container.querySelector("#chat-archive-list");

let detailExpanded = false;
const ACCENT = "#7c3aed";
let busy = false;
// Context cursor — see chat card for details.
let contextCursor = 0;
let messageIndex = 0;
let lastCapacity = 0;

function projectHeaders(extra) {
  const h = { "X-Mica-Project": (typeof mica !== "undefined" && mica.project) || "" };
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

function formatK(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}

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

// Hydrate fuel gauge buffer from recent turn history on mount.
hydrateFuelGauge();

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

// Re-evaluate cursor-dependent display state across every rendered message
// and re-position the single horizon separator. Call after a mid-session
// cursor advance so the break is visible immediately.
function applyCursorDisplay() {
  const existing = messagesEl.querySelector(".chat-horizon");
  if (existing) existing.remove();
  const msgs = messagesEl.querySelectorAll("[data-msg-index]");
  let inserted = false;
  for (const m of msgs) {
    const idx = parseInt(m.getAttribute("data-msg-index"), 10);
    m.style.opacity = idx < contextCursor ? "0.55" : "";
    if (!inserted && contextCursor > 0 && idx >= contextCursor) {
      messagesEl.insertBefore(buildHorizonEl(), m);
      inserted = true;
    }
  }
}

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
  msg.setAttribute("data-msg-index", String(messageIndex));
  const aboveHorizon = messageIndex < contextCursor;
  if (aboveHorizon) msg.style.opacity = "0.55";
  messageIndex++;
  if (role === "user") {
    msg.style.cssText = "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";
    msg.innerHTML = `<div style="color:#e6edf3;font-size:13px;line-height:1.5;">${escapeHtml(content)}</div>`;
  } else {
    msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
    // A — past, per-turn footer chevron. See chat card for full design.
    const chevron = turnId ? `<span class="chat-bubble-toggle" data-turn-id="${escapeHtml(turnId)}" title="Show turn details" style="cursor:pointer;color:#8b949e;font-size:13px;font-weight:600;margin-left:8px;padding:1px 5px;border-radius:3px;display:inline-block;line-height:1;transition:transform 120ms ease, background-color 120ms ease;">▸</span>` : "";
    const header = agent ? `<div style="color:${ACCENT};font-size:11px;font-weight:600;margin-bottom:4px;">${escapeHtml(agent)}${chevron}</div>` : "";
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

// A — past, per-turn footer (delegated click handler). See chat card for
// full rationale. Lazy-builds the chip strip + snapshot link on first
// expand; toggles visibility on subsequent clicks without re-fetching.
function formatChips(turn, subagents) {
  const tc = turn.tool_calls || {};
  const skillsList = Array.isArray(turn.skills_invoked) ? turn.skills_invoked : [];
  const subList = Array.isArray(subagents) ? subagents : [];
  const toolEntries = Object.keys(tc).map(function(k) { return [k, tc[k]]; }).sort(function(a, b) { return b[1] - a[1]; });
  const totalToolCalls = toolEntries.reduce(function(s, e) { return s + e[1]; }, 0);
  const topTools = toolEntries.slice(0, 3).map(function(e) { return e[0] + " " + e[1]; }).join(" · ");
  const skillsTitle = skillsList.length > 0 ? skillsList.join(", ") : "(none)";
  const subsTitle = subList.length > 0
    ? subList.map(function(s) { return s.subagent_name + " · " + Math.round(s.duration_ms / 100) / 10 + "s"; }).join("\n")
    : "(none)";
  const durationSec = turn.duration_ms ? Math.round(turn.duration_ms / 100) / 10 : 0;
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
    const isHidden = footer.style.display === "none";
    footer.style.display = isHidden ? "flex" : "none";
    toggle.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
    return;
  }
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
    // strips the X-Mica-Project header. Server's getRequestProject() accepts either.
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

// B (future) — fuel gauge with capacity trajectory. See chat card for the
// full design rationale. Pushes (peak, baseline) into rolling buffers,
// redraws fill from peak with a marker at baseline.
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

function renderFuelGauge() {
  if (!fuelEl || !fuelFill) return;
  const cw = lastContextWindow;
  const latest = recentBaselines.length > 0 ? recentBaselines[recentBaselines.length - 1] : 0;
  if (!latest || !cw || cw <= 0) { fuelEl.style.display = "none"; return; }
  fuelEl.style.display = "inline-flex";
  const pct = Math.max(0, Math.min(100, Math.round((latest / cw) * 100)));
  fuelFill.style.width = pct + "%";
  let color = "#4ade80";
  if (pct >= 80) color = "#f87171";
  else if (pct >= 50) color = "#fbbf24";
  fuelFill.style.background = color;
  // Baseline marker — vertical line at baseline%, hidden when no baseline
  // is available (hydration path with peak-only history).
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
  const peakList = recentBaselines.map(formatK).join(", ");
  let title = "Peak: " + formatK(latest) + " / " + formatK(cw) + " (" + pct + "%)\n";
  if (latestBaseline > 0) {
    title += "Baseline: " + formatK(latestBaseline) + " (" + baselinePct + "%)\n";
  }
  title += "Recent peaks: " + peakList + "\n" + headroomTitle;
  fuelEl.title = title;
}

function hydrateFuelGauge() {
  fetch("/api/agent/turn-history/" + encodeURIComponent(mica.cardId) + "?limit=" + FUEL_HISTORY_CAP, {
    headers: projectHeaders(),
  }).then(function(r) { return r.json(); }).then(function(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    items.reverse();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
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
  }).catch(function() { /* swallow */ });
}

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
    row.appendChild(mkBtn("Keep going", false, function() { /* dismissed */ }));
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
          addMessage(data.messages[i].role, data.messages[i].content, data.messages[i].agent, undefined, data.messages[i].turn_id);
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
      // Advance cursor locally and re-render cursor-dependent display
      // (greyed pre-cursor messages + horizon separator) so a mid-session
      // advance is visible immediately, not delayed to the next message.
      {
        const prevCursor = contextCursor;
        if (typeof data.cursor === "number") contextCursor = data.cursor;
        if (contextCursor !== prevCursor) applyCursorDisplay();
      }
      // Prefer the turn's PEAK input tokens over turn-start baseline for
      // the fill — peak tells you whether the turn brushed the ceiling.
      // Baseline goes alongside as the marker on the track.
      updateFuelGauge(
        data.inputTokens || data.baselineTokens || 0,
        data.baselineTokens || 0,
        data.contextWindow || 0,
      );
      lastCapacity = typeof data.capacity === "number" ? data.capacity : 0;
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      setStatus(`${doneMsg} (${elapsedSec}s, ${stepCount} steps)`, "#3fb950", false);
      addDetailLine(`Completed in ${elapsedSec}s with ${stepCount} steps`);
      addMessage("assistant", data.content, data.agent || "Claude", undefined, data.turn_id);
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

// ── Clear / Spawn / Archive browser ────────────────────────

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
    messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared. Send a message to start a new one.</div>';
    contextCursor = 0;
    messageIndex = 0;
    if (fuelEl) fuelEl.style.display = "none";
    recentBaselines.length = 0;
    recentBaselinesActual.length = 0;
    lastCapacity = 0;
  }).catch(function(err) { console.error("[claude] clear failed:", err); });
}

function spawnSiblingCard() {
  const match = (mica.filename || "").match(/\.([^./]+)$/);
  const ext = match ? match[1] : "claude";
  const base = (mica.filename || "").replace(/\.[^./]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  const prompt = window.prompt(
    "Name for the new " + ext + " card (without ." + ext + " extension):",
    base ? (base + "-next") : "new-" + ext
  );
  if (!prompt) return;
  const name = prompt.trim().replace(new RegExp("\\." + ext + "$", "i"), "");
  if (!name) return;
  const parts = mica.filename.split("/");
  parts.pop();
  const dir = parts.join("/");
  const target = (dir ? dir + "/" : "") + name + "." + ext;
  mica.files.write(target, "").catch(function(err) {
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
      row.style.cssText = "padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;";
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
    modal.style.cssText = "position:absolute;inset:0;background:rgba(13,17,23,0.96);backdrop-filter:blur(2px);z-index:25;display:flex;flex-direction:column;padding:12px 16px;font-size:12px;color:#e6edf3;";
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
  }).catch(function(err) { console.error("[claude] archive viewer failed:", err); });
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

const _unsubChatCleared = mica.on("chat-cleared", function(ev) {
  if (!ev || ev.chatId !== mica.cardId) return;
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared.</div>';
  contextCursor = 0;
  messageIndex = 0;
  if (fuelEl) fuelEl.style.display = "none";
  recentBaselines.length = 0;
  recentBaselinesActual.length = 0;
  lastCapacity = 0;
});
mica.onDestroy(_unsubChatCleared);

mica.onDestroy(function() {
  ch.close();
  if (elapsedTimer) clearInterval(elapsedTimer);
});
