// Module augmentation for custom shape types in tldraw v4
// This registers our custom shapes with tldraw's type system

declare module '@tldraw/tlschema' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface TLGlobalShapePropsMap {
    'mission-card': {
      w: number
      h: number
      title: string
      summary: string
      questions: string[]
    }
    cluster: {
      w: number
      h: number
      title: string
      summary: string
      status: string
      icon: string
      nodeId: string
      hasChildren: boolean
    }
    'artifact-card': {
      w: number
      h: number
      title: string
      summary: string
      artifactType: string
      nodeId: string
      hasChildren: boolean
    }
    'swarm-cluster': {
      w: number
      h: number
      title: string
      summary: string
      agentCount: number
      health: string
      activity: number
      nodeId: string
      hasChildren: boolean
    }
    'escalation-card': {
      w: number
      h: number
      title: string
      summary: string
      reason: string
      recommendation: string
      decisionNeeded: string
      options: string[]
    }
  }
}

export {}
