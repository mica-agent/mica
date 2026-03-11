import { SemanticLevel, LEVEL_LABELS } from '../logic/semanticLevels'

interface LevelIndicatorProps {
  currentLevel: SemanticLevel
  parentTitle?: string
}

const LEVEL_COLORS: Record<SemanticLevel, string> = {
  [SemanticLevel.MISSION]: '#64b4ff',
  [SemanticLevel.INTENT]: '#7c4dff',
  [SemanticLevel.ARCHITECTURE]: '#448aff',
  [SemanticLevel.SWARMS]: '#64dca0',
  [SemanticLevel.DETAIL]: '#ff9632',
}

export function LevelIndicator({ currentLevel, parentTitle }: LevelIndicatorProps) {
  const color = LEVEL_COLORS[currentLevel]

  return (
    <div
      style={{
        position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 16px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 20px',
        background: 'rgba(12, 14, 22, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: `1px solid ${color}33`,
        borderRadius: 12,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 8px ${color}`,
        }}
      />
      <div style={{ fontSize: 13, fontWeight: 600, color: 'rgba(255,255,255,0.8)' }}>
        {LEVEL_LABELS[currentLevel]}
      </div>
      {parentTitle && (
        <>
          <div style={{ color: 'rgba(255,255,255,0.2)', fontSize: 12 }}>·</div>
          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)' }}>{parentTitle}</div>
        </>
      )}
    </div>
  )
}
