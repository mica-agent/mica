import { useState, useEffect } from 'react';
import { fetchProject } from './api/canvasFiles';
import type { ProjectInfo } from './api/canvasFiles';
import { connect as connectMicaSocket, onConnectionChange } from './api/micaSocket';
import CanvasCardRuntime from './whiteboard/CanvasCardRuntime';

connectMicaSocket();

export default function App() {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => onConnectionChange(setWsConnected), []);

  useEffect(() => {
    fetchProject().then(setProject).catch(console.error);
  }, []);

  if (!project) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#999', background: '#0a0a0f' }}>
        Connecting to project...
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#0a0a0f', color: '#ccc' }}>
      {/* Top bar */}
      <div style={{
        height: 40, flexShrink: 0,
        display: 'flex', alignItems: 'center', padding: '0 16px',
        background: 'rgba(10, 10, 15, 0.9)', borderBottom: '1px solid #222',
        gap: 12,
      }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{project.name}</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            width: 8, height: 8, borderRadius: '50%',
            background: wsConnected ? '#4ade80' : '#f87171',
          }}
          title={wsConnected ? 'Connected' : 'Disconnected'}
        />
      </div>

      {/* Canvas */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        <CanvasCardRuntime />
      </div>
    </div>
  );
}
