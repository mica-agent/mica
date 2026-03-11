export const SemanticLevel = {
  MISSION: 0,
  INTENT: 1,
  ARCHITECTURE: 2,
  SWARMS: 3,
  DETAIL: 4,
} as const

export type SemanticLevel = (typeof SemanticLevel)[keyof typeof SemanticLevel]

export const LEVEL_LABELS: Record<SemanticLevel, string> = {
  [SemanticLevel.MISSION]: 'Mission',
  [SemanticLevel.INTENT]: 'Intent',
  [SemanticLevel.ARCHITECTURE]: 'Architecture',
  [SemanticLevel.SWARMS]: 'Swarms',
  [SemanticLevel.DETAIL]: 'Detail',
}
