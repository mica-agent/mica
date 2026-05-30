import { useState, useEffect, useCallback } from 'react';
import {
  fetchConnections,
  saveConnection,
  deleteConnection,
  type ConnectionStatus,
} from './api/canvasFiles';

// Connections — modal for managing API keys + CLI-delegated logins for the
// services Mica talks to on the user's behalf. Phase 1 implements the
// paste-key flow (OpenRouter, Anthropic, Tavily) fully; delegated-cli
// services (Claude, GitHub) show a static "run this in a terminal card"
// instruction. Phase 2 will wire the CLI's login flow into this modal so
// users don't need to drop to a terminal.

interface Props {
  onClose: () => void;
}

export default function Connections({ onClose }: Props) {
  const [services, setServices] = useState<ConnectionStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-service local state. Keyed by service id.
  //   editing — true when the user is mid-paste; shows the input field.
  //   saving  — true while the validate-and-save POST is in-flight.
  //   draft   — the in-progress key being typed.
  const [editing, setEditing] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [perServiceMsg, setPerServiceMsg] = useState<Record<string, { kind: 'ok' | 'err' | 'warn'; text: string }>>({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const list = await fetchConnections();
      setServices(list);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Allow Esc to close the modal — UX expectation for any dialog.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const startEdit = (id: string) => {
    setEditing((prev) => ({ ...prev, [id]: true }));
    setDrafts((prev) => ({ ...prev, [id]: '' }));
    setPerServiceMsg((prev) => { const c = { ...prev }; delete c[id]; return c; });
  };

  const cancelEdit = (id: string) => {
    setEditing((prev) => { const c = { ...prev }; delete c[id]; return c; });
    setDrafts((prev) => { const c = { ...prev }; delete c[id]; return c; });
  };

  const saveKey = async (id: string) => {
    const key = (drafts[id] || '').trim();
    if (!key) return;
    setSaving((prev) => ({ ...prev, [id]: true }));
    setPerServiceMsg((prev) => { const c = { ...prev }; delete c[id]; return c; });
    try {
      const result = await saveConnection(id, key);
      setPerServiceMsg((prev) => ({
        ...prev,
        [id]: result.warning
          ? { kind: 'warn', text: result.warning }
          : { kind: 'ok', text: 'Saved.' },
      }));
      cancelEdit(id);
      await load();
    } catch (err) {
      setPerServiceMsg((prev) => ({ ...prev, [id]: { kind: 'err', text: (err as Error).message } }));
    } finally {
      setSaving((prev) => { const c = { ...prev }; delete c[id]; return c; });
    }
  };

  const disconnect = async (id: string, displayName: string) => {
    if (!confirm(`Disconnect ${displayName}? The stored key will be removed from credentials.json.`)) return;
    setPerServiceMsg((prev) => { const c = { ...prev }; delete c[id]; return c; });
    try {
      await deleteConnection(id);
      setPerServiceMsg((prev) => ({ ...prev, [id]: { kind: 'ok', text: 'Disconnected.' } }));
      await load();
    } catch (err) {
      setPerServiceMsg((prev) => ({ ...prev, [id]: { kind: 'err', text: (err as Error).message } }));
    }
  };

  return (
    <div
      style={overlayStyle}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="mica-resizable" style={modalStyle}>
        <div className="mica-resize-handle" />
        <div style={headerStyle}>
          <div>
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, color: '#e6edf3' }}>Connections</h2>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: '#888' }}>
              Authenticate the external services Mica uses on your behalf. Keys are stored in <code style={inlineCodeStyle}>{'<workspace>/.mica/credentials.json'}</code>.
            </p>
          </div>
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">×</button>
        </div>

        {error && (
          <div style={errorBoxStyle}>{error}</div>
        )}

        {loading ? (
          <div style={{ padding: 24, color: '#888' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
            {services.map((svc) => (
              <ServiceRow
                key={svc.id}
                svc={svc}
                editing={!!editing[svc.id]}
                saving={!!saving[svc.id]}
                draft={drafts[svc.id] ?? ''}
                msg={perServiceMsg[svc.id]}
                onStartEdit={() => startEdit(svc.id)}
                onCancelEdit={() => cancelEdit(svc.id)}
                onChangeDraft={(v) => setDrafts((prev) => ({ ...prev, [svc.id]: v }))}
                onSave={() => saveKey(svc.id)}
                onDisconnect={() => disconnect(svc.id, svc.displayName)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceRow({
  svc, editing, saving, draft, msg,
  onStartEdit, onCancelEdit, onChangeDraft, onSave, onDisconnect,
}: {
  svc: ConnectionStatus;
  editing: boolean;
  saving: boolean;
  draft: string;
  msg?: { kind: 'ok' | 'err' | 'warn'; text: string };
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeDraft: (v: string) => void;
  onSave: () => void;
  onDisconnect: () => void;
}) {
  const isPasteKey = svc.pattern === 'paste-key';
  return (
    <div style={rowStyle}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#e6edf3' }}>{svc.displayName}</span>
            <StatusPill status={svc} />
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#999', lineHeight: 1.4 }}>{svc.description}</p>
          {svc.connected && svc.source && (
            <p style={{ margin: '4px 0 0', fontSize: 11, color: '#666' }}>
              Source: {sourceLabel(svc.source)}
              {svc.savedAt ? ` · saved ${formatRelative(svc.savedAt)}` : ''}
            </p>
          )}
          {svc.connected && svc.id === 'openrouter' && <OpenRouterUsage />}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {isPasteKey ? (
            !editing ? (
              <>
                <button style={btnPrimaryStyle} onClick={onStartEdit}>
                  {svc.connected ? 'Reconnect' : 'Connect'}
                </button>
                {svc.connected && svc.source === 'credentials' && (
                  <button style={btnGhostStyle} onClick={onDisconnect}>Disconnect</button>
                )}
              </>
            ) : null
          ) : (
            <span style={{ fontSize: 11, color: '#666', fontStyle: 'italic', alignSelf: 'center' }}>via CLI</span>
          )}
        </div>
      </div>

      {/* Paste-key input form. Wrapped in <form> so Enter submits. */}
      {editing && isPasteKey && (
        <form
          onSubmit={(e) => { e.preventDefault(); if (!saving) onSave(); }}
          style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          <input
            type="password"
            value={draft}
            onChange={(e) => onChangeDraft(e.target.value)}
            placeholder={svc.inputHint || 'Paste API key'}
            style={inputStyle}
            autoFocus
            disabled={saving}
          />
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <button type="submit" style={btnPrimaryStyle} disabled={!draft.trim() || saving}>
                {saving ? 'Validating…' : 'Save'}
              </button>
              <button type="button" style={btnGhostStyle} onClick={onCancelEdit} disabled={saving}>Cancel</button>
            </div>
            {svc.signupUrl && (
              <a href={svc.signupUrl} target="_blank" rel="noopener noreferrer" style={linkStyle}>
                Get a key →
              </a>
            )}
          </div>
        </form>
      )}

      {/* Static instruction for delegated-cli services in Phase 1. Hidden
          once connected — surfacing "To connect:" on a row already showing
          a green Connected pill is the exact confusion that caused us to
          look "not connected" for a working setup. */}
      {!isPasteKey && !svc.connected && svc.phase1Instruction && (
        <div style={instructionBoxStyle}>
          <span style={{ color: '#888', marginRight: 6 }}>To connect:</span>
          <code style={inlineCodeStyle}>{svc.phase1Instruction.replace(/^Open a \.terminal card and run: /, '')}</code>
        </div>
      )}

      {msg && (
        <div style={{
          marginTop: 8,
          fontSize: 12,
          color: msg.kind === 'ok' ? '#4ade80' : msg.kind === 'warn' ? '#fbbf24' : '#f87171',
        }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}

// Workspace-level OpenRouter usage. Thin display over GET /api/usage/openrouter
// (proxy of openrouter.ai/api/v1/auth/key — returns this month's spend,
// remaining credit, daily/weekly buckets). Renders inline under the OpenRouter
// service row when the key is connected. No-ops cleanly when the endpoint
// errors or the key has no associated limit (legacy keys before OpenRouter
// added the per-key limit field).
interface OpenRouterUsageData {
  ok: boolean;
  usage?: number;
  usage_daily?: number;
  usage_weekly?: number;
  usage_monthly?: number;
  limit?: number | null;
  limit_remaining?: number | null;
  limit_reset?: string | null;
  is_free_tier?: boolean;
}
function fmtUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  if (n < 100) return '$' + n.toFixed(2);
  return '$' + Math.round(n).toLocaleString();
}
function OpenRouterUsage() {
  const [data, setData] = useState<OpenRouterUsageData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch('/api/usage/openrouter')
      .then((r) => r.json())
      .then((j: OpenRouterUsageData) => { if (!cancelled) setData(j); })
      .catch((e: Error) => { if (!cancelled) setErr(e.message); });
    return () => { cancelled = true; };
  }, []);
  if (err) return null;          // silent fail — don't pollute the panel with transient probe errors
  if (!data) return (
    <p style={{ margin: '6px 0 0', fontSize: 11, color: '#666' }}>Loading usage…</p>
  );
  if (!data.ok) return null;     // backend reported no_key or upstream error — hide quietly
  const usedThisMonth = data.usage_monthly ?? 0;
  const limit = data.limit ?? null;
  const remaining = data.limit_remaining ?? null;
  const tooltip = [
    `Lifetime: ${fmtUsd(data.usage)}`,
    `Today: ${fmtUsd(data.usage_daily)}`,
    `This week: ${fmtUsd(data.usage_weekly)}`,
    `This month: ${fmtUsd(usedThisMonth)}`,
    limit != null ? `Limit (${data.limit_reset || 'monthly'}): ${fmtUsd(limit)}` : null,
    remaining != null ? `Remaining: ${fmtUsd(remaining)}` : null,
  ].filter(Boolean).join('\n');
  // Headline: "spent this month · X remaining" when there's a limit; else
  // just "spent this month" (legacy keys with no per-key cap).
  const headline = limit != null
    ? `${fmtUsd(usedThisMonth)} / ${fmtUsd(limit)} this month · ${fmtUsd(remaining)} left`
    : `${fmtUsd(usedThisMonth)} this month`;
  // Subtle pct bar when limit known. Color shifts amber >75%, red >90%.
  const pct = (limit != null && limit > 0) ? Math.min(1, usedThisMonth / limit) : 0;
  const barColor = pct >= 0.9 ? '#f87171' : pct >= 0.75 ? '#fbbf24' : '#4ade80';
  return (
    <div style={{ marginTop: 8 }} title={tooltip}>
      <div style={{ fontSize: 11, color: '#999', fontFamily: 'monospace' }}>{headline}</div>
      {limit != null && limit > 0 && (
        <div style={{ marginTop: 4, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(pct * 100)}%`, height: '100%', background: barColor, transition: 'width 200ms ease' }} />
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  if (status.connected) {
    return <span style={{ ...pillStyle, background: 'rgba(74,222,128,0.15)', color: '#4ade80', borderColor: 'rgba(74,222,128,0.4)' }}>Connected</span>;
  }
  return <span style={{ ...pillStyle, background: 'rgba(255,255,255,0.04)', color: '#888', borderColor: 'rgba(255,255,255,0.1)' }}>Not connected</span>;
}

function sourceLabel(s: NonNullable<ConnectionStatus['source']>): string {
  switch (s) {
    case 'credentials': return 'credentials.json (managed here)';
    case 'legacy': return 'legacy config.json';
    case 'env': return 'environment variable (.env)';
    case 'gh-cli': return 'gh CLI (~/.config/gh/hosts.yml)';
    case 'env-token': return 'GH_TOKEN environment variable';
    case 'git-credential': return 'git credential helper (inherited)';
  }
}

function formatRelative(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return 'just now';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── Styles ──────────────────────────────────────────────

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
  // `resize`, `overflow`, `position`, and the corner-glyph ::after come
  // from the shared `.mica-resizable` class (App.css), so this modal
  // matches the canvas-settings overlay's resize affordance exactly.
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

const rowStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.02)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 8,
  padding: '12px 14px',
};

const pillStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  padding: '2px 8px',
  borderRadius: 4,
  border: '1px solid',
};

const btnPrimaryStyle: React.CSSProperties = {
  background: 'rgba(124,58,237,0.6)',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const btnGhostStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#aaa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '5px 12px',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  background: 'rgba(0,0,0,0.3)',
  border: '1px solid rgba(255,255,255,0.1)',
  borderRadius: 6,
  padding: '7px 10px',
  fontSize: 13,
  color: '#e6edf3',
  fontFamily: 'monospace',
  outline: 'none',
  width: '100%',
};

const instructionBoxStyle: React.CSSProperties = {
  marginTop: 8,
  background: 'rgba(0,0,0,0.25)',
  border: '1px solid rgba(255,255,255,0.06)',
  borderRadius: 6,
  padding: '6px 10px',
  fontSize: 12,
  color: '#bbb',
};

const inlineCodeStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)',
  padding: '1px 6px',
  borderRadius: 3,
  fontFamily: 'monospace',
  fontSize: 11,
  color: '#c9a45d',
};

const linkStyle: React.CSSProperties = {
  fontSize: 11,
  color: '#7c3aed',
  textDecoration: 'none',
};

const errorBoxStyle: React.CSSProperties = {
  background: 'rgba(248,113,113,0.1)',
  border: '1px solid rgba(248,113,113,0.3)',
  borderRadius: 6,
  padding: '8px 12px',
  marginBottom: 12,
  color: '#f87171',
  fontSize: 12,
};
