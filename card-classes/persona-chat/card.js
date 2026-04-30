// Persona-chat — reference card class for the llm-direct handler.
// The system prompt comes from the instance file content, so two cards
// of this class can have completely different personalities just by
// having different file contents. No server code involved — everything
// rides on `metadata.handler: "llm-direct"` and the args we pass to
// mica.openChannel.

(async () => {
  const personaLine = container.querySelector("#pc-persona-line");
  const messagesEl = container.querySelector("#pc-messages");
  const form = container.querySelector("#pc-form");
  const input = container.querySelector("#pc-input");

  const systemPrompt = (await mica.getContent()).trim();
  if (systemPrompt) {
    const firstLine = systemPrompt.split("\n")[0];
    personaLine.textContent = "Persona: " + firstLine.slice(0, 120);
  }

  const channel = mica.openChannel("turn", {
    systemPrompt: systemPrompt || "You are a friendly assistant.",
    model: "coder",
  });

  let activeAssistantBubble = null;

  function appendBubble(role, text) {
    const div = document.createElement("div");
    const isUser = role === "user";
    div.style.cssText = "max-width:80%;padding:6px 10px;border-radius:8px;font-size:13px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word;"
      + (isUser
        ? "align-self:flex-end;background:#3b82f6;color:#fff;"
        : "align-self:flex-start;background:#1f242c;color:#e6edf3;border:1px solid #30363d;");
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  channel.onData((evt) => {
    if (evt.type === "user") {
      appendBubble("user", evt.content);
      activeAssistantBubble = appendBubble("assistant", "");
    } else if (evt.type === "delta") {
      if (!activeAssistantBubble) activeAssistantBubble = appendBubble("assistant", "");
      activeAssistantBubble.textContent += evt.content;
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (evt.type === "done") {
      activeAssistantBubble = null;
    } else if (evt.type === "error") {
      appendBubble("assistant", "[error] " + evt.error);
      activeAssistantBubble = null;
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    channel.send({ message: text });
  });
})();
