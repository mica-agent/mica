/**
 * Simple Project card class — a canvas card for straightforward projects.
 *
 * Renders the project layout including:
 * - Toolbar with card creation buttons (dynamic from available classes) and layout toggle
 * - Slots for seed cards and content cards
 * - Project name and description
 */

import { marked } from 'marked';

export const metadata = { extension: ".project", badge: "PROJECT", primaryFile: "project.md", seed: true, defaultTitle: "Project" };

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
        <!-- Toolbar: rendered by card class, dynamic from available card classes -->
        <div id="project-toolbar" class="project-toolbar"></div>

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
    .project-toolbar {
        display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
        padding: 8px 0; border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .project-toolbar .toolbar-btn {
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
        border-radius: 6px; padding: 4px 12px; color: #ccc; font-size: 0.8rem;
        cursor: pointer; font-family: inherit;
    }
    .project-toolbar .toolbar-btn:hover {
        background: rgba(255,255,255,0.1); color: #fff;
    }
    .project-toolbar .toolbar-spacer { flex: 1; }
    .project-toolbar .toolbar-btn--active {
        background: rgba(74,138,255,0.3); border-color: rgba(74,138,255,0.5); color: #fff;
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
        const toolbar = container.querySelector('#project-toolbar');
        const contentSlot = container.querySelector('[data-slot="content-cards"]');
        const emptyEl = container.querySelector('.project-empty');

        // Watch for child cards being added/removed to toggle empty state
        if (contentSlot && emptyEl) {
            const observer = new MutationObserver(() => {
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            });
            observer.observe(contentSlot, { childList: true });
            requestAnimationFrame(() => {
                emptyEl.style.display = contentSlot.children.length === 0 ? 'block' : 'none';
            });
        }

        // Fetch available card classes and build toolbar buttons
        fetch('/api/card-classes')
            .then(r => r.json())
            .then(classes => {
                const buttons = [];

                // Card creation buttons (skip seed cards, skip canvas types)
                for (const [name, meta] of Object.entries(classes)) {
                    if (meta.seed || name === 'simple-project' || name === 'canvas') continue;
                    const btn = document.createElement('button');
                    btn.className = 'toolbar-btn';
                    btn.textContent = '+ ' + (meta.defaultTitle || name);
                    btn.addEventListener('click', () => {
                        const prefix = name.split('-')[0].slice(0, 6);
                        const cardName = prefix + '-' + Date.now().toString(36) + meta.extension;
                        fetch('/api/projects/' + mica.project + '/canvases/_root/cards', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: cardName }),
                        }).catch(err => console.error('[project] Card creation failed:', err));
                    });
                    buttons.push(btn);
                }

                // Spacer
                const spacer = document.createElement('span');
                spacer.className = 'toolbar-spacer';
                buttons.push(spacer);

                // Layout toggle (broadcasts to canvas host)
                const gridBtn = document.createElement('button');
                gridBtn.className = 'toolbar-btn';
                gridBtn.textContent = 'Grid';
                gridBtn.addEventListener('click', () => {
                    mica.broadcast('layout-mode', { mode: 'masonry' });
                    gridBtn.classList.add('toolbar-btn--active');
                    freeBtn.classList.remove('toolbar-btn--active');
                });

                const freeBtn = document.createElement('button');
                freeBtn.className = 'toolbar-btn';
                freeBtn.textContent = 'Free';
                freeBtn.addEventListener('click', () => {
                    mica.broadcast('layout-mode', { mode: 'freeform' });
                    freeBtn.classList.add('toolbar-btn--active');
                    gridBtn.classList.remove('toolbar-btn--active');
                });

                buttons.push(gridBtn, freeBtn);

                // Append all buttons to toolbar
                for (const btn of buttons) toolbar.appendChild(btn);
            })
            .catch(err => console.error('[project] Failed to load card classes:', err));
    })();
    </script>
  `;
}

export async function create_file(content, args, mica) {
  const filename = args.filename || "";
  const fileContent = args.content || "";
  if (!filename) return { error: "filename is required" };
  await mica.createCard(filename);
  return { ok: true, filename };
}
