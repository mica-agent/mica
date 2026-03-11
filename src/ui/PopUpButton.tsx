import { SemanticLevel, LEVEL_LABELS } from '../logic/semanticLevels'

interface PopUpButtonProps {
  currentLevel: SemanticLevel
  parentTitle?: string
  onAscend: () => void
  canAscend: boolean
}

export function PopUpButton({ currentLevel, parentTitle, onAscend, canAscend }: PopUpButtonProps) {
  if (!canAscend) return null

  const label = parentTitle ?? LEVEL_LABELS[Math.max(0, currentLevel - 1) as SemanticLevel]

  return (
    <button
      onClick={onAscend}
      style={{
        position: 'fixed',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
        right: 24,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 20px',
        background: 'rgba(20, 25, 40, 0.9)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(100, 180, 255, 0.2)',
        borderRadius: 14,
        color: 'rgba(100, 180, 255, 0.9)',
        fontSize: 14,
        fontWeight: 600,
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
        cursor: 'pointer',
        boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        transition: 'transform 0.15s, box-shadow 0.15s',
        touchAction: 'manipulation',
      }}
      onPointerDown={(e) => {
        const el = e.currentTarget
        el.style.transform = 'scale(0.95)'
      }}
      onPointerUp={(e) => {
        const el = e.currentTarget
        el.style.transform = 'scale(1)'
      }}
    >
      <span style={{ fontSize: 18 }}>↑</span>
      <span>{label}</span>
    </button>
  )
}
