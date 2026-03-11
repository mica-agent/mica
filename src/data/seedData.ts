import { SemanticLevel } from '../logic/semanticLevels'

export type ArtifactType =
  | 'mission'
  | 'cluster'
  | 'wireframe'
  | 'qa'
  | 'journey'
  | 'storyboard'
  | 'scenario'
  | 'capability'
  | 'constraint'
  | 'decision'
  | 'swarm'
  | 'escalation'

export type HealthStatus = 'healthy' | 'degraded' | 'critical'

export interface LayerNode {
  id: string
  type: ArtifactType
  title: string
  summary: string
  level: SemanticLevel
  position: { x: number; y: number }
  size: { w: number; h: number }
  props?: Record<string, unknown>
  children?: LayerNode[]
}

export const missionTree: LayerNode = {
  id: 'root',
  type: 'mission',
  title: 'Inbox Intelligence',
  summary:
    'Help users ask high-value quantitative questions over their inbox data — spending by category, travel expenses, vendor summaries, recurring subscriptions.',
  level: SemanticLevel.MISSION,
  position: { x: 0, y: 0 },
  size: { w: 600, h: 200 },
  props: {
    questions: [
      'What information is worth extracting?',
      'What should the experience look like?',
      'How accurate does extraction need to be?',
    ],
  },
  children: [
    {
      id: 'cluster-ux',
      type: 'cluster',
      title: 'User Experience',
      summary: 'How users interact with inbox intelligence — dashboards, flows, and answer presentation',
      level: SemanticLevel.MISSION,
      position: { x: -500, y: 350 },
      size: { w: 380, h: 180 },
      props: { status: 'active', icon: '🎨' },
      children: [
        {
          id: 'artifact-dashboard',
          type: 'wireframe',
          title: 'Spending Dashboard',
          summary:
            'Primary view showing spending breakdown by category with drill-down into individual transactions. Top bar: search + date range. Main area: category cards with totals. Detail panel: transaction list from source emails.',
          level: SemanticLevel.INTENT,
          position: { x: -700, y: 280 },
          size: { w: 360, h: 280 },
        },
        {
          id: 'artifact-qa',
          type: 'qa',
          title: 'How much did I spend on restaurants last month?',
          summary:
            'The system scans inbox for restaurant receipts, delivery confirmations, and credit card statements. Returns: $847.32 across 23 transactions. Top merchants: DoorDash ($312), Sweetgreen ($156), Local restaurants ($379).',
          level: SemanticLevel.INTENT,
          position: { x: -280, y: 280 },
          size: { w: 360, h: 240 },
        },
        {
          id: 'artifact-journey',
          type: 'journey',
          title: 'Ask → Answer → Drill Down → Source Emails',
          summary:
            'User types a natural question → system parses intent → queries extracted data → presents summary answer → user taps to see supporting transactions → taps further to view original emails.',
          level: SemanticLevel.INTENT,
          position: { x: -500, y: 580 },
          size: { w: 400, h: 200 },
        },
        {
          id: 'artifact-storyboard',
          type: 'storyboard',
          title: 'Tax Preparation Scenario',
          summary:
            'April: User opens Mica to prepare taxes. Asks "Show all deductible expenses from 2024." System surfaces medical, charity, and business expenses. User reviews, flags corrections, exports to accountant.',
          level: SemanticLevel.INTENT,
          position: { x: -100, y: 580 },
          size: { w: 360, h: 200 },
        },
      ],
    },
    {
      id: 'cluster-questions',
      type: 'cluster',
      title: 'Sample Questions',
      summary: 'Representative questions users will ask — validates what the system must support',
      level: SemanticLevel.MISSION,
      position: { x: 0, y: 350 },
      size: { w: 380, h: 180 },
      props: { status: 'active', icon: '❓' },
      children: [
        {
          id: 'artifact-q1',
          type: 'qa',
          title: 'What are my recurring subscriptions?',
          summary:
            'Detect repeating charges from the same merchant at regular intervals. Display: service name, amount, frequency, total annual cost. Flag: subscriptions with price increases.',
          level: SemanticLevel.INTENT,
          position: { x: -200, y: 280 },
          size: { w: 340, h: 220 },
        },
        {
          id: 'artifact-q2',
          type: 'qa',
          title: 'How much did I spend on travel in Q3?',
          summary:
            'Aggregate flights, hotels, car rentals, and travel-related purchases from Jul-Sep. Break down by trip if itinerary data available. Source: airline confirmations, hotel receipts, Uber/Lyft rides.',
          level: SemanticLevel.INTENT,
          position: { x: 200, y: 280 },
          size: { w: 340, h: 220 },
        },
        {
          id: 'artifact-q3',
          type: 'scenario',
          title: 'Vendor Spend Summary',
          summary:
            'User asks: "Which vendors did I spend the most with this year?" System ranks vendors by total spend. Shows trend arrows for increasing/decreasing. Links each vendor to source transactions.',
          level: SemanticLevel.INTENT,
          position: { x: 0, y: 550 },
          size: { w: 360, h: 200 },
        },
      ],
    },
    {
      id: 'cluster-constraints',
      type: 'cluster',
      title: 'Product Constraints',
      summary: 'Hard requirements and boundaries the system must respect',
      level: SemanticLevel.MISSION,
      position: { x: 500, y: 350 },
      size: { w: 380, h: 180 },
      props: { status: 'stable', icon: '🔒' },
      children: [
        {
          id: 'artifact-constraint-privacy',
          type: 'constraint',
          title: 'All Processing Local-First',
          summary:
            'Email content must never leave the user\'s device or private cloud instance. All extraction, classification, and analytics happen locally. Only anonymized aggregates may be synced.',
          level: SemanticLevel.INTENT,
          position: { x: 300, y: 280 },
          size: { w: 360, h: 220 },
        },
        {
          id: 'artifact-constraint-accuracy',
          type: 'constraint',
          title: 'Answerability Over Perfection',
          summary:
            'System should prioritize giving a useful approximate answer quickly over waiting for perfect extraction. Show confidence levels. Let users correct misclassifications.',
          level: SemanticLevel.INTENT,
          position: { x: 700, y: 280 },
          size: { w: 360, h: 220 },
        },
        {
          id: 'artifact-decision-1',
          type: 'decision',
          title: 'Incremental vs. Batch Processing',
          summary:
            'Decision: Process new emails incrementally as they arrive rather than periodic batch jobs. Rationale: Fresher data, lower peak resource usage, better UX for recent queries.',
          level: SemanticLevel.INTENT,
          position: { x: 500, y: 550 },
          size: { w: 360, h: 200 },
        },
      ],
    },
    {
      id: 'cluster-capabilities',
      type: 'cluster',
      title: 'Candidate Capabilities',
      summary: 'Core system capabilities required to deliver the product — architecture building blocks',
      level: SemanticLevel.MISSION,
      position: { x: -10, y: 620 },
      size: { w: 380, h: 180 },
      props: { status: 'active', icon: '⚙️' },
      children: [
        {
          id: 'cap-ingestion',
          type: 'capability',
          title: 'Gmail Ingestion',
          summary:
            'OAuth-based Gmail API integration. Fetches messages incrementally. Handles rate limits, pagination, and attachment extraction. Stores raw content in local encrypted store.',
          level: SemanticLevel.ARCHITECTURE,
          position: { x: -400, y: 280 },
          size: { w: 340, h: 220 },
          children: [
            {
              id: 'swarm-ingestion',
              type: 'swarm',
              title: 'Ingestion Pipeline Swarm',
              summary: 'Building and testing the Gmail fetch, parse, and store pipeline',
              level: SemanticLevel.SWARMS,
              position: { x: -500, y: 280 },
              size: { w: 320, h: 200 },
              props: { agentCount: 47, health: 'healthy' as HealthStatus, activity: 0.6 },
            },
          ],
        },
        {
          id: 'cap-extraction',
          type: 'capability',
          title: 'Transaction Extraction',
          summary:
            'ML pipeline that identifies financial transactions in emails — receipts, invoices, statements, confirmations. Extracts: amount, merchant, date, category. Handles diverse email formats.',
          level: SemanticLevel.ARCHITECTURE,
          position: { x: 0, y: 280 },
          size: { w: 340, h: 220 },
          children: [
            {
              id: 'swarm-extraction',
              type: 'swarm',
              title: 'Receipt Extraction Swarm',
              summary: 'Training and evaluating extraction models across email formats',
              level: SemanticLevel.SWARMS,
              position: { x: -200, y: 280 },
              size: { w: 320, h: 200 },
              props: { agentCount: 284, health: 'degraded' as HealthStatus, activity: 0.9 },
              children: [
                {
                  id: 'escalation-extraction',
                  type: 'escalation',
                  title: 'Receipt extraction accuracy stalled at 82%',
                  summary:
                    'Three different extraction strategies have been tried over 6 cycles with no improvement beyond 82% accuracy on the held-out test set.',
                  level: SemanticLevel.DETAIL,
                  position: { x: -300, y: 300 },
                  size: { w: 420, h: 340 },
                  props: {
                    reason: 'Three strategies tried; no improvement in 6 cycles',
                    recommendation:
                      'Loosen schema and prioritize answerability over completeness. Accept 82% on structured receipts and add confidence scores for ambiguous cases.',
                    decisionNeeded: 'Accuracy vs. generality tradeoff',
                    options: [
                      'Continue optimizing current approach (diminishing returns likely)',
                      'Loosen schema, add confidence scoring',
                      'Hybrid: strict for common formats, fuzzy for rare ones',
                    ],
                  },
                },
              ],
            },
            {
              id: 'swarm-evaluation',
              type: 'swarm',
              title: 'Evaluation Swarm',
              summary: 'Running accuracy benchmarks and regression tests across extraction pipeline',
              level: SemanticLevel.SWARMS,
              position: { x: 200, y: 280 },
              size: { w: 320, h: 200 },
              props: { agentCount: 91, health: 'healthy' as HealthStatus, activity: 0.4 },
            },
          ],
        },
        {
          id: 'cap-classification',
          type: 'capability',
          title: 'Merchant Classification',
          summary:
            'Categorizes merchants into a taxonomy (restaurants, travel, subscriptions, utilities, etc.). Uses merchant name, transaction context, and email content signals.',
          level: SemanticLevel.ARCHITECTURE,
          position: { x: 400, y: 280 },
          size: { w: 340, h: 220 },
          children: [
            {
              id: 'swarm-classification',
              type: 'swarm',
              title: 'Merchant Classification Swarm',
              summary: 'Building and refining merchant taxonomy and classification models',
              level: SemanticLevel.SWARMS,
              position: { x: 200, y: 280 },
              size: { w: 320, h: 200 },
              props: { agentCount: 119, health: 'healthy' as HealthStatus, activity: 0.5 },
            },
            {
              id: 'escalation-taxonomy',
              type: 'escalation',
              title: 'Merchant taxonomy conflict',
              summary:
                'Two swarms have proposed incompatible category hierarchies. One uses flat categories (30 types), the other uses nested hierarchy (8 top-level, ~60 leaf categories).',
              level: SemanticLevel.SWARMS,
              position: { x: 600, y: 280 },
              size: { w: 420, h: 340 },
              props: {
                reason: 'Conflicting architectural assumptions between swarms',
                recommendation:
                  'Adopt the nested hierarchy but expose a simplified flat view in the UI. This preserves granularity for analytics while keeping the user experience clean.',
                decisionNeeded: 'Flat vs. hierarchical merchant taxonomy',
                options: [
                  'Flat taxonomy (simpler, less precise)',
                  'Nested hierarchy (richer, more complex)',
                  'Nested with flat UI projection (recommended)',
                ],
              },
            },
          ],
        },
        {
          id: 'cap-analytics',
          type: 'capability',
          title: 'Analytics Query Layer',
          summary:
            'Natural language to structured query translation. Handles aggregations, time ranges, comparisons, and drill-downs. Returns results with confidence and source links.',
          level: SemanticLevel.ARCHITECTURE,
          position: { x: 0, y: 560 },
          size: { w: 340, h: 220 },
          children: [
            {
              id: 'swarm-analytics',
              type: 'swarm',
              title: 'Architecture Synthesis Swarm',
              summary: 'Designing the query layer and integrating it with extraction and classification',
              level: SemanticLevel.SWARMS,
              position: { x: 0, y: 280 },
              size: { w: 320, h: 200 },
              props: { agentCount: 18, health: 'healthy' as HealthStatus, activity: 0.3 },
            },
          ],
        },
      ],
    },
  ],
}

/** Flatten the tree to find a node by ID */
export function findNode(id: string, node: LayerNode = missionTree): LayerNode | undefined {
  if (node.id === id) return node
  for (const child of node.children ?? []) {
    const found = findNode(id, child)
    if (found) return found
  }
  return undefined
}

/** Get the root-level shapes to show initially (mission card + top clusters) */
export function getMissionLevelNodes(): LayerNode[] {
  return [missionTree, ...(missionTree.children ?? [])]
}
