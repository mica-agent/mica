import mica
import json
import html as html_module

AGENT_NAMES = {
    "mission": "Mission Strategist",
    "experience": "Experience Designer",
    "architecture": "System Architect",
    "implementation": "Implementation Engineer",
}

AGENT_ICONS = {
    "mission": "\u25c6",
    "experience": "\u25c7",
    "architecture": "\u2b21",
    "implementation": "\u2b22",
}


def _render_messages(messages):
    """Render chat message history as HTML."""
    html_parts = []
    for msg in messages:
        role = msg.get("role", "user")
        text = html_module.escape(msg.get("content", ""))
        agent = html_module.escape(msg.get("agent", ""))

        if role == "user":
            html_parts.append(
                f'<div class="chat-msg chat-msg--user">'
                f'<div class="chat-msg-body">{text}</div>'
                f'</div>'
            )
        else:
            html_parts.append(
                f'<div class="chat-msg chat-msg--assistant">'
                f'<div class="chat-msg-header">{agent}</div>'
                f'<div class="chat-msg-body">{text}</div>'
                f'</div>'
            )
    return "".join(html_parts)


@mica.render
def render(content, config):
    """Render the chat widget with persistent history."""
    layer = config.get("layer", "mission")
    agent_name = AGENT_NAMES.get(layer, "AI Agent")
    agent_icon = AGENT_ICONS.get(layer, "\u25c6")

    # Load existing history
    history_raw = mica.read_file("_chat-history.json")
    messages = []
    if history_raw:
        try:
            messages = json.loads(history_raw)
        except json.JSONDecodeError:
            messages = []

    history_html = _render_messages(messages)

    return f'''
    <div class="chat-widget" data-layer="{layer}">
      <div class="chat-header">
        <span class="chat-icon">{agent_icon}</span>
        <span class="chat-agent-name">{agent_name}</span>
        <span class="chat-status" id="status">ready</span>
      </div>

      <div class="chat-messages" id="messages">{history_html}</div>

      <div class="chat-input-area">
        <input id="chat-input" type="text"
               placeholder="Ask {agent_name}..."
               onkeydown="if(event.key==='Enter'&&!event.shiftKey)sendMessage()" />
        <button onclick="sendMessage()" id="send-btn">&uarr;</button>
      </div>
    </div>

    <script>
      (function() {{
        const messagesEl = document.getElementById('messages');
        const inputEl = document.getElementById('chat-input');
        const statusEl = document.getElementById('status');
        const sendBtn = document.getElementById('send-btn');
        let sending = false;

        function addMsg(role, text, agent) {{
          const div = document.createElement('div');
          div.className = 'chat-msg chat-msg--' + role;
          if (role === 'assistant' && agent) {{
            const hdr = document.createElement('div');
            hdr.className = 'chat-msg-header';
            hdr.textContent = agent;
            div.appendChild(hdr);
          }}
          const body = document.createElement('div');
          body.className = 'chat-msg-body';
          body.textContent = text;
          div.appendChild(body);
          messagesEl.appendChild(div);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }}

        window.sendMessage = async function() {{
          if (sending) return;
          const text = inputEl.value.trim();
          if (!text) return;

          inputEl.value = '';
          inputEl.disabled = true;
          sendBtn.disabled = true;
          sending = true;
          statusEl.textContent = 'thinking...';

          addMsg('user', text);

          try {{
            const result = await mica.call('send_message', {{ message: text }});
            addMsg('assistant', result.message, result.agent);

            if (result.filesChanged) {{
              statusEl.textContent = 'updated whiteboard';
              setTimeout(() => statusEl.textContent = 'ready', 2000);
            }} else {{
              statusEl.textContent = 'ready';
            }}
          }} catch (err) {{
            addMsg('assistant', 'Error: ' + (err.message || err), 'System');
            statusEl.textContent = 'error';
            setTimeout(() => statusEl.textContent = 'ready', 3000);
          }}

          inputEl.disabled = false;
          sendBtn.disabled = false;
          sending = false;
          inputEl.focus();
        }};

        // Auto check-in on first load (only if no history)
        if (messagesEl.children.length === 0) {{
          (async () => {{
            statusEl.textContent = 'reviewing whiteboard...';
            try {{
              const result = await mica.call('check_in', {{}});
              addMsg('assistant', result.message, result.agent);
            }} catch(e) {{
              // Check-in failed, no worries
            }}
            statusEl.textContent = 'ready';
          }})();
        }}

        // Scroll to bottom on load
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }})();
    </script>
    '''


@mica.export
def send_message(content, args):
    """Handle a chat message from the user."""
    layer = _get_layer()
    message = args.get("message", "")
    agent_name = AGENT_NAMES.get(layer, "AI Agent")

    # Call the AI agent
    response = mica.agent.chat(message)

    # Persist to history
    _append_history(layer, [
        {"role": "user", "content": message},
        {"role": "assistant", "content": response.get("message", ""), "agent": response.get("agentName", agent_name)},
    ])

    return {
        "message": response.get("message", ""),
        "agent": response.get("agentName", agent_name),
        "filesChanged": response.get("filesChanged", False),
    }


@mica.export
def check_in(content, args):
    """Agent reviews the whiteboard on first visit."""
    layer = _get_layer()
    agent_name = AGENT_NAMES.get(layer, "AI Agent")

    response = mica.agent.chat(
        "Briefly assess the whiteboard against _goal.md and _todo.md. "
        "What's solid, what's the top priority to work on next? 2-3 sentences max."
    )

    # Persist to history
    _append_history(layer, [
        {"role": "assistant", "content": response.get("message", ""), "agent": response.get("agentName", agent_name)},
    ])

    return {
        "message": response.get("message", ""),
        "agent": response.get("agentName", agent_name),
    }


def _get_layer():
    """Get current layer from mica request context."""
    # The config passed during render includes the layer
    # For exports, mica SDK sets this via the request context
    return mica._request_id.split("-")[0] if mica._request_id else "mission"


def _append_history(layer, new_messages):
    """Append messages to _chat-history.json."""
    history_raw = mica.read_file("_chat-history.json")
    messages = []
    if history_raw:
        try:
            messages = json.loads(history_raw)
        except json.JSONDecodeError:
            messages = []

    messages.extend(new_messages)

    # Keep last 100 messages to prevent file bloat
    if len(messages) > 100:
        messages = messages[-100:]

    mica.write_file("_chat-history.json", json.dumps(messages, indent=2))
