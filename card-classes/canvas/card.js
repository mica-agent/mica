// Canvas card class -- freeform layout surface for child cards.
//
// Owns the entire canvas surface:
// - Toolbar with file/chat creation buttons
// - Freeform layout container for child cards
// - Layout persistence (load/save/drag/resize)
// - Cross-window layout sync
// - Tidy auto-arrange
//
// React portals child card components into #canvas-freeform.
// This script positions them, handles drag/resize, and persists layout.
//
// container and mica are provided by CARD_SHIM

const toolbar = container.querySelector('#project-toolbar');
const freeform = container.querySelector('#canvas-freeform');
const emptyEl = container.querySelector('.project-empty');
const metaSidebar = container.querySelector('#canvas-meta-sidebar');
const metaList = container.querySelector('#canvas-meta-list');
const metaToggle = container.querySelector('#canvas-meta-toggle');
const metaResize = container.querySelector('#canvas-meta-resize');

// -- Meta sidebar (collapsible + drag-to-resize). State + width persist per
//    device class via localStorage so phone vs desktop can have independent layouts.
const _devSuffix = window.innerWidth < 768 ? 'phone' : window.innerWidth < 1200 ? 'tablet' : 'desktop';
const META_KEY = 'mica-meta-sidebar-' + _devSuffix;
const META_W_KEY = META_KEY + '-width';

function applyMetaState(expanded) {
    metaSidebar.classList.toggle('canvas-meta-sidebar--expanded', expanded);
    metaSidebar.classList.toggle('canvas-meta-sidebar--collapsed', !expanded);
    if (expanded) {
        const savedW = parseInt(localStorage.getItem(META_W_KEY) || '', 10);
        metaSidebar.style.width = savedW > 0 ? savedW + 'px' : '';
    } else {
        metaSidebar.style.width = '';  // CSS class controls collapsed width
    }
}
applyMetaState(localStorage.getItem(META_KEY) === '1');
metaToggle.addEventListener('click', function(e) {
    e.stopPropagation();
    const willExpand = metaSidebar.classList.contains('canvas-meta-sidebar--collapsed');
    applyMetaState(willExpand);
    localStorage.setItem(META_KEY, willExpand ? '1' : '0');
});

// Drag the left edge of the sidebar to resize. Drag LEFT increases width.
let _resizeStart = null;
metaResize.addEventListener('pointerdown', function(e) {
    if (metaSidebar.classList.contains('canvas-meta-sidebar--collapsed')) return;
    e.preventDefault(); e.stopPropagation();
    _resizeStart = { x: e.clientX, w: metaSidebar.offsetWidth };
    try { metaResize.setPointerCapture(e.pointerId); } catch (_) {}
});
metaResize.addEventListener('pointermove', function(e) {
    if (!_resizeStart) return;
    const dx = _resizeStart.x - e.clientX;  // moving cursor LEFT widens sidebar
    const minW = 240;
    const maxW = Math.floor(window.innerWidth * 0.7);
    const w = Math.max(minW, Math.min(maxW, _resizeStart.w + dx));
    metaSidebar.style.width = w + 'px';
});
metaResize.addEventListener('pointerup', function(e) {
    if (!_resizeStart) return;
    try { metaResize.releasePointerCapture(e.pointerId); } catch (_) {}
    localStorage.setItem(META_W_KEY, String(metaSidebar.offsetWidth));
    _resizeStart = null;
});

// Canvas root — directory where new cards are created (e.g. "docs")
let canvasRoot = '';
fetch('/api/canvas/config').then(r => r.json()).then(cfg => {
    const root = cfg.canvasRoot || 'docs';
    canvasRoot = root === '.' ? '' : root.replace(/\/$/, '') + '/';
}).catch(() => {});

// -- Device detection ------------------------------------
const vw = window.innerWidth;
const deviceClass = vw < 768 ? 'phone' : vw < 1200 ? 'tablet' : vw < 2560 ? 'desktop' : 'display';
const isPhone = deviceClass === 'phone';
const isDisplay = deviceClass === 'display';

