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

// -- Meta overlay (full-viewport modal, opens via banner gear) --
// The overlay contains #canvas-meta-list, the React portal target meta
// cards render into. It starts hidden; opened by the banner gear in
// App.tsx dispatching `mica-open-canvas-settings`. Closed via × button,
// backdrop click, or Escape.
const metaOverlay = container.querySelector('#canvas-meta-overlay');
const metaOverlayBackdrop = container.querySelector('.canvas-meta-overlay-backdrop');
const metaOverlayClose = container.querySelector('#canvas-meta-overlay-close');
const libraryToggleBtn = container.querySelector('#canvas-library-toggle');

// Library toggle — flips whether THIS project's path lives in
// ~/.mica/include-projects.json. When on, this project's card classes
// resolve in every other project on the machine. We probe the API on
// every overlay-open to keep state in sync (file could change on disk
// from CLI or another window). The current project's absolute path is
// computed by the server side — we send `mica.project` and let the
// server resolve to WORKSPACE_DIR/<project>.
let currentProjectAbsPath = null;  // populated on first overlay-open
async function refreshLibraryToggleState() {
    if (!libraryToggleBtn) return;
    try {
        const resp = await fetch('/api/library-projects', { headers: projectHeaders() });
        if (!resp.ok) return;
        const data = await resp.json();
        const list = Array.isArray(data.include) ? data.include : [];
        // We don't know our own abs path; ask /api/project (returns the
        // project's absolute path under WORKSPACE_DIR).
        if (!currentProjectAbsPath) {
            const projResp = await fetch('/api/project', { headers: projectHeaders() });
            if (projResp.ok) {
                const j = await projResp.json();
                if (typeof j.path === 'string') currentProjectAbsPath = j.path;
            }
        }
        const on = currentProjectAbsPath ? list.includes(currentProjectAbsPath) : false;
        libraryToggleBtn.textContent = on ? '📚 Library: on' : '📚 Library: off';
        libraryToggleBtn.style.background = on ? 'rgba(96,165,250,0.2)' : '';
    } catch { /* silent — toggle just stays at last state */ }
}
if (libraryToggleBtn) {
    libraryToggleBtn.addEventListener('click', async () => {
        if (!currentProjectAbsPath) await refreshLibraryToggleState();
        if (!currentProjectAbsPath) {
            libraryToggleBtn.textContent = '📚 Library: error';
            return;
        }
        const isOn = libraryToggleBtn.textContent.includes('on');
        const method = isOn ? 'DELETE' : 'POST';
        try {
            await fetch('/api/library-projects', {
                method,
                headers: projectHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ path: currentProjectAbsPath }),
            });
            await refreshLibraryToggleState();
            // Notify the host (App.tsx header) so the 📚 icon next to the
            // project name re-renders without polling.
            window.dispatchEvent(new CustomEvent('mica-libraries-changed'));
        } catch (err) {
            console.error('[canvas] library toggle failed:', err);
        }
    });
}

function openMetaOverlay() {
    metaOverlay.style.display = 'flex';
    void refreshLibraryToggleState();
}
// Host-side surfaces (the banner gear in App.tsx, the orphan-card
// placeholder in CardFrame.tsx) request the settings overlay via a
// window event. Matches the pattern used by mica-toggle-collapse for
// cross-boundary signaling.
window.addEventListener('mica-open-canvas-settings', openMetaOverlay);
function closeMetaOverlay() {
    metaOverlay.style.display = 'none';
}
metaOverlayBackdrop.addEventListener('click', closeMetaOverlay);
metaOverlayClose.addEventListener('click', closeMetaOverlay);
window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && metaOverlay.style.display !== 'none') closeMetaOverlay();
});

// Scope /api/* calls to this card's project. Canvas layout, canvas-root, and
// project-scoped card-classes all live per-project — two tabs on different
// projects would collide without this header.
function projectHeaders(extra) {
    const h = { 'X-Mica-Project': (typeof mica !== 'undefined' && mica.project) || '' };
    if (extra) for (const k in extra) h[k] = extra[k];
    return h;
}

// Canvas root — directory where new cards are created (default "canvas").
// Matches initProject's default. The server's /api/canvas/config endpoint
// normally returns a concrete value; this fallback only kicks in if the
// fetch fails OR config.json omits the field entirely.
let canvasRoot = '';
fetch('/api/canvas/config', { headers: projectHeaders() }).then(r => r.json()).then(cfg => {
    const root = cfg.canvasRoot || 'canvas';
    canvasRoot = root === '.' ? '' : root.replace(/\/$/, '') + '/';
}).catch(() => {});

// -- Device detection ------------------------------------
const vw = window.innerWidth;
const deviceClass = vw < 768 ? 'phone' : vw < 1200 ? 'tablet' : vw < 2560 ? 'desktop' : 'display';
const isPhone = deviceClass === 'phone';
const isDisplay = deviceClass === 'display';

// -- Constants ----------------------------------------
// Card sizing scales with device class so default-sized cards don't clip
// content (and so the user isn't forced to resize every new card to actually
// use it). Display = TV/4K screens; desktop = laptop; tablet = ~iPad; phone
// = single-column stack.
const CARD_W = isPhone ? vw - 32 : isDisplay ? 540 : 440;
const CARD_H = isPhone ? 360 : isDisplay ? 460 : 360;
// GAP + EDGE_PAD are sized so the card-write glow (peak box-shadow ~34px beyond
// the card box) has room to render without being clipped by the viewport edge
// or by a neighbor card. Phone keeps tight spacing since glow matters less
// on a small screen.
const GAP = isPhone ? 8 : 28;
const EDGE_PAD = isPhone ? 8 : 40;
const COLS = isPhone ? 1 : isDisplay ? 4 : 3;
// Resize floor — small enough for "minimize" feel, large enough that the
// content card classes (chat, terminal, markdown) still have room for their
// chrome (header, toolbar, footer) plus a usable body region.
const MIN_W = 280;
const MIN_H = 220;
let layout = {};  // { filename: { x, y, w, h, z } }
let layoutLoaded = false;
let saveTimer = null;
let topZ = 1;     // monotonic — bumped on every card pointerdown, seeded from saved z on load
const SAVE_DELAY = 500;

