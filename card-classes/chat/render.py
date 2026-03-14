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
        <span class="chat-status">ready</span>
      </div>

      <div class="chat-messages">{history_html}</div>

      <div class="chat-input-area">
        <input type="text" class="chat-input"
               placeholder="Ask {agent_name}..." />
        <button class="chat-send-btn">&uarr;</button>
      </div>
    </div>

    <style>
        .chat-widget {{
            display: flex; flex-direction: column;
            min-height: 0; overflow: hidden;
            color: #e8e8f0;
            font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif;
            -webkit-font-smoothing: antialiased;
        }}
        .chat-header {{
            display: flex; align-items: center; gap: 6px;
            padding: 6px 0 8px; border-bottom: 1px solid rgba(255,255,255,0.1);
            font-size: 0.8rem; flex-shrink: 0;
        }}
        .chat-icon {{ font-size: 1rem; }}
        .chat-agent-name {{ font-weight: 600; flex: 1; color: #e8e8f0; }}
        .chat-status {{
            font-size: 0.65rem; color: rgba(255,255,255,0.5);
            padding: 1px 6px; border: 1px solid rgba(255,255,255,0.12);
            border-radius: 3px;
        }}
        .chat-messages {{
            flex: 1; overflow-y: auto; padding: 8px 0;
            min-height: 0;
            display: flex; flex-direction: column; gap: 8px;
        }}
        .chat-msg {{
            padding: 8px 12px; border-radius: 10px;
            font-size: 0.84rem; line-height: 1.5;
            word-wrap: break-word; overflow-wrap: break-word;
            max-width: 100%; box-sizing: border-box;
        }}
        .chat-msg--user {{
            background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.15);
            align-self: flex-end; max-width: 85%;
            color: #f0f0f5;
        }}
        .chat-msg--assistant {{
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
            align-self: flex-start; max-width: 95%;
            color: rgba(255,255,255,0.85);
        }}
        .chat-msg-header {{
            font-size: 0.7rem; font-weight: 600; color: rgba(255,255,255,0.6);
            margin-bottom: 3px;
        }}
        .chat-msg-body {{ white-space: pre-wrap; word-break: break-word; }}
        .chat-input-area {{
            display: flex; gap: 6px; padding: 10px 0 2px;
            border-top: 1px solid rgba(255,255,255,0.1);
            flex-shrink: 0;
        }}
        .chat-input {{
            flex: 1; min-width: 0;
            background: rgba(255,255,255,0.07);
            border: 1px solid rgba(255,255,255,0.18);
            color: #f0f0f5; padding: 8px 12px; border-radius: 8px;
            font-size: 0.84rem; font-family: inherit;
            outline: none;
        }}
        .chat-input:focus {{
            border-color: rgba(255,255,255,0.35);
            background: rgba(255,255,255,0.09);
        }}
        .chat-input::placeholder {{ color: rgba(255,255,255,0.35); }}
        .chat-input:disabled {{ opacity: 0.5; }}
        .chat-send-btn {{
            background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.2);
            color: #e8e8f0; border-radius: 8px; padding: 4px 14px; cursor: pointer;
            font-size: 1rem; font-weight: 700; flex-shrink: 0;
        }}
        .chat-send-btn:hover {{ background: rgba(255,255,255,0.18); }}
        .chat-send-btn:disabled {{ opacity: 0.3; cursor: default; }}
        .chat-typing {{
            align-self: flex-start; padding: 10px 14px;
            background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px; display: flex; gap: 5px; align-items: center;
        }}
        .chat-typing span {{
            width: 6px; height: 6px; border-radius: 50%;
            background: rgba(255,255,255,0.4);
            animation: chatDots 1.2s infinite;
        }}
        .chat-typing span:nth-child(2) {{ animation-delay: 0.2s; }}
        .chat-typing span:nth-child(3) {{ animation-delay: 0.4s; }}
        @keyframes chatDots {{
            0%, 80%, 100% {{ opacity: 0.3; transform: scale(0.8); }}
            40% {{ opacity: 1; transform: scale(1); }}
        }}
    </style>

    <script>
    (function() {{
        // mica and container are injected by WidgetRuntime
        if (!container) return;

        const messagesEl = container.querySelector('.chat-messages');
        const inputEl = container.querySelector('.chat-input');
        const statusEl = container.querySelector('.chat-status');
        const sendBtn = container.querySelector('.chat-send-btn');
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

        async function sendMessage() {{
            if (sending) return;
            const text = inputEl.value.trim();
            if (!text) return;

            inputEl.value = '';
            inputEl.disabled = true;
            sendBtn.disabled = true;
            sending = true;
            statusEl.textContent = 'thinking...';

            addMsg('user', text);

            // Show typing indicator
            const typingEl = document.createElement('div');
            typingEl.className = 'chat-typing';
            typingEl.innerHTML = '<span></span><span></span><span></span>';
            messagesEl.appendChild(typingEl);
            messagesEl.scrollTop = messagesEl.scrollHeight;

            try {{
                const result = await mica.call('send_message', {{ message: text }});
                typingEl.remove();
                addMsg('assistant', result.message, result.agent);

                if (result.filesChanged) {{
                    statusEl.textContent = 'updated whiteboard';
                    setTimeout(() => statusEl.textContent = 'ready', 2000);
                }} else {{
                    statusEl.textContent = 'ready';
                }}
            }} catch (err) {{
                typingEl.remove();
                addMsg('assistant', 'Error: ' + (err.message || err), 'System');
                statusEl.textContent = 'error';
                setTimeout(() => statusEl.textContent = 'ready', 3000);
            }}

            inputEl.disabled = false;
            sendBtn.disabled = false;
            sending = false;
            inputEl.focus();
        }}

        // Wire up events via JS (not HTML attributes)
        sendBtn.addEventListener('click', (e) => {{ e.stopPropagation(); sendMessage(); }});
        inputEl.addEventListener('keydown', (e) => {{
            if (e.key === 'Enter' && !e.shiftKey) {{ e.stopPropagation(); e.preventDefault(); sendMessage(); }}
        }});
        inputEl.addEventListener('click', (e) => e.stopPropagation());

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
    # The layer is set by the worker pool context; fall back to 'workspace'
    return getattr(mica, '_current_layer', 'workspace')


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
