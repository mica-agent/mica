import { useCallback, useRef, useState } from 'react'
import { Tldraw, Editor } from 'tldraw'
import 'tldraw/tldraw.css'

import { MissionCardShapeUtil } from '../shapes/MissionCardShape'
import { ClusterShapeUtil } from '../shapes/ClusterShape'
import { ArtifactCardShapeUtil } from '../shapes/ArtifactCardShape'
import { SwarmClusterShapeUtil } from '../shapes/SwarmClusterShape'
import { EscalationCardShapeUtil } from '../shapes/EscalationCardShape'
import { SemanticNavigator } from './SemanticNavigator'
import type { SemanticLevel } from '../logic/semanticLevels'
import { SemanticLevel as SL } from '../logic/semanticLevels'
import { findNode } from '../data/seedData'
import { PopUpButton } from '../ui/PopUpButton'
import { LevelIndicator } from '../ui/LevelIndicator'
import { ToolBar } from '../ui/ToolBar'

const customShapeUtils = [
  MissionCardShapeUtil,
  ClusterShapeUtil,
  ArtifactCardShapeUtil,
  SwarmClusterShapeUtil,
  EscalationCardShapeUtil,
]

export function MissionCanvas() {
  const navigatorRef = useRef<SemanticNavigator | null>(null)
  const [currentLevel, setCurrentLevel] = useState<SemanticLevel>(SL.MISSION)
  const [parentTitle, setParentTitle] = useState<string | undefined>(undefined)
  const [popUpLabel, setPopUpLabel] = useState<string | undefined>(undefined)
  const [canAscend, setCanAscend] = useState(false)
  const [activeTool, setActiveTool] = useState('select')
  const editorRef = useRef<Editor | null>(null)

  const handleMount = useCallback((editor: Editor) => {
    editorRef.current = editor
    const navigator = new SemanticNavigator(editor)
    navigatorRef.current = navigator

    navigator.onLevelChange = (level: SemanticLevel, title?: string) => {
      setCurrentLevel(level)
      setParentTitle(title)
      setCanAscend(navigator.canAscend())
      setPopUpLabel(navigator.getParentTitle())
    }

    navigator.initialize()

    // Listen for double-click events to trigger navigation
    editor.on('event', (event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any
      if (
        ev.type === 'click' &&
        ev.name === 'double_click' &&
        ev.phase === 'settle' &&
        ev.target === 'shape' &&
        ev.shape
      ) {
        const shape = ev.shape

        let nodeId: string | undefined

        if (shape.type === 'cluster') {
          nodeId = shape.props.nodeId
        } else if (shape.type === 'artifact-card' && shape.props.hasChildren) {
          nodeId = shape.props.nodeId
        } else if (shape.type === 'swarm-cluster' && shape.props.hasChildren) {
          nodeId = shape.props.nodeId
        }

        if (nodeId) {
          const node = findNode(nodeId)
          if (node?.children?.length) {
            requestAnimationFrame(() => {
              navigator.descend(nodeId!)
            })
          }
        }
      }
    })

    // Set dark color scheme
    editor.user.updateUserPreferences({ colorScheme: 'dark' })
  }, [])

  const handleAscend = useCallback(() => {
    navigatorRef.current?.ascend()
  }, [])

  const handleSelectTool = useCallback((tool: string) => {
    setActiveTool(tool)
    const editor = editorRef.current
    if (!editor) return

    switch (tool) {
      case 'select':
        editor.setCurrentTool('select')
        break
      case 'draw':
        editor.setCurrentTool('draw')
        break
      case 'eraser':
        editor.setCurrentTool('eraser')
        break
    }
  }, [])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <Tldraw
        shapeUtils={customShapeUtils}
        hideUi
        onMount={handleMount}
      />
      <LevelIndicator currentLevel={currentLevel} parentTitle={parentTitle} />
      <PopUpButton
        currentLevel={currentLevel}
        parentTitle={popUpLabel}
        onAscend={handleAscend}
        canAscend={canAscend}
      />
      <ToolBar activeTool={activeTool} onSelectTool={handleSelectTool} />
    </div>
  )
}
