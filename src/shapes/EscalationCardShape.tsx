import { ShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw'
import type { TLBaseShape } from 'tldraw'

type EscalationCardShape = TLBaseShape<
  'escalation-card',
  { w: number; h: number; title: string; summary: string; reason: string; recommendation: string; decisionNeeded: string; options: string[] }
>

export class EscalationCardShapeUtil extends ShapeUtil<EscalationCardShape> {
  static override type = 'escalation-card' as const
  static override props = {
    w: T.number, h: T.number, title: T.string, summary: T.string,
    reason: T.string, recommendation: T.string, decisionNeeded: T.string,
    options: T.arrayOf(T.string),
  }

  getDefaultProps(): EscalationCardShape['props'] {
    return { w: 420, h: 340, title: 'Escalation', summary: '', reason: '', recommendation: '', decisionNeeded: '', options: [] }
  }

  getGeometry(shape: EscalationCardShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: EscalationCardShape) {
    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <style>{`
          @keyframes escalation-glow {
            0%, 100% { border-color: rgba(255, 150, 50, 0.3); box-shadow: 0 0 0 0 rgba(255, 150, 50, 0), 0 4px 24px rgba(0,0,0,0.4); }
            50% { border-color: rgba(255, 150, 50, 0.6); box-shadow: 0 0 0 3px rgba(255, 150, 50, 0.15), 0 4px 24px rgba(0,0,0,0.4); }
          }
        `}</style>
        <div
          style={{
            width: '100%', height: '100%',
            background: 'linear-gradient(145deg, rgba(40, 25, 15, 0.95) 0%, rgba(30, 20, 12, 0.98) 100%)',
            borderRadius: 16, padding: '24px 28px',
            display: 'flex', flexDirection: 'column', gap: 10,
            border: '1.5px solid rgba(255, 150, 50, 0.3)',
            animation: 'escalation-glow 3s ease-in-out infinite',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
            overflow: 'hidden',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: '#ff9632', background: 'rgba(255, 150, 50, 0.12)', borderRadius: 8, padding: '3px 10px' }}>
              ⚠ Escalation
            </div>
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#f0d0a0', lineHeight: 1.3 }}>{shape.props.title}</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.5 }}>{shape.props.summary}</div>
          {shape.props.reason && (
            <div style={{ fontSize: 12, color: 'rgba(255, 180, 100, 0.7)' }}>
              <span style={{ fontWeight: 600 }}>Why escalated:</span> {shape.props.reason}
            </div>
          )}
          {shape.props.recommendation && (
            <div style={{ fontSize: 12, color: 'rgba(100, 220, 160, 0.7)', background: 'rgba(100, 220, 160, 0.06)', borderRadius: 8, padding: '8px 12px', borderLeft: '2px solid rgba(100, 220, 160, 0.3)' }}>
              <span style={{ fontWeight: 600 }}>Recommendation:</span> {shape.props.recommendation}
            </div>
          )}
          {shape.props.decisionNeeded && (
            <div style={{ fontSize: 13, fontWeight: 600, color: '#ff9632', marginTop: 'auto', paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)' }}>
              Decision needed: {shape.props.decisionNeeded}
            </div>
          )}
          {shape.props.options.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
              {shape.props.options.map((opt: string, i: number) => (
                <div key={i} style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', padding: '4px 10px', background: 'rgba(255,255,255,0.03)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.05)' }}>
                  {i + 1}. {opt}
                </div>
              ))}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: EscalationCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={16} ry={16} fill="none" stroke="rgba(255, 150, 50, 0.6)" strokeWidth={1.5} />
  }
}