// -- Smooth layout transitions (tidy / expand / contract) ---
// Cards jump discretely when style.left/top/width/height change; adding
// this class briefly around the change turns the jump into a smooth
// animation (see CSS .wb-card--animating-layout). Must be absent during
// drag — the drag handler removes it on pointerdown so the card keeps
// up with the cursor.
const LAYOUT_ANIM_MS = 300;                 // matches the CSS transition duration
const LAYOUT_STAGGER_MS = 60;               // per-card delay for tidy cascade
const LAYOUT_STAGGER_MAX_INDEX = 12;        // clamp stagger so a huge canvas doesn't take forever

function animateLayoutChange(cards, opts) {
    const stagger = !!(opts && opts.stagger);
    for (let i = 0; i < cards.length; i++) {
        const c = cards[i];
        c.classList.add('wb-card--animating-layout');
        if (stagger) {
            const delay = Math.min(i, LAYOUT_STAGGER_MAX_INDEX) * LAYOUT_STAGGER_MS;
            c.style.transitionDelay = delay + 'ms';
        }
    }
    const totalMs = LAYOUT_ANIM_MS +
        (stagger ? LAYOUT_STAGGER_MAX_INDEX * LAYOUT_STAGGER_MS : 0) + 50;
    setTimeout(() => {
        for (let i = 0; i < cards.length; i++) {
            cards[i].classList.remove('wb-card--animating-layout');
            cards[i].style.transitionDelay = '';
        }
    }, totalMs);
}

// -- Canvas bounds ------------------------------------
// The canvas has its OWN size independent of where cards happen to be.
// A sizer div pins scrollWidth/scrollHeight to the bounds; cards move
// freely inside. Bounds grow when cards are placed / dragged / resized
// past the current edge. Bounds only SHRINK via Tidy (explicit reset).
// Without this, scrollHeight tracked the farthest card edge and auto-
// clamped scroll position when a card was moved inward, causing drag-
// cursor drift. See plan: /home/vscode/.claude/plans/joyful-honking-hinton.md
let bounds = { w: 0, h: 0 };
const BOUNDS_PAD = 200;
const sizer = window.document.createElement('div');
sizer.className = 'canvas-freeform-sizer';
sizer.setAttribute('aria-hidden', 'true');
sizer.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;pointer-events:none;';
freeform.appendChild(sizer);

function applyBounds() {
    sizer.style.width = bounds.w + 'px';
    sizer.style.height = bounds.h + 'px';
}

function growBounds(rect) {
    const newW = Math.max(bounds.w, rect.x + rect.w + BOUNDS_PAD);
    const newH = Math.max(bounds.h, rect.y + rect.h + BOUNDS_PAD);
    if (newW !== bounds.w || newH !== bounds.h) {
        bounds = { w: newW, h: newH };
        applyBounds();
        return true;
    }
    return false;
}

function seedBoundsFromCards() {
    let maxR = 0, maxB = 0;
    for (const name of Object.keys(layout)) {
        const c = layout[name];
        if (!c) continue;
        const right = (c.x || 0) + (c.w || CARD_W);
        const bottom = (c.y || 0) + (c.h || CARD_H);
        if (right > maxR) maxR = right;
        if (bottom > maxB) maxB = bottom;
    }
    const fallbackW = freeform.clientWidth || 1200;
    const fallbackH = freeform.clientHeight || 800;
    return {
        w: Math.max(maxR + BOUNDS_PAD, fallbackW),
        h: Math.max(maxB + BOUNDS_PAD, fallbackH),
    };
}

// -- Layout persistence -------------------------------
function loadLayout() {
    return fetch('/api/layout', { headers: projectHeaders() })
        .then(r => r.ok ? r.json() : {})
        .then(data => {
            if (data.cards) layout = data.cards;
            if (data.bounds && typeof data.bounds.w === 'number' && typeof data.bounds.h === 'number') {
                bounds = { w: data.bounds.w, h: data.bounds.h };
            } else {
                bounds = seedBoundsFromCards();
            }
            applyBounds();
            layoutLoaded = true;
        })
        .catch(() => { layoutLoaded = true; });
}

function persistLayout() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch('/api/layout', {
            method: 'PUT',
            headers: projectHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ cards: layout, bounds, source: mica.windowId || '' }),
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
            headers: projectHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ cards: layout, bounds, source: mica.windowId || '', silent: true }),
        }).catch(() => {});
    }, SAVE_DELAY);
}

