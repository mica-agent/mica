import mica
import markdown

@mica.render
def render(content, config):
    """Render the activity log card."""
    html = markdown.markdown(content, extensions=["tables", "fenced_code", "sane_lists"])
    return f'''
    <div class="card-log">
        <div class="card-markdown">{html}</div>
    </div>
    '''
