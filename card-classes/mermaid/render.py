import mica
import html as html_module

@mica.render
def render(content, config):
    """Wrap mermaid syntax for browser-side rendering."""
    escaped = html_module.escape(content)
    return f'<pre class="mermaid">{escaped}</pre>'
