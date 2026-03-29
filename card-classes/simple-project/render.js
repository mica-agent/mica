/**
 * Simple Project card class — a canvas card for straightforward projects.
 *
 * Renders a project overview with:
 * - Project name and description
 * - Slots for system cards (goal, todo, brief, log) and content cards
 *
 * Uses the `marked` library (injected by the isolate pool).
 */

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function render(content, config) {
  const projectName = escapeHtml(config.projectName || config.project || "Project");
  const children = config.children || [];
  const childrenJson = escapeHtml(JSON.stringify(children));

  // Render project description from content
  let descriptionHtml = "";
  if (content.trim()) {
    const lines = content.trim().split("\n");
    let body = content.trim();
    if (lines.length > 0 && lines[0].startsWith("# ")) {
      body = lines.slice(1).join("\n").trim();
    }
    if (body) {
      descriptionHtml = `<div class="project-description">${marked.parse(body, { breaks: true, gfm: true })}</div>`;
    }
  }

  const systemCount = children.filter(c => c.isSystem).length;
  const contentCount = children.length - systemCount;

  return `
    <div class="simple-project" data-children='${childrenJson}'>
        <div class="project-header">
            <h1 class="project-name">${projectName}</h1>
            <div class="project-stats">
                <span class="stat">${contentCount} card${contentCount !== 1 ? "s" : ""}</span>
            </div>
        </div>

        ${descriptionHtml}

        <div data-slot="system-cards" class="project-system-cards"></div>
        <div data-slot="content-cards" class="project-content-cards"></div>

        <div class="project-empty" style="display: none;">
            No content cards yet. Use the toolbar above to create your first card.
        </div>
    </div>

    <style>
    .simple-project {
        display: flex; flex-direction: column; gap: 16px; padding: 0; min-height: 100%;
    }
    .project-header {
        display: flex; align-items: baseline; gap: 16px; padding: 8px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .project-name { font-size: 1.5rem; font-weight: 700; color: #f0f0f0; margin: 0; }
    .project-stats { display: flex; gap: 12px; color: #888; font-size: 0.85rem; }
    .project-description { color: #aaa; font-size: 0.9rem; line-height: 1.5; max-width: 700px; }
    .project-description p { margin: 0 0 8px 0; }
    .project-system-cards {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px;
    }
    .project-content-cards {
        display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px;
    }
    .project-empty {
        text-align: center; color: #666; padding: 40px 20px; font-size: 0.9rem;
    }
    </style>

    <script>
    (function() {
        var contentSlot = container.querySelector('[data-slot="content-cards"]');
        var emptyEl = container.querySelector('.project-empty');
        if (contentSlot && emptyEl) {
            var observer = new MutationObserver(function() {
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            });
            observer.observe(contentSlot, { childList: true });
            requestAnimationFrame(function() {
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            });
        }

        container.querySelectorAll('.toolbar-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var action = btn.getAttribute('data-action');
                mica.broadcast('toolbar-action', { action: action });
            });
        });
    })();
    </script>
  `;
}

export async function create_file(content, args, mica) {
  const filename = args.filename || "";
  const fileContent = args.content || "";
  if (!filename) return { error: "filename is required" };
  await mica.writeFile(filename, fileContent);
  return { ok: true, filename };
}
