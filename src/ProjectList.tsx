import { useState, useEffect, useCallback } from 'react';
import {
  fetchProjects,
  createProjectApi,
  cloneProjectApi,
  renameProjectApi,
  deleteProjectApi,
  fetchTemplates,
} from './api/canvasFiles';
import type { ProjectInfo, TemplateInfo } from './api/canvasFiles';

interface Props {
  workspaceName: string;
  onOpenProject: (project: ProjectInfo) => void;
}

export default function ProjectList({ workspaceName, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createTemplate, setCreateTemplate] = useState<string | null>(null);  // null = closed; "" = empty project; "<name>" = template
  const [showClone, setShowClone] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const list = await fetchProjects();
      setProjects(list);
    } catch (err) {
      console.error('Failed to load projects:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProjects();
    fetchTemplates().then(setTemplates).catch((err) => console.error('Failed to load templates:', err));
  }, [loadProjects]);

  const handleCreate = useCallback(async (name: string, docsDir: string, template: string | null) => {
    setError(null);
    try {
      const result = await createProjectApi(name, template ? undefined : docsDir, template || undefined);
      setCreateTemplate(null);
      // Open the new project immediately — same flow as clicking it from the list.
      onOpenProject({ name: result.name, path: "" });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [onOpenProject]);

  const handleClone = useCallback(async (url: string, name: string, docsDir: string) => {
    setError(null);
    try {
      const result = await cloneProjectApi(url, name || undefined, docsDir);
      setShowClone(false);
      onOpenProject({ name: result.name, path: "" });
    } catch (err) {
      setError((err as Error).message);
    }
  }, [onOpenProject]);

  const handleRename = useCallback(async (project: ProjectInfo) => {
    const newName = prompt('New name:', project.name);
    if (!newName || newName === project.name) return;
    setError(null);
    try {
      await renameProjectApi(project.name, newName);
      await loadProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadProjects]);

  const handleDelete = useCallback(async (project: ProjectInfo) => {
    if (!confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;
    setError(null);
    try {
      await deleteProjectApi(project.name);
      await loadProjects();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [loadProjects]);

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '48px 24px' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: '#eee', margin: 0 }}>
          {workspaceName}
        </h1>
        <p style={{ color: '#888', fontSize: 14, margin: '8px 0 0' }}>
          Select a project or create a new one
        </p>
      </div>

      {error && (
        <div style={{
          background: 'rgba(248, 113, 113, 0.1)', border: '1px solid rgba(248, 113, 113, 0.3)',
          borderRadius: 8, padding: '10px 14px', marginBottom: 16, color: '#f87171', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 24, position: 'relative' }}>
        <div style={{ position: 'relative' }}>
          <button onClick={() => { setShowNewMenu((v) => !v); setShowClone(false); }} style={btnStyle}>
            + New Project ▾
          </button>
          {showNewMenu && (
            <div style={menuStyle} onMouseLeave={() => setShowNewMenu(false)}>
              <div
                style={menuItemStyle}
                onClick={() => { setCreateTemplate(''); setShowNewMenu(false); setShowClone(false); }}
              >
                <div style={{ color: '#ddd', fontSize: 13 }}>Empty project</div>
                <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>Bare project, no skills bundled</div>
              </div>
              {templates.length > 0 && <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '4px 0' }} />}
              {templates.map((t) => (
                <div
                  key={t.name}
                  style={menuItemStyle}
                  onClick={() => { setCreateTemplate(t.name); setShowNewMenu(false); setShowClone(false); }}
                >
                  <div style={{ color: '#ddd', fontSize: 13 }}>{t.name}</div>
                  {t.description && <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>{t.description}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => { setShowClone(true); setCreateTemplate(null); setShowNewMenu(false); }} style={btnStyle}>
          Clone Repo
        </button>
      </div>

      {/* Create form */}
      {createTemplate !== null && (
        <CreateForm
          template={createTemplate || null}
          onSubmit={handleCreate}
          onCancel={() => setCreateTemplate(null)}
        />
      )}

      {/* Clone form */}
      {showClone && (
        <CloneForm
          onSubmit={handleClone}
          onCancel={() => setShowClone(false)}
        />
      )}

      {/* Project list */}
      {loading ? (
        <div style={{ color: '#666', padding: 24 }}>Loading projects...</div>
      ) : projects.length === 0 ? (
        <div style={{ color: '#666', padding: 24, textAlign: 'center' }}>
          <p style={{ fontSize: 16, marginBottom: 8 }}>No projects yet</p>
          <p style={{ fontSize: 13 }}>Create a new project or clone an existing repository</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {projects.map((project) => (
            <div
              key={project.name}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '14px 16px', borderRadius: 8,
                background: 'rgba(255, 255, 255, 0.03)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                cursor: 'pointer',
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255, 255, 255, 0.06)'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255, 255, 255, 0.03)'; }}
              onClick={() => onOpenProject(project)}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 15, fontWeight: 500, color: '#ddd' }}>
                  {project.name}
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2, display: 'flex', gap: 8 }}>
                  {project.hasGit && <span style={{ color: '#f97316' }}>git</span>}
                  {project.hasMica && <span style={{ color: '#4ade80' }}>mica</span>}
                  {!project.hasMica && <span style={{ color: '#888' }}>not initialized</span>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={() => handleRename(project)}
                  style={smallBtnStyle}
                  title="Rename"
                >
                  Rename
                </button>
                <button
                  onClick={() => handleDelete(project)}
                  style={{ ...smallBtnStyle, color: '#f87171' }}
                  title="Delete"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────

function CreateForm({ template, onSubmit, onCancel }: { template: string | null; onSubmit: (name: string, docsDir: string, template: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [docsDir, setDocsDir] = useState('docs');

  return (
    <div style={formStyle}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 500, color: '#ddd' }}>
        {template ? `New Project from "${template}"` : 'New Empty Project'}
      </h3>
      <label style={labelStyle}>
        Project name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="my-project"
          style={inputStyle}
          autoFocus
        />
      </label>
      {!template && (
        <label style={labelStyle}>
          Planning docs directory
          <input
            value={docsDir}
            onChange={(e) => setDocsDir(e.target.value)}
            placeholder="docs"
            style={inputStyle}
          />
          <span style={{ fontSize: 11, color: '#666' }}>Where Mica places new planning files (spec, todo, etc.)</span>
        </label>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button onClick={() => name.trim() && onSubmit(name.trim(), docsDir.trim() || 'docs', template)} style={btnStyle} disabled={!name.trim()}>
          Create
        </button>
        <button onClick={onCancel} style={{ ...btnStyle, background: 'transparent' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CloneForm({ onSubmit, onCancel }: { onSubmit: (url: string, name: string, docsDir: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [docsDir, setDocsDir] = useState('docs');
  const [cloning, setCloning] = useState(false);

  return (
    <div style={formStyle}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 500, color: '#ddd' }}>Clone Repository</h3>
      <label style={labelStyle}>
        Git URL
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://github.com/user/repo.git"
          style={inputStyle}
          autoFocus
        />
      </label>
      <label style={labelStyle}>
        Project name (optional)
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="auto-detected from URL"
          style={inputStyle}
        />
      </label>
      <label style={labelStyle}>
        Planning docs directory
        <input
          value={docsDir}
          onChange={(e) => setDocsDir(e.target.value)}
          placeholder="docs"
          style={inputStyle}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          onClick={() => {
            if (!url.trim()) return;
            setCloning(true);
            onSubmit(url.trim(), name.trim(), docsDir.trim() || 'docs');
          }}
          style={btnStyle}
          disabled={!url.trim() || cloning}
        >
          {cloning ? 'Cloning...' : 'Clone'}
        </button>
        <button onClick={onCancel} style={{ ...btnStyle, background: 'transparent' }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────

const btnStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.06)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 6,
  padding: '8px 14px',
  color: '#ccc',
  fontSize: 13,
  cursor: 'pointer',
};

const smallBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: '#888',
  fontSize: 12,
  cursor: 'pointer',
  padding: '4px 8px',
};

const formStyle: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.03)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  borderRadius: 8,
  padding: 20,
  marginBottom: 24,
};

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 12,
  fontSize: 13,
  color: '#aaa',
};

const inputStyle: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.3)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 4,
  padding: '8px 10px',
  color: '#eee',
  fontSize: 14,
  outline: 'none',
};

const menuStyle: React.CSSProperties = {
  position: 'absolute',
  top: '100%',
  left: 0,
  marginTop: 4,
  background: '#1a1a1a',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 6,
  minWidth: 280,
  zIndex: 10,
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  padding: 4,
};

const menuItemStyle: React.CSSProperties = {
  padding: '8px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  transition: 'background 0.1s',
};