// -- Constants ----------------------------------------
const CARD_W = isPhone ? vw - 32 : 320;
const CARD_H = isPhone ? 320 : 280;
const GAP = isPhone ? 8 : 16;
const COLS = isPhone ? 1 : 3;
const MIN_W = 200;
const MIN_H = 120;
let layout = {};  // { filename: { x, y, w, h, z } }
let layoutLoaded = false;
let saveTimer = null;
let topZ = 1;     // monotonic — bumped on every card pointerdown, seeded from saved z on load
const SAVE_DELAY = 500;

// -- Layout persistence -------------------------------
function loadLayout() {
    return fetch('/api/layout')
        .then(r => r.ok ? r.json() : {})
        .then(data => { if (data.cards) layout = data.cards; layoutLoaded = true; })
        .catch(() => { layoutLoaded = true; });
}

function persistLayout() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch('/api/layout', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards: layout, source: mica.windowId || '' }),
        }).catch(() => {});
    }, SAVE_DELAY);
}

// Z-order persists but is intentionally NOT broadcast — it tracks
// "what I'm focused on right now" per tab. Other clients pick up the
// new z values on next layout fetch / reload, but a click here doesn't
// reorder cards under another viewer's cursor in real time.
let zSaveTimer = null;
function persistZSilent() {
    if (zSaveTimer) clearTimeout(zSaveTimer);
    zSaveTimer = setTimeout(() => {
        fetch('/api/layout', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cards: layout, source: mica.windowId || '', silent: true }),
        }).catch(() => {});
    }, SAVE_DELAY);
}

// -- Position a card based on layout data -------------
function positionCard(card) {
    const name = card.getAttribute('data-filename');
    if (!name) return;
    // Phone: CSS handles stacking, just reveal the card
    if (isPhone) {
        requestAnimationFrame(() => { card.classList.add('wb-card--positioned'); });
        return;
    }
    const pos = layout[name];
    if (pos) {
        card.style.left = `${pos.x}px`;
        card.style.top = `${pos.y}px`;
        card.style.width = `${pos.w || CARD_W}px`;
        card.style.height = `${pos.h || CARD_H}px`;
        if (typeof pos.z === 'number') {
            card.style.zIndex = String(pos.z);
            if (pos.z > topZ) topZ = pos.z;
        }
        card.classList.add('wb-card--resized');
    } else {
        // Auto-position: next open grid slot. No prior layout entry =
        // genuinely new card → bring it to front so it's not hidden behind
        // dragged-around siblings.
        const cards = Array.from(freeform.querySelectorAll('.wb-card'));
        let idx = cards.indexOf(card);
        if (idx < 0) idx = cards.length;
        const col = idx % COLS;
        const row = Math.floor(idx / COLS);
        const x = col * (CARD_W + GAP);
        const y = row * (CARD_H + GAP);
        const z = ++topZ;
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        card.style.width = `${CARD_W}px`;
        card.style.height = `${CARD_H}px`;
        card.style.zIndex = String(z);
        card.classList.add('wb-card--resized');
        layout[name] = { x, y, w: CARD_W, h: CARD_H, z };
        persistLayout();
    }
    // Reveal card with fade-in after positioning
    requestAnimationFrame(() => { card.classList.add('wb-card--positioned'); });
}

function positionAllCards() {
    const cards = Array.from(freeform.querySelectorAll('.wb-card'));
    cards.forEach(function(c) {
        // Re-route meta cards to the sidebar before positioning.
        if (c.dataset && c.dataset.meta === 'true') {
            if (c.parentElement !== metaList) metaList.appendChild(c);
            c.classList.add('wb-card--positioned');
        } else {
            positionCard(c);
        }
    });
    updateEmptyState();
}

function updateEmptyState() {
    if (!emptyEl) return;
    const count = freeform.querySelectorAll('.wb-card').length;
    emptyEl.style.display = count === 0 ? 'block' : 'none';
}

// -- Raise selected card to front (any pointerdown inside the card) ---
// Capture phase runs before drag/resize handlers below, so the card is
// already on top by the time it starts being moved.
// Persists silently so stacking survives reload, but doesn't broadcast —
// each tab decides its own focus (don't reorder cards under another
// viewer's cursor in real time).
freeform.addEventListener('pointerdown', (e) => {
    const card = e.target.closest('.wb-card');
    if (!card) return;
    const z = ++topZ;
    card.style.zIndex = String(z);
    const name = card.getAttribute('data-filename');
    if (name) {
        const existing = layout[name] || { x: card.offsetLeft, y: card.offsetTop, w: CARD_W, h: CARD_H };
        layout[name] = { ...existing, z };
        persistZSilent();
    }
}, true);

