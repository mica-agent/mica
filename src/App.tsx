import { useState, useEffect, useRef, useCallback } from 'react';
import { LAYERS, LAYER_DATA, PROJECT_NAME } from './data';
import type { LayerId } from './data';
import LayerWorkspace from './LayerWorkspace';
import './App.css';

// ── Helpers ────────────────────────────────────────────────

function layerPosition(layerIndex: number, activeIndex: number): string {
  const diff = layerIndex - activeIndex;
  if (diff === 0) return 'layer-active';
  if (diff === -1) return 'layer-ghost-above';
  if (diff === 1) return 'layer-ghost-below';
  if (diff < -1) return 'layer-hidden-above';
  return 'layer-hidden-below';
}

// ── App ────────────────────────────────────────────────────

export default function App() {
  const [activeLayer, setActiveLayer] = useState(0);
  const [navHint, setNavHint] = useState('');
  const [navHintVisible, setNavHintVisible] = useState(false);

  const scrollAccRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const initialPinchRef = useRef<number | null>(null);
  const edgeSwipeRef = useRef<{ startX: number; startY: number; id: number } | null>(null);
  const cooldownRef = useRef(false);
  const navHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentLayer = LAYERS[activeLayer];

  // ── Navigation ─────────────────────────────────────────

  const navigateTo = useCallback((index: number) => {
    if (index < 0 || index >= LAYERS.length || index === activeLayer || cooldownRef.current) return;
    cooldownRef.current = true;
    setActiveLayer(index);

    // Show nav hint
    const target = LAYERS[index];
    const direction = index > activeLayer ? 'Descending to' : 'Ascending to';
    showNavHint(`${direction} ${target.label}`);

    setTimeout(() => { cooldownRef.current = false; }, 600);
  }, [activeLayer]);

  const descend = useCallback(() => navigateTo(activeLayer + 1), [activeLayer, navigateTo]);
  const ascend = useCallback(() => navigateTo(activeLayer - 1), [activeLayer, navigateTo]);

  function showNavHint(text: string) {
    setNavHint(text);
    setNavHintVisible(true);
    if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
    navHintTimerRef.current = setTimeout(() => setNavHintVisible(false), 1500);
  }

  // ── Scroll wheel → layer navigation ───────────────────

  useEffect(() => {
    function onWheel(e: WheelEvent) {
      // Ignore if inside a scrollable workspace that hasn't reached its edge
      const target = e.target as HTMLElement;
      const workspace = target.closest('.workspace');
      if (workspace) {
        const { scrollTop, scrollHeight, clientHeight } = workspace;
        const atTop = scrollTop <= 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 2;

        if (e.deltaY < 0 && !atTop) return;
        if (e.deltaY > 0 && !atBottom) return;
      }

      e.preventDefault();
      scrollAccRef.current += e.deltaY;

      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => { scrollAccRef.current = 0; }, 300);

      const threshold = 120;
      if (scrollAccRef.current > threshold) {
        scrollAccRef.current = 0;
        descend();
      } else if (scrollAccRef.current < -threshold) {
        scrollAccRef.current = 0;
        ascend();
      }
    }

    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [descend, ascend]);

  // ── Touch → pinch for layer navigation ────────────────

  useEffect(() => {
    function onTouchStart(e: TouchEvent) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        touchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });

        // Detect left-edge touch for swipe-to-ascend
        if (t.clientX < 30 && touchesRef.current.size === 1) {
          edgeSwipeRef.current = { startX: t.clientX, startY: t.clientY, id: t.identifier };
        }
      }
      if (touchesRef.current.size >= 2) {
        edgeSwipeRef.current = null; // Cancel edge swipe if multi-touch
        const pts = Array.from(touchesRef.current.values());
        initialPinchRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      }
    }

    function onTouchMove(e: TouchEvent) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        touchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });

        // Left-edge swipe detection
        if (edgeSwipeRef.current && t.identifier === edgeSwipeRef.current.id) {
          const dx = t.clientX - edgeSwipeRef.current.startX;
          const dy = Math.abs(t.clientY - edgeSwipeRef.current.startY);
          if (dx > 80 && dy < 100) {
            ascend();
            edgeSwipeRef.current = null;
          }
        }
      }

      // Pinch detection
      if (touchesRef.current.size >= 2 && initialPinchRef.current !== null) {
        const pts = Array.from(touchesRef.current.values());
        const currentDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const delta = currentDist - initialPinchRef.current;

        if (delta > 100) {
          descend();
          initialPinchRef.current = currentDist;
        } else if (delta < -100) {
          ascend();
          initialPinchRef.current = currentDist;
        }
      }
    }

    function onTouchEnd(e: TouchEvent) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const id = e.changedTouches[i].identifier;
        touchesRef.current.delete(id);
        if (edgeSwipeRef.current?.id === id) edgeSwipeRef.current = null;
      }
      if (touchesRef.current.size < 2) {
        initialPinchRef.current = null;
      }
    }

    const opts: AddEventListenerOptions = { passive: false };
    window.addEventListener('touchstart', onTouchStart, opts);
    window.addEventListener('touchmove', onTouchMove, opts);
    window.addEventListener('touchend', onTouchEnd, opts);
    window.addEventListener('touchcancel', onTouchEnd, opts);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [descend, ascend]);

  // ── Keyboard shortcuts ────────────────────────────────

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); descend(); }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); ascend(); }
      // Number keys jump to layers
      const n = parseInt(e.key);
      if (n >= 1 && n <= 4) navigateTo(n - 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [descend, ascend, navigateTo]);

  // ── Render ─────────────────────────────────────────────

  return (
    <div className="app">
      {/* Background tint that shifts with active layer */}
      <div
        className="app-bg-tint"
        style={{ background: currentLayer.bgTint }}
      />
      <div
        className="app-bg-glow"
        style={{ background: currentLayer.color }}
      />

      {/* Breadcrumb */}
      <nav className="breadcrumb">
        <span className="breadcrumb-project">{PROJECT_NAME}</span>
        <span className="breadcrumb-sep">›</span>
        {LAYERS.map((layer) => (
          <span
            key={layer.id}
            className={`breadcrumb-layer ${layer.index === activeLayer ? 'breadcrumb-layer--active' : ''}`}
            style={{
              color: layer.index === activeLayer ? layer.color : undefined,
              background: layer.index === activeLayer ? `${layer.color}15` : undefined,
              borderColor: layer.index === activeLayer ? `${layer.color}30` : undefined,
            }}
            onClick={() => navigateTo(layer.index)}
          >
            {layer.icon} {layer.label}
          </span>
        ))}
      </nav>

      {/* Depth indicator */}
      <div className="depth-indicator">
        {LAYERS.map((layer) => (
          <div
            key={layer.id}
            className={`depth-segment ${layer.index === activeLayer ? 'depth-segment--active' : ''}`}
            style={{ '--layer-color': layer.color } as React.CSSProperties}
            onClick={() => navigateTo(layer.index)}
          >
            <span className="depth-icon" style={{ color: layer.color }}>
              {layer.icon}
            </span>
            <span className="depth-label">{layer.label}</span>
          </div>
        ))}
      </div>

      {/* Layer stack */}
      <div className="layer-stack">
        {LAYERS.map((layer) => (
          <div
            key={layer.id}
            className={`layer-container ${layerPosition(layer.index, activeLayer)}`}
          >
            <LayerWorkspace
              layer={layer}
              data={LAYER_DATA[layer.id as LayerId]}
            />
          </div>
        ))}
      </div>

      {/* Left-edge swipe hint (visible when can ascend) */}
      <div
        className={`edge-swipe-hint ${activeLayer > 0 ? 'edge-swipe-hint--visible' : ''}`}
        style={{ '--layer-color': currentLayer.color } as React.CSSProperties}
      />

      {/* Navigation hint */}
      <div className={`nav-hint ${navHintVisible ? 'nav-hint--visible' : ''}`}>
        {navHint}
      </div>
    </div>
  );
}
