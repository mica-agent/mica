import { useState, useEffect, useCallback } from 'react';
import { fetchWorkspace, fetchProjects, openProjectApi } from './api/canvasFiles';
import type { WorkspaceInfo, ProjectInfo } from './api/canvasFiles';
import { connect as connectMicaSocket, onConnectionChange, on as onSocketEvent, subscribeProject, unsubscribeProject } from './api/micaSocket';
import CanvasCardRuntime from './whiteboard/CanvasCardRuntime';
import ProjectList from './ProjectList';
import './App.css';

connectMicaSocket();

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wasConnected, setWasConnected] = useState(false);
  // Show a manual "Reload" failsafe on the reconnecting overlay after a
  // few seconds of being stuck. The auto-reconnect polling loop in
  // micaSocket.ts retries every 2s but can wedge (sleeping device,
  // dropped Tailscale, frozen connect()) and leave the user staring at
  // the spinner with no escape. The button does a hard reload — drops
  // any unsaved card-input state but reliably re-establishes everything.
  const [showReloadFailsafe, setShowReloadFailsafe] = useState(false);
  // Library-project state for the header icons. libraryPaths is the set
  // of absolute paths currently in ~/.mica/include-projects.json;
  // exportedClasses is the active project's project-scoped card class
  // names (what it would expose if it were a library). Both refreshed
  // when the active project changes or when the canvas card class
  // fires the mica-libraries-changed event after a toggle.
  const [libraryPaths, setLibraryPaths] = useState<Set<string>>(new Set());
  const [exportedClasses, setExportedClasses] = useState<string[]>([]);
  // Transient toast queue for agent-initiated pin events. Surfaces "Mica
  // pinned <name>" so the user knows what just landed on their canvas
  // without scrolling to find a new card. User-initiated pins (via the
  // shared-library discovery card) don't emit pin-added — the user
  // already saw their own click.
  const [toasts, setToasts] = useState<Array<{ id: number; text: string }>>([]);

  const loadLibraryPaths = useCallback(async () => {
    try {
      const API_BASE = import.meta.env.VITE_MICA_API || '';
      const res = await fetch(`${API_BASE}/api/library-projects`);
      if (!res.ok) return;
      const data = await res.json() as { include?: string[] };
      setLibraryPaths(new Set(Array.isArray(data.include) ? data.include : []));
    } catch { /* silent — header just won't show the icon */ }
  }, []);

  useEffect(() => { void loadLibraryPaths(); }, [loadLibraryPaths]);

  // Refresh library set after the canvas card class toggles a library
  // on/off. The toggle fires a window event so the header here can
  // re-render its 📚 icon without polling.
  useEffect(() => {
    const handler = () => { void loadLibraryPaths(); };
    window.addEventListener('mica-libraries-changed', handler);
    return () => window.removeEventListener('mica-libraries-changed', handler);
  }, [loadLibraryPaths]);

  // Pull the project-scoped card classes for the active project. Used
  // as the tooltip on the 📚 icon — "shared, exports: gpu-monitor, ...".
  useEffect(() => {
    if (!activeProject) { setExportedClasses([]); return; }
    let cancelled = false;
    const API_BASE = import.meta.env.VITE_MICA_API || '';
    fetch(`${API_BASE}/api/card-classes`, { headers: { 'X-Mica-Project': activeProject.name } })
      .then((r) => r.ok ? r.json() : null)
      .then((d: Record<string, { scope?: string; meta?: boolean }> | null) => {
        if (cancelled || !d) return;
        const names = Object.keys(d).filter((name) => {
          const entry = d[name];
          return entry?.scope === 'project' && !entry?.meta;
        }).sort();
        setExportedClasses(names);
      })
      .catch(() => { if (!cancelled) setExportedClasses([]); });
    return () => { cancelled = true; };
  }, [activeProject]);

  const isCurrentShared = activeProject ? libraryPaths.has(activeProject.path) : false;

  useEffect(() => onConnectionChange((val) => {
    setWsConnected(val);
    if (val) setWasConnected(true);
  }), []);

  // Subscribe to agent-initiated pin notifications. Toast auto-dismisses
  // after 4s. The shared-library card class reacts to file-created
  // independently to refresh its pinned-state badge.
  useEffect(() => {
    const unsub = onSocketEvent("pin-added", (data: unknown) => {
      const ev = data as { filename?: string; source?: string };
      if (ev.source !== "agent" || !ev.filename) return;
      const name = ev.filename.startsWith("shared/") ? ev.filename.slice("shared/".length) : ev.filename;
      const id = Date.now() + Math.random();
      setToasts((cur) => [...cur, { id, text: `Mica pinned ${name}` }]);
      window.setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4000);
    });
    return unsub;
  }, []);

  // Arm the reload failsafe button after 10s of continuous disconnect.
  // 10s is past the natural reconnect window (auto-poll fires every 2s),
  // so a successful recovery hides this before it ever shows. Clears
  // immediately if the connection comes back.
  useEffect(() => {
    if (!(wasConnected && !wsConnected)) {
      setShowReloadFailsafe(false);
      return;
    }
    const t = setTimeout(() => setShowReloadFailsafe(true), 10000);
    return () => clearTimeout(t);
  }, [wasConnected, wsConnected]);

  // Global drag-resize handler for `.mica-resize-handle` inside any
  // `.mica-resizable` element. One handler covers every resizable
  // modal/overlay on the page, including elements inside card classes
  // (pointerdown bubbles to window).
  //
  // All listeners use the CAPTURE phase so a deeper handler calling
  // stopPropagation (the canvas card class attaches document-level
  // pointer listeners for pan/drag) can't block our cleanup. The
  // `buttons === 0` check inside onMove is the safety net: if pointerup
  // never reaches us (released outside viewport, window lost focus,
  // browser quirk), the next pointermove without a held button tears
  // the drag down. Together with the window 'blur' listener, the drag
  // always ends within one extra event tick.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const handle = target.closest('.mica-resize-handle') as HTMLElement | null;
      if (!handle) return;
      const root = handle.closest('.mica-resizable') as HTMLElement | null;
      if (!root) return;
      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = root.offsetWidth;
      const startH = root.offsetHeight;
      const cs = getComputedStyle(root);
      const minW = parseInt(cs.minWidth) || 200;
      const minH = parseInt(cs.minHeight) || 150;
      const pointerId = e.pointerId;
      let active = true;
      const onMove = (ev: PointerEvent) => {
        if (!active) return;
        if (ev.pointerId !== pointerId) return;
        if (ev.buttons === 0) { stop(); return; }
        const w = Math.max(minW, startW + ev.clientX - startX);
        const h = Math.max(minH, startH + ev.clientY - startY);
        root.style.width = `${w}px`;
        root.style.height = `${h}px`;
      };
      const stop = () => {
        if (!active) return;
        active = false;
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('pointercancel', stop, true);
        window.removeEventListener('blur', stop);
        document.body.style.userSelect = '';
        try { handle.releasePointerCapture(pointerId); } catch { /* released */ }
      };
      try { handle.setPointerCapture(pointerId); } catch { /* unsupported */ }
      document.body.style.userSelect = 'none';
      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      window.addEventListener('blur', stop);
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, []);

  // Tell the server which project this tab is subscribed to. Server uses this
  // to route file-watcher events to the right tabs (and to ref-count the
  // multi-project file watcher).
  useEffect(() => {
    if (activeProject) {
      subscribeProject(activeProject.name);
    } else {
      unsubscribeProject();
    }
  }, [activeProject]);

  // Mirror the active project name into the document title so browser tabs
  // show which project this tab is on. Reverts to the default when no
  // project is active. The "— Mica" suffix preserves the app identity for
  // tab grouping and bookmarking.
  useEffect(() => {
    // Brand name is injectable per-deployment: the server writes
    // window.__MICA_BRAND__ into the served index.html from MICA_DEMO_TITLE
    // (e.g. "Mica · Gemini"). Defaults to "Mica" when unset (single-tenant main).
    const brand = (typeof window !== "undefined" && (window as { __MICA_BRAND__?: string }).__MICA_BRAND__) || "Mica";
    document.title = activeProject ? `${activeProject.name} — ${brand}` : `${brand} — Magic Canvas`;
  }, [activeProject]);

  useEffect(() => {
    fetchWorkspace().then(setWorkspace).catch(console.error);
  }, []);

  // Restore last active project on mount
  useEffect(() => {
    const saved = sessionStorage.getItem("mica-active-project");
    if (saved) {
      try {
        const project = JSON.parse(saved) as ProjectInfo;
        openProjectApi(project.name).then((result) => {
          setActiveProject({ ...project, ...result });
        }).catch(() => {
          sessionStorage.removeItem("mica-active-project");
        });
      } catch {
        sessionStorage.removeItem("mica-active-project");
      }
    }
  }, []);

  const handleOpenProject = useCallback(async (project: ProjectInfo) => {
    try {
      const result = await openProjectApi(project.name);
      const p = { ...project, ...result };
      setActiveProject(p);
      sessionStorage.setItem("mica-active-project", JSON.stringify(p));
    } catch (err) {
      console.error('Failed to open project:', err);
    }
  }, []);

  const handleBackToProjects = useCallback(() => {
    setActiveProject(null);
    sessionStorage.removeItem("mica-active-project");
  }, []);

  if (!workspace) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999', background: '#0a0a0f' }}>
        Connecting...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0f', color: '#ccc', fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', system-ui, sans-serif" }}>
      {/* Top bar */}
      <div style={{
        minHeight: 40, flexShrink: 0,
        display: 'flex', alignItems: 'center',
        padding: 'env(safe-area-inset-top, 0) 16px 0 16px',
        background: 'rgba(10, 10, 15, 0.9)', borderBottom: '1px solid #222',
        gap: 12,
      }}>
        {activeProject ? (
          <>
            <button
              onClick={handleBackToProjects}
              style={{
                background: 'none', border: 'none', color: '#888', cursor: 'pointer',
                fontSize: 14, padding: '2px 8px', borderRadius: 4,
              }}
              title="Back to projects"
            >
              &larr;
            </button>
            <span style={{ color: '#666', fontSize: 12 }}>{workspace.name}</span>
            <span style={{ color: '#555' }}>/</span>
            <span style={{ fontWeight: 600, fontSize: 14 }}>{activeProject.name}</span>
            {isCurrentShared && (
              <span
                title={
                  exportedClasses.length === 0
                    ? 'Shared as a library project (no card classes exported yet)'
                    : `Shared as a library project\nExports:\n  ${exportedClasses.join('\n  ')}`
                }
                style={{ fontSize: 13, cursor: 'help' }}
              >
                📚
              </span>
            )}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent('mica-open-canvas-settings'))}
              title="Canvas settings (library, meta cards)"
              style={{
                background: 'none', border: 'none', color: '#888', cursor: 'pointer',
                fontSize: 14, padding: '2px 6px', borderRadius: 4,
              }}
            >
              ⚙
            </button>
          </>
        ) : (
          <span style={{ fontWeight: 600, fontSize: 14 }}>{workspace.name}</span>
        )}
        <span style={{ flex: 1 }} />
        <a
          href="https://github.com/mica-agent/mica"
          target="_blank"
          rel="noopener noreferrer"
          title="Mica on GitHub — opens in new tab"
          style={{
            color: '#888', textDecoration: 'none',
            fontWeight: 600, fontSize: 13, letterSpacing: 0.3,
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#ccc'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#888'; }}
        >
          Mica
        </a>
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: wsConnected ? '#4ade80' : '#f87171',
          }}
          title={wsConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', overflowX: 'hidden' }}>
        {activeProject ? (
          <CanvasCardRuntime key={activeProject.name} project={activeProject.name} />
        ) : (
          <ProjectList
            workspaceName={workspace.name}
            onOpenProject={handleOpenProject}
          />
        )}
      </div>

      {/* Pin-added toasts (agent-initiated only) */}
      {toasts.length > 0 && (
        <div
          style={{
            position: 'fixed', top: 56, right: 16, zIndex: 1000,
            display: 'flex', flexDirection: 'column', gap: 8,
            pointerEvents: 'none',
          }}
        >
          {toasts.map((t) => (
            <div
              key={t.id}
              style={{
                background: 'rgba(34, 197, 94, 0.92)', color: '#fff',
                padding: '8px 14px', borderRadius: 6, fontSize: 13,
                fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
                maxWidth: 360,
              }}
            >
              📌 {t.text}
            </div>
          ))}
        </div>
      )}

      {/* Reconnection overlay */}
      {wasConnected && !wsConnected && (
        <div className="ws-overlay">
          <div className="ws-overlay-content">
            {showReloadFailsafe
              ? <div className="ws-overlay-sadface" aria-hidden="true">☹</div>
              : <div className="ws-overlay-spinner" />}
            <div className="ws-overlay-text">{showReloadFailsafe ? 'Connection Lost' : 'Reconnecting...'}</div>
            {showReloadFailsafe && (
              <button
                className="ws-overlay-btn"
                onClick={() => {
                  // Match the auto-reconnect path in micaSocket.ts (force-
                  // reload-on-server-back). `replace(...?t=...)` is a fresh
                  // navigation, less likely to inherit the renderer's
                  // half-state than `reload()`. Specifically helps the
                  // voice card's audio context — soft reloads can leave
                  // it "running but silent" until a forced refresh.
                  window.location.replace(window.location.pathname + "?t=" + Date.now());
                }}
                title="Reload the page to re-establish the connection"
              >
                Reload to reconnect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
