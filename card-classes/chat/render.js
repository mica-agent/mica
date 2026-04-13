/**
 * Qwen Agent card class -- agentic coding assistant using @qwen-code/sdk.
 * Connects via WebSocket channel for streaming tool use and responses.
 */

export const metadata = { extension: ".chat", badge: "QWEN", primaryFile: "chat.json", defaultTitle: "Qwen Agent" };

export const dependencies = {};

export default function render(content, config) {
  var color = '#7c3aed';

  return '<div id="chat-root" style="' +
    'display:flex;flex-direction:column;height:100%;min-height:260px;' +
    'background:#0d1117;border-radius:6px;overflow:hidden;font-family:inherit;' +
    '-webkit-font-smoothing:antialiased;">' +

    '<div id="chat-messages" style="' +
      'flex:1;overflow-y:auto;padding:8px 12px;min-height:0;' +
      'display:flex;flex-direction:column;gap:8px;">' +
      '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">' +
        'Send a message to start the Qwen Code agent.' +
      '</div>' +
    '</div>' +

    '<div id="chat-statusbar" style="display:none;flex-shrink:0;">' +
      '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;' +
        'border-top:1px solid #30363d;font-size:12px;color:#8b949e;">' +
        '<span id="chat-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span>' +
        '<span id="chat-status-label" style="flex:1;"></span>' +
        '<span id="chat-status-meta" style="flex-shrink:0;font-size:11px;"></span>' +
      '</div>' +
    '</div>' +

    '<div style="display:flex;gap:6px;padding:8px 12px;border-top:1px solid #30363d;flex-shrink:0;">' +
      '<input id="chat-input" type="text" placeholder="Ask Qwen Agent..." style="' +
        'flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;' +
        'padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;font-family:inherit;" />' +
      '<button id="chat-stop" style="' +
        'background:#f87171;color:#fff;border:none;border-radius:6px;' +
        'padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;display:none;">Stop</button>' +
      '<button id="chat-send" style="' +
        'background:' + color + ';color:#fff;border:none;border-radius:6px;' +
        'padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Send</button>' +
    '</div>' +
  '</div>' +

  '<style>' +
    '@keyframes chatpulse { 0%,100%{opacity:1} 50%{opacity:0.25} }' +
    '.chat-md p { margin:0 0 8px; } .chat-md p:last-child { margin-bottom:0; }' +
    '.chat-md code { background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace; }' +
    '.chat-md pre { background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0; }' +
    '.chat-md pre code { background:none;padding:0; }' +
    '.chat-md ul,.chat-md ol { margin:4px 0;padding-left:20px; } .chat-md li { margin:2px 0; }' +
    '.chat-md h1,.chat-md h2,.chat-md h3 { margin:8px 0 4px;color:#e6edf3; }' +
    '.chat-md h1 { font-size:16px; } .chat-md h2 { font-size:14px; } .chat-md h3 { font-size:13px; }' +
    '.chat-md strong { color:#fff; } .chat-md a { color:#58a6ff; }' +
    '#chat-input:focus { border-color: rgba(124,58,237,0.5); }' +
  '</style>' +

  '<script>' +
  '(function() {' +
    'var messagesEl = container.querySelector("#chat-messages");' +
    'var inputEl = container.querySelector("#chat-input");' +
    'var sendBtn = container.querySelector("#chat-send");' +
    'var stopBtn = container.querySelector("#chat-stop");' +
    'var statusBar = container.querySelector("#chat-statusbar");' +
    'var statusDot = container.querySelector("#chat-dot");' +
    'var statusLabel = container.querySelector("#chat-status-label");' +
    'var statusMeta = container.querySelector("#chat-status-meta");' +
    'var ACCENT = "' + color + '";' +
    'var busy = false;' +
    'var elapsedSec = 0;' +
    'var elapsedTimer = null;' +
    'var stepCount = 0;' +

    // Open channel to server agent
    'var ch = mica.openChannel("agent_session");' +

    'function scrollBottom() { requestAnimationFrame(function() { messagesEl.scrollTop = messagesEl.scrollHeight; }); }' +

    'function escapeHtml(s) { var d = window.document.createElement("div"); d.textContent = s; return d.innerHTML; }' +

    'function renderMarkdown(text) {' +
      'text = text.replace(/^```markdown\\n([\\s\\S]*?)```$/gm, function(m, inner) { return inner; });' +
      'var fenced = [];' +
      'text = text.replace(/```(\\w*)\\n([\\s\\S]*?)```/g, function(m, lang, code) {' +
        'fenced.push("<pre style=\\"background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0\\"><code style=\\"font-size:12px;font-family:monospace\\">" + code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</code></pre>");' +
        'return "__FENCED__" + (fenced.length - 1) + "__";' +
      '});' +
      'text = text' +
        '.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")' +
        '.replace(/^### (.+)$/gm, "<h3>$1</h3>")' +
        '.replace(/^## (.+)$/gm, "<h2>$1</h2>")' +
        '.replace(/^# (.+)$/gm, "<h1>$1</h1>")' +
        '.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")' +
        '.replace(/\\*(.+?)\\*/g, "<em>$1</em>")' +
        ".replace(/`([^`]+)`/g, '<code style=\"background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace\">$1</code>')" +
        '.replace(/^- (.+)$/gm, "<li>$1</li>")' +
        '.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>")' +
        '.replace(/\\n\\n/g, "<br/><br/>")' +
        '.replace(/\\n/g, "<br/>");' +
      'for (var fi = 0; fi < fenced.length; fi++) {' +
        'text = text.replace("__FENCED__" + fi + "__", fenced[fi]);' +
      '}' +
      'return text;' +
    '}' +

    'function addMessage(role, content, agent) {' +
      'if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {' +
        'messagesEl.innerHTML = "";' +
      '}' +
      'var msg = window.document.createElement("div");' +
      'if (role === "user") {' +
        'msg.style.cssText = "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";' +
        'msg.innerHTML = \'<div style="color:#e6edf3;font-size:13px;line-height:1.5;">\' + escapeHtml(content) + "</div>";' +
      '} else {' +
        'msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";' +
        'var header = agent ? \'<div style="color:\' + ACCENT + \';font-size:11px;font-weight:600;margin-bottom:4px;">\' + escapeHtml(agent) + "</div>" : "";' +
        'msg.innerHTML = header + \'<div class="chat-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">\' + renderMarkdown(content) + "</div>";' +
      '}' +
      'messagesEl.appendChild(msg);' +
      'scrollBottom();' +
    '}' +

    'function setStatus(text, dot, pulsing) {' +
      'statusBar.style.display = "block";' +
      'statusDot.style.background = dot;' +
      'statusDot.style.animation = pulsing ? "chatpulse 1.2s ease-in-out infinite" : "none";' +
      'statusLabel.textContent = text;' +
    '}' +

    'function updateMeta() {' +
      'var parts = [];' +
      'if (elapsedSec > 0) parts.push(elapsedSec + "s");' +
      'if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));' +
      'statusMeta.textContent = parts.join(" . ");' +
    '}' +

    // Handle channel data from server
    'ch.onData(function(data) {' +
      'switch (data.type) {' +
        'case "history":' +
          'messagesEl.innerHTML = "";' +
          'if (data.messages && data.messages.length > 0) {' +
            'for (var i = 0; i < data.messages.length; i++) addMessage(data.messages[i].role, data.messages[i].content, data.messages[i].agent);' +
          '} else {' +
            'messagesEl.innerHTML = \'<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start the Qwen Code agent.</div>\';' +
          '}' +
          'setStatus("Ready", "#3fb950", false);' +
          'break;' +
        'case "user": addMessage("user", data.content); break;' +
        'case "thinking":' +
          'busy = true; sendBtn.disabled = true; sendBtn.style.display = "none"; stopBtn.style.display = "";' +
          'stepCount = 0; elapsedSec = 0;' +
          'setStatus("Thinking...", ACCENT, true);' +
          'elapsedTimer = setInterval(function() { elapsedSec++; updateMeta(); }, 1000);' +
          'break;' +
        'case "progress":' +
          'if (data.description) { stepCount++; setStatus(data.description, ACCENT, true); updateMeta(); }' +
          'break;' +
        'case "assistant":' +
          'busy = false; sendBtn.disabled = false; sendBtn.style.display = ""; stopBtn.style.display = "none";' +
          'if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }' +
          'setStatus(data.filesChanged ? "Canvas updated" : "Done", "#3fb950", false);' +
          'addMessage("assistant", data.content, data.agent || "Qwen");' +
          'break;' +
        'case "error":' +
          'busy = false; sendBtn.disabled = false; sendBtn.style.display = ""; stopBtn.style.display = "none";' +
          'if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }' +
          'setStatus("Error", "#f87171", false);' +
          'addMessage("assistant", "Error: " + (data.error || "Unknown"), "System");' +
          'break;' +
      '}' +
    '});' +

    'ch.onClose(function() {});' +

    'function send() {' +
      'var text = inputEl.value.trim();' +
      'if (!text || busy) return;' +
      'inputEl.value = "";' +
      'ch.send({ message: text });' +
    '}' +

    'sendBtn.addEventListener("click", send);' +
    'stopBtn.addEventListener("click", function() {' +
      'ch.send({ type: "interrupt" });' +
      'busy = false; sendBtn.disabled = false; sendBtn.style.display = ""; stopBtn.style.display = "none";' +
      'if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }' +
      'setStatus("Stopped", "#fbbf24", false);' +
    '});' +
    'inputEl.addEventListener("keydown", function(e) {' +
      'if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }' +
    '});' +

    'mica.onDestroy(function() { ch.close(); if (elapsedTimer) clearInterval(elapsedTimer); });' +
  '})();' +
  '</script>';
}
