import { ShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw'
import type { TLBaseShape } from 'tldraw'

type ArtifactCardShape = TLBaseShape<
  'artifact-card',
  { w: number; h: number; title: string; summary: string; artifactType: string; nodeId: string; hasChildren: boolean }
>

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  wireframe: { label: 'Wireframe', color: '#7c4dff', icon: '🖼️' },
  qa: { label: 'Sample Q&A', color: '#00bfa5', icon: '💬' },
  journey: { label: 'User Journey', color: '#ff6d00', icon: '🗺️' },
  storyboard: { label: 'Storyboard', color: '#e040fb', icon: '📖' },
  scenario: { label: 'Scenario', color: '#ffab00', icon: '🎯' },
  capability: { label: 'Capability', color: '#448aff', icon: '⚙️' },
  constraint: { label: 'Constraint', color: '#ff5252', icon: '🔒' },
  decision: { label: 'Decision', color: '#69f0ae', icon: '⚖️' },
}

export class ArtifactCardShapeUtil extends ShapeUtil<ArtifactCardShape> {
  static override type = 'artifact-card' as const
  static override props = {
    w: T.number, h: T.number, title: T.string, summary: T.string,
    artifactType: T.string, nodeId: T.string, hasChildren: T.boolean,
  }

  getDefaultProps(): ArtifactCardShape['props'] {
    return { w: 340, h: 220, title: 'Artifact', summary: '', artifactType: 'capability', nodeId: '', hasChildren: false }
  }

  getGeometry(shape: ArtifactCardShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: ArtifactCardShape) {
    const config = TYPE_CONFIG[shape.props.artifactType] ?? { label: shape.props.artifactType, color: '#90a4ae', icon: '📄' }

    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%', height: '100%',
            background: 'rgba(22, 27, 42, 0.95)',
            borderRadius: 14, padding: '20px 24px',
            display: 'flex', flexDirection: 'column', gap: 8,
            border: `1px solid ${config.color}22`,
            borderLeft: `3px solid ${config.color}88`,
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            cursor: shape.props.hasChildren ? 'pointer' : 'default',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 16 }}>{config.icon}</span>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.5, color: config.color, opacity: 0.8 }}>
              {config.label}
            </div>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#e0e4f0', lineHeight: 1.3 }}>{shape.props.title}</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, flex: 1, overflow: 'hidden' }}>{shape.props.summary}</div>
          {shape.props.hasChildren && (
            <div style={{ fontSize: 11, color: 'rgba(100, 180, 255, 0.5)', textAlign: 'right' }}>double-tap to explore →</div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ArtifactCardShape) {
    const config = TYPE_CONFIG[shape.props.artifactType]
    return <rect width={shape.props.w} height={shape.props.h} rx={14} ry={14} fill="none" stroke={config?.color ?? '#90a4ae'} strokeWidth={1.5} opacity={0.5} />
  }
}
