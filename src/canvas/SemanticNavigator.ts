import { Editor, createShapeId } from 'tldraw'
import type { TLShapeId } from 'tldraw'
import type { LayerNode } from '../data/seedData'
import { findNode, getMissionLevelNodes } from '../data/seedData'
import type { SemanticLevel } from '../logic/semanticLevels'
import { SemanticLevel as SL } from '../logic/semanticLevels'

interface NavStackEntry {
  nodeId: string
  level: SemanticLevel
}

export class SemanticNavigator {
  private editor: Editor
  private navStack: NavStackEntry[] = []
  private activeShapeIds: TLShapeId[] = []
  private _currentLevel: SemanticLevel = SL.MISSION
  private _onLevelChange: ((level: SemanticLevel, parentTitle?: string) => void) | null = null

  constructor(editor: Editor) {
    this.editor = editor
  }

  get currentLevel(): SemanticLevel {
    return this._currentLevel
  }

  set onLevelChange(cb: (level: SemanticLevel, parentTitle?: string) => void) {
    this._onLevelChange = cb
  }

  initialize() {
    const nodes = getMissionLevelNodes()
    this.loadNodes(nodes)
    this.navStack = [{ nodeId: 'root', level: SL.MISSION }]
    this._currentLevel = SL.MISSION
    this._onLevelChange?.(SL.MISSION)

    requestAnimationFrame(() => {
      this.editor.zoomToFit({ animation: { duration: 300 } })
    })
  }

  descend(nodeId: string) {
    const node = findNode(nodeId)
    if (!node?.children?.length) return

    this.clearActiveShapes()
    this.loadNodes(node.children)

    const newLevel = node.children[0].level
    this._currentLevel = newLevel
    this.navStack.push({ nodeId, level: newLevel })

    requestAnimationFrame(() => {
      this.editor.zoomToFit({ animation: { duration: 500 } })
    })

    this._onLevelChange?.(newLevel, node.title)
  }

  ascend() {
    if (this.navStack.length <= 1) return

    this.navStack.pop()
    const parent = this.navStack[this.navStack.length - 1]

    this.clearActiveShapes()

    if (parent.nodeId === 'root') {
      const nodes = getMissionLevelNodes()
      this.loadNodes(nodes)
      this._currentLevel = SL.MISSION
      this._onLevelChange?.(SL.MISSION)
    } else {
      const parentNode = findNode(parent.nodeId)
      if (parentNode?.children) {
        this.loadNodes(parentNode.children)
        this._currentLevel = parent.level
        this._onLevelChange?.(parent.level, parentNode.title)
      }
    }

    requestAnimationFrame(() => {
      this.editor.zoomToFit({ animation: { duration: 500 } })
    })
  }

  canAscend(): boolean {
    return this.navStack.length > 1
  }

  getParentTitle(): string | undefined {
    if (this.navStack.length < 2) return undefined
    const parentEntry = this.navStack[this.navStack.length - 2]
    if (parentEntry.nodeId === 'root') return 'Mission'
    const parentNode = findNode(parentEntry.nodeId)
    return parentNode?.title
  }

  private clearActiveShapes() {
    if (this.activeShapeIds.length > 0) {
      this.editor.deleteShapes(this.activeShapeIds)
      this.activeShapeIds = []
    }
  }

  private loadNodes(nodes: LayerNode[]) {
    const shapes = nodes.map((node) => this.nodeToShape(node))
    this.editor.createShapes(shapes)
    this.activeShapeIds = shapes.map((s) => s.id)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private nodeToShape(node: LayerNode): any {
    const id = createShapeId(node.id)
    const hasChildren = (node.children?.length ?? 0) > 0

    switch (node.type) {
      case 'mission':
        return {
          id,
          type: 'mission-card' as const,
          x: node.position.x,
          y: node.position.y,
          props: {
            w: node.size.w,
            h: node.size.h,
            title: node.title,
            summary: node.summary,
            questions: (node.props?.questions as string[]) ?? [],
          },
        }

      case 'cluster':
        return {
          id,
          type: 'cluster' as const,
          x: node.position.x,
          y: node.position.y,
          props: {
            w: node.size.w,
            h: node.size.h,
            title: node.title,
            summary: node.summary,
            status: (node.props?.status as string) ?? 'active',
            icon: (node.props?.icon as string) ?? '📦',
            nodeId: node.id,
            hasChildren,
          },
        }

      case 'swarm':
        return {
          id,
          type: 'swarm-cluster' as const,
          x: node.position.x,
          y: node.position.y,
          props: {
            w: node.size.w,
            h: node.size.h,
            title: node.title,
            summary: node.summary,
            agentCount: (node.props?.agentCount as number) ?? 0,
            health: (node.props?.health as string) ?? 'healthy',
            activity: (node.props?.activity as number) ?? 0.5,
            nodeId: node.id,
            hasChildren,
          },
        }

      case 'escalation':
        return {
          id,
          type: 'escalation-card' as const,
          x: node.position.x,
          y: node.position.y,
          props: {
            w: node.size.w,
            h: node.size.h,
            title: node.title,
            summary: node.summary,
            reason: (node.props?.reason as string) ?? '',
            recommendation: (node.props?.recommendation as string) ?? '',
            decisionNeeded: (node.props?.decisionNeeded as string) ?? '',
            options: (node.props?.options as string[]) ?? [],
          },
        }

      default:
        return {
          id,
          type: 'artifact-card' as const,
          x: node.position.x,
          y: node.position.y,
          props: {
            w: node.size.w,
            h: node.size.h,
            title: node.title,
            summary: node.summary,
            artifactType: node.type,
            nodeId: node.id,
            hasChildren,
          },
        }
    }
  }
}
