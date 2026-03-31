/**
 * Llama Chat card class — interactive chat with local LLM agent.
 * Opens a chat_session channel with provider: "local".
 * Same protocol as Claude Chat but routes to llama-server.
 */

export default function render(content, config) {
  return chatCardHtml("local", "Llama", "#4ade80", "🦙");
}

function chatCardHtml(provider, label, color, icon) {
  return `
<div id="chat-root" style="
  display:flex;flex-direction:column;height:260px;
  background:#0d1117;border-radius:6px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
">
  <!-- Header -->
  <div style="
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;
  ">
    <span style="font-size:14px;">${icon}</span>
    <span style="color:#e6edf3;font-size:13px;font-weight:600;">${label} Chat</span>
    <span id="chat-status" style="color:#8b949e;font-size:11px;margin-left:auto;"></span>
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
  const statusEl = container.querySelector('#chat-status');
  const provider = '${provider}';
  const color = '${color}';

  let busy = false;

  // Open chat channel
  const ch = mica.openChannel('chat_session', { provider });

  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
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
      ? 'align-self:flex-end;background:rgba(74,222,128,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
      : 'align-self:flex-start;background:rgba(255,255,255,0.06);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:85%;';

    if (role === 'user') {
      msg.innerHTML = '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + escapeHtml(content) + '</div>';
    } else {
      const header = agent ? '<div style="color:' + color + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(agent) + '</div>' : '';
      msg.innerHTML = header + '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + renderMarkdown(content) + '</div>';
    }
    messagesEl.appendChild(msg);
    scrollToBottom();
    return msg;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  ch.onData((data) => {
    switch (data.type) {
      case 'history':
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
          for (const m of data.messages) {
            addMessage(m.role, m.content, m.agent);
          }
        } else {
          messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start collaborating.</div>';
        }
        break;
      case 'user':
        addMessage('user', data.content);
        break;
      case 'thinking':
        busy = true;
        sendBtn.disabled = true;
        const thinkEl = document.createElement('div');
        thinkEl.id = 'thinking-indicator';
        thinkEl.style.cssText = 'align-self:flex-start;background:rgba(255,255,255,0.06);border-radius:12px 12px 12px 4px;padding:10px 16px;';
        thinkEl.innerHTML = '<span style="color:#8b949e;font-size:13px;letter-spacing:2px;" class="thinking-dots">...</span>';
        messagesEl.appendChild(thinkEl);
        scrollToBottom();
        break;
      case 'progress':
        if (data.description) {
          setStatus(data.description);
          const ind = messagesEl.querySelector('#thinking-indicator .thinking-dots');
          if (ind) ind.textContent = data.description;
        }
        break;
      case 'assistant':
        busy = false;
        setStatus('');
        sendBtn.disabled = false;
        const thinkInd = messagesEl.querySelector('#thinking-indicator');
        if (thinkInd) thinkInd.remove();
        addMessage('assistant', data.content, data.agent);
        break;
      case 'error':
        busy = false;
        setStatus('');
        sendBtn.disabled = false;
        const errThink = messagesEl.querySelector('#thinking-indicator');
        if (errThink) errThink.remove();
        addMessage('assistant', 'Error: ' + (data.error || 'Unknown error'), 'System');
        break;
    }
  });

  ch.onClose(() => { /* Channel may reopen on re-render — don't show permanent error */ });

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
  `;
}
