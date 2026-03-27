import mica
import json
import html as html_module
import markdown


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
        agent_name = html_module.escape(msg.get("agent", "AI Agent"))
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
                f'<div class="chat-msg-header">{agent_name}{action_badge}</div>'
                f'<div class="chat-msg-body">{body_html}</div>'
                f'</div>'
            )
    return "".join(html_parts)


@mica.render
def render(content, config):
    """Render agent chat message history. The sidebar shell (ChatSidebar.tsx)
    owns the header and input — this widget renders the message list."""
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
        requestAnimationFrame(function() {{ container.scrollTop = container.scrollHeight; }});
    }})();
    </script>
    '''


@mica.export
def send_message(content, args):
    """Handle a chat message from the user."""
    message = args.get("message", "")

    # Call the AI agent
    response = mica.agent.chat(message)

    # Persist to history
    files_changed = response.get("filesChanged", False)
    agent_name = response.get("agentName", "AI Agent")
    _append_history([
        {"role": "user", "content": message},
        {"role": "assistant", "content": response.get("message", ""), "agent": agent_name, "filesChanged": files_changed},
    ])

    return {
        "message": response.get("message", ""),
        "agent": agent_name,
        "filesChanged": files_changed,
    }


@mica.export
def check_in(content, args):
    """Agent reviews the whiteboard on first visit."""
    response = mica.agent.chat(
        "Briefly assess the whiteboard against _goal.md and _todo.md. "
        "What's solid, what's the top priority to work on next? 2-3 sentences max."
    )

    agent_name = response.get("agentName", "AI Agent")
    _append_history([
        {"role": "assistant", "content": response.get("message", ""), "agent": agent_name},
    ])

    return {
        "message": response.get("message", ""),
        "agent": agent_name,
    }


def _append_history(new_messages):
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
