import type { AgentResponse, CanvasId, ProgressCallback } from "./types.js";

export interface AgentProvider {
  readonly name: string;
  readonly defaultModel: string;

  chat(
    project: string,
    canvas: CanvasId,
    message: string,
    image?: string,
    onProgress?: ProgressCallback,
    resumeSessionId?: string,
  ): Promise<AgentResponse>;

  resetCanvas(project: string, canvas: string): void;
  resetAll(): void;
  setWriteHook(hook: (project: string, canvas: string, filename: string) => void): void;
}
