import { useState, useEffect, useCallback } from 'react';
import { listExamplesApi, cloneProjectApi, type ExampleProject } from './api/canvasFiles';

// LoadExamplesModal — picker for the curated list of example projects
// (`examples.json` at the Mica repo root, served via /api/examples).
//
// UX shape:
//   * Checkbox per example + "Select all" toggle at the top.
//   * Footer: Cancel | Load N selected.
//   * On Load: Promise.allSettled across cloneProjectApi(url, name) — each
//     row's status flips to ✓ / ✗ as its clone completes. All-success →
//     onLoaded() + close. Partial failure → modal stays open so the user
//     sees which landed and which didn't, and can retry the failed ones.
//
// Style mirrors Connections.tsx (same overlay + .mica-resizable modal
// pattern + same Esc / click-outside dismiss).

interface Props {
  onClose: () => void;
  onLoaded: () => void;
}

type RowStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok' }
  | { kind: 'err'; message: string };

export default function LoadExamplesModal({ onClose, onLoaded }: Props) {
  const [examples, setExamples] = useState<ExampleProject[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loadingList, setLoadingList] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, RowStatus>>({});
  const [isLoading, setIsLoading] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await listExamplesApi();
      setExamples(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Esc to close — match Connections.tsx pattern. Skip when a load is in
  // flight so the user can't accidentally lose visibility into per-row
  // status mid-clone.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !isLoading) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, isLoading]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) =>
      prev.size === examples.length ? new Set() : new Set(examples.map((e) => e.name)),
    );
  };

  const handleLoad = async () => {
    const picks = examples.filter((e) => selected.has(e.name));
    if (picks.length === 0) return;
    setIsLoading(true);
    // Mark every pick as loading upfront so the row shows the inflight state.
    setStatus((prev) => {
      const next = { ...prev };
      for (const p of picks) next[p.name] = { kind: 'loading' };
      return next;
    });

    // Promise.allSettled — one rejection doesn't abort the others, and we
    // surface per-row outcome instead of bailing on first failure.
    const results = await Promise.allSettled(
      picks.map((p) => cloneProjectApi(p.url, p.name).then(() => p.name)),
    );

    const nextStatus: Record<string, RowStatus> = { ...status };
    let anyFailed = false;
    results.forEach((r, i) => {
      const name = picks[i].name;
      if (r.status === 'fulfilled') {
        nextStatus[name] = { kind: 'ok' };
      } else {
        anyFailed = true;
        nextStatus[name] = { kind: 'err', message: (r.reason as Error).message || 'clone failed' };
      }
    });
    setStatus(nextStatus);
    setIsLoading(false);

    // Tell parent so it refreshes its list — even on partial failure, the
    // succeeded clones already landed and the user should see them.
    onLoaded();
    // Close only if everything succeeded; otherwise keep open so the user
    // can read the errors and decide what to retry.
    if (!anyFailed) onClose();
  };

  const allSelected = examples.length > 0 && selected.size === examples.length;
  const loadDisabled = isLoading || selected.size === 0;

  return (
    <div
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget && !isLoading) onClose(); }}
    >
      <div className="mica-resizable" style={modalStyle}>
        <div className="mica-resize-handle" />
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#e6edf3' }}>Load Examples</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#888' }}>
              Curated example projects to git-clone into your workspace. Pick a few or take them all.
            </p>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close" disabled={isLoading}>×</button>
        </div>

        {error && (
          <div style={errorBoxStyle}>{error}</div>
        )}

        {loadingList ? (
          <div style={{ padding: 24, color: '#888' }}>Loading…</div>
        ) : examples.length === 0 ? (
          <div style={{ padding: 24, color: '#888' }}>
            No examples configured. Add entries to <code style={inlineCodeStyle}>examples.json</code> at the Mica repo root and reopen this dialog.
          </div>
        ) : (
          <>
            <label style={selectAllRowStyle}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={toggleAll}
                disabled={isLoading}
              />
              <span style={{ marginLeft: 8, fontSize: 13, color: '#ddd' }}>
                Select all ({examples.length})
              </span>
            </label>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '8px 0' }}>
              {examples.map((ex) => {
                const s = status[ex.name];
                return (
                  <label key={ex.name} style={rowStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(ex.name)}
                      onChange={() => toggle(ex.name)}
                      disabled={isLoading || s?.kind === 'ok'}
                      style={{ marginTop: 3, flexShrink: 0 }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 500, color: '#e6edf3' }}>{ex.name}</span>
                        {s?.kind === 'ok' && <span style={{ fontSize: 11, color: '#3fb950' }}>✓ loaded</span>}
                        {s?.kind === 'loading' && <span style={{ fontSize: 11, color: '#888' }}>⠿ cloning…</span>}
                        {s?.kind === 'err' && <span style={{ fontSize: 11, color: '#f87171' }}>✗ failed</span>}
                      </div>
                      {ex.description && (
                        <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{ex.description}</div>
                      )}
                      <div style={{ fontSize: 11, color: '#666', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {ex.url}
                      </div>
                      {s?.kind === 'err' && (
                        <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>{s.message}</div>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </>
        )}

        <div style={footerStyle}>
          <button onClick={onClose} style={btnGhostStyle} disabled={isLoading}>Cancel</button>
          <button onClick={handleLoad} style={btnPrimaryStyle} disabled={loadDisabled}>
            {isLoading ? `Loading ${selected.size}…` : selected.size > 0 ? `Load ${selected.size} selected` : 'Load'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Styles — match Connections.tsx so the two modals feel consistent ──

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0, left: 0, right: 0, bottom: 0,
  background: 'rgba(0,0,0,0.6)',
  zIndex: 1000,
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'center',
  padding: '40px 20px',
  overflowY: 'auto',
};

const modalStyle: React.CSSProperties = {
  width: 'min(720px, calc(100vw - 40px))',
  height: 'min(80vh, 800px)',
  minWidth: 400,
  minHeight: 300,
  maxWidth: 'calc(100vw - 40px)',
  maxHeight: 'calc(100vh - 40px)',
  background: '#16161e',
  border: '1px solid rgba(255,255,255,0.08)',
  borderRadius: 12,
  padding: '20px 22px',
  color: '#e6edf3',
  display: 'flex',
  flexDirection: 'column',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  marginBottom: 14,
  paddingBottom: 12,
  borderBottom: '1px solid rgba(255,255,255,0.06)',
};

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: '#888',
  fontSize: 24,
  cursor: 'pointer',
  padding: 0,
  width: 28,
  height: 28,
  lineHeight: '24px',
};

const selectAllRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  padding: '8px 12px',
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8,
  cursor: 'pointer',
  marginBottom: 4,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 10,
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8,
  padding: '10px 14px',
  cursor: 'pointer',
};

const errorBoxStyle: React.CSSProperties = {
  background: 'rgba(248,113,113,0.1)',
  border: '1px solid rgba(248,113,113,0.3)',
  borderRadius: 8,
  padding: '10px 14px',
  marginBottom: 12,
  color: '#f87171',
  fontSize: 13,
};

const inlineCodeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  padding: '1px 5px',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontSize: 11,
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  paddingTop: 14,
  marginTop: 'auto',
  borderTop: '1px solid rgba(255,255,255,0.06)',
};

const btnPrimaryStyle: React.CSSProperties = {
  background: 'rgba(124,58,237,0.6)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnGhostStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '6px 14px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
};
