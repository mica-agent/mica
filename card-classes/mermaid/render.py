import mica

@mica.render
def render(content, config):
    """Wrap mermaid syntax for browser-side rendering.

    Content is NOT HTML-escaped — mermaid.js needs the raw syntax
    and WidgetRuntime reads pre.textContent for rendering.
    """
    return f'<pre class="mermaid">{content}</pre>'
