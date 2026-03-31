export type CanvasId = string;

export interface AgentResponse {
  canvas: CanvasId;
  message: string;
  consultation?: Consultation | null;
  filesChanged?: boolean;
  cost?: number;
  sessionId?: string;
}

export interface Consultation {
  targetCanvas: CanvasId;
  question: string;
  context: string;
}

export type ProgressCallback = (event: {
  type: string;
  tool?: string;
  elapsed?: number;
  description?: string;
}) => void;
