import { useState, useEffect, useCallback } from 'react';
import { fetchProjects } from './api/canvasFiles';
import type { ProjectConfig } from './api/canvasFiles';
import { connect as connectMicaSocket, onConnectionChange } from './api/micaSocket';
import CanvasCardRuntime from './whiteboard/CanvasCardRuntime';
import ProjectNav from './ProjectNav';
import './App.css';

// Connect the shared WebSocket for widget communication
connectMicaSocket();

// ── App ────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);
  const [wsConnected, setWsConnected] = useState(false);
  const [wasConnected, setWasConnected] = useState(false);

  useEffect(() => onConnectionChange((val) => {
    setWsConnected(val);
    if (val) setWasConnected(true);
  }), []);

  const loadProjects = useCallback(() => {
    fetchProjects()
      .then((p) => {
        setProjects(p);
        // Restore last selected project by ID, fallback to first
        const savedId = localStorage.getItem('mica-active-project');
        const savedIdx = savedId ? p.findIndex(proj => proj.id === savedId) : -1;
        setActiveProjectIndex(savedIdx >= 0 ? savedIdx : 0);
      })
      .catch((err) => console.error('Failed to fetch projects:', err));
  }, []);

  useEffect(() => { loadProjects(); }, []);

  const activeProject = projects[activeProjectIndex] || null;
  const canvasColor = '#4a8aff';

  if (!activeProject) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999' }}>
        Loading project...
      </div>
    );
  }

  const projectId = activeProject.id;

  return (
    <div className="app-main">
      <div className="app app--project">
        <div
          className="app-bg-tint"
          style={{ background: 'rgba(74, 138, 255, 0.06)' }}
        />
        <div
          className="app-bg-glow"
          style={{ background: canvasColor }}
        />

        <nav className="breadcrumb">
          <ProjectNav
            projects={projects}
            activeProject={activeProject}
            onSwitch={(i) => {
              setActiveProjectIndex(i);
              if (projects[i]) localStorage.setItem('mica-active-project', projects[i].id);
            }}
            onProjectsChanged={loadProjects}
          />
          <span className="breadcrumb-spacer" />
          <span
            className={`breadcrumb-ws-indicator ${wsConnected ? "breadcrumb-ws-indicator--connected" : "breadcrumb-ws-indicator--disconnected"}`}
            title={wsConnected ? "Connected" : "Disconnected — reconnecting..."}
          />
        </nav>

        <div className="project-content">
          <CanvasCardRuntime
            key={projectId}
            projectId={projectId}
          />
        </div>

        {wasConnected && !wsConnected && (
          <div className="ws-overlay">
            <div className="ws-overlay-content">
              <div className="ws-overlay-spinner" />
              <div className="ws-overlay-text">Reconnecting...</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
