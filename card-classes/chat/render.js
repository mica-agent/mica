/**
 * Chat card class — renders chat message history.
 * The sidebar shell (ChatSidebar.tsx) owns the header and input —
 * this widget only renders the message list.
 *
 * Uses the `marked` library (injected by the isolate pool).
 */

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

const AGENT_NAMES = {
  mission: "Mission Strategist",
  experience: "Experience Designer",
  architecture: "System Architect",
  implementation: "Implementation Engineer",
};

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
  // Load existing chat history from the canvas data file
  const historyRaw = mica.readFile(".chat-history.json");
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

export async function send_message(content, args, mica) {
  const message = args.message || "";
  const agentName = "AI Agent";

  const response = await mica.agent.chat(message);

  const filesChanged = response?.filesChanged || false;
  await appendHistory(mica, [
    { role: "user", content: message },
    { role: "assistant", content: response?.message || "", agent: response?.agentName || agentName, filesChanged },
  ]);

  return {
    message: response?.message || "",
    agent: response?.agentName || agentName,
    filesChanged: response?.filesChanged || false,
  };
}

export async function check_in(content, args, mica) {
  const agentName = "AI Agent";

  const response = await mica.agent.chat(
    "Briefly assess the whiteboard against _goal.goal and _todo.todo. " +
    "What's solid, what's the top priority to work on next? 2-3 sentences max."
  );

  await appendHistory(mica, [
    { role: "assistant", content: response?.message || "", agent: response?.agentName || agentName },
  ]);

  return {
    message: response?.message || "",
    agent: response?.agentName || agentName,
  };
}

async function appendHistory(mica, newMessages) {
  const historyRaw = await mica.readFile(".chat-history.json");
  let messages = [];
  if (historyRaw) {
    try { messages = JSON.parse(historyRaw); } catch { messages = []; }
  }

  messages.push(...newMessages);

  // Keep last 100 messages
  if (messages.length > 100) {
    messages = messages.slice(-100);
  }

  await mica.writeFile(".chat-history.json", JSON.stringify(messages, null, 2));
}
