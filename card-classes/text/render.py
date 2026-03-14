import mica
import html as html_module

@mica.render
def render(content, config):
    """Render plain text in a pre block."""
    escaped = html_module.escape(content)
    return f'<pre class="card-text">{escaped}</pre>'
