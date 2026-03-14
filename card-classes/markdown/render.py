import mica
import markdown

@mica.render
def render(content, config):
    """Convert markdown content to HTML."""
    html = markdown.markdown(
        content,
        extensions=["tables", "fenced_code", "nl2br", "sane_lists", "smarty"],
    )
    return f'<div class="card-markdown">{html}</div>'
