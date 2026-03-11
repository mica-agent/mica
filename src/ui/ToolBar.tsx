interface ToolBarProps {
  activeTool: string
  onSelectTool: (tool: string) => void
}

export function ToolBar({ activeTool, onSelectTool }: ToolBarProps) {
  const tools = [
    { id: 'select', label: 'Select', icon: '↗' },
    { id: 'draw', label: 'Draw', icon: '✏️' },
    { id: 'eraser', label: 'Erase', icon: '◻' },
  ]

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        gap: 2,
        padding: 4,
        background: 'rgba(12, 14, 22, 0.85)',
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 14,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
      }}
    >
      {tools.map((tool) => {
        const isActive = activeTool === tool.id
        return (
          <button
            key={tool.id}
            onClick={() => onSelectTool(tool.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '8px 16px',
              background: isActive ? 'rgba(100, 180, 255, 0.15)' : 'transparent',
              border: 'none',
              borderRadius: 10,
              color: isActive ? 'rgba(100, 180, 255, 0.9)' : 'rgba(255,255,255,0.4)',
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              cursor: 'pointer',
              touchAction: 'manipulation',
              transition: 'background 0.15s, color 0.15s',
            }}
          >
            <span style={{ fontSize: 16 }}>{tool.icon}</span>
            <span>{tool.label}</span>
          </button>
        )
      })}
    </div>
  )
}
