/**
 * Simple Project card class — a canvas card for straightforward projects.
 *
 * Owns the entire canvas surface:
 * - Toolbar with card creation buttons (dynamic from available classes)
 * - Freeform layout container for child cards
 * - Layout persistence (load/save/drag/resize)
 * - Cross-window layout sync
 * - Tidy auto-arrange
 *
 * React portals child FileCard components into #canvas-freeform.
 * This script positions them, handles drag/resize, and persists layout.
 */

import { marked } from 'marked';

export const metadata = { extension: ".project", badge: "PROJECT", primaryFile: "project.md", defaultTitle: "Project" };

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function render(content, config) {
  const projectName = escapeHtml(config.projectName || config.project || "Project");
  const children = config.children || [];
  const childrenJson = escapeHtml(JSON.stringify(children));

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

  const contentCount = children.length;

  return `
    <div class="simple-project" data-children='${childrenJson}'>
        <div id="project-toolbar" class="project-toolbar"></div>

        <div class="project-header">
            <h1 class="project-name">${projectName}</h1>
            <div class="project-stats">
                <span class="stat">${contentCount} card${contentCount !== 1 ? "s" : ""}</span>
            </div>
        </div>

        ${descriptionHtml}

        <div id="canvas-freeform" class="canvas-freeform"></div>

        <div class="project-empty" style="display: none;">
            No content cards yet. Use the toolbar above to create your first card.
        </div>
    </div>

    <style>
    .simple-project {
        display: flex; flex-direction: column; gap: 12px; padding: 0;
        min-height: 100%; flex: 1;
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
    .project-header {
        display: flex; align-items: baseline; gap: 16px; padding: 4px 0;
        border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    .project-name { font-size: 1.5rem; font-weight: 700; color: #f0f0f0; margin: 0; }
    .project-stats { display: flex; gap: 12px; color: #888; font-size: 0.85rem; }
    .project-description { color: #aaa; font-size: 0.9rem; line-height: 1.5; max-width: 700px; }
    .project-description p { margin: 0 0 8px 0; }
    .canvas-freeform {
        position: relative; flex: 1; min-height: 200px; overflow: auto;
    }
    .canvas-freeform > .wb-card {
        position: absolute; width: 320px;
    }
    .canvas-freeform .wb-card-header { cursor: grab; }
    .canvas-freeform .wb-card-header:active { cursor: grabbing; }
    .project-empty {
        text-align: center; color: #666; padding: 40px 20px; font-size: 0.9rem;
    }
    </style>

    <script>
    (function() {
        const toolbar = container.querySelector('#project-toolbar');
        const freeform = container.querySelector('#canvas-freeform');
        const emptyEl = container.querySelector('.project-empty');

        // ── Constants ────────────────────────────────────────
        const CARD_W = 320, CARD_H = 280, GAP = 16, COLS = 3;
        const MIN_W = 200, MIN_H = 120;
        let layout = {};  // { filename: { x, y, w, h } }
        let layoutLoaded = false;
        let saveTimer = null;
        const SAVE_DELAY = 500;

        // ── Layout persistence ───────────────────────────────
        function loadLayout() {
            return fetch('/api/projects/' + mica.project + '/canvases/_root/layout')
                .then(function(r) { return r.ok ? r.json() : {}; })
                .then(function(data) { if (data.cards) layout = data.cards; layoutLoaded = true; })
                .catch(function() { layoutLoaded = true; });
        }

        function persistLayout() {
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(function() {
                fetch('/api/projects/' + mica.project + '/canvases/_root/layout', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cards: layout, source: mica.windowId || '' }),
                }).catch(function() {});
            }, SAVE_DELAY);
        }

        // ── Position a card based on layout data ─────────────
        function positionCard(card) {
            var name = card.getAttribute('data-filename');
            if (!name) return;
            var pos = layout[name];
            if (pos) {
                card.style.left = pos.x + 'px';
                card.style.top = pos.y + 'px';
                card.style.width = (pos.w || CARD_W) + 'px';
                if (pos.h && pos.h !== CARD_H) {
                    card.style.height = pos.h + 'px';
                    card.classList.add('wb-card--resized');
                }
            } else {
                // Auto-position: next open grid slot
                var cards = Array.from(freeform.querySelectorAll('.wb-card'));
                var idx = cards.indexOf(card);
                if (idx < 0) idx = cards.length;
                var col = idx % COLS;
                var row = Math.floor(idx / COLS);
                var x = col * (CARD_W + GAP);
                var y = row * (CARD_H + GAP);
                card.style.left = x + 'px';
                card.style.top = y + 'px';
                card.style.width = CARD_W + 'px';
                layout[name] = { x: x, y: y, w: CARD_W, h: CARD_H };
                persistLayout();
            }
        }

        function positionAllCards() {
            var cards = Array.from(freeform.querySelectorAll('.wb-card'));
            cards.forEach(positionCard);
            updateEmptyState();
        }

        function updateEmptyState() {
            if (!emptyEl) return;
            var count = freeform.querySelectorAll('.wb-card').length;
            emptyEl.style.display = count === 0 ? 'block' : 'none';
        }

        // ── Drag via event delegation ────────────────────────
        freeform.addEventListener('pointerdown', function(e) {
            var header = e.target.closest('.wb-card-header');
            if (!header) return;
            if (e.target.closest('.wb-card-btn') || e.target.closest('.wb-card-actions')) return;

            var card = header.closest('.wb-card');
            if (!card) return;

            e.preventDefault();
            var startX = e.clientX, startY = e.clientY;
            var origLeft = card.offsetLeft, origTop = card.offsetTop;
            card.classList.add('wb-card--dragging');
            var moved = false;

            function onMove(ev) {
                moved = true;
                card.style.left = Math.max(0, origLeft + ev.clientX - startX) + 'px';
                card.style.top = Math.max(0, origTop + ev.clientY - startY) + 'px';
            }

            function onUp(ev) {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                card.classList.remove('wb-card--dragging');
                if (!moved) return;
                // Suppress click-to-expand after drag
                card.dataset.justDragged = '1';
                setTimeout(function() { delete card.dataset.justDragged; }, 0);
                var x = Math.max(0, origLeft + ev.clientX - startX);
                var y = Math.max(0, origTop + ev.clientY - startY);
                var name = card.getAttribute('data-filename');
                if (name) {
                    var existing = layout[name] || { x: 0, y: 0, w: CARD_W, h: CARD_H };
                    layout[name] = { x: x, y: y, w: existing.w, h: existing.h };
                    persistLayout();
                }
            }

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });

        // ── Resize via event delegation ──────────────────────
        freeform.addEventListener('pointerdown', function(e) {
            var handle = e.target.closest('.wb-card-resize-handle');
            if (!handle) return;

            var card = handle.closest('.wb-card');
            if (!card) return;

            e.preventDefault();
            e.stopPropagation();
            var startX = e.clientX, startY = e.clientY;
            var origW = card.offsetWidth, origH = card.offsetHeight;

            function onMove(ev) {
                var w = Math.max(MIN_W, origW + ev.clientX - startX);
                var h = Math.max(MIN_H, origH + ev.clientY - startY);
                card.style.width = w + 'px';
                card.style.height = h + 'px';
                card.classList.add('wb-card--resized');
            }

            function onUp(ev) {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                var w = Math.max(MIN_W, origW + ev.clientX - startX);
                var h = Math.max(MIN_H, origH + ev.clientY - startY);
                var name = card.getAttribute('data-filename');
                if (name) {
                    var existing = layout[name] || { x: card.offsetLeft, y: card.offsetTop, w: CARD_W, h: CARD_H };
                    layout[name] = { x: existing.x, y: existing.y, w: w, h: h };
                    persistLayout();
                }
            }

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });

        // ── Watch for React-portaled child cards ─────────────
        var pendingCards = [];
        var childObserver = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                var added = mutations[i].addedNodes;
                for (var j = 0; j < added.length; j++) {
                    var node = added[j];
                    if (node.nodeType === 1 && node.classList && node.classList.contains('wb-card')) {
                        if (layoutLoaded) {
                            positionCard(node);
                        } else {
                            pendingCards.push(node);
                        }
                    }
                }
            }
            updateEmptyState();
        });
        childObserver.observe(freeform, { childList: true });
        mica.onDestroy(function() { childObserver.disconnect(); });

        // ── Cross-window layout sync ─────────────────────────
        var unsubLayout = mica.on('layout-changed', function(msg) {
            if (msg.project !== mica.project || msg.canvas !== '_root') return;
            if (msg.source === (mica.windowId || '')) return;
            fetch('/api/projects/' + mica.project + '/canvases/_root/layout')
                .then(function(r) { return r.ok ? r.json() : {}; })
                .then(function(data) {
                    if (data.cards) {
                        layout = data.cards;
                        positionAllCards();
                    }
                })
                .catch(function() {});
        });
        mica.onDestroy(unsubLayout);

        // ── Toolbar: card creation buttons ───────────────────
        function buildToolbar(classes) {
                toolbar.innerHTML = '';
                var buttons = [];

                for (var _i = 0, _entries = Object.entries(classes); _i < _entries.length; _i++) {
                    var name = _entries[_i][0], meta = _entries[_i][1];
                    if (name === 'simple-project' || name === 'canvas') continue;
                    var btn = document.createElement('button');
                    btn.className = 'toolbar-btn';
                    btn.textContent = '+ ' + (meta.defaultTitle || name);
                    btn.addEventListener('click', (function(n, m) {
                        return function() {
                            var prefix = n.split('-')[0].slice(0, 6);
                            var cardName = prefix + '-' + Date.now().toString(36) + m.extension;
                            fetch('/api/projects/' + mica.project + '/canvases/_root/cards', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name: cardName }),
                            }).catch(function(err) { console.error('[project] Card creation failed:', err); });
                        };
                    })(name, meta));
                    buttons.push(btn);
                }

                var spacer = document.createElement('span');
                spacer.className = 'toolbar-spacer';
                buttons.push(spacer);

                // Tidy button — auto-arrange in grid
                var tidyBtn = document.createElement('button');
                tidyBtn.className = 'toolbar-btn';
                tidyBtn.textContent = 'Tidy';
                tidyBtn.addEventListener('click', function() {
                    var cards = Array.from(freeform.querySelectorAll('.wb-card'));
                    if (cards.length === 0) return;

                    cards.sort(function(a, b) {
                        var aName = a.getAttribute('data-filename') || '';
                        var bName = b.getAttribute('data-filename') || '';
                        var aSeed = a.classList.contains('wb-card--goal') || a.classList.contains('wb-card--todo');
                        var bSeed = b.classList.contains('wb-card--goal') || b.classList.contains('wb-card--todo');
                        if (aSeed && !bSeed) return -1;
                        if (!aSeed && bSeed) return 1;
                        return aName.localeCompare(bName);
                    });

                    // Place cards left-to-right, wrapping to next row when
                    // the card would exceed the container width
                    layout = {};
                    var maxWidth = freeform.offsetWidth || 1200;
                    var x = 0, y = 0, rowMaxH = 0;
                    cards.forEach(function(card) {
                        var w = card.offsetWidth || CARD_W;
                        var h = card.offsetHeight || CARD_H;
                        // Wrap to next row if this card won't fit (unless it's the first in the row)
                        if (x > 0 && x + w > maxWidth) {
                            y += rowMaxH + GAP;
                            x = 0;
                            rowMaxH = 0;
                        }
                        card.style.left = x + 'px';
                        card.style.top = y + 'px';
                        if (h > rowMaxH) rowMaxH = h;
                        var name = card.getAttribute('data-filename');
                        if (name) layout[name] = { x: x, y: y, w: w, h: h };
                        x += w + GAP;
                    });
                    persistLayout();
                });
                buttons.push(tidyBtn);

                for (var k = 0; k < buttons.length; k++) toolbar.appendChild(buttons[k]);
        }

        function refreshToolbar() {
            fetch('/api/card-classes')
                .then(function(r) { return r.json(); })
                .then(buildToolbar)
                .catch(function(err) { console.error('[project] Failed to load card classes:', err); });
        }
        refreshToolbar();

        // Rebuild toolbar when card classes change (e.g. agent creates a new class)
        var unsubClasses = mica.on('classes-updated', refreshToolbar);
        mica.onDestroy(unsubClasses);

        // ── Load layout then position initial + pending cards ──
        loadLayout().then(function() {
            positionAllCards();
            for (var i = 0; i < pendingCards.length; i++) positionCard(pendingCards[i]);
            pendingCards = [];
        });
    })();
    </script>
  `;
}
