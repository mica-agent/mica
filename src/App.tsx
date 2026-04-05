import { useState, useEffect, useCallback } from 'react';
import { fetchProjects } from './api/canvasFiles';
import type { ProjectConfig } from './api/canvasFiles';
import { connect as connectMicaSocket } from './api/micaSocket';
import CanvasCardRuntime from './whiteboard/CanvasCardRuntime';
import ProjectNav from './ProjectNav';
import './App.css';

// Connect the shared WebSocket for widget communication
connectMicaSocket();

// ── App ────────────────────────────────────────────────────

export default function App() {
  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [activeProjectIndex, setActiveProjectIndex] = useState(0);

  const loadProjects = useCallback(() => {
    fetchProjects()
      .then((p) => {
        setProjects(p);
        setActiveProjectIndex((prev) => Math.min(prev, Math.max(0, p.length - 1)));
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
            onSwitch={(i) => { setActiveProjectIndex(i); }}
            onProjectsChanged={loadProjects}
          />
        </nav>

        <div className="project-content">
          <CanvasCardRuntime
            key={projectId}
            projectId={projectId}
          />
        </div>
      </div>
    </div>
  );
}
