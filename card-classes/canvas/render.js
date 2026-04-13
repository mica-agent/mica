/**
 * Canvas card class -- freeform layout surface for child cards.
 *
 * Owns the entire canvas surface:
 * - Toolbar with file/chat creation buttons
 * - Freeform layout container for child cards
 * - Layout persistence (load/save/drag/resize)
 * - Cross-window layout sync
 * - Tidy auto-arrange
 *
 * React portals child card components into #canvas-freeform.
 * This script positions them, handles drag/resize, and persists layout.
 */

export const metadata = { extension: ".canvas", badge: "CANVAS", primaryFile: null, defaultTitle: "Canvas" };

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default function render(content, config) {
  const children = config.children || [];
  const childrenJson = escapeHtml(JSON.stringify(children));
  const contentCount = children.length;

  return `
    <div class="canvas-root" data-children='${childrenJson}'>
        <div id="project-toolbar" class="project-toolbar"></div>

        <div id="canvas-freeform" class="canvas-freeform"></div>

        <div class="project-empty" style="display: none;">
            No cards yet. Use the toolbar above to create your first card.
        </div>
    </div>

    <style>
    .canvas-root {
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
    .canvas-freeform {
        position: relative; flex: 1; min-height: 200px; overflow: auto;
    }
    .canvas-freeform > .wb-card {
        position: absolute; width: 320px;
        opacity: 0; transition: opacity 0.3s ease, box-shadow 0.2s;
    }
    .canvas-freeform > .wb-card.wb-card--positioned {
        opacity: 1;
    }
    .canvas-freeform .wb-card-header { cursor: grab; }
    .canvas-freeform .wb-card-header:active { cursor: grabbing; }
    .project-empty {
        text-align: center; color: #666; padding: 40px 20px; font-size: 0.9rem;
    }
    </style>

    <script>
    (function() {
        var toolbar = container.querySelector('#project-toolbar');
        var freeform = container.querySelector('#canvas-freeform');
        var emptyEl = container.querySelector('.project-empty');

        // -- Constants ----------------------------------------
        var CARD_W = 320, CARD_H = 280, GAP = 16, COLS = 3;
        var MIN_W = 200, MIN_H = 120;
        var layout = {};  // { filename: { x, y, w, h } }
        var layoutLoaded = false;
        var saveTimer = null;
        var SAVE_DELAY = 500;

        // -- Layout persistence -------------------------------
        function loadLayout() {
            return fetch('/api/layout')
                .then(function(r) { return r.ok ? r.json() : {}; })
                .then(function(data) { if (data.cards) layout = data.cards; layoutLoaded = true; })
                .catch(function() { layoutLoaded = true; });
        }

        function persistLayout() {
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = setTimeout(function() {
                fetch('/api/layout', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cards: layout, source: mica.windowId || '' }),
                }).catch(function() {});
            }, SAVE_DELAY);
        }

        // -- Position a card based on layout data -------------
        function positionCard(card) {
            var name = card.getAttribute('data-filename');
            if (!name) return;
            var pos = layout[name];
            if (pos) {
                card.style.left = pos.x + 'px';
                card.style.top = pos.y + 'px';
                card.style.width = (pos.w || CARD_W) + 'px';
                card.style.height = (pos.h || CARD_H) + 'px';
                card.classList.add('wb-card--resized');
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
                card.style.height = CARD_H + 'px';
                card.classList.add('wb-card--resized');
                layout[name] = { x: x, y: y, w: CARD_W, h: CARD_H };
                persistLayout();
            }
            // Reveal card with fade-in after positioning
            requestAnimationFrame(function() { card.classList.add('wb-card--positioned'); });
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

        // -- Drag via event delegation ------------------------
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

        // -- Resize via event delegation ----------------------
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

        // -- Watch for React-portaled child cards -------------
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

        // -- Cross-window layout sync -------------------------
        var unsubLayout = mica.on('layout-changed', function(msg) {
            if (msg.source === (mica.windowId || '')) return;
            fetch('/api/layout')
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

        // -- File created/deleted handling --------------------
        var unsubCreated = mica.on('file-created', function(msg) {
            // New cards will appear via React portaling + MutationObserver
            // Just update empty state after a tick
            setTimeout(updateEmptyState, 100);
        });
        mica.onDestroy(unsubCreated);

        var unsubDeleted = mica.on('file-deleted', function(msg) {
            if (msg.filename && layout[msg.filename]) {
                delete layout[msg.filename];
                persistLayout();
            }
            setTimeout(updateEmptyState, 100);
        });
        mica.onDestroy(unsubDeleted);

        // -- Toolbar ------------------------------------------
        function buildToolbar() {
            toolbar.innerHTML = '';

            // + New File button
            var newFileBtn = document.createElement('button');
            newFileBtn.className = 'toolbar-btn';
            newFileBtn.textContent = '+ New File';
            newFileBtn.addEventListener('click', function() {
                var filename = prompt('Filename (e.g. notes.md):');
                if (!filename) return;
                filename = filename.trim();
                if (!filename) return;
                // Default to .md if no extension
                if (filename.indexOf('.') === -1) filename += '.md';
                fetch('/api/files/' + encodeURIComponent(filename), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: '' }),
                }).catch(function(err) { console.error('[canvas] File creation failed:', err); });
            });
            toolbar.appendChild(newFileBtn);

            // + AI Chat button
            var chatBtn = document.createElement('button');
            chatBtn.className = 'toolbar-btn';
            chatBtn.textContent = '+ AI Chat';
            chatBtn.addEventListener('click', function() {
                var chatId = 'chat-' + Date.now().toString(36);
                var cardName = chatId + '.chat';
                var stub = '---\\nmica: chat\\nid: ' + chatId + '\\n---\\nMica AI chat session.\\n';
                fetch('/api/files/' + encodeURIComponent(cardName), {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: stub }),
                }).catch(function(err) { console.error('[canvas] Chat creation failed:', err); });
            });
            toolbar.appendChild(chatBtn);

            // Spacer
            var spacer = document.createElement('span');
            spacer.className = 'toolbar-spacer';
            toolbar.appendChild(spacer);

            // Tidy button -- auto-arrange in grid
            var tidyBtn = document.createElement('button');
            tidyBtn.className = 'toolbar-btn';
            tidyBtn.textContent = 'Tidy';
            tidyBtn.title = 'Tidy layout (hold Option/Alt to fit all on screen)';
            tidyBtn.addEventListener('click', function(e) {
                var cards = Array.from(freeform.querySelectorAll('.wb-card'));
                if (cards.length === 0) return;

                cards.sort(function(a, b) {
                    var aName = a.getAttribute('data-filename') || '';
                    var bName = b.getAttribute('data-filename') || '';
                    return aName.localeCompare(bName);
                });

                var maxWidth = freeform.offsetWidth || 1200;
                var maxHeight = freeform.offsetHeight || 800;

                if (e.altKey) {
                    // Option/Alt + Tidy: resize cards to fit all on screen
                    var count = cards.length;
                    // Calculate optimal grid: try to make it roughly square
                    var cols = Math.ceil(Math.sqrt(count));
                    var rows = Math.ceil(count / cols);
                    var cardW = Math.floor((maxWidth - (cols - 1) * GAP) / cols);
                    var cardH = Math.floor((maxHeight - (rows - 1) * GAP) / rows);
                    // Clamp to reasonable minimums
                    cardW = Math.max(MIN_W, cardW);
                    cardH = Math.max(MIN_H, cardH);

                    layout = {};
                    cards.forEach(function(card, i) {
                        var col = i % cols;
                        var row = Math.floor(i / cols);
                        var x = col * (cardW + GAP);
                        var y = row * (cardH + GAP);
                        card.style.left = x + 'px';
                        card.style.top = y + 'px';
                        card.style.width = cardW + 'px';
                        card.style.height = cardH + 'px';
                        card.classList.add('wb-card--resized');
                        var name = card.getAttribute('data-filename');
                        if (name) layout[name] = { x: x, y: y, w: cardW, h: cardH };
                    });
                } else {
                    // Normal tidy: arrange in grid with current card sizes
                    layout = {};
                    var x = 0, y = 0, rowMaxH = 0;
                    cards.forEach(function(card) {
                        var w = card.offsetWidth || CARD_W;
                        var h = card.offsetHeight || CARD_H;
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
                }
                persistLayout();
            });
            toolbar.appendChild(tidyBtn);
        }

        buildToolbar();

        // -- Load layout then position initial + pending cards --
        loadLayout().then(function() {
            positionAllCards();
            for (var i = 0; i < pendingCards.length; i++) positionCard(pendingCards[i]);
            pendingCards = [];
        });
    })();
    </script>
  `;
}
