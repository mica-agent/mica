// Mica PoC — Types & Mock Data

// ── Types ──────────────────────────────────────────────────

export type LayerId = 'mission' | 'experience' | 'architecture' | 'implementation';

export interface LayerMeta {
  id: LayerId;
  index: number;
  label: string;
  color: string;       // accent color
  bgTint: string;      // subtle background tint
  icon: string;
}

export type CueKind = 'question' | 'prompt' | 'exercise' | 'checklist';

export interface Cue {
  kind: CueKind;
  text: string;
  addressed?: boolean;
}

export type ContextQuality = 'complete' | 'partial' | 'missing';

export interface ContextIndicator {
  label: string;
  quality: ContextQuality;
}

export interface Artifact {
  id: string;
  title: string;
  type: string;
  summary: string;
  detail?: string;
  progress?: number;       // 0-1 for implementation artifacts
  status?: string;
  isEscalation?: boolean;
  options?: string[];
  recommendation?: string;
}

export interface LayerData {
  goal: string;
  aiInitiative: 'low' | 'moderate' | 'high';
  contextIndicators: ContextIndicator[];
  cues: Cue[];
  artifacts: Artifact[];
}

// ── Layer Metadata ─────────────────────────────────────────

export const LAYERS: LayerMeta[] = [
  {
    id: 'mission',
    index: 0,
    label: 'Mission',
    color: '#4a8aff',
    bgTint: 'rgba(74, 138, 255, 0.06)',
    icon: '◆',
  },
  {
    id: 'experience',
    index: 1,
    label: 'Experience',
    color: '#ff8a6a',
    bgTint: 'rgba(255, 138, 106, 0.06)',
    icon: '◇',
  },
  {
    id: 'architecture',
    index: 2,
    label: 'Architecture',
    color: '#4acaa0',
    bgTint: 'rgba(74, 202, 160, 0.06)',
    icon: '⬡',
  },
  {
    id: 'implementation',
    index: 3,
    label: 'Implementation',
    color: '#9a7aff',
    bgTint: 'rgba(154, 122, 255, 0.06)',
    icon: '⬢',
  },
];

// ── Mock Data per Layer ────────────────────────────────────

