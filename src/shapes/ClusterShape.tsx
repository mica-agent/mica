import { ShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw'
import type { TLBaseShape } from 'tldraw'

type ClusterShape = TLBaseShape<
  'cluster',
  { w: number; h: number; title: string; summary: string; status: string; icon: string; nodeId: string; hasChildren: boolean }
>

export class ClusterShapeUtil extends ShapeUtil<ClusterShape> {
  static override type = 'cluster' as const
  static override props = {
    w: T.number, h: T.number, title: T.string, summary: T.string,
    status: T.string, icon: T.string, nodeId: T.string, hasChildren: T.boolean,
  }

  getDefaultProps(): ClusterShape['props'] {
    return { w: 380, h: 180, title: 'Cluster', summary: '', status: 'active', icon: '📦', nodeId: '', hasChildren: false }
  }

  getGeometry(shape: ClusterShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: ClusterShape) {
    const statusColor =
      shape.props.status === 'active' ? 'rgba(100, 220, 160, 0.8)'
        : shape.props.status === 'degraded' ? 'rgba(255, 180, 60, 0.8)'
          : 'rgba(120, 140, 170, 0.6)'

    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%', height: '100%',
            background: 'linear-gradient(145deg, rgba(30, 35, 50, 0.95) 0%, rgba(20, 25, 40, 0.98) 100%)',
            borderRadius: 16, padding: '24px 28px',
            display: 'flex', flexDirection: 'column', gap: 8,
            border: '1px solid rgba(255,255,255,0.06)',
            boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
            cursor: shape.props.hasChildren ? 'pointer' : 'default',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 22 }}>{shape.props.icon}</span>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#e0e4f0', flex: 1 }}>{shape.props.title}</div>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, boxShadow: `0 0 6px ${statusColor}` }} />
          </div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5, flex: 1 }}>{shape.props.summary}</div>
          {shape.props.hasChildren && (
            <div style={{ fontSize: 11, color: 'rgba(100, 180, 255, 0.5)', textAlign: 'right' }}>double-tap to explore →</div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: ClusterShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={16} ry={16} fill="none" stroke="rgba(100,180,255,0.4)" strokeWidth={1.5} />
  }
}
