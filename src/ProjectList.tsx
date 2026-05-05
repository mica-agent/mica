import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  fetchProjects,
  createProjectApi,
  cloneProjectApi,
  renameProjectApi,
  deleteProjectApi,
  fetchTemplates,
} from './api/canvasFiles';
import type { ProjectInfo, TemplateInfo } from './api/canvasFiles';
import { on as onMicaEvent } from './api/micaSocket';

interface Props {
  workspaceName: string;
  onOpenProject: (project: ProjectInfo) => void;
}

type SortMode = 'recent' | 'name';
const SORT_KEY = 'mica.projectListSort';

function readInitialSort(): SortMode {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === 'name' || v === 'recent') return v;
  } catch { /* localStorage unavailable */ }
  return 'recent';
}

export default function ProjectList({ workspaceName, onOpenProject }: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [createTemplate, setCreateTemplate] = useState<string | null>(null);  // null = closed; "" = empty project; "<name>" = template
  const [showClone, setShowClone] = useState(false);
  const [showNewMenu, setShowNewMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>(readInitialSort);

  // Persist sort preference across sessions. Wrapped in try/catch because
  // private-browsing modes throw on localStorage writes.
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sortMode); } catch { /* ignore */ }
  }, [sortMode]);

  // Sorted view of the projects array. Memoized so resorting only happens
  // when projects or sortMode change.
  //   recent: by lastOpenedAt descending; never-opened projects fall to the
  //           bottom (sorted alphabetically among themselves so the order
  //           is stable).
  //   name:   case-insensitive locale-aware alphabetical.
  const sortedProjects = useMemo(() => {
    const copy = projects.slice();
    if (sortMode === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } else {
      copy.sort((a, b) => {
        const aT = a.lastOpenedAt ?? 0;
        const bT = b.lastOpenedAt ?? 0;
        if (bT !== aT) return bT - aT;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      });
    }
    return copy;
  }, [projects, sortMode]);

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

  // Live updates from the server. Two events to handle:
  //   - project-activity-changed: an agent turn started / ended for a project.
  //     Patch the project's activeTurns + lastActivityAt without re-fetching.
  //   - project-list-changed: a project was created / deleted / renamed.
  //     Re-fetch the whole list (cheap; not paginated).
  useEffect(() => {
    const offActivity = onMicaEvent('project-activity-changed', (raw) => {
      const data = raw as { project: string; activeTurns: number; lastActivityAt: number };
      setProjects((prev) => prev.map((p) =>
        p.name === data.project
          ? { ...p, activeTurns: data.activeTurns, lastActivityAt: data.lastActivityAt }
          : p
      ));
    });
    const offListChanged = onMicaEvent('project-list-changed', () => {
      loadProjects();
    });
    return () => { offActivity(); offListChanged(); };
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

  const handleClone = useCallback(async (url: string, name: string, docsDir: string, template: string | null) => {
    setError(null);
    try {
      const result = await cloneProjectApi(url, name || undefined, docsDir, template || undefined);
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
          templates={templates}
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
        <>
          {/* Sort control — shown only when there's more than one project. */}
          {projects.length > 1 && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 11, color: '#888' }}>Sort:</span>
              <div style={{ display: 'inline-flex', borderRadius: 6, border: '1px solid rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <button
                  onClick={() => setSortMode('recent')}
                  style={{
                    background: sortMode === 'recent' ? 'rgba(255,255,255,0.08)' : 'transparent',
                    color: sortMode === 'recent' ? '#ddd' : '#888',
                    border: 'none',
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                  title="Most recently opened first"
                >
                  Recent
                </button>
                <button
                  onClick={() => setSortMode('name')}
                  style={{
                    background: sortMode === 'name' ? 'rgba(255,255,255,0.08)' : 'transparent',
                    color: sortMode === 'name' ? '#ddd' : '#888',
                    border: 'none',
                    padding: '4px 10px',
                    fontSize: 12,
                    cursor: 'pointer',
                    borderLeft: '1px solid rgba(255,255,255,0.08)',
                  }}
                  title="Alphabetical by name"
                >
                  Name
                </button>
              </div>
            </div>
          )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sortedProjects.map((project) => (
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
                <div style={{ fontSize: 15, fontWeight: 500, color: '#ddd', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {(project.activeTurns ?? 0) > 0 && (
                    <span
                      title={`Agent active${project.activeTurns! > 1 ? ` (${project.activeTurns} turns)` : ''}`}
                      style={activeDotStyle}
                    />
                  )}
                  {project.name}
                </div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2, display: 'flex', gap: 8 }}>
                  {project.hasGit && <span style={{ color: '#f97316' }}>git</span>}
                  {project.hasMica && <span style={{ color: '#4ade80' }}>mica</span>}
                  {!project.hasMica && <span style={{ color: '#888' }}>not initialized</span>}
                  {(project.activeTurns ?? 0) > 0 && <span style={{ color: '#4ade80' }}>active</span>}
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
        </>
      )}
    </div>
  );
}

// ── Forms ────────────────────────────────────────────────

function CreateForm({ template, onSubmit, onCancel }: { template: string | null; onSubmit: (name: string, docsDir: string, template: string | null) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  // UI prefill only — the server's DEFAULT_CANVAS_ROOT is authoritative
  // when the field is left blank. Keeping a matching visible default is
  // UX polish so users can see what they'll get without typing.
  const [docsDir, setDocsDir] = useState('canvas');

  // Wrapping in <form> means Enter from any input fires onSubmit — no extra
  // keypress handlers needed. The submit button is the form's default action;
  // Cancel uses type="button" so it doesn't trigger submission.
  return (
    <form
      style={formStyle}
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSubmit(name.trim(), docsDir.trim(), template);
      }}
    >
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
          Canvas directory
          <input
            value={docsDir}
            onChange={(e) => setDocsDir(e.target.value)}
            placeholder="canvas"
            style={inputStyle}
          />
          <span style={{ fontSize: 11, color: '#666' }}>Where Mica places canvas cards (spec, todo, etc.)</span>
        </label>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="submit" style={btnStyle} disabled={!name.trim()}>
          Create
        </button>
        <button type="button" onClick={onCancel} style={{ ...btnStyle, background: 'transparent' }}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function CloneForm({
  templates,
  onSubmit,
  onCancel,
}: {
  templates: TemplateInfo[];
  onSubmit: (url: string, name: string, docsDir: string, template: string | null) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  // Default to `canvas` for cloned repos — most repos have their own `docs/`,
  // and putting Mica's canvas there would mix seed cards with the repo's
  // documentation. `canvas/` keeps them separate. This is a UI prefill;
  // the server's DEFAULT_CANVAS_ROOT is authoritative when the field is
  // left blank.
  const [docsDir, setDocsDir] = useState('canvas');
  // Default to the first template (usually cloud-claude) so a cloned repo gets
  // skills + agents out of the box. User can switch to "None" for a bare clone.
  const [template, setTemplate] = useState<string | null>(templates[0]?.name ?? null);
  const [cloning, setCloning] = useState(false);

  return (
    <form
      style={formStyle}
      onSubmit={(e) => {
        e.preventDefault();
        if (!url.trim() || cloning) return;
        setCloning(true);
        onSubmit(url.trim(), name.trim(), docsDir.trim(), template);
      }}
    >
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
        Canvas directory
        <input
          value={docsDir}
          onChange={(e) => setDocsDir(e.target.value)}
          placeholder="canvas"
          style={inputStyle}
        />
        <span style={{ fontSize: 11, color: '#666' }}>Where Mica places canvas cards (kept separate from the repo&apos;s own files)</span>
      </label>
      {templates.length > 0 && (
        <label style={labelStyle}>
          Overlay template
          <select
            value={template ?? ''}
            onChange={(e) => setTemplate(e.target.value || null)}
            style={{ ...inputStyle, appearance: 'auto' }}
          >
            <option value="">None (bare clone, no skills)</option>
            {templates.map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>
          <span style={{ fontSize: 11, color: '#666' }}>Adds skills, agents, and seed cards alongside the cloned repo</span>
        </label>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          type="submit"
          style={btnStyle}
          disabled={!url.trim() || cloning}
        >
          {cloning ? 'Cloning...' : 'Clone'}
        </button>
        <button type="button" onClick={onCancel} style={{ ...btnStyle, background: 'transparent' }}>
          Cancel
        </button>
      </div>
    </form>
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

// Pulsing green dot rendered next to a project name when activeTurns > 0.
// Inline animation defined via a once-injected <style> block; React's inline
// style API doesn't support @keyframes, so we inject the keyframe rule into
// document.head on module load.
const activeDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: '#4ade80',
  boxShadow: '0 0 8px rgba(74, 222, 128, 0.6)',
  animation: 'mica-active-pulse 1.6s ease-in-out infinite',
  flexShrink: 0,
};

if (typeof document !== 'undefined' && !document.getElementById('mica-active-pulse-style')) {
  const styleEl = document.createElement('style');
  styleEl.id = 'mica-active-pulse-style';
  styleEl.textContent = `
    @keyframes mica-active-pulse {
      0%, 100% { opacity: 0.5; transform: scale(0.92); }
      50%      { opacity: 1;   transform: scale(1.1);  }
    }
  `;
  document.head.appendChild(styleEl);
}
