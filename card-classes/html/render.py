import mica
import html as html_module


@mica.render
def render(content, config):
    """Render raw HTML content directly.

    The HTML is rendered inside a sandboxed container. Inline styles
    and scripts work normally. External resources are subject to
    browser security policies.
    """
    return f'<div class="html-widget">{content}</div>'