// -- Position a card based on layout data -------------
function positionCard(card) {
    const name = card.getAttribute('data-filename');
    if (!name) return;
    // Seed heat from the card's modifiedAt attribute. Heat trail uses this
    // to bucket cards as hot/warm/mild/cool/cold on first mount; live
    // file-changed broadcasts maintain it after that.
    seedHeatFromCard(card, name);
    // Phone: CSS handles stacking, just reveal the card
    if (isPhone) {
        requestAnimationFrame(() => { card.classList.add('wb-card--positioned'); });
        return;
    }
    const pos = layout[name];
    if (pos) {
        // Heal sub-minimum heights from an older build (see toggleCardCollapse
        // comment): if we stored h=40ish because we collapsed the card before
        // the write-side fix, the uncollapsed view would render as a sliver.
        // Clamp to CARD_H so the card at least shows a usable body.
        const healedH = typeof pos.h === 'number' && pos.h >= MIN_H ? pos.h : CARD_H;
        card.style.left = `${pos.x}px`;
        card.style.top = `${pos.y}px`;
        card.style.width = `${pos.w || CARD_W}px`;
        card.style.height = `${healedH}px`;
        if (typeof pos.z === 'number') {
            card.style.zIndex = String(pos.z);
            if (pos.z > topZ) topZ = pos.z;
        }
        card.classList.add('wb-card--resized');
        // Restore collapsed state from layout. CSS applies height:auto so
        // the card shrinks to its header; the stored w/h is retained so
        // expanding later returns to the user's previous size.
        card.classList.toggle('wb-card--collapsed', !!pos.collapsed);
        if (growBounds({ x: pos.x, y: pos.y, w: pos.w || CARD_W, h: pos.h || CARD_H })) persistLayout();
    } else {
        // Auto-position: scan grid slots row-major and pick the FIRST one
        // that doesn't overlap any existing card. The naive "next index"
        // approach put new cards on top of dragged-around siblings.
        // Fall back to stacking below the lowest existing card if every
        // grid slot in the visible viewport is occupied.
        const occupied = Object.values(layout).map(function(p) {
            return { x: p.x, y: p.y, w: p.w || CARD_W, h: p.h || CARD_H };
        });
        function rectsOverlap(a, b) {
            return !(a.x + a.w + GAP <= b.x || b.x + b.w + GAP <= a.x ||
                     a.y + a.h + GAP <= b.y || b.y + b.h + GAP <= a.y);
        }
        function slotFree(x, y) {
            const candidate = { x: x, y: y, w: CARD_W, h: CARD_H };
            for (let i = 0; i < occupied.length; i++) {
                if (rectsOverlap(candidate, occupied[i])) return false;
            }
            return true;
        }
        let x = EDGE_PAD, y = EDGE_PAD;
        // Scan up to 8 rows × COLS columns of grid candidates.
        let placed = false;
        outer: for (let row = 0; row < 8; row++) {
            for (let col = 0; col < COLS; col++) {
                const cx = EDGE_PAD + col * (CARD_W + GAP);
                const cy = EDGE_PAD + row * (CARD_H + GAP);
                if (slotFree(cx, cy)) { x = cx; y = cy; placed = true; break outer; }
            }
        }
        if (!placed) {
            // Stack below the lowest existing card.
            let maxBottom = 0;
            for (let i = 0; i < occupied.length; i++) {
                const b = occupied[i].y + occupied[i].h;
                if (b > maxBottom) maxBottom = b;
            }
            x = EDGE_PAD;
            y = maxBottom + GAP;
        }
        const z = ++topZ;
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        card.style.width = `${CARD_W}px`;
        card.style.height = `${CARD_H}px`;
        card.style.zIndex = String(z);
        card.classList.add('wb-card--resized');
        layout[name] = { x, y, w: CARD_W, h: CARD_H, z };
        growBounds({ x, y, w: CARD_W, h: CARD_H });
        persistLayout();
    }
    // Reveal card with fade-in after positioning
    requestAnimationFrame(() => { card.classList.add('wb-card--positioned'); });
}

