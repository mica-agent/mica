import { useState, useEffect, useCallback } from 'react';
import { fetchWorkspace, fetchProjects, openProjectApi } from './api/canvasFiles';
import type { WorkspaceInfo, ProjectInfo } from './api/canvasFiles';
import { connect as connectMicaSocket, onConnectionChange } from './api/micaSocket';
import CanvasCardRuntime from './whiteboard/CanvasCardRuntime';
import ProjectList from './ProjectList';
import './App.css';

connectMicaSocket();

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [activeProject, setActiveProject] = useState<ProjectInfo | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [wasConnected, setWasConnected] = useState(false);

  useEffect(() => onConnectionChange((val) => {
    setWsConnected(val);
    if (val) setWasConnected(true);
  }), []);

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
          </>
        ) : (
          <span style={{ fontWeight: 600, fontSize: 14 }}>{workspace.name}</span>
        )}
        <span style={{ flex: 1 }} />
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
          <CanvasCardRuntime key={activeProject.name} />
        ) : (
          <ProjectList
            workspaceName={workspace.name}
            onOpenProject={handleOpenProject}
          />
        )}
      </div>

      {/* Reconnection overlay */}
      {wasConnected && !wsConnected && (
        <div className="ws-overlay">
          <div className="ws-overlay-content">
            <div className="ws-overlay-spinner" />
            <div className="ws-overlay-text">Reconnecting...</div>
          </div>
        </div>
      )}
    </div>
  );
}
