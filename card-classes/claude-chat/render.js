/**
 * Claude Chat card class — interactive chat with Claude agent.
 * Opens a chat_session channel with provider: "claude".
 */

export default function render(content, config) {
  return chatCardHtml("claude", "Claude", "#60a5fa", "◆");
}

function chatCardHtml(provider, label, color, icon) {
  return `
<div id="chat-root" style="
  display:flex;flex-direction:column;height:100%;min-height:260px;
  background:#0d1117;border-radius:6px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
">
  <!-- Header -->
  <div style="
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;
  ">
    <span style="color:${color};font-size:14px;">${icon}</span>
    <span style="color:#e6edf3;font-size:13px;font-weight:600;">${label} Chat</span>
  </div>

  <!-- Messages -->
  <div id="chat-messages" style="
    flex:1;overflow-y:auto;padding:8px 12px;min-height:0;
    display:flex;flex-direction:column;gap:8px;
  ">
    <div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">
      Send a message to start collaborating.
    </div>
  </div>

  <!-- Status bar (hidden when idle) -->
  <div id="chat-statusbar" style="display:none;flex-shrink:0;">
    <div id="chat-status-main" style="
      display:flex;align-items:center;gap:8px;padding:6px 12px;
      border-top:1px solid #30363d;cursor:pointer;
      font-size:12px;color:#8b949e;
    ">
      <span id="chat-dot" style="
        width:8px;height:8px;border-radius:50%;flex-shrink:0;
      "></span>
      <span id="chat-status-label" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
      <span id="chat-status-meta" style="flex-shrink:0;font-size:11px;"></span>
    </div>
    <div id="chat-progress-log" style="
      display:none;padding:4px 12px 6px 28px;
      font-size:11px;color:#6e7681;line-height:1.6;
      max-height:80px;overflow-y:auto;
    "></div>
  </div>

  <!-- Input -->
  <div style="
    display:flex;gap:6px;padding:8px 12px;
    border-top:1px solid #30363d;flex-shrink:0;
  ">
    <input id="chat-input" type="text" placeholder="Type a message..."
      tabindex="0"
      style="
        flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;
        padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;
        font-family:inherit;
      "
    />
    <button id="chat-send" style="
      background:${color};color:#0d1117;border:none;border-radius:6px;
      padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;
      font-family:inherit;
    ">Send</button>
  </div>
</div>

<script>
(() => {
  const root = container.querySelector('#chat-root');
  const messagesEl = container.querySelector('#chat-messages');
  const inputEl = container.querySelector('#chat-input');
  const sendBtn = container.querySelector('#chat-send');
  const statusBar = container.querySelector('#chat-statusbar');
  const statusMain = container.querySelector('#chat-status-main');
  const statusDot = container.querySelector('#chat-dot');
  const statusLabel = container.querySelector('#chat-status-label');
  const statusMeta = container.querySelector('#chat-status-meta');
  const progressLog = container.querySelector('#chat-progress-log');
  const provider = '${provider}';
  const color = '${color}';

  let busy = false;
  let stepCount = 0;
  let elapsedSec = 0;
  let elapsedTimer = null;
  let logExpanded = false;

  const ch = mica.openChannel('chat_session', { provider });

  function scrollToBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\`([^\`]+)\`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>')
      .replace(/\\n/g, '<br>');
  }

  function addMessage(role, content, agent) {
    if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
      messagesEl.innerHTML = '';
    }
    const msg = document.createElement('div');
    msg.style.cssText = role === 'user'
      ? 'align-self:flex-end;background:rgba(96,165,250,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
      : 'align-self:flex-start;background:rgba(255,255,255,0.06);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:85%;';
    if (role === 'user') {
      msg.innerHTML = '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + escapeHtml(content) + '</div>';
    } else {
      const header = agent ? '<div style="color:' + color + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(agent) + '</div>' : '';
      msg.innerHTML = header + '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + renderMarkdown(content) + '</div>';
    }
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  // ── Status bar ──

  function showWorking(text) {
    statusBar.style.display = 'block';
    statusDot.style.background = '${color}';
    statusDot.style.animation = 'none';
    statusDot.offsetHeight; // reflow
    statusDot.style.animation = 'pulse 1.5s ease-in-out infinite';
    statusLabel.textContent = text || 'Agent is working...';
    updateMeta();
  }

  function showDone(filesChanged) {
    statusBar.style.display = 'block';
    statusDot.style.background = '#3fb950';
    statusDot.style.animation = 'none';
    statusLabel.textContent = filesChanged ? 'Whiteboard updated — your turn' : 'Done — your turn';
    statusMeta.textContent = '';
  }

  function showIdle() {
    statusBar.style.display = 'block';
    statusDot.style.background = '#3fb950';
    statusDot.style.animation = 'none';
    statusLabel.textContent = 'Your turn';
    statusMeta.textContent = '';
    progressLog.style.display = 'none';
  }

  function hideStatus() {
    statusBar.style.display = 'none';
  }

  function updateMeta() {
    const parts = [];
    if (elapsedSec > 0) parts.push(elapsedSec + 's');
    if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? ' step' : ' steps'));
    statusMeta.textContent = parts.join(' · ');
  }

  function addLogEntry(text) {
    stepCount++;
    const entry = document.createElement('div');
    entry.style.cssText = 'display:flex;align-items:baseline;gap:6px;';
    entry.innerHTML = '<span style="color:${color};font-size:8px;">●</span>' + escapeHtml(text);
    progressLog.appendChild(entry);
    if (logExpanded) progressLog.scrollTop = progressLog.scrollHeight;
    updateMeta();
  }

  function startElapsed() {
    elapsedSec = 0;
    elapsedTimer = setInterval(() => { elapsedSec++; updateMeta(); }, 1000);
  }

  function stopElapsed() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  // Toggle log on click
  statusMain.addEventListener('click', () => {
    if (stepCount === 0) return;
    logExpanded = !logExpanded;
    progressLog.style.display = logExpanded ? 'block' : 'none';
  });

  // ── Channel data ──

  ch.onData((data) => {
    switch (data.type) {
      case 'history':
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
          for (const m of data.messages) addMessage(m.role, m.content, m.agent);
        } else {
          messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start collaborating.</div>';
        }
        showIdle();
        break;

      case 'user':
        addMessage('user', data.content);
        break;

      case 'thinking':
        busy = true;
        sendBtn.disabled = true;
        stepCount = 0;
        progressLog.innerHTML = '';
        logExpanded = false;
        progressLog.style.display = 'none';
        showWorking('Thinking...');
        startElapsed();
        break;

      case 'progress':
        if (data.description) {
          showWorking(data.description);
          addLogEntry(data.description);
        }
        break;

      case 'assistant':
        busy = false;
        sendBtn.disabled = false;
        stopElapsed();
        showDone(data.filesChanged);
        addMessage('assistant', data.content, data.agent);
        break;

      case 'error':
        busy = false;
        sendBtn.disabled = false;
        stopElapsed();
        statusBar.style.display = 'block';
        statusDot.style.background = '#f87171';
        statusDot.style.animation = 'none';
        statusLabel.textContent = 'Error';
        statusMeta.textContent = '';
        addMessage('assistant', 'Error: ' + (data.error || 'Unknown error'), 'System');
        break;
    }
  });

  ch.onClose(() => {});

  function send() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    ch.send({ message: text });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  root.addEventListener('click', (e) => {
    if (e.target === root || e.target === messagesEl) inputEl.focus();
  });

  mica.onDestroy(() => { ch.close(); });
})();
</script>

<style>
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
  `;
}