function positionAllCards() {
    // Only operate on cards in the freeform area. Meta cards live in the
    // metaList (sidebar) and are React-portaled there directly; we never
    // move them between containers (see MutationObserver comment below).
    const cards = Array.from(freeform.querySelectorAll('.wb-card'));
    cards.forEach(positionCard);
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

// -- Edge-scroll driver (shared by drag + resize) ------
// When a drag is active and the cursor is within EDGE_SCROLL_THRESHOLD of
// a viewport edge, the canvas auto-scrolls in that direction. Combined
// with real-time bounds growth, this lets a user drag a card to arbitrary
// far positions without losing cursor alignment or running off-screen.
const EDGE_SCROLL_THRESHOLD_PX = 40;
const EDGE_SCROLL_MAX_SPEED_PX = 30;
let edgeScrollRaf = 0;
let edgeScrollPointer = null;   // latest pointer event during the active gesture

function edgeScrollDelta(pos, size) {
    if (pos < EDGE_SCROLL_THRESHOLD_PX) {
        const t = 1 - (pos / EDGE_SCROLL_THRESHOLD_PX);
        return -Math.round(t * EDGE_SCROLL_MAX_SPEED_PX);
    }
    if (pos > size - EDGE_SCROLL_THRESHOLD_PX) {
        const t = 1 - ((size - pos) / EDGE_SCROLL_THRESHOLD_PX);
        return Math.round(t * EDGE_SCROLL_MAX_SPEED_PX);
    }
    return 0;
}

function edgeScrollTick() {
    if (!edgeScrollPointer) { edgeScrollRaf = 0; return; }
    const rect = freeform.getBoundingClientRect();
    const dx = edgeScrollDelta(edgeScrollPointer.clientX - rect.left, rect.width);
    const dy = edgeScrollDelta(edgeScrollPointer.clientY - rect.top, rect.height);
    if (dx !== 0 || dy !== 0) {
        freeform.scrollLeft += dx;
        freeform.scrollTop += dy;
    }
    edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
}

function startEdgeScroll() {
    if (!edgeScrollRaf) edgeScrollRaf = requestAnimationFrame(edgeScrollTick);
}

function stopEdgeScroll() {
    edgeScrollPointer = null;
    if (edgeScrollRaf) {
        cancelAnimationFrame(edgeScrollRaf);
        edgeScrollRaf = 0;
    }
}

// -- Drag via event delegation (disabled on phone) ------
freeform.addEventListener('pointerdown', (e) => {
    if (isPhone) return;
    const header = e.target.closest('.wb-card-header');
    if (!header) return;
    if (e.target.closest('.wb-card-btn') || e.target.closest('.wb-card-actions')) return;

    const card = header.closest('.wb-card');
    if (!card) return;

    e.preventDefault();
    // Clear any active layout-transition so the drag follows the cursor
    // without easing lag. Tidy/expand/contract may still be animating this
    // card when the user grabs it.
    card.classList.remove('wb-card--animating-layout');
    card.style.transitionDelay = '';
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = card.offsetLeft;
    const origTop = card.offsetTop;
    // Capture scroll at drag start. If auto-scroll or user-initiated scroll
    // changes freeform.scrollLeft/scrollTop mid-drag, the card's
    // freeform-relative position must be adjusted by the scroll delta so
    // the card stays glued to the cursor.
    const startScrollX = freeform.scrollLeft;
    const startScrollY = freeform.scrollTop;
    card.classList.add('wb-card--dragging');
    let moved = false;
    edgeScrollPointer = e;
    startEdgeScroll();

    function computeNewPos(ev) {
        const scrollDx = freeform.scrollLeft - startScrollX;
        const scrollDy = freeform.scrollTop - startScrollY;
        return {
            x: Math.max(0, origLeft + (ev.clientX - startX) + scrollDx),
            y: Math.max(0, origTop + (ev.clientY - startY) + scrollDy),
        };
    }

    function onMove(ev) {
        moved = true;
        edgeScrollPointer = ev;
        const { x, y } = computeNewPos(ev);
        card.style.left = `${x}px`;
        card.style.top = `${y}px`;
        growBounds({ x, y, w: card.offsetWidth, h: card.offsetHeight });
    }

    function onUp(ev) {
        window.document.removeEventListener('pointermove', onMove);
        window.document.removeEventListener('pointerup', onUp);
        stopEdgeScroll();
        card.classList.remove('wb-card--dragging');
        if (!moved) return;
        // Suppress click-to-expand after drag
        card.dataset.justDragged = '1';
        setTimeout(() => { delete card.dataset.justDragged; }, 0);
        const { x, y } = computeNewPos(ev);
        const name = card.getAttribute('data-filename');
        if (name) {
            const existing = layout[name] || { x: 0, y: 0, w: CARD_W, h: CARD_H };
            layout[name] = { x, y, w: existing.w, h: existing.h };
            growBounds({ x, y, w: existing.w, h: existing.h });
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
        growBounds({ x: card.offsetLeft, y: card.offsetTop, w, h });
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
            growBounds({ x: existing.x, y: existing.y, w, h });
            persistLayout();
        }
    }

    window.document.addEventListener('pointermove', onMove);
    window.document.addEventListener('pointerup', onUp);
});

// -- Double-click on card header = three-state size cycle -------------
// Cycle: collapsed → normal → expanded → normal → collapsed → …
// Endpoint states (collapsed, expanded) always step back to normal.
// From normal, direction decides: `sizeDir` stored per-card on the DOM
// (data-size-dir). Flip happens at endpoints so the next double-click
// continues the zigzag. Single-button clicks update sizeDir too so the
// cycle stays coherent when users mix buttons with double-clicks.
//
// Scoped to .wb-card-header only so double-click inside a card's body
// (selecting a word, dragging a chart) stays the user's intended action.
// Buttons inside the header chrome still opt out. Header-drag tracks
// pointer movement; dblclick only fires when the two clicks land at the
// same spot (no drag), so the two gestures don't conflict.
freeform.addEventListener('dblclick', (e) => {
    const header = e.target.closest('.wb-card-header');
    if (!header) return;
    if (e.target.closest('.wb-card-btn, .wb-card-actions')) return;
    const card = header.closest('.wb-card');
    if (!card) return;
    e.preventDefault();
    e.stopPropagation();
    cycleCardSize(card);
});

function cycleCardSize(card) {
    const filename = card.getAttribute('data-filename');
    if (!filename) return;
    const isCollapsed = card.classList.contains('wb-card--collapsed');
    const isExpanded = card.classList.contains('wb-card--expanded');
    const expandBtn = card.querySelector('.wb-card-expand-btn');

    if (isCollapsed) {
        // Endpoint — step back to normal. Next cycle step from normal
        // should continue upward (toward expanded).
        toggleCardCollapse(filename, false);
        card.dataset.sizeDir = 'up';
        return;
    }
    if (isExpanded) {
        // Endpoint — contract to normal via the existing expand-btn
        // click handler (owns the prevLayout restore). Next step from
        // normal should continue downward (toward collapsed).
        if (expandBtn) expandBtn.click();
        card.dataset.sizeDir = 'down';
        return;
    }
    // Normal state — step in the stored direction. Default 'up' means
    // a fresh card's first double-click takes it to Expanded, matching
    // users' "zoom in" expectation.
    const dir = card.dataset.sizeDir || 'up';
    if (dir === 'up') {
        if (expandBtn) expandBtn.click();
    } else {
        toggleCardCollapse(filename, true);
    }
}

// -- Expand/contract a card to 80% of viewport ----------
// Click .wb-card-expand-btn → toggle .wb-card--expanded on the parent card.
// Expand stashes the pre-expand layout in data-prev-layout (transient — lives
// on the DOM node, not in layout.json). Contract restores from that stash.
// Tidy clears the transient state so the expanded size becomes permanent
// (the Tidy arrangement reads offsetWidth/offsetHeight which is already the
// expanded size; Tidy just needs to stop pretending the card is "peeking").
freeform.addEventListener('click', (e) => {
    const btn = e.target.closest('.wb-card-expand-btn');
    if (!btn) return;
    const card = btn.closest('.wb-card');
    if (!card) return;
    e.stopPropagation();
    const name = card.getAttribute('data-filename');
    // Smooth-animate the position/size change. See animateLayoutChange
    // for lifecycle; safely removed if the user grabs the card mid-animation.
    animateLayoutChange([card]);
    const wasExpanded = card.classList.contains('wb-card--expanded');
    // Record the cycle direction BEFORE we flip the class so the double-
    // click loop reads a coherent value regardless of where the user
    // clicked from: pressing the button at Expanded is a contract (down);
    // pressing it at Normal is an expand (up).
    card.dataset.sizeDir = wasExpanded ? 'down' : 'up';
    if (card.classList.contains('wb-card--expanded')) {
        // Contract — restore to saved layout
        const saved = card.dataset.prevLayout;
        if (saved) {
            try {
                const p = JSON.parse(saved);
                card.style.left = p.x + 'px';
                card.style.top = p.y + 'px';
                card.style.width = p.w + 'px';
                card.style.height = p.h + 'px';
            } catch (_) { /* malformed — fall through, just drop the expanded flag */ }
            delete card.dataset.prevLayout;
        }
        card.classList.remove('wb-card--expanded');
    } else {
        // Expand — stash current layout, resize to 80% of viewport centered
        // in the currently visible portion of the freeform area.
        card.dataset.prevLayout = JSON.stringify({
            x: card.offsetLeft, y: card.offsetTop,
            w: card.offsetWidth, h: card.offsetHeight,
        });
        const w = Math.floor(window.innerWidth * 0.8);
        const h = Math.floor(window.innerHeight * 0.8);
        const x = (freeform.scrollLeft || 0) + Math.max(0, Math.floor((freeform.clientWidth - w) / 2));
        const y = (freeform.scrollTop || 0) + Math.max(0, Math.floor((freeform.clientHeight - h) / 2));
        card.style.left = x + 'px';
        card.style.top = y + 'px';
        card.style.width = w + 'px';
        card.style.height = h + 'px';
        card.classList.add('wb-card--expanded');
        card.classList.add('wb-card--resized');
    }
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
// React (CanvasCardRuntime) portals each card into the correct container
// directly: meta cards (data-meta="true") into `#canvas-meta-list`, content
// cards into `#canvas-freeform`. We DON'T move cards between containers
// here — doing so violates React's portal contract (its reconciler expects
// the portaled node to stay in the parent it was portaled into, and throws
// NotFoundError on the next layout commit if it moved). So this observer
// only handles content cards arriving in freeform; meta cards are entirely
// React's responsibility.
let pendingCards = [];
const childObserver = new MutationObserver((mutations) => {
    for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
            const node = added[j];
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
mica.onDestroy(() => { childObserver.disconnect(); });

// -- Cross-window layout sync -------------------------
const unsubLayout = mica.on('layout-changed', (msg) => {
    if (msg.source === (mica.windowId || '')) return;
    fetch('/api/layout', { headers: projectHeaders() })
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
    // Newly created file is by definition fresh — heat trail bumps it.
    if (msg && msg.filename) bumpHeat(msg.filename);
});
mica.onDestroy(unsubCreated);

const unsubDeleted = mica.on('file-deleted', (msg) => {
    if (msg.filename && layout[msg.filename]) {
        delete layout[msg.filename];
        persistLayout();
    }
    if (msg && msg.filename) heatTimestamps.delete(msg.filename);
    setTimeout(updateEmptyState, 100);
});
mica.onDestroy(unsubDeleted);

// -- Heat trail ----------------------------------------
//
// Persistent recency-driven opacity. Decoupled from the existing 10s
// `wb-card--agent-write` / `wb-card--external-write` glow (whiteboard.css):
// that animation is the spike attention-grabber on fresh writes; this is
// the long-term "shape of activity" baseline that lets the user glance at
// a busy canvas and tell which cards have been touched recently versus
// which are reference material.
//
// Bucketed (5 levels) rather than a continuous gradient so the CSS layer
// is cheap (no animation churn; each card lives in one of five static
// states). Buckets transition smoothly via the existing
// `transition: opacity 0.3s` rule on .canvas-freeform > .wb-card.
//
// Heat is per-tab in-memory state. Persisted state is unnecessary —
// modifiedAt seeds initial heat on load; live broadcasts maintain it.

// Per-card last-touched timestamp (ms). Bumped on file-created /
// file-changed / agent-write; seeded from data-modified-at when a card
// first mounts. Map key: filename.
const heatTimestamps = new Map();

// Bucket thresholds in seconds since last touch. Tuned so:
//   - Fresh edits keep the card at full strength for a half hour
//     (covers a typical iteration session).
//   - Cards stay legible (>= 0.45 opacity) even when cold.
const HEAT_BUCKETS = [
    { name: 'hot',  maxAgeSec: 60 },          // < 1 min
    { name: 'warm', maxAgeSec: 1800 },        // < 30 min
    { name: 'mild', maxAgeSec: 14400 },       // < 4 hours
    { name: 'cool', maxAgeSec: 86400 },       // < 24 hours
    // anything else → 'cold'
];

function bucketForAge(ageSec) {
    for (const b of HEAT_BUCKETS) if (ageSec < b.maxAgeSec) return b.name;
    return 'cold';
}

function applyHeat(filename) {
    const card = freeform.querySelector(`.wb-card[data-filename="${CSS.escape(filename)}"]`);
    if (!card) return;
    const ts = heatTimestamps.get(filename);
    if (typeof ts !== 'number') {
        // Unknown card (no event seen, no modifiedAt seeded) — treat as warm
        // so we don't visually demote brand-new cards we haven't tracked yet.
        card.dataset.heat = 'warm';
        return;
    }
    const ageSec = (Date.now() - ts) / 1000;
    card.dataset.heat = bucketForAge(ageSec);
}

function bumpHeat(filename) {
    if (!filename) return;
    heatTimestamps.set(filename, Date.now());
    applyHeat(filename);
}

// Initial seed when a card first mounts — read its data-modified-at and
// translate the file's mtime into a heat timestamp. Skip if we already have
// a more-recent timestamp from a live event (don't demote a hot card just
// because positionCard re-ran).
function seedHeatFromCard(card, filename) {
    if (!card || !filename) return;
    const isoStr = card.dataset.modifiedAt;
    if (!isoStr) return;
    const t = new Date(isoStr).getTime();
    if (Number.isNaN(t)) return;
    const existing = heatTimestamps.get(filename);
    if (typeof existing !== 'number' || t > existing) {
        heatTimestamps.set(filename, t);
    }
    applyHeat(filename);
}

// Re-sweep all tracked cards once a minute to age them through buckets.
// Cheap: just read timestamps, compute bucket, set dataset attribute.
const heatDecayTimer = setInterval(() => {
    for (const filename of heatTimestamps.keys()) applyHeat(filename);
}, 60_000);
mica.onDestroy(() => clearInterval(heatDecayTimer));

// Live writes (any source — agent, this tab, other tab, external editor)
// bump heat. Self-edits intentionally count: the heat trail is "shape of
// activity" not "alert me to changes" (which is what the 10s glow does,
// and which already skips self-echoes).
const unsubChanged = mica.on('file-changed', (msg) => {
    if (msg && msg.filename) bumpHeat(msg.filename);
});
mica.onDestroy(unsubChanged);

// -- Collapse / expand individual cards -----------------
// CardFrame's minimize button dispatches `mica-toggle-collapse` with
// `{ filename }`. The state lives here (in layout[filename].collapsed),
// not in React: toggling the CSS class is what drives the visual change
// and CardFrame reads no state from us — it just sends the signal.
function toggleCardCollapse(filename, forceValue) {
    const card = freeform.querySelector(`.wb-card[data-filename="${CSS.escape(filename)}"]`);
    if (!card) return;
    const nowCollapsed = typeof forceValue === 'boolean'
        ? forceValue
        : !card.classList.contains('wb-card--collapsed');

    // Expanded → Collapsed is a compound: contract first (restoring the
    // stashed pre-expand layout) and then apply the collapsed class in
    // one user click. A card shouldn't be simultaneously at 80% viewport
    // AND header-only; that's a nonsensical state. The contract path
    // synthesizes a click on the existing expand button, which is the
    // canonical home of the contract logic (dataset.prevLayout restore,
    // class removal, animation). Keeps one implementation of contract
    // instead of duplicating its quirks here.
    if (nowCollapsed && card.classList.contains('wb-card--expanded')) {
        const expandBtn = card.querySelector('.wb-card-expand-btn');
        if (expandBtn) expandBtn.click();
    }

    card.classList.toggle('wb-card--collapsed', nowCollapsed);
    const existing = layout[filename] || { x: card.offsetLeft, y: card.offsetTop, w: card.offsetWidth, h: card.offsetHeight };
    // h in layout ALWAYS represents the uncollapsed height. Measuring
    // card.offsetHeight AFTER applying wb-card--collapsed gives us ~40px
    // (just the header), which would clobber the real size — reload or
    // uncollapse would then render a paper-thin card. When collapsing,
    // preserve the previously-stored h; only update it when the card is
    // currently uncollapsed (its measured height is meaningful).
    // Heal migration: if a prior write from an older build saved a
    // sub-minimum h, reset to CARD_H so uncollapse produces a usable
    // card instead of the same paper-thin strip.
    const measuredH = nowCollapsed
        ? (typeof existing.h === 'number' && existing.h >= MIN_H ? existing.h : CARD_H)
        : card.offsetHeight;
    layout[filename] = {
        ...existing,
        x: card.offsetLeft, y: card.offsetTop,
        w: card.offsetWidth, h: measuredH,
        collapsed: nowCollapsed,
    };
    persistLayout();
    // Keep the double-click cycle direction coherent with button actions.
    // sizeDir records the DIRECTION JUST TAKEN. A collapse (any→Collapsed)
    // is downward; an uncollapse (Collapsed→Normal) is upward. Reading
    // sizeDir at a later double-click from Normal decides whether to
    // continue up (to Expanded) or down (back to Collapsed).
    card.dataset.sizeDir = nowCollapsed ? 'down' : 'up';
}
const _onToggleCollapse = (ev) => {
    const name = ev && ev.detail && ev.detail.filename;
    if (typeof name === 'string' && name) toggleCardCollapse(name);
};
window.addEventListener('mica-toggle-collapse', _onToggleCollapse);
mica.onDestroy(() => window.removeEventListener('mica-toggle-collapse', _onToggleCollapse));

// Coalesce bursts of card-class events (the agent typically copies card.html +
// card.js + card.css + metadata.json in quick succession; without coalescing,
// each fires its own buildToolbar and overlapping async fetches duplicate the
// button row before settling).
let cardClassRebuildTimer = null;
const unsubCardClass = mica.on('card-class-changed', () => {
    if (cardClassRebuildTimer) clearTimeout(cardClassRebuildTimer);
    cardClassRebuildTimer = setTimeout(() => {
        cardClassRebuildTimer = null;
        buildToolbar();
    }, 250);
});
mica.onDestroy(() => {
    if (cardClassRebuildTimer) clearTimeout(cardClassRebuildTimer);
    unsubCardClass();
});

// -- Toolbar ------------------------------------------
// Default content stubs for each card class
const defaultStubs = {
    'md': (name) => `# ${name}\n`,
    'todo': (name) => `---\nmica: todo\n---\n# ${name}\n\n## Active\n- [ ] @human First task\n\n## Done\n`,
    'mmd': (name) => `graph TD\n    A[Start] --> B[End]\n`,
    'chat': (name) => { const id = `chat-${Date.now().toString(36)}`; return `---\nmica: chat\nid: ${id}\n---\nMica AI chat session.\n`; },
    'terminal': () => '',
};

// Monotonic counter so an in-flight fetch from a previous buildToolbar() is
// recognized as stale and dropped on the floor. Without this, two overlapping
// rebuilds can both call .appendChild(btn) for their N buttons → duplicates.
let toolbarBuildGen = 0;

function buildToolbar() {
    const myGen = ++toolbarBuildGen;
    // Build the new content in a detached fragment so the visible toolbar
    // doesn't go through an empty state while the /api/card-classes fetch
    // is in flight. Prior implementation cleared `toolbar.innerHTML` first,
    // which (combined with `.project-toolbar { flex-wrap: wrap }`) caused
    // the bar to collapse from 2 rows to 1 row for ~50-100ms per rebuild
    // and the canvas to shift up/down each time — visible as flicker during
    // agent builds that rewrite card-class files repeatedly.
    const fragment = window.document.createDocumentFragment();

    // Tidy button — lives on the LEFT of the toolbar (append first). The
    // async card-class buttons land after the spacer, so the final layout
    // is [Tidy][spacer(flex:1)][+ creation buttons].
    const tidyBtn = window.document.createElement('button');
    tidyBtn.className = 'toolbar-btn';
    tidyBtn.textContent = 'Tidy Up';
    tidyBtn.title = 'Tidy layout — resolves overlaps with minimal displacement (cards stay where you put them). Hold Option/Alt for fit-all-on-screen grid.';
    tidyBtn.addEventListener('click', (e) => {
        const cards = Array.from(freeform.querySelectorAll('.wb-card'));
        if (cards.length === 0) return;

        // Commit any expanded cards' current size as permanent: clear the
        // transient flag + stash so Tidy's offsetWidth/offsetHeight reads
        // flow through unchanged. This is the "Tidy while expanded → makes
        // the new size stick" behavior.
        cards.forEach((c) => {
            if (c.classList.contains('wb-card--expanded')) {
                c.classList.remove('wb-card--expanded');
                delete c.dataset.prevLayout;
            }
        });

        if (e.altKey) {
            // Alt+Tidy: fit-all-on-screen. Keep filename sort here — the
            // user is explicitly asking for a square recap and alphabetical
            // order is a reasonable stable ordering for that intent.
            cards.sort((a, b) => {
                const aName = a.getAttribute('data-filename') || '';
                const bName = b.getAttribute('data-filename') || '';
                return aName.localeCompare(bName);
            });
        } else {
            // Normal Tidy: sort by current VISUAL position so cards stay
            // near where the user put them. Tolerance groups cards that are
            // roughly in the same row into the same sort-bucket, so two
            // cards whose top values differ by ~20px stay horizontal
            // neighbors rather than getting reordered by a pixel difference.
            const ROW_TOLERANCE = 40;
            const yOf = (c) => {
                const v = parseInt(c.style.top || '0', 10);
                return Number.isFinite(v) ? v : 0;
            };
            const xOf = (c) => {
                const v = parseInt(c.style.left || '0', 10);
                return Number.isFinite(v) ? v : 0;
            };
            cards.sort((a, b) => {
                const ay = yOf(a), by = yOf(b);
                if (Math.abs(ay - by) > ROW_TOLERANCE) return ay - by;
                return xOf(a) - xOf(b);
            });
        }

        // Cascade-animate cards into their new positions.
        animateLayoutChange(cards, { stagger: true });

        const maxWidth = freeform.offsetWidth || 1200;
        const maxHeight = freeform.offsetHeight || 800;

        if (e.altKey) {
            // Option/Alt + Tidy: resize cards to fit all on screen
            const count = cards.length;
            // Calculate optimal grid: try to make it roughly square
            const cols = Math.ceil(Math.sqrt(count));
            const rows = Math.ceil(count / cols);
            let cardW = Math.floor((maxWidth - 2 * EDGE_PAD - (cols - 1) * GAP) / cols);
            let cardH = Math.floor((maxHeight - 2 * EDGE_PAD - (rows - 1) * GAP) / rows);
            // Clamp to reasonable minimums
            cardW = Math.max(MIN_W, cardW);
            cardH = Math.max(MIN_H, cardH);

            layout = {};
            cards.forEach((card, i) => {
                const col = i % cols;
                const row = Math.floor(i / cols);
                const x = EDGE_PAD + col * (cardW + GAP);
                const y = EDGE_PAD + row * (cardH + GAP);
                card.style.left = `${x}px`;
                card.style.top = `${y}px`;
                card.style.width = `${cardW}px`;
                card.style.height = `${cardH}px`;
                card.classList.add('wb-card--resized');
                const name = card.getAttribute('data-filename');
                if (name) layout[name] = { x, y, w: cardW, h: cardH,
                    collapsed: card.classList.contains('wb-card--collapsed') };
            });
        } else {
            // Normal tidy — MINIMAL DISPLACEMENT. Keep every card as close
            // to its current position as possible; only nudge cards that
            // overlap something already placed. Reading-order processing
            // (top→bottom, left→right) anchors the top-left card at its
            // current spot and resolves conflicts forward.
            //
            // Resolution strategy per card: try current position. If it
            // overlaps an already-placed card, push it right past the
            // overlap (preserves Y, minimal vertical displacement). If
            // that would exceed canvas width, snap to (EDGE_PAD, just
            // below the lowest overlapping card). Repeat until placed.
            //
            // No partition by collapse state — a collapsed card stays where
            // the user left it; only its own offsetHeight (the header strip)
            // is used for collision math, so it occupies less vertical
            // space and won't push later cards down unnecessarily.
            //
            // For Alt+Tidy use the fit-all-on-screen path above; this path
            // is the gentle conflict resolver users reach for after
            // dragging things into rough position.
            const placed = [];  // [{x, y, w, h}] in placement order
            layout = {};

            const overlaps = (a, b) => (
                a.x < b.x + b.w &&
                a.x + a.w > b.x &&
                a.y < b.y + b.h &&
                a.y + a.h > b.y
            );

            cards.forEach(card => {
                const isCollapsed = card.classList.contains('wb-card--collapsed');
                const w = card.offsetWidth || CARD_W;
                // Use offsetHeight for collision math: a collapsed card
                // measures only the header strip, so other cards naturally
                // pack below it without extra padding.
                const collisionH = card.offsetHeight || CARD_H;

                // Start at the card's current position, clamped into canvas
                // bounds. Cards pulled in from drag-overflow that landed
                // off-canvas snap back into the visible area as a side
                // effect — desirable for tidy.
                let x = parseInt(card.style.left || '0', 10) || EDGE_PAD;
                let y = parseInt(card.style.top || '0', 10) || EDGE_PAD;
                if (x < EDGE_PAD) x = EDGE_PAD;
                if (y < EDGE_PAD) y = EDGE_PAD;
                if (x + w > maxWidth - EDGE_PAD) x = Math.max(EDGE_PAD, maxWidth - EDGE_PAD - w);

                // Resolve overlaps against already-placed cards.
                let attempts = 0;
                while (attempts < cards.length + 1) {
                    const candidate = { x, y, w, h: collisionH };
                    const hit = placed.find((p) => overlaps(candidate, p));
                    if (!hit) break;
                    // Try push-right past the conflict (preserves Y).
                    const pushRightTo = hit.x + hit.w + GAP;
                    if (pushRightTo + w <= maxWidth - EDGE_PAD) {
                        x = pushRightTo;
                    } else {
                        // No horizontal room — drop to next row, anchored
                        // below the LOWEST card whose row overlaps this Y
                        // band, then reset X to start of canvas.
                        const sameBand = placed.filter((p) =>
                            p.y < y + collisionH && p.y + p.h > y
                        );
                        const newY = sameBand.length > 0
                            ? Math.max(...sameBand.map((p) => p.y + p.h)) + GAP
                            : hit.y + hit.h + GAP;
                        y = newY;
                        x = EDGE_PAD;
                    }
                    attempts++;
                }

                card.style.left = `${x}px`;
                card.style.top = `${y}px`;
                placed.push({ x, y, w, h: collisionH });

                const name = card.getAttribute('data-filename');
                if (name) {
                    const prior = layout[name] || {};
                    // Preserve the UNCOLLAPSED height in stored layout so
                    // re-expand restores the right size — never persist the
                    // 40px measured height of a collapsed card as `h`.
                    const storedH = isCollapsed
                        ? (typeof prior.h === 'number' && prior.h >= MIN_H ? prior.h : CARD_H)
                        : collisionH;
                    layout[name] = { ...prior, x, y, w, h: storedH,
                        collapsed: isCollapsed };
                }
            });
        }
        // Tidy is the ONLY place that shrinks canvas bounds — it's the
        // explicit "clean up" gesture. Recompute from the newly-placed
        // cards + padding so scrollbars match the tidied content.
        let maxR = 0, maxB = 0;
        for (const name of Object.keys(layout)) {
            const c = layout[name];
            if (!c) continue;
            const right = c.x + c.w;
            const bottom = c.y + c.h;
            if (right > maxR) maxR = right;
            if (bottom > maxB) maxB = bottom;
        }
        bounds = {
            w: Math.max(maxR + BOUNDS_PAD, freeform.clientWidth || 1200),
            h: Math.max(maxB + BOUNDS_PAD, freeform.clientHeight || 800),
        };
        applyBounds();
        persistLayout();
    });
    fragment.appendChild(tidyBtn);

    // Spacer — pushes the card-creation buttons (added below) to the right.
    const spacer = window.document.createElement('span');
    spacer.className = 'toolbar-spacer';
    fragment.appendChild(spacer);

    // Dynamically load card classes and create buttons. The fetch is async,
    // but we append into the detached fragment — the visible toolbar keeps
    // showing the previous build's buttons until the swap below.
    fetch('/api/card-classes', { headers: projectHeaders() }).then(r => r.json()).then(classes => {
        if (myGen !== toolbarBuildGen) return;  // a newer build superseded us
        // Skip canvas (that is us) and meta cards (infrastructure shells
        // like canvas-back and skills — seeded by template, not user-
        // creatable). Server decorates each entry with `meta: boolean`
        // from its metadata.json; read it here so future meta card types
        // are auto-hidden without a code change.
        const names = Object.keys(classes).filter(n => n !== 'canvas' && !classes[n].meta);
        names.sort();

        names.forEach(name => {
            const btn = window.document.createElement('button');
            btn.className = 'toolbar-btn';
            btn.textContent = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
            // Scope-aware styling so the toolbar tells you where a card comes
            // from at a glance: project-scoped (green-italic), library (blue),
            // or built-in (default). `scope` is the canonical field; older
            // builds without it fall back to the legacy builtIn boolean.
            const shortcut = '\n\nOption/Alt-click to create immediately with an auto-generated filename (skips the name prompt).';
            // displayName: friendly product name from metadata.json (e.g.
            // "Qwen Code", "Claude Code"). When present, prepended to the
            // tooltip so the button label (which is the file extension)
            // is annotated with what it actually creates. Absent for
            // most editor classes; falls back to scope-only tooltip.
            const friendly = classes[name].displayName;
            const friendlyPrefix = friendly ? `${friendly}\n` : '';
            const scope = classes[name].scope || (classes[name].builtIn ? 'builtin' : 'project');
            if (scope === 'library') {
                const libPath = classes[name].libraryProject || '';
                const libName = libPath.split('/').filter(Boolean).pop() || libPath;
                btn.title = `${friendlyPrefix}From library project: ${libName}${shortcut}`;
                btn.style.borderColor = 'rgba(96,165,250,0.4)';
            } else if (scope === 'project') {
                btn.title = `${friendlyPrefix}Project card class${shortcut}`;
                btn.style.borderColor = 'rgba(74,222,128,0.3)';
                btn.style.fontStyle = 'italic';
            } else {
                btn.title = `${friendlyPrefix}Built-in card class${shortcut}`;
            }

            // Pre-fill the prompt with the lowest free name. The base is
            // the sanitized PROJECT name (cards read as "quickstart.chat",
            // "trip.md" — the project is the noun, the class is the type
            // via extension), not the class name doubled ("chat.chat",
            // "filebrowser.filebrowser" — the old default, repetitive).
            // Collisions append "-2", "-3", … as before. Filenames are
            // durable identifiers (layout.json key, agent references) and
            // no rename tool exists, so a clean default is worth one
            // extra fetch. Falls back to the legacy timestamped suffix
            // if the file list can't be loaded so the action never blocks
            // on a transient backend hiccup.
            const projectSlug = ((typeof mica !== 'undefined' && mica.project) || '')
                .toLowerCase()
                .replace(/\s+/g, '-')
                .replace(/[^a-z0-9_-]/g, '')
                || name;  // fallback to class name in workspace mode or if slug wipes empty
            btn.addEventListener('click', async (e) => {
                let friendly = `${projectSlug}-${Date.now().toString(36)}.${name}`;  // legacy fallback
                try {
                    const r = await fetch('/api/files?canvas=1', { headers: projectHeaders() });
                    if (r.ok) {
                        const data = await r.json();
                        // /api/files returns a raw array, not {files: [...]}. Earlier
                        // code wrote `data.files || []` which always evaluated to
                        // [] — leaving `taken` empty so collisions were missed and
                        // alt-click kept overwriting the same `<projectSlug>.<class>` file.
                        const files = Array.isArray(data) ? data : (data && Array.isArray(data.files) ? data.files : []);
                        const taken = new Set(files.map((f) => f.name));
                        const ext = `.${name}`;
                        const candidate = (suffix) => suffix
                            ? `${canvasRoot}${projectSlug}-${suffix}${ext}`
                            : `${canvasRoot}${projectSlug}${ext}`;
                        if (!taken.has(candidate(''))) {
                            friendly = `${projectSlug}${ext}`;
                        } else {
                            for (let n = 2; n < 10000; n++) {
                                if (!taken.has(candidate(n))) { friendly = `${projectSlug}-${n}${ext}`; break; }
                            }
                        }
                    }
                } catch { /* fall through to legacy default */ }
                // Option/Alt-click skips the name prompt and creates
                // immediately with the auto-generated friendly name. Used
                // when the user trusts the default and just wants the card.
                const skipPrompt = e.altKey;
                const baseName = skipPrompt
                    ? friendly
                    : prompt(`Name for the ${name} card:`, friendly);
                if (!baseName) return;
                const trimmed = baseName.trim();
                if (!trimmed) return;
                const filename = trimmed.indexOf('.') === -1 ? `${trimmed}.${name}` : trimmed;
                const path = filename.indexOf('/') === -1 ? canvasRoot + filename : filename;
                const stubFn = defaultStubs[name];
                const content = stubFn ? stubFn(trimmed) : '';
                fetch(`/api/files/${encodeURIComponent(path)}`, {
                    method: 'PUT',
                    headers: projectHeaders({ 'Content-Type': 'application/json' }),
                    body: JSON.stringify({ content }),
                }).catch(err => { console.error('[canvas] Card creation failed:', err); });
            });
            fragment.appendChild(btn);
        });

        // Atomic swap — replace the old toolbar contents with the freshly
        // built fragment in a single DOM operation. No empty intermediate
        // state, no layout shift, no canvas reflow.
        if (myGen !== toolbarBuildGen) return;
        toolbar.replaceChildren(fragment);
    }).catch(err => { console.error('[canvas] Failed to load card classes:', err); });
}

buildToolbar();

// -- Load layout then position initial + pending cards --
loadLayout().then(() => {
    positionAllCards();
    for (let i = 0; i < pendingCards.length; i++) positionCard(pendingCards[i]);
    pendingCards = [];
});
