import mica
import markdown

@mica.render
def render(content, config):
    """Render the layer goal card with checklist progress."""
    html = markdown.markdown(content, extensions=["tables", "fenced_code", "sane_lists"])

    # Count checklist items
    total = content.count("- [")
    done = content.count("- [x]") + content.count("- [X]")
    pending = total - done

    progress_html = ""
    if total > 0:
        pct = int(done / total * 100)
        progress_html = f'''
        <div class="card-progress">
            <div class="card-progress-bar" style="width: {pct}%"></div>
        </div>
        <div class="card-progress-label">{done}/{total} complete</div>
        '''

    return f'''
    <div class="card-goal">
        {progress_html}
        <div class="card-markdown">{html}</div>
    </div>
    '''