// -- Drag via event delegation (disabled on phone) ------
freeform.addEventListener('pointerdown', (e) => {
    if (isPhone) return;
    const header = e.target.closest('.wb-card-header');
    if (!header) return;
    if (e.target.closest('.wb-card-btn') || e.target.closest('.wb-card-actions')) return;

    const card = header.closest('.wb-card');
    if (!card) return;

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = card.offsetLeft;
    const origTop = card.offsetTop;
    card.classList.add('wb-card--dragging');
    let moved = false;

    function onMove(ev) {
        moved = true;
        card.style.left = `${Math.max(0, origLeft + ev.clientX - startX)}px`;
        card.style.top = `${Math.max(0, origTop + ev.clientY - startY)}px`;
    }

    function onUp(ev) {
        window.document.removeEventListener('pointermove', onMove);
        window.document.removeEventListener('pointerup', onUp);
        card.classList.remove('wb-card--dragging');
        if (!moved) return;
        // Suppress click-to-expand after drag
        card.dataset.justDragged = '1';
        setTimeout(() => { delete card.dataset.justDragged; }, 0);
        const x = Math.max(0, origLeft + ev.clientX - startX);
        const y = Math.max(0, origTop + ev.clientY - startY);
        const name = card.getAttribute('data-filename');
        if (name) {
            const existing = layout[name] || { x: 0, y: 0, w: CARD_W, h: CARD_H };
            layout[name] = { x, y, w: existing.w, h: existing.h };
            persistLayout();
        }
    }

    window.document.addEventListener('pointermove', onMove);
    window.document.addEventListener('pointerup', onUp);
});

// -- Resize via event delegation (disabled on phone) ----
freeform.addEventListener('pointerdown', (e) => {
    if (isPhone) return;
    const handle = e.target.closest('.wb-card-resize-handle');
    if (!handle) return;

    const card = handle.closest('.wb-card');
    if (!card) return;

    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const origW = card.offsetWidth;
    const origH = card.offsetHeight;

    function onMove(ev) {
        const w = Math.max(MIN_W, origW + ev.clientX - startX);
        const h = Math.max(MIN_H, origH + ev.clientY - startY);
        card.style.width = `${w}px`;
        card.style.height = `${h}px`;
        card.classList.add('wb-card--resized');
    }

    function onUp(ev) {
        window.document.removeEventListener('pointermove', onMove);
        window.document.removeEventListener('pointerup', onUp);
        const w = Math.max(MIN_W, origW + ev.clientX - startX);
        const h = Math.max(MIN_H, origH + ev.clientY - startY);
        const name = card.getAttribute('data-filename');
        if (name) {
            const existing = layout[name] || { x: card.offsetLeft, y: card.offsetTop, w: CARD_W, h: CARD_H };
            layout[name] = { x: existing.x, y: existing.y, w, h };
            persistLayout();
        }
    }

    window.document.addEventListener('pointermove', onMove);
    window.document.addEventListener('pointerup', onUp);
});

// -- Pinch-to-resize height (phone only) ---------------
if (isPhone) {
    let pinchCard = null;
    let pinchStartDist = 0;
    let pinchStartH = 0;

    freeform.addEventListener('touchstart', function(e) {
        if (e.touches.length !== 2) return;
        var card = e.target.closest('.wb-card');
        if (!card) return;
        pinchCard = card;
        pinchStartDist = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
        pinchStartH = card.offsetHeight;
        card.style.outline = '2px solid #4ade80';
        card.style.outlineOffset = '-2px';
    }, { passive: true });

    freeform.addEventListener('touchmove', function(e) {
        if (!pinchCard || e.touches.length !== 2) return;
        e.preventDefault();
        var dist = Math.abs(e.touches[0].clientY - e.touches[1].clientY);
        var scale = dist / pinchStartDist;
        var newH = Math.max(MIN_H, Math.round(pinchStartH * scale));
        pinchCard.style.minHeight = newH + 'px';
        pinchCard.style.height = newH + 'px';
    }, { passive: false });

    freeform.addEventListener('touchend', function(e) {
        if (!pinchCard) return;
        if (e.touches.length === 0) {
            pinchCard.style.outline = '';
            pinchCard.style.outlineOffset = '';
            pinchCard = null;
        }
    }, { passive: true });
}

