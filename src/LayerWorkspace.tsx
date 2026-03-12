import { useState } from 'react';
import type { LayerMeta, LayerData, Artifact, Cue } from './data';

interface Props {
  layer: LayerMeta;
  data: LayerData;
}

// ── Cue Pill ───────────────────────────────────────────────

function CuePill({ cue, layerColor }: { cue: Cue; layerColor: string }) {
  const [expanded, setExpanded] = useState(false);

  const classes = [
    'cue-pill',
    cue.addressed ? 'cue-pill--addressed' : '',
    expanded ? 'cue-pill--expanded' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      onClick={() => setExpanded(!expanded)}
      style={{ '--layer-color': layerColor } as React.CSSProperties}
    >
      <span className={`cue-kind cue-kind--${cue.kind}`}>
        {cue.kind === 'question' ? 'Q' : cue.kind === 'prompt' ? 'P' : cue.kind === 'exercise' ? 'E' : '✓'}
      </span>
      <span className="cue-text">{cue.text}</span>
    </div>
  );
}

// ── Wireframe Preview ──────────────────────────────────────

function WireframePreview() {
  return (
    <div className="wireframe-preview">
      <div className="wireframe-bar wireframe-bar--long" />
      <div className="wireframe-row">
        <div className="wireframe-block" />
        <div className="wireframe-block" />
      </div>
      <div className="wireframe-bar wireframe-bar--medium" />
      <div className="wireframe-bar wireframe-bar--short" />
    </div>
  );
}

// ── Flow Preview ───────────────────────────────────────────

function FlowPreview({ steps }: { steps: string[] }) {
  return (
    <div className="flow-preview">
      {steps.map((step, i) => (
        <span key={i}>
          <span className="flow-step">{step}</span>
          {i < steps.length - 1 && <span className="flow-arrow"> → </span>}
        </span>
      ))}
    </div>
  );
}

// ── Architecture Preview ───────────────────────────────────

function ArchPreview({ components }: { components: string[] }) {
  return (
    <div className="arch-preview">
      {components.map((comp, i) => (
        <span key={i}>
          <span className="arch-component">{comp}</span>
          {i < components.length - 1 && <span className="arch-arrow"> → </span>}
        </span>
      ))}
    </div>
  );
}

// ── Artifact Card ──────────────────────────────────────────

function ArtifactCard({ artifact, layer }: { artifact: Artifact; layer: LayerMeta }) {
  const [showDetail, setShowDetail] = useState(false);
  const isEscalation = artifact.isEscalation;
  const isDecision = artifact.type === 'decision';

  const classes = [
    'artifact-card',
    isEscalation ? 'artifact-card--escalation' : '',
    isDecision ? 'artifact-card--decision' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classes}
      style={{ '--layer-color': layer.color } as React.CSSProperties}
      onClick={() => artifact.detail && setShowDetail(!showDetail)}
    >
      <div className="artifact-card-header">
        {isEscalation ? (
          <span className="escalation-badge">⚠ Decision Needed</span>
        ) : (
          <span className="artifact-type">{artifact.type}</span>
        )}
        <span className="artifact-title">{artifact.title}</span>
      </div>
      <div className="artifact-summary">{artifact.summary}</div>

      {/* Layer-specific visual treatments */}
      {artifact.type === 'flow' && (
        <FlowPreview steps={artifact.summary.split(' → ')} />
      )}
      {artifact.type === 'wireframe' && <WireframePreview />}
      {artifact.type === 'diagram' && artifact.detail && (
        <ArchPreview components={artifact.summary.split(' → ')} />
      )}
      {artifact.type === 'api' && (
        <div className="code-preview">
          {artifact.summary}
        </div>
      )}

      {/* Progress bar for implementation */}
      {artifact.progress !== undefined && (
        <>
          <div className="artifact-progress">
            <div
              className="artifact-progress-fill"
              style={{
                width: `${artifact.progress * 100}%`,
                background: artifact.progress >= 1
                  ? 'var(--quality-complete)'
                  : artifact.progress >= 0.5
                  ? 'var(--quality-partial)'
                  : 'var(--quality-missing)',
              }}
            />
          </div>
          {artifact.status && (
            <div className="artifact-status">{artifact.status}</div>
          )}
        </>
      )}

      {/* Expandable detail */}
      {showDetail && artifact.detail && (
        <div className="artifact-detail">{artifact.detail}</div>
      )}

      {/* Escalation recommendation + options */}
      {isEscalation && artifact.recommendation && (
        <div className="escalation-recommendation">
          💡 {artifact.recommendation}
        </div>
      )}
      {isEscalation && artifact.options && (
        <div className="escalation-options">
          {artifact.options.map((opt, i) => (
            <button key={i} className="escalation-option">{opt}</button>
          ))}
        </div>
      )}

      {/* Decision options */}
      {isDecision && artifact.options && (
        <div className="decision-options">
          {artifact.options.map((opt, i) => (
            <span
              key={i}
              className={`decision-option ${i === 0 ? 'decision-option--chosen' : ''}`}
            >
              {opt}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Layer Workspace ────────────────────────────────────────

const VERSION_METAPHORS: Record<string, { label: string; action: string }> = {
  mission: { label: 'Snapshot', action: 'Fossilize' },
  experience: { label: 'Pin', action: 'Crystallize' },
  architecture: { label: 'Baseline', action: 'Bedrock' },
  implementation: { label: 'Commit', action: 'Commit' },
};

export default function LayerWorkspace({ layer, data }: Props) {
  const initiativeLabel =
    data.aiInitiative === 'high' ? 'AI leads' :
    data.aiInitiative === 'moderate' ? 'Collaborative' :
    'Human leads';

  const version = VERSION_METAPHORS[layer.id];

  return (
    <div className="workspace">
      {/* Collaboration + version indicators */}
      <div className="collab-section">
        <div className="collab-badge">
          <span className={`collab-dot collab-dot--${data.aiInitiative}`} />
          <span>{initiativeLabel}</span>
        </div>
        <button
          className="version-btn"
          style={{
            background: `${layer.color}10`,
            borderColor: `${layer.color}25`,
            color: layer.color,
          }}
        >
          {version.action}
        </button>
      </div>

      {/* Goal bar */}
      <div className="goal-bar">
        <div className="goal-bar-header">
          <span
            className="goal-layer-badge"
            style={{
              background: `${layer.color}20`,
              color: layer.color,
            }}
          >
            {layer.icon} {layer.label}
          </span>
          <span className="goal-text">{data.goal}</span>
        </div>
        <div className="goal-meta">
          <span className="ai-initiative">AI: {data.aiInitiative}</span>
          <div className="context-quality">
            {data.contextIndicators.map((ci, i) => (
              <div key={i} className="quality-item">
                <span className={`quality-dot quality-dot--${ci.quality}`} />
                {ci.label}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Cue pills */}
      <div className="cue-pills">
        {data.cues.map((cue, i) => (
          <CuePill key={i} cue={cue} layerColor={layer.color} />
        ))}
      </div>

      {/* Artifact grid */}
      <div className="artifact-grid">
        {data.artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} layer={layer} />
        ))}
      </div>
    </div>
  );
}
