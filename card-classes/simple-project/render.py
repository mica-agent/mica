"""
Simple Project card class — a canvas card for straightforward projects.

Renders a project overview with:
- Project name and description
- Toolbar for creating new cards (notes, docs, diagrams)
- Slots for system cards (goal, todo, brief, log) and content cards

For most projects, this single canvas card is all you need.
Complex projects can nest additional canvas cards as children.
"""

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


@mica.render
def render(content, config):
    """Render the project card layout with toolbar and child slots."""
    project_name = html_module.escape(config.get("projectName", config.get("project", "Project")))
    children = config.get("children", [])
    children_json = html_module.escape(json.dumps(children))

    # Render project description from _project.project content
    description_html = ""
    if content.strip():
        # Skip the first line if it's a heading matching the project name
        lines = content.strip().split("\n")
        body = content.strip()
        if lines and lines[0].startswith("# "):
            body = "\n".join(lines[1:]).strip()
        if body:
            description_html = f'<div class="project-description">{_md(body)}</div>'

    # Count children by type
    system_count = sum(1 for c in children if c.get("isSystem"))
    content_count = len(children) - system_count

    return f'''
    <div class="simple-project" data-children='{children_json}'>
        <div class="project-header">
            <h1 class="project-name">{project_name}</h1>
            <div class="project-stats">
                <span class="stat">{content_count} card{"s" if content_count != 1 else ""}</span>
            </div>
        </div>

        {description_html}

        <div class="project-toolbar">
            <button class="toolbar-btn" data-action="new-note" title="New note">
                + Note
            </button>
            <button class="toolbar-btn" data-action="new-doc" title="New document">
                + Doc
            </button>
            <button class="toolbar-btn" data-action="new-diagram" title="New diagram">
                + Diagram
            </button>
        </div>

        <div data-slot="system-cards" class="project-system-cards"></div>

        <div data-slot="content-cards" class="project-content-cards"></div>

        <div class="project-empty" style="display: none;">
            No content cards yet. Use the toolbar above to create your first card.
        </div>
    </div>

    <style>
    .simple-project {{
        display: flex;
        flex-direction: column;
        gap: 16px;
        padding: 0;
        min-height: 100%;
    }}
    .project-header {{
        display: flex;
        align-items: baseline;
        gap: 16px;
        padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
    }}
    .project-name {{
        font-size: 1.5rem;
        font-weight: 700;
        color: #f0f0f0;
        margin: 0;
    }}
    .project-stats {{
        display: flex;
        gap: 12px;
        color: #888;
        font-size: 0.85rem;
    }}
    .project-description {{
        color: #aaa;
        font-size: 0.9rem;
        line-height: 1.5;
        max-width: 700px;
    }}
    .project-description p {{
        margin: 0 0 8px 0;
    }}
    .project-toolbar {{
        display: flex;
        gap: 8px;
        padding: 4px 0;
    }}
    .toolbar-btn {{
        padding: 6px 14px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 6px;
        background: rgba(255,255,255,0.04);
        color: #ccc;
        cursor: pointer;
        font-size: 0.85rem;
        transition: all 0.15s;
    }}
    .toolbar-btn:hover {{
        background: rgba(255,255,255,0.08);
        border-color: rgba(255,255,255,0.2);
        color: #fff;
    }}
    .project-system-cards {{
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 10px;
    }}
    .project-content-cards {{
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 12px;
    }}
    .project-empty {{
        text-align: center;
        color: #666;
        padding: 40px 20px;
        font-size: 0.9rem;
    }}
    </style>

    <script>
    (function() {{
        // Show empty state if no content cards
        var contentSlot = container.querySelector('[data-slot="content-cards"]');
        var emptyEl = container.querySelector('.project-empty');
        if (contentSlot && emptyEl) {{
            var observer = new MutationObserver(function() {{
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            }});
            observer.observe(contentSlot, {{ childList: true }});
            // Initial check after slots are filled
            requestAnimationFrame(function() {{
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            }});
        }}

        // Toolbar button handlers — broadcast events for the React shell to handle
        container.querySelectorAll('.toolbar-btn').forEach(function(btn) {{
            btn.addEventListener('click', function() {{
                var action = btn.getAttribute('data-action');
                mica.broadcast('toolbar-action', {{ action: action }});
            }});
        }});
    }})();
    </script>
    '''


@mica.export
def create_file(content, args):
    """Create a new file in the project canvas."""
    filename = args.get("filename", "")
    file_content = args.get("content", "")
    if not filename:
        return {"error": "filename is required"}
    mica.write_file(filename, file_content)
    return {"ok": True, "filename": filename}
