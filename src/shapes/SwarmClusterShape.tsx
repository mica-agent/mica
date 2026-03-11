import { ShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw'
import type { TLBaseShape } from 'tldraw'

type SwarmClusterShape = TLBaseShape<
  'swarm-cluster',
  { w: number; h: number; title: string; summary: string; agentCount: number; health: string; activity: number; nodeId: string; hasChildren: boolean }
>

export class SwarmClusterShapeUtil extends ShapeUtil<SwarmClusterShape> {
  static override type = 'swarm-cluster' as const
  static override props = {
    w: T.number, h: T.number, title: T.string, summary: T.string,
    agentCount: T.number, health: T.string, activity: T.number,
    nodeId: T.string, hasChildren: T.boolean,
  }

  getDefaultProps(): SwarmClusterShape['props'] {
    return { w: 320, h: 200, title: 'Swarm', summary: '', agentCount: 0, health: 'healthy', activity: 0.5, nodeId: '', hasChildren: false }
  }

  getGeometry(shape: SwarmClusterShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: SwarmClusterShape) {
    const healthColors: Record<string, { bg: string; text: string; glow: string }> = {
      healthy: { bg: 'rgba(100, 220, 160, 0.15)', text: '#64dca0', glow: 'rgba(100, 220, 160, 0.3)' },
      degraded: { bg: 'rgba(255, 180, 60, 0.15)', text: '#ffb43c', glow: 'rgba(255, 180, 60, 0.3)' },
      critical: { bg: 'rgba(255, 80, 80, 0.15)', text: '#ff5050', glow: 'rgba(255, 80, 80, 0.3)' },
    }
    const hc = healthColors[shape.props.health] ?? healthColors.healthy
    const pulseSpeed = shape.props.health === 'degraded' ? '2s' : shape.props.health === 'critical' ? '1s' : '3s'
    const safeId = shape.id.replace(/[^a-zA-Z0-9]/g, '')

    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <style>{`
          @keyframes sp-${safeId} {
            0%, 100% { box-shadow: 0 0 0 0 ${hc.glow}, 0 4px 16px rgba(0,0,0,0.3); }
            50% { box-shadow: 0 0 0 4px ${hc.glow}, 0 4px 16px rgba(0,0,0,0.3); }
          }
          @keyframes ad-${safeId} { 0%, 100% { opacity: 0.3; } 50% { opacity: 1; } }
        `}</style>
        <div
          style={{
            width: '100%', height: '100%',
            background: 'linear-gradient(145deg, rgba(22, 27, 42, 0.95) 0%, rgba(18, 22, 36, 0.98) 100%)',
            borderRadius: 14, padding: '20px 24px',
            display: 'flex', flexDirection: 'column', gap: 8,
            border: `1px solid ${hc.text}33`,
            animation: `sp-${safeId} ${pulseSpeed} ease-in-out infinite`,
            cursor: shape.props.hasChildren ? 'pointer' : 'default',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 1.5, color: 'rgba(255,255,255,0.4)' }}>Swarm</div>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: hc.text, background: hc.bg, borderRadius: 10, padding: '2px 10px' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: hc.text }} />
              {shape.props.health}
            </div>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#e0e4f0', lineHeight: 1.3 }}>{shape.props.title}</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', lineHeight: 1.5, flex: 1 }}>{shape.props.summary}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>
              <span style={{ fontWeight: 600, color: '#e0e4f0', fontSize: 16 }}>{shape.props.agentCount}</span> agents
            </div>
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', gap: 3 }}>
              {[0, 1, 2, 3, 4].map((i) => (
                <div
                  key={i}
                  style={{
                    width: 4, height: 12, borderRadius: 2,
                    background: i / 5 < shape.props.activity ? hc.text : 'rgba(255,255,255,0.1)',
                    animation: i / 5 < shape.props.activity ? `ad-${safeId} ${1 + i * 0.3}s ease-in-out infinite` : 'none',
                  }}
                />
              ))}
            </div>
            {shape.props.hasChildren && (
              <div style={{ fontSize: 11, color: 'rgba(100, 180, 255, 0.5)' }}>double-tap →</div>
            )}
          </div>
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: SwarmClusterShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={14} ry={14} fill="none" stroke="rgba(100,220,160,0.5)" strokeWidth={1.5} />
  }
}