// -- Watch for React-portaled child cards -------------
//
// Cards with `data-meta="true"` (their card class declares `meta: true` in
// metadata.json) configure HOW the canvas works — canvas-back, skills, etc.
// They go into the docked sidebar instead of the freeform layout area.
// Everything else is content (the WHAT) and lays out in the freeform grid.
let pendingCards = [];
function placeCard(node) {
    if (node.dataset && node.dataset.meta === 'true') {
        // Meta card → sidebar. Skip layout/drag/resize.
        if (node.parentElement !== metaList) metaList.appendChild(node);
        node.classList.add('wb-card--positioned');  // reveal (skip the fade-in handled by positionCard)
    } else {
        positionCard(node);
    }
}
const childObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
            const node = added[j];
            if (node.nodeType === 1 && node.classList && node.classList.contains('wb-card')) {
                if (layoutLoaded) {
                    placeCard(node);
                } else {
                    pendingCards.push(node);
                }
            }
        }
    }
    updateEmptyState();
});
childObserver.observe(freeform, { childList: true });
mica.onDestroy(() => { childObserver.disconnect(); });

// -- Cross-window layout sync -------------------------
const unsubLayout = mica.on('layout-changed', (msg) => {
    if (msg.source === (mica.windowId || '')) return;
    fetch('/api/layout')
        .then(r => r.ok ? r.json() : {})
        .then(data => {
            if (data.cards) {
                layout = data.cards;
                positionAllCards();
            }
        })
        .catch(() => {});
});
mica.onDestroy(unsubLayout);

// -- File created/deleted handling --------------------
const unsubCreated = mica.on('file-created', (msg) => {
    // New cards will appear via React portaling + MutationObserver
    // Just update empty state after a tick
    setTimeout(updateEmptyState, 100);
});
mica.onDestroy(unsubCreated);

const unsubDeleted = mica.on('file-deleted', (msg) => {
    if (msg.filename && layout[msg.filename]) {
        delete layout[msg.filename];
        persistLayout();
    }
    setTimeout(updateEmptyState, 100);
});
mica.onDestroy(unsubDeleted);

// -- Toolbar ------------------------------------------
// Default content stubs for each card class
const defaultStubs = {
    'md': (name) => `# ${name}\n`,
    'todo': (name) => `---\nmica: todo\n---\n# ${name}\n\n## Active\n- [ ] @human First task\n\n## Done\n`,
    'mmd': (name) => `graph TD\n    A[Start] --> B[End]\n`,
    'chat': (name) => { const id = `chat-${Date.now().toString(36)}`; return `---\nmica: chat\nid: ${id}\n---\nMica AI chat session.\n`; },
    'terminal': () => '',
};

