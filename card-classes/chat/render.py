import mica
import json
import html as html_module
import markdown

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


def _md(text):
    """Convert markdown text to HTML."""
    return markdown.markdown(
        text,
        extensions=["tables", "fenced_code", "nl2br", "sane_lists", "smarty"],
    )


def _render_messages(messages):
    """Render chat message history as HTML."""
    html_parts = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")
        agent = html_module.escape(msg.get("agent", ""))
        files_changed = msg.get("filesChanged", False)

        if role == "user":
            html_parts.append(
                f'<div class="chat-msg chat-msg--user">'
                f'<div class="chat-msg-body">{html_module.escape(content)}</div>'
                f'</div>'
            )
        else:
            body_html = _md(content)
            action_badge = (
                '<span class="chat-action-badge">whiteboard updated</span>'
                if files_changed else ''
            )
            html_parts.append(
                f'<div class="chat-msg chat-msg--assistant">'
                f'<div class="chat-msg-header">{agent}{action_badge}</div>'
                f'<div class="chat-msg-body">{body_html}</div>'
                f'</div>'
            )
    return "".join(html_parts)


@mica.render
def render(content, config):
    """Render chat message history. The sidebar shell (ChatSidebar.tsx) owns
    the header and input — this widget only renders the message list."""
    # Load existing history
    history_raw = mica.read_file("_chat-history.json")
    messages = []
    if history_raw:
        try:
            messages = json.loads(history_raw)
        except json.JSONDecodeError:
            messages = []

    history_html = _render_messages(messages)
    has_messages = "true" if messages else "false"

    return f'''
    <div class="chat-messages" data-has-messages="{has_messages}">{history_html}</div>

    <script>
    (function() {{
        // container = the widget-runtime div, which is the scroll parent
        requestAnimationFrame(function() {{ container.scrollTop = container.scrollHeight; }});
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
    files_changed = response.get("filesChanged", False)
    _append_history(layer, [
        {"role": "user", "content": message},
        {"role": "assistant", "content": response.get("message", ""), "agent": response.get("agentName", agent_name), "filesChanged": files_changed},
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