export const LAYER_DATA: Record<LayerId, LayerData> = {
  mission: {
    goal: 'Complete product brief with target users, constraints, success criteria',
    aiInitiative: 'moderate',
    contextIndicators: [
      { label: 'Product brief', quality: 'complete' },
      { label: 'Personas', quality: 'complete' },
      { label: 'Constraints', quality: 'partial' },
      { label: 'Success criteria', quality: 'partial' },
    ],
    cues: [
      { kind: 'question', text: 'Who is the primary user, and what pain are they feeling?' , addressed: true },
      { kind: 'question', text: 'What does success look like in 6 months?' },
      { kind: 'exercise', text: 'Write one sentence: [User] needs [capability] so they can [outcome].' , addressed: true },
      { kind: 'checklist', text: 'Does the brief cover: target user, core problem, desired outcome, scope?' },
    ],
    artifacts: [
      {
        id: 'm1',
        title: 'Product Brief',
        type: 'narrative',
        summary: 'Inbox Intelligence helps users answer quantitative questions about their email data — spending by category, travel expenses, vendor summaries, subscriptions.',
        detail: 'Users today have no way to query their inbox as structured data. Financial information is scattered across thousands of emails. We turn the inbox into a queryable financial database.',
      },
      {
        id: 'm2',
        title: 'Primary Persona: Alex',
        type: 'persona',
        summary: 'Freelance consultant who tracks expenses manually. Frustrated by lost receipts, time spent categorizing, and tax-season panic.',
        detail: 'Alex receives 40+ transaction emails per week. Currently copies amounts into a spreadsheet manually. Needs answers like "How much did I spend on travel in Q3?"',
      },
      {
        id: 'm3',
        title: 'Constraints',
        type: 'constraint',
        summary: 'All processing local-first for privacy. Gmail API only (v1). Ship MVP in 8 weeks. Budget: $0 infrastructure cost for users.',
        status: 'partial',
      },
      {
        id: 'm4',
        title: 'Success Criteria',
        type: 'criteria',
        summary: 'Users can answer 80% of spending questions within 30 seconds. Transaction extraction accuracy ≥ 90%. Zero data leaves the device.',
        status: 'partial',
      },
      {
        id: 'm5',
        title: 'Scope Decision Needed',
        type: 'escalation',
        summary: 'Should we support shared/family accounts in v1?',
        isEscalation: true,
        recommendation: 'Recommend deferring to v2 — single-user simplifies privacy model and reduces scope by ~30%.',
        options: ['Single user only (v1)', 'Basic shared access (v1)', 'Defer to v2'],
      },
    ],
  },

  experience: {
    goal: 'Full UX flow with wireframes for all primary paths',
    aiInitiative: 'moderate',
    contextIndicators: [
      { label: 'User flows', quality: 'complete' },
      { label: 'Wireframes', quality: 'partial' },
      { label: 'Interaction specs', quality: 'missing' },
    ],
    cues: [
      { kind: 'question', text: 'Walk through what the user does from open to satisfied.' , addressed: true },
      { kind: 'exercise', text: 'Sketch the happy path: 3-5 steps from trigger to outcome.' },
      { kind: 'question', text: 'What should the user never have to think about?' },
      { kind: 'prompt', text: 'Consider the error states — what happens when things go wrong?' },
    ],
    artifacts: [
      {
        id: 'e1',
        title: 'Core User Flow',
        type: 'flow',
        summary: 'Ask → Categorize → Answer → Drill-down → Source Emails',
        detail: '1. User types natural language question\n2. System categorizes intent (spending, merchant, time-range)\n3. System returns answer card with confidence\n4. User drills into supporting transactions\n5. User can view original source emails',
      },
      {
        id: 'e2',
        title: 'Dashboard Wireframe',
        type: 'wireframe',
        summary: 'Spending overview with category breakdown, natural language query bar at top, recent queries sidebar.',
      },
      {
        id: 'e3',
        title: 'Query Results Wireframe',
        type: 'wireframe',
        summary: 'Answer card (large number + context), supporting transaction list below, confidence indicator, "view emails" action.',
      },
      {
        id: 'e4',
        title: 'Tax Season Journey',
        type: 'journey',
        summary: 'Alex needs all business expenses for tax filing. Walks through: connect Gmail → wait for processing → ask "business expenses 2024" → export report.',
        detail: 'Pain points: waiting for initial sync, categorization accuracy, exporting to accountant-friendly format.',
      },
      {
        id: 'e5',
        title: 'Empty State Design',
        type: 'wireframe',
        summary: 'First-run experience: connect Gmail prompt, processing progress, sample questions to try once ready.',
      },
    ],
  },

  architecture: {
    goal: 'Component architecture with dependency map and API contracts',
    aiInitiative: 'high',
    contextIndicators: [
      { label: 'Components', quality: 'complete' },
      { label: 'API contracts', quality: 'complete' },
      { label: 'Data model', quality: 'partial' },
      { label: 'Dependencies', quality: 'complete' },
    ],
    cues: [
      { kind: 'question', text: "What's the hardest technical bet here?" , addressed: true },
      { kind: 'exercise', text: 'Name the 3 critical capabilities — what happens if each fails?' },
      { kind: 'question', text: 'Are there constraints (privacy, latency, cost) that force a specific approach?' , addressed: true },
    ],
    artifacts: [
      {
        id: 'a1',
        title: 'System Architecture',
        type: 'diagram',
        summary: 'Gmail Ingestion → Transaction Extraction → Merchant Classification → Analytics Query Engine → UI Layer',
        detail: '5 components, all running client-side. SQLite for local storage. WebAssembly ML model for classification.',
      },
      {
        id: 'a2',
        title: 'Query API Contract',
        type: 'api',
        summary: 'POST /query { question: string, timeRange?: DateRange } → { answer: string, confidence: number, transactions: Transaction[], sources: Email[] }',
      },
      {
        id: 'a3',
        title: 'Data Model',
        type: 'model',
        summary: 'Transaction { amount, merchant, category, date, email_id, confidence, raw_text }. Category enum: dining, travel, subscriptions, shopping, utilities, other.',
        status: 'partial',
      },
      {
        id: 'a4',
        title: 'Decision: Local-First Strategy',
        type: 'decision',
        summary: 'SQLite + in-browser ML vs. encrypted cloud sync.',
        detail: 'Chose SQLite + WASM. Tradeoff: limited model size (must fit in browser), but zero infrastructure cost and complete privacy.',
        options: ['SQLite + WASM (chosen)', 'Encrypted cloud sync', 'Hybrid with optional cloud'],
      },
      {
        id: 'a5',
        title: 'Extraction Accuracy Risk',
        type: 'escalation',
        summary: 'Receipt extraction accuracy stalled at 82% — below 90% target.',
        isEscalation: true,
        recommendation: 'Add a human-in-the-loop correction UI. Let users fix misclassifications, feeding corrections back into the local model.',
        options: ['Add correction UI', 'Lower accuracy target to 85%', 'Add cloud ML fallback (breaks local-first)'],
      },
    ],
  },

  implementation: {
    goal: 'Deployed, tested product matching architecture',
    aiInitiative: 'high',
    contextIndicators: [
      { label: 'Source code', quality: 'partial' },
      { label: 'Test suite', quality: 'partial' },
      { label: 'Deployment', quality: 'missing' },
    ],
    cues: [
      { kind: 'question', text: "What's the smallest thing we can build to validate the riskiest assumption?" },
      { kind: 'checklist', text: 'For each component: clear input, clear output, clear success metric?' },
    ],
    artifacts: [
      {
        id: 'i1',
        title: 'Sprint 3 Status',
        type: 'status',
        summary: 'Gmail ingestion complete. Transaction extraction at 82% accuracy. Classification pipeline in progress.',
        progress: 0.45,
      },
      {
        id: 'i2',
        title: 'Test Results',
        type: 'tests',
        summary: '142 passing, 3 failing (extraction edge cases: foreign currency, split transactions, refunds).',
        progress: 0.98,
        status: '142/145 passing',
      },
      {
        id: 'i3',
        title: 'Gmail Ingestion Pipeline',
        type: 'component',
        summary: 'OAuth2 flow → incremental sync → message parsing → local SQLite storage. Handles 10,000 emails in ~45s.',
        progress: 1.0,
        status: 'complete',
      },
      {
        id: 'i4',
        title: 'PR #47: Merchant Classification',
        type: 'review',
        summary: 'Adds WASM-based merchant classification pipeline. 119 merchant categories. Needs review of category taxonomy.',
        status: 'review needed',
      },
      {
        id: 'i5',
        title: 'Deployment Config',
        type: 'deploy',
        summary: 'Static site deployment. No server infrastructure needed. CDN + service worker for offline capability.',
        progress: 0.0,
        status: 'not started',
      },
    ],
  },
};

export const PROJECT_NAME = 'Inbox Intelligence';
