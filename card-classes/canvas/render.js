/**
 * Canvas card class — base class for cards that contain other cards.
 *
 * Renders a layout shell with slot markers. The frontend
 * (CanvasCardRuntime) fills those slots with individually isolated
 * child cards, each in its own WidgetRuntime with its own mica bridge.
 */

export const metadata = { extension: ".canvas", badge: "CANVAS", primaryFile: "canvas.json", seed: true, defaultTitle: "Canvas" };

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function render(content, config) {
  const title = escapeHtml(config.title || config.projectName || "Canvas");
  const children = config.children || [];
  const childrenJson = escapeHtml(JSON.stringify(children));

  return `
    <div class="canvas-card" data-children='${childrenJson}'>
        <div class="canvas-header">
            <h2 class="canvas-title">${title}</h2>
        </div>
        <div data-slot="system-cards" class="canvas-system-cards"></div>
        <div data-slot="content-cards" class="canvas-content-cards"></div>
    </div>

    <style>
    .canvas-card {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 0;
    }
    .canvas-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 8px 0;
    }
    .canvas-title {
        font-size: 1.3rem;
        font-weight: 600;
        color: #e0e0e0;
        margin: 0;
    }
    .canvas-system-cards {
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .canvas-content-cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: 12px;
    }
    </style>
  `;
}
