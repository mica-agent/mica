/**
 * Chat card class — renders chat message history.
 *
 * This is a RENDER-ONLY card class. It produces static HTML of the message
 * history for display in the canvas grid view. The actual chat interaction
 * (sending messages, receiving responses) is handled by ChatChannelManager
 * on the server and ChatSidebar.tsx on the client — no V8 isolate involved.
 *
 * Uses the `marked` library (injected by the isolate pool).
 */

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function renderMessages(messages) {
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || "user";
    const content = msg.content || "";
    const agent = escapeHtml(msg.agent || "");
    const filesChanged = msg.filesChanged || false;
    const reactive = msg.reactive || false;

    if (role === "user") {
      parts.push(
        `<div class="chat-msg chat-msg--user">` +
        `<div class="chat-msg-body">${escapeHtml(content)}</div>` +
        `</div>`
      );
    } else {
      const bodyHtml = marked.parse(content, { breaks: true, gfm: true });
      const actionBadge = filesChanged
        ? '<span class="chat-action-badge">whiteboard updated</span>'
        : '';
      let triggerBadge = '';
      if (reactive) {
        const triggerFile = escapeHtml(msg.trigger || "");
        triggerBadge = `<span class="chat-action-badge chat-action-badge--reactive">noticed change in ${triggerFile}</span>`;
      }
      const reactiveClass = reactive ? ' chat-msg--reactive' : '';
      parts.push(
        `<div class="chat-msg chat-msg--assistant${reactiveClass}">` +
        `<div class="chat-msg-header">${agent}${triggerBadge}${actionBadge}</div>` +
        `<div class="chat-msg-body">${bodyHtml}</div>` +
        `</div>`
      );
    }
  }
  return parts.join("");
}

export default function render(content, config) {
  // Chat history is pre-loaded by cardManager and passed via config.
  const historyRaw = config.__chatHistory || null;
  let messages = [];
  if (historyRaw) {
    try { messages = JSON.parse(historyRaw); } catch { messages = []; }
  }

  const historyHtml = renderMessages(messages);
  const hasMessages = messages.length > 0 ? "true" : "false";

  return `
    <div class="chat-messages" data-has-messages="${hasMessages}">${historyHtml}</div>

    <script>
    (function() {
        requestAnimationFrame(function() { container.scrollTop = container.scrollHeight; });
    })();
    </script>
  `;
}
