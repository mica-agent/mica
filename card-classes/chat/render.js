/**
 * Chat card class -- AI planning assistant using mica.chat.* API.
 * Status bar shows thinking/tool-calling state. Renders markdown responses.
 */

export const metadata = { extension: ".chat", badge: "AI", primaryFile: "chat.json", defaultTitle: "AI Chat" };

export const dependencies = {};

export default function render(content, config) {
  var color = '#4a8aff';

  return '<div id="chat-root" style="' +
    'display:flex;flex-direction:column;height:100%;min-height:260px;' +
    'background:#0d1117;border-radius:6px;overflow:hidden;' +
    'font-family:inherit;-webkit-font-smoothing:antialiased;">' +

    '<div id="chat-messages" style="' +
      'flex:1;overflow-y:auto;padding:8px 12px;min-height:0;' +
      'display:flex;flex-direction:column;gap:8px;">' +
      '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">' +
        'Ask the AI about your project. It can see all your files.' +
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
      '<input id="chat-input" type="text" placeholder="Ask about your project..." ' +
        'style="flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;' +
        'padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;font-family:inherit;" />' +
      '<button id="chat-clear" title="Clear" style="' +
        'background:transparent;border:1px solid #30363d;border-radius:6px;' +
        'color:#6e7681;font-size:13px;cursor:pointer;padding:6px 8px;font-family:inherit;">&#8634;</button>' +
      '<button id="chat-send" style="' +
        'background:' + color + ';color:#fff;border:none;border-radius:6px;' +
        'padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Send</button>' +
    '</div>' +
  '</div>' +

  '<style>' +
    '@keyframes chatpulse { 0%,100%{opacity:1} 50%{opacity:0.25} }' +
    '.chat-md p { margin:0 0 8px; }' +
    '.chat-md p:last-child { margin-bottom:0; }' +
    '.chat-md code { background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace; }' +
    '.chat-md pre { background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0; }' +
    '.chat-md pre code { background:none;padding:0;font-size:12px; }' +
    '.chat-md ul, .chat-md ol { margin:4px 0;padding-left:20px; }' +
    '.chat-md li { margin:2px 0; }' +
    '.chat-md h1,.chat-md h2,.chat-md h3 { margin:8px 0 4px;color:#e6edf3; }' +
    '.chat-md h1 { font-size:16px; } .chat-md h2 { font-size:14px; } .chat-md h3 { font-size:13px; }' +
    '.chat-md blockquote { border-left:3px solid #444;margin:6px 0;padding:2px 10px;color:#999; }' +
    '.chat-md strong { color:#fff; }' +
    '.chat-md a { color:#58a6ff; }' +
    '.chat-md table { border-collapse:collapse;margin:6px 0;font-size:12px; }' +
    '.chat-md th,.chat-md td { border:1px solid #333;padding:4px 8px; }' +
    '.chat-md th { background:rgba(255,255,255,0.05); }' +
    '#chat-input:focus { border-color: rgba(74,138,255,0.5); }' +
  '</style>' +

  '<script>' +
  '(function() {' +
    'var messagesEl = container.querySelector("#chat-messages");' +
    'var inputEl = container.querySelector("#chat-input");' +
    'var sendBtn = container.querySelector("#chat-send");' +
    'var clearBtn = container.querySelector("#chat-clear");' +
    'var statusBar = container.querySelector("#chat-statusbar");' +
    'var statusDot = container.querySelector("#chat-dot");' +
    'var statusLabel = container.querySelector("#chat-status-label");' +
    'var statusMeta = container.querySelector("#chat-status-meta");' +
    'var ACCENT = "' + color + '";' +
    'var chatId = mica.filename.replace(".chat", "");' +
    'var busy = false;' +
    'var elapsedSec = 0;' +
    'var elapsedTimer = null;' +

    'function scrollBottom() {' +
      'requestAnimationFrame(function() { messagesEl.scrollTop = messagesEl.scrollHeight; });' +
    '}' +

    'function escapeHtml(text) {' +
      'var div = window.document.createElement("div");' +
      'div.textContent = text;' +
      'return div.innerHTML;' +
    '}' +

    'function renderMarkdown(text) {' +
      'text = text.replace(/^```markdown\\n([\\s\\S]*?)```$/gm, function(m, inner) { return inner; });' +
      'var fenced = [];' +
      'text = text.replace(/```(\\w*)\\n([\\s\\S]*?)```/g, function(m, lang, code) {' +
        'fenced.push("<pre style=\\"background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0\\"><code style=\\"font-size:12px;font-family:monospace\\">" + code.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;") + "</code></pre>");' +
        'return "__FENCED__" + (fenced.length - 1) + "\\x00";' +
      '});' +
      'text = text' +
        '.replace(/&/g, "&amp;")' +
        '.replace(/</g, "&lt;")' +
        '.replace(/>/g, "&gt;")' +
        '.replace(/^### (.+)$/gm, "<h3>$1</h3>")' +
        '.replace(/^## (.+)$/gm, "<h2>$1</h2>")' +
        '.replace(/^# (.+)$/gm, "<h1>$1</h1>")' +
        '.replace(/\\*\\*(.+?)\\*\\*/g, "<strong>$1</strong>")' +
        '.replace(/\\*(.+?)\\*/g, "<em>$1</em>")' +
        ".replace(/`([^`]+)`/g, '<code style=\"background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace\">$1</code>')" +
        '.replace(/^- \\[x\\] (.+)$/gm, \'<div style="opacity:0.6"><input type="checkbox" checked disabled /> <s>$1</s></div>\')' +
        '.replace(/^- \\[ \\] (.+)$/gm, \'<div><input type="checkbox" disabled /> $1</div>\')' +
        '.replace(/^- (.+)$/gm, "<li>$1</li>")' +
        '.replace(/^\\d+\\. (.+)$/gm, "<li>$1</li>")' +
        '.replace(/\\n\\n/g, "<br/><br/>")' +
        '.replace(/\\n/g, "<br/>");' +
      'for (var fi = 0; fi < fenced.length; fi++) {' +
        'text = text.replace("__FENCED__" + fi + "\\x00", fenced[fi]);' +
      '}' +
      'return text;' +
    '}' +

    'function addMessage(role, content) {' +
      'if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {' +
        'messagesEl.innerHTML = "";' +
      '}' +
      'var msg = window.document.createElement("div");' +
      'if (role === "user") {' +
        'msg.style.cssText = "align-self:flex-end;background:rgba(74,138,255,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";' +
        'msg.innerHTML = \'<div style="color:#e6edf3;font-size:13px;line-height:1.5;">\' + escapeHtml(content) + "</div>";' +
      '} else {' +
        'msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";' +
        'msg.innerHTML = \'<div style="color:' + color + ';font-size:11px;font-weight:600;margin-bottom:4px;">AI</div>\' +' +
          '\'<div class="chat-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">\' + renderMarkdown(content) + "</div>";' +
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

    'function renderHistory(messages) {' +
      'messagesEl.innerHTML = "";' +
      'if (!messages || messages.length === 0) {' +
        'messagesEl.innerHTML = \'<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Ask the AI about your project. It can see all your files.</div>\';' +
        'setStatus("Ready", "#3fb950", false);' +
        'return;' +
      '}' +
      'for (var i = 0; i < messages.length; i++) {' +
        'addMessage(messages[i].role, messages[i].content);' +
      '}' +
      'setStatus("Ready", "#3fb950", false);' +
    '}' +

    'fetch("/api/mica/chat/history", {' +
      'method: "POST",' +
      'headers: { "Content-Type": "application/json" },' +
      'body: JSON.stringify({ chatId: chatId })' +
    '})' +
    '.then(function(r) { return r.json(); })' +
    '.then(function(data) { renderHistory(data.history || []); })' +
    '.catch(function() { renderHistory([]); });' +

    'function sendMessage() {' +
      'var msg = inputEl.value.trim();' +
      'if (!msg || busy) return;' +
      'inputEl.value = "";' +
      'busy = true;' +
      'sendBtn.disabled = true;' +
      'elapsedSec = 0;' +
      'addMessage("user", msg);' +
      'setStatus("Thinking...", ACCENT, true);' +
      'elapsedTimer = setInterval(function() {' +
        'elapsedSec++;' +
        'statusMeta.textContent = elapsedSec + "s";' +
      '}, 1000);' +

      'fetch("/api/mica/chat/send", {' +
        'method: "POST",' +
        'headers: { "Content-Type": "application/json" },' +
        'body: JSON.stringify({ chatId: chatId, message: msg })' +
      '})' +
      '.then(function(r) { return r.json(); })' +
      '.then(function(data) {' +
        'busy = false;' +
        'sendBtn.disabled = false;' +
        'if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }' +
        'if (data.error) {' +
          'setStatus("Error", "#f87171", false);' +
          'addMessage("assistant", "Error: " + data.error);' +
        '} else {' +
          'setStatus("Done (" + elapsedSec + "s)", "#3fb950", false);' +
          'addMessage("assistant", data.reply);' +
        '}' +
      '})' +
      '.catch(function(err) {' +
        'busy = false;' +
        'sendBtn.disabled = false;' +
        'if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }' +
        'setStatus("Error", "#f87171", false);' +
        'addMessage("assistant", "Error: " + err.message);' +
      '});' +
    '}' +

    'sendBtn.addEventListener("click", sendMessage);' +
    'inputEl.addEventListener("keydown", function(e) {' +
      'if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }' +
    '});' +

    'clearBtn.addEventListener("click", function() {' +
      'fetch("/api/mica/chat/clear", {' +
        'method: "POST",' +
        'headers: { "Content-Type": "application/json" },' +
        'body: JSON.stringify({ chatId: chatId })' +
      '})' +
      '.then(function() { renderHistory([]); })' +
      '.catch(function(err) { console.error("Clear failed:", err); });' +
    '});' +

    'mica.onDestroy(function() { if (elapsedTimer) clearInterval(elapsedTimer); });' +
  '})();' +
  '</script>';
}
