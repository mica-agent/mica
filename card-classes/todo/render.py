import mica
import markdown
import re

@mica.render
def render(content, config):
    """Render the to-do card with section counts."""
    active = 0
    blocked = 0
    done = 0
    section = "active"

    for line in content.split("\n"):
        lower = line.lower().strip()
        if lower.startswith("## active"):
            section = "active"
        elif lower.startswith("## blocked"):
            section = "blocked"
        elif lower.startswith("## done"):
            section = "done"
        elif re.match(r"^- \[x\]", line.strip(), re.IGNORECASE):
            done += 1
        elif re.match(r"^- \[ \]", line.strip()):
            if section == "blocked":
                blocked += 1
            else:
                active += 1

    badges = []
    if active > 0:
        badges.append(f'<span class="todo-badge todo-active">{active} active</span>')
    if blocked > 0:
        badges.append(f'<span class="todo-badge todo-blocked">{blocked} blocked</span>')
    if done > 0:
        badges.append(f'<span class="todo-badge todo-done">{done} done</span>')

    badges_html = f'<div class="todo-badges">{"".join(badges)}</div>' if badges else ""

    html = markdown.markdown(content, extensions=["tables", "fenced_code", "sane_lists"])

    return f'''
    <div class="card-todo">
        {badges_html}
        <div class="card-markdown">{html}</div>
    </div>
    '''
