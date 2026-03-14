import { useState, useEffect, useRef, useCallback } from 'react';
import { LAYERS, PROJECT_NAME } from './data';
import WhiteboardView from './whiteboard/WhiteboardView';
import type { WhiteboardHandle } from './whiteboard/WhiteboardView';
import ChatSidebar from './whiteboard/ChatSidebar';
import './App.css';
import './ai/ai.css';

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
      const target = e.target as HTMLElement;

      // Never intercept scroll inside the chat sidebar or expanded card overlay
      if (target.closest('.ai-sidebar, .wb-expanded-overlay')) return;

      // Check if we're inside any scrollable container (whiteboard grid, chat messages, etc.)
      const scrollable = target.closest('.wb-grid, .ai-chat-messages, .chat-messages, .workspace');
      if (scrollable) {
        const { scrollTop, scrollHeight, clientHeight } = scrollable;
        const hasScroll = scrollHeight > clientHeight + 5;
        const atTop = scrollTop <= 0;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 2;

        // If the container has scrollable content, let it scroll normally
        // Only pass through to layer navigation if at the very edge
        if (hasScroll) {
          if (e.deltaY < 0 && !atTop) return;
          if (e.deltaY > 0 && !atBottom) return;
        }
      }

      e.preventDefault();
      scrollAccRef.current += e.deltaY;

      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => { scrollAccRef.current = 0; }, 300);

      const threshold = 200; // Higher threshold to avoid accidental navigation
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

        if (t.clientX < 30 && touchesRef.current.size === 1) {
          edgeSwipeRef.current = { startX: t.clientX, startY: t.clientY, id: t.identifier };
        }
      }
      if (touchesRef.current.size >= 2) {
        edgeSwipeRef.current = null;
        const pts = Array.from(touchesRef.current.values());
        initialPinchRef.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      }
    }

    function onTouchMove(e: TouchEvent) {
      for (let i = 0; i < e.changedTouches.length; i++) {
        const t = e.changedTouches[i];
        touchesRef.current.set(t.identifier, { x: t.clientX, y: t.clientY });

        if (edgeSwipeRef.current && t.identifier === edgeSwipeRef.current.id) {
          const dx = t.clientX - edgeSwipeRef.current.startX;
          const dy = Math.abs(t.clientY - edgeSwipeRef.current.startY);
          if (dx > 80 && dy < 100) {
            ascend();
            edgeSwipeRef.current = null;
          }
        }
      }

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
      // Don't intercept when user is typing in an input or textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); descend(); }
      if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); ascend(); }
      const n = parseInt(e.key);
      if (n >= 1 && n <= 4) navigateTo(n - 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [descend, ascend, navigateTo]);

  // ── Render ─────────────────────────────────────────────

  const layerIdMap: ('mission' | 'experience' | 'architecture' | 'implementation')[] =
    ['mission', 'experience', 'architecture', 'implementation'];

  const whiteboardRef = useRef<WhiteboardHandle>(null);
  const [agentBusyLayer, setAgentBusyLayer] = useState<number | null>(null);

  return (
    <div className="app-with-ai">
      <div className="app-main">
        <div className="app">
          <div
            className="app-bg-tint"
            style={{ background: currentLayer.bgTint }}
          />
          <div
            className="app-bg-glow"
            style={{ background: currentLayer.color }}
          />

          <nav className="breadcrumb">
            <span className="breadcrumb-project">{PROJECT_NAME}</span>
            <span className="breadcrumb-sep">›</span>
            {LAYERS.map((layer) => (
              <span
                key={layer.id}
                className={`breadcrumb-layer ${layer.index === activeLayer ? 'breadcrumb-layer--active' : ''} ${layer.index === agentBusyLayer ? 'breadcrumb-layer--busy' : ''}`}
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

          <div className="depth-indicator">
            {LAYERS.map((layer) => (
              <div
                key={layer.id}
                className={`depth-segment ${layer.index === activeLayer ? 'depth-segment--active' : ''} ${layer.index === agentBusyLayer ? 'depth-segment--busy' : ''}`}
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

          <div className="layer-stack">
            {LAYERS.map((layer) => (
              <div
                key={layer.id}
                className={`layer-container ${layerPosition(layer.index, activeLayer)}`}
              >
                <WhiteboardView
                  ref={layer.index === activeLayer ? whiteboardRef : null}
                  layerId={layer.id}
                  layerColor={layer.color}
                />
              </div>
            ))}
          </div>

          <div
            className={`edge-swipe-hint ${activeLayer > 0 ? 'edge-swipe-hint--visible' : ''}`}
            style={{ '--layer-color': currentLayer.color } as React.CSSProperties}
          />

          <div className={`nav-hint ${navHintVisible ? 'nav-hint--visible' : ''}`}>
            {navHint}
          </div>
        </div>
      </div>

      {/* Chat Sidebar — widget-based chat per layer */}
      <div className="ai-sidebar">
        <ChatSidebar
          activeLayer={layerIdMap[activeLayer]}
          layerColor={currentLayer.color}
          onFilesChanged={() => whiteboardRef.current?.refetch()}
          onAgentBusy={(busy) => setAgentBusyLayer(busy ? activeLayer : null)}
        />
      </div>
    </div>
  );
}
