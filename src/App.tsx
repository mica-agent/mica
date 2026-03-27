import { useState, useEffect, useRef, useCallback } from 'react';
import { buildCanvasMeta } from './data';
import type { CanvasMeta } from './data';
import { fetchProjects } from './api/canvasFiles';
import type { ProjectConfig } from './api/canvasFiles';
import { connect as connectMicaSocket } from './api/micaSocket';
import WhiteboardView from './whiteboard/WhiteboardView';
import type { WhiteboardHandle } from './whiteboard/WhiteboardView';
import ChatSidebar from './whiteboard/ChatSidebar';
import ProjectNav from './ProjectNav';
import './App.css';
import './ai/ai.css';

// Connect the shared WebSocket for widget communication
connectMicaSocket();

// ── Helpers ────────────────────────────────────────────────

function canvasPosition(canvasIndex: number, activeIndex: number): string {
  const diff = canvasIndex - activeIndex;
  if (diff === 0) return 'canvas-active';
  if (diff === -1) return 'canvas-ghost-above';
  if (diff === 1) return 'canvas-ghost-below';
  if (diff < -1) return 'canvas-hidden-above';
  return 'canvas-hidden-below';
}

// ── App ────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  const [activeCanvas, setActiveCanvas] = useState(0);
  const [navHint, setNavHint] = useState('');
  const [navHintVisible, setNavHintVisible] = useState(false);

  const scrollAccRef = useRef(0);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const initialPinchRef = useRef<number | null>(null);
  const edgeSwipeRef = useRef<{ startX: number; startY: number; id: number } | null>(null);
  const cooldownRef = useRef(false);
  const navHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch projects on mount and on demand
  const loadProjects = useCallback(() => {
    fetchProjects()
      .then((p) => {
        setProjects(p);
        // Clamp active index if projects were deleted
        setActiveProjectIndex((prev) => Math.min(prev, Math.max(0, p.length - 1)));
        if (p.length > 0 && activeCanvas >= (p[0]?.canvases.length ?? 1)) {
          setActiveCanvas(0);
        }
      })
      .catch((err) => console.error('Failed to fetch projects:', err));
  }, [activeCanvas]);

  useEffect(() => { loadProjects(); }, []);

  const activeProject = projects[activeProjectIndex] || null;
  const CANVASES: CanvasMeta[] = activeProject ? buildCanvasMeta(activeProject.canvases) : [];
  const currentCanvas = CANVASES[activeCanvas] || { color: '#4a8aff', bgTint: 'rgba(74,138,255,0.06)', icon: '\u25c6', label: '...', id: '', index: 0 };

  // ── Navigation ─────────────────────────────────────────

  const navigateTo = useCallback((index: number) => {
    if (index < 0 || index >= CANVASES.length || index === activeCanvas || cooldownRef.current) return;
    cooldownRef.current = true;
    setActiveCanvas(index);

    // Show nav hint
    const target = CANVASES[index];
    const direction = index > activeCanvas ? 'Descending to' : 'Ascending to';
    showNavHint(`${direction} ${target.label}`);

    setTimeout(() => { cooldownRef.current = false; }, 600);
  }, [activeCanvas, CANVASES]);

  const descend = useCallback(() => navigateTo(activeCanvas + 1), [activeCanvas, navigateTo]);
  const ascend = useCallback(() => navigateTo(activeCanvas - 1), [activeCanvas, navigateTo]);

  function showNavHint(text: string) {
    setNavHint(text);
    setNavHintVisible(true);
    if (navHintTimerRef.current) clearTimeout(navHintTimerRef.current);
    navHintTimerRef.current = setTimeout(() => setNavHintVisible(false), 1500);
  }

  // ── Scroll wheel → canvas navigation ─────────────────

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
        // Only pass through to canvas navigation if at the very edge
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

  // ── Touch → pinch for canvas navigation ───────────────

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
      if (n >= 1 && n <= CANVASES.length) navigateTo(n - 1);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [descend, ascend, navigateTo, CANVASES.length]);

  // ── Render ─────────────────────────────────────────────

  const whiteboardRef = useRef<WhiteboardHandle>(null);
  const [agentBusyCanvas, setAgentBusyCanvas] = useState<number | null>(null);

  // Loading state
  if (!activeProject || CANVASES.length === 0) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999' }}>
        Loading project...
      </div>
    );
  }

  const projectId = activeProject.id;

  return (
    <div className="app-with-ai">
      <div className="app-main">
        <div className="app">
          <div
            className="app-bg-tint"
            style={{ background: currentCanvas.bgTint }}
          />
          <div
            className="app-bg-glow"
            style={{ background: currentCanvas.color }}
          />

          <nav className="breadcrumb">
            <ProjectNav
              projects={projects}
              activeProject={activeProject}
              onSwitch={(i) => { setActiveProjectIndex(i); setActiveCanvas(0); }}
              onProjectsChanged={loadProjects}
            />
            <span className="breadcrumb-sep">&rsaquo;</span>
            {CANVASES.map((canvas) => (
              <span
                key={canvas.id}
                className={`breadcrumb-canvas ${canvas.index === activeCanvas ? 'breadcrumb-canvas--active' : ''} ${canvas.index === agentBusyCanvas ? 'breadcrumb-canvas--busy' : ''}`}
                style={{
                  color: canvas.index === activeCanvas ? canvas.color : undefined,
                  background: canvas.index === activeCanvas ? `${canvas.color}15` : undefined,
                  borderColor: canvas.index === activeCanvas ? `${canvas.color}30` : undefined,
                }}
                onClick={() => navigateTo(canvas.index)}
              >
                {canvas.icon} {canvas.label}
              </span>
            ))}
          </nav>

          <div className="depth-indicator">
            {CANVASES.map((canvas) => (
              <div
                key={canvas.id}
                className={`depth-segment ${canvas.index === activeCanvas ? 'depth-segment--active' : ''} ${canvas.index === agentBusyCanvas ? 'depth-segment--busy' : ''}`}
                style={{ '--canvas-color': canvas.color } as React.CSSProperties}
                onClick={() => navigateTo(canvas.index)}
              >
                <span className="depth-icon" style={{ color: canvas.color }}>
                  {canvas.icon}
                </span>
                <span className="depth-label">{canvas.label}</span>
              </div>
            ))}
          </div>

          <div className="canvas-stack">
            {CANVASES.map((canvas) => (
              <div
                key={canvas.id}
                className={`canvas-container ${canvasPosition(canvas.index, activeCanvas)}`}
              >
                <WhiteboardView
                  ref={canvas.index === activeCanvas ? whiteboardRef : null}
                  projectId={projectId}
                  canvasId={canvas.id}
                  canvasColor={canvas.color}
                />
              </div>
            ))}
          </div>

          <div
            className={`edge-swipe-hint ${activeCanvas > 0 ? 'edge-swipe-hint--visible' : ''}`}
            style={{ '--canvas-color': currentCanvas.color } as React.CSSProperties}
          />

          <div className={`nav-hint ${navHintVisible ? 'nav-hint--visible' : ''}`}>
            {navHint}
          </div>
        </div>
      </div>

      {/* Chat Sidebar — widget-based chat per canvas */}
      <div className="ai-sidebar">
        <ChatSidebar
          key={`${projectId}/${CANVASES[activeCanvas].id}`}
          projectId={projectId}
          activeCanvas={CANVASES[activeCanvas].id}
          canvasColor={currentCanvas.color}
          onFilesChanged={() => whiteboardRef.current?.refetch()}
          onAgentBusy={(busy) => setAgentBusyCanvas(busy ? activeCanvas : null)}
        />
      </div>
    </div>
  );
}
