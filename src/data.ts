// Mica — Types & Color Palette

// ── Types ──────────────────────────────────────────────────

export type CanvasId = string;

export interface CanvasMeta {
  id: CanvasId;
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

export interface CanvasData {
  goal: string;
  aiInitiative: 'low' | 'moderate' | 'high';
  contextIndicators: ContextIndicator[];
  cues: Cue[];
  artifacts: Artifact[];
}

// ── Color palette for canvases ────────────────────────────
// Assigns colors by index so any dynamic set of canvases gets consistent colors

const CANVAS_COLORS = [
  { color: '#4a8aff', bgTint: 'rgba(74, 138, 255, 0.06)', icon: '\u25c6' },   // blue diamond
  { color: '#ff8a6a', bgTint: 'rgba(255, 138, 106, 0.06)', icon: '\u25c7' },   // orange diamond outline
  { color: '#4acaa0', bgTint: 'rgba(74, 202, 160, 0.06)', icon: '\u2b21' },     // green hexagon
  { color: '#9a7aff', bgTint: 'rgba(154, 122, 255, 0.06)', icon: '\u2b22' },    // purple hexagon
  { color: '#ff6b9d', bgTint: 'rgba(255, 107, 157, 0.06)', icon: '\u25cb' },    // pink circle
  { color: '#ffa94d', bgTint: 'rgba(255, 169, 77, 0.06)', icon: '\u25a1' },     // orange square
  { color: '#63e6be', bgTint: 'rgba(99, 230, 190, 0.06)', icon: '\u25b3' },     // teal triangle
  { color: '#da77f2', bgTint: 'rgba(218, 119, 242, 0.06)', icon: '\u2b20' },    // violet pentagon
];

export function getCanvasColor(index: number): { color: string; bgTint: string; icon: string } {
  return CANVAS_COLORS[index % CANVAS_COLORS.length];
}

export function buildCanvasMeta(canvases: string[]): CanvasMeta[] {
  return canvases.map((id, index) => {
    const palette = getCanvasColor(index);
    const label = id
      .replace(/[-_]/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      id,
      index,
      label,
      ...palette,
    };
  });
}
