import { ShapeUtil, HTMLContainer, Rectangle2d, T } from 'tldraw'
import type { TLBaseShape } from 'tldraw'

type MissionCardShape = TLBaseShape<
  'mission-card',
  { w: number; h: number; title: string; summary: string; questions: string[] }
>

/** @public */
export class MissionCardShapeUtil extends ShapeUtil<MissionCardShape> {
  static override type = 'mission-card' as const
  static override props = {
    w: T.number,
    h: T.number,
    title: T.string,
    summary: T.string,
    questions: T.arrayOf(T.string),
  }

  getDefaultProps(): MissionCardShape['props'] {
    return { w: 600, h: 200, title: 'Mission', summary: '', questions: [] }
  }

  getGeometry(shape: MissionCardShape) {
    return new Rectangle2d({ width: shape.props.w, height: shape.props.h, isFilled: true })
  }

  component(shape: MissionCardShape) {
    return (
      <HTMLContainer style={{ width: shape.props.w, height: shape.props.h, pointerEvents: 'all' }}>
        <div
          style={{
            width: '100%',
            height: '100%',
            background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
            borderRadius: 20,
            padding: '32px 40px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            border: '1px solid rgba(255,255,255,0.08)',
            boxShadow: '0 8px 32px rgba(0,0,0,0.4), inset 0 1px 0 rgba(255,255,255,0.05)',
            overflow: 'hidden',
            fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 2, color: 'rgba(100, 180, 255, 0.7)' }}>
            Mission
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: '#e8eaf6', lineHeight: 1.2 }}>
            {shape.props.title}
          </div>
          <div style={{ fontSize: 14, color: 'rgba(255,255,255,0.55)', lineHeight: 1.5, flex: 1 }}>
            {shape.props.summary}
          </div>
          {shape.props.questions.length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
              {shape.props.questions.map((q: string, i: number) => (
                <div
                  key={i}
                  style={{
                    fontSize: 11,
                    color: 'rgba(100, 180, 255, 0.8)',
                    background: 'rgba(100, 180, 255, 0.08)',
                    borderRadius: 12,
                    padding: '4px 12px',
                    border: '1px solid rgba(100, 180, 255, 0.15)',
                  }}
                >
                  {q}
                </div>
              ))}
            </div>
          )}
        </div>
      </HTMLContainer>
    )
  }

  indicator(shape: MissionCardShape) {
    return <rect width={shape.props.w} height={shape.props.h} rx={20} ry={20} fill="none" stroke="rgba(100,180,255,0.5)" strokeWidth={1.5} />
  }
}