function buildToolbar() {
    toolbar.innerHTML = '';

    // + New File button (plain text file)
    const newFileBtn = window.document.createElement('button');
    newFileBtn.className = 'toolbar-btn';
    newFileBtn.textContent = '+ File';
    newFileBtn.title = 'Create a plain file';
    newFileBtn.addEventListener('click', () => {
        let filename = prompt('Filename (e.g. notes.txt):');
        if (!filename) return;
        filename = filename.trim();
        if (!filename) return;
        if (filename.indexOf('.') === -1) filename += '.txt';
        const path = filename.indexOf('/') === -1 ? canvasRoot + filename : filename;
        fetch(`/api/files/${encodeURIComponent(path)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: '' }),
        }).catch(err => { console.error('[canvas] File creation failed:', err); });
    });
    toolbar.appendChild(newFileBtn);

    // Dynamically load card classes and create buttons
    fetch('/api/card-classes').then(r => r.json()).then(classes => {
        // Skip canvas class (that is us)
        const names = Object.keys(classes).filter(n => n !== 'canvas');
        names.sort();

        names.forEach(name => {
            const btn = window.document.createElement('button');
            btn.className = 'toolbar-btn';
            btn.textContent = `+ ${name.charAt(0).toUpperCase()}${name.slice(1)}`;
            btn.title = classes[name].builtIn ? 'Built-in card class' : 'Project card class';
            if (!classes[name].builtIn) btn.style.borderColor = 'rgba(74,222,128,0.3)';

            btn.addEventListener('click', () => {
                const baseName = prompt(`Name for the ${name} card:`, `${name}-${Date.now().toString(36)}`);
                if (!baseName) return;
                const trimmed = baseName.trim();
                if (!trimmed) return;
                const filename = trimmed.indexOf('.') === -1 ? `${trimmed}.${name}` : trimmed;
                const path = filename.indexOf('/') === -1 ? canvasRoot + filename : filename;
                const stubFn = defaultStubs[name];
                const content = stubFn ? stubFn(trimmed) : '';
                fetch(`/api/files/${encodeURIComponent(path)}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content }),
                }).catch(err => { console.error('[canvas] Card creation failed:', err); });
            });
            toolbar.appendChild(btn);
        });
    }).catch(err => { console.error('[canvas] Failed to load card classes:', err); });

    // Spacer
    const spacer = window.document.createElement('span');
    spacer.className = 'toolbar-spacer';
    toolbar.appendChild(spacer);

    // Tidy button -- auto-arrange in grid
    const tidyBtn = window.document.createElement('button');
    tidyBtn.className = 'toolbar-btn';
    tidyBtn.textContent = 'Tidy';
    tidyBtn.title = 'Tidy layout (hold Option/Alt to fit all on screen)';
    tidyBtn.addEventListener('click', (e) => {
        const cards = Array.from(freeform.querySelectorAll('.wb-card'));
        if (cards.length === 0) return;

        cards.sort((a, b) => {
            const aName = a.getAttribute('data-filename') || '';
            const bName = b.getAttribute('data-filename') || '';
            return aName.localeCompare(bName);
        });

        const maxWidth = freeform.offsetWidth || 1200;
        const maxHeight = freeform.offsetHeight || 800;

        if (e.altKey) {
            // Option/Alt + Tidy: resize cards to fit all on screen
            const count = cards.length;
            // Calculate optimal grid: try to make it roughly square
            const cols = Math.ceil(Math.sqrt(count));
            const rows = Math.ceil(count / cols);
            let cardW = Math.floor((maxWidth - (cols - 1) * GAP) / cols);
            let cardH = Math.floor((maxHeight - (rows - 1) * GAP) / rows);
            // Clamp to reasonable minimums
            cardW = Math.max(MIN_W, cardW);
            cardH = Math.max(MIN_H, cardH);

            layout = {};
            cards.forEach((card, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                const x = col * (cardW + GAP);
                const y = row * (cardH + GAP);
                card.style.left = `${x}px`;
                card.style.top = `${y}px`;
                card.style.width = `${cardW}px`;
                card.style.height = `${cardH}px`;
                card.classList.add('wb-card--resized');
                const name = card.getAttribute('data-filename');
                if (name) layout[name] = { x, y, w: cardW, h: cardH };
            });
        } else {
            // Normal tidy: arrange in grid with current card sizes
            layout = {};
            let x = 0, y = 0, rowMaxH = 0;
            cards.forEach(card => {
                const w = card.offsetWidth || CARD_W;
                const h = card.offsetHeight || CARD_H;
                if (x > 0 && x + w > maxWidth) {
                    y += rowMaxH + GAP;
                    x = 0;
                    rowMaxH = 0;
                }
                card.style.left = `${x}px`;
                card.style.top = `${y}px`;
                if (h > rowMaxH) rowMaxH = h;
                const name = card.getAttribute('data-filename');
                if (name) layout[name] = { x, y, w, h };
                x += w + GAP;
            });
        }
        persistLayout();
    });
    toolbar.appendChild(tidyBtn);
}

buildToolbar();

// -- Load layout then position initial + pending cards --
loadLayout().then(() => {
    positionAllCards();
    for (let i = 0; i < pendingCards.length; i++) placeCard(pendingCards[i]);
    pendingCards = [];
});
