"""
Canvas card class — base class for cards that contain other cards.

A canvas card renders a layout shell with slot markers. The frontend
(CanvasCardRuntime) fills those slots with individually isolated child
cards, each in its own WidgetRuntime with its own mica bridge.

This is the base implementation. Specialized canvas cards (simple-project,
portfolio, etc.) can import from this module or implement their own.
"""

import mica
import json
import html as html_module


def render_layout(title, children_meta, toolbar_html="", header_html=""):
    """Render a canvas card layout with slots for child cards.

    Args:
        title: Display title for the canvas
        children_meta: List of dicts with keys: filename, cardClass, title, badge, isSystem
        toolbar_html: Optional extra HTML for the toolbar area
        header_html: Optional extra HTML for the header area

    Returns:
        HTML string with data-slot markers for child cards
    """
    escaped_title = html_module.escape(title)

    # Build child metadata as JSON for the frontend to consume
    children_json = html_module.escape(json.dumps(children_meta))

    return f'''
    <div class="canvas-card" data-children='{children_json}'>
        <div class="canvas-header">
            <h2 class="canvas-title">{escaped_title}</h2>
            {header_html}
        </div>
        {toolbar_html}
        <div data-slot="system-cards" class="canvas-system-cards"></div>
        <div data-slot="content-cards" class="canvas-content-cards"></div>
    </div>

    <style>
    .canvas-card {{
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0;
    }}
    .canvas-header {{
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
    }}
    .canvas-title {{
        font-size: 1.3rem;
        font-weight: 600;
        color: #e0e0e0;
        margin: 0;
    }}
    .canvas-system-cards {{
        display: flex;
        flex-direction: column;
        gap: 8px;
    }}
    .canvas-content-cards {{
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 12px;
    }}
    </style>
    '''


@mica.render
def render(content, config):
    """Default canvas card render — layout shell with slots."""
    title = config.get("title", config.get("projectName", "Canvas"))
    children = config.get("children", [])
    return render_layout(title, children)
