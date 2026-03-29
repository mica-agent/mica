// ReactiveAgent — watches for human file edits and intelligently proposes updates.
//
// Two-phase architecture:
//   Phase 1 (Triage): Cheap LLM call to decide if any other files need updating.
//   Phase 2 (Reaction): Full chatWithAgent with tools to reason about and execute changes.
//
// Feedback loop prevention: agent-originated writes are tracked and suppressed.

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
} from "./canvasFiles.js";
import { readMicaConfig } from "./projectConnection.js";
import type { ChatHistoryMessage } from "./chatHistory.js";
import { appendChatHistory } from "./chatHistory.js";

// ── Types ────────────────────────────────────────────────────

export interface FileChangeEvent {
  type: string;        // "created" | "changed" | "deleted"
  project: string;
  canvas: string;
  filename: string;
}

interface TriageResult {
  shouldReact: boolean;
  reason: string;
  affectedFiles: string[];
}

type BroadcastFn = (msg: Record<string, unknown>) => void;
type ChatWithAgentFn = (
  project: string,
  canvas: string,
  userMessage: string,
  imageBase64?: string,
  onProgress?: (event: { type: string; tool?: string; description?: string }) => void,
) => Promise<{ message: string; filesChanged?: boolean; cost?: number }>;

// ── Ignore rules ────────────────────────────────────────────
// Dot-prefixed files are internal data (not cards) — handled by naming convention.
// _log.log is a system card but reacting to log changes creates feedback loops.

// ── ReactiveAgent ────────────────────────────────────────────

export class ReactiveAgent {
  private busyCanvases = new Set<string>();
  private cooldowns = new Map<string, number>();     // key → timestamp of last reaction
  private agentWrites = new Map<string, number>();   // key → timestamp (auto-expire)

  private cooldownMs: number;

  constructor(
    private chatWithAgent: ChatWithAgentFn,
    private broadcast: BroadcastFn,
    opts?: { cooldownMs?: number },
  ) {
    this.cooldownMs = opts?.cooldownMs ?? 60_000;
  }

  // ── Public API ──────────────────────────────────────────

  /** Called from file-watcher handler in index.ts */
  onFileChange(event: FileChangeEvent): void {
    // Skip ignored files
    if (event.filename.startsWith(".")) return;   // dot-prefix = internal data
    if (event.filename === "_log.log") return;      // reacting to log changes creates loops

    // Skip agent-originated writes (feedback loop prevention)
    const writeKey = this.fileKey(event.project, event.canvas, event.filename);
    if (this.agentWrites.has(writeKey)) {
      this.agentWrites.delete(writeKey);
      return;
    }

    // Skip if canvas is busy (agent already working on something)
    const canvasKey = this.canvasKey(event.project, event.canvas);
    if (this.busyCanvases.has(canvasKey)) return;

    // Skip if in cooldown
    const lastReaction = this.cooldowns.get(canvasKey);
    if (lastReaction && Date.now() - lastReaction < this.cooldownMs) return;

    // Skip deletes — triage only makes sense for content changes
    if (event.type === "deleted") return;

    // Fire triage asynchronously
    this.triageAndReact(event).catch((err) => {
      console.error(`[reactive] Error processing ${event.filename}:`, err.message);
    });
  }

  /** Mark a file as agent-originated before writing it.
   *  Entries auto-expire after 5s as a safety net. */
  markAgentWrite(project: string, canvas: string, filename: string): void {
    const key = this.fileKey(project, canvas, filename);
    this.agentWrites.set(key, Date.now());
    setTimeout(() => this.agentWrites.delete(key), 5_000);
  }

  /** Mark a canvas as busy (e.g. manual chat in progress) */
  markBusy(project: string, canvas: string): void {
    this.busyCanvases.add(this.canvasKey(project, canvas));
  }

  /** Clear busy state for a canvas */
  clearBusy(project: string, canvas: string): void {
    this.busyCanvases.delete(this.canvasKey(project, canvas));
  }

  // ── Private ─────────────────────────────────────────────

  private fileKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  private canvasKey(project: string, canvas: string): string {
    return `${project}/${canvas}`;
  }

  /** Phase 1: Triage — cheap LLM call to decide if reaction is needed */
  private async triageAndReact(event: FileChangeEvent): Promise<void> {
    const { project, canvas, filename } = event;
    const canvasKey = this.canvasKey(project, canvas);

    // Double-check busy (may have changed since event was queued)
    if (this.busyCanvases.has(canvasKey)) return;

    // Mark busy
    this.busyCanvases.add(canvasKey);

    try {
      // Read the changed file content
      let fileContent: string;
      try {
        const file = await readCanvasFile(project, canvas, filename);
        fileContent = file.content;
      } catch {
        return; // File may have been deleted between event and triage
      }

      // List all files for context
      const allFiles = await listFiles(project, canvas);
      const fileList = allFiles
        .map((f) => f.name)
        .join(", ");

      // Check if reactive is enabled in config
      const config = await readMicaConfig(project);
      if (config?.reactive?.enabled === false) return;
      const cooldownOverride = config?.reactive?.cooldownMs;
      if (cooldownOverride !== undefined) this.cooldownMs = cooldownOverride;

      // Resolve triage model — use Haiku for cost efficiency
      const triageModel = "claude-haiku-4-5-20251001";

      // Build triage prompt
      const contentPreview = fileContent.slice(0, 500);
      const triagePrompt = `A human just edited a file on a project whiteboard.

Changed file: ${filename}
Content preview:
${contentPreview}

All whiteboard files: ${fileList}

Should any OTHER files on the whiteboard be updated as a result of this change?
Consider semantic relationships — e.g. a storyboard derived from requirements, a diagram reflecting architecture decisions, etc.

Reply with ONLY valid JSON (no markdown fences):
{"shouldReact": true/false, "reason": "brief explanation", "affectedFiles": ["file1.md"]}

If the change is trivial (typos, formatting, whitespace) or unlikely to affect other files, set shouldReact: false.`;

      // Run triage query
      const triage = await this.runTriageQuery(triagePrompt, triageModel);

      if (!triage.shouldReact || triage.affectedFiles.length === 0) {
        console.log(`[reactive] Triage: no reaction needed for ${filename}`);
        return;
      }

      console.log(`[reactive] Triage: ${filename} may affect ${triage.affectedFiles.join(", ")} — ${triage.reason}`);

      // Phase 2: Full reaction
      await this.executeReaction(project, canvas, filename, fileContent, triage);

      // Set cooldown
      this.cooldowns.set(canvasKey, Date.now());
    } finally {
      this.busyCanvases.delete(canvasKey);
    }
  }

  /** Run a lightweight triage query (no tools, small model) */
  private async runTriageQuery(prompt: string, model: string): Promise<TriageResult> {
    let resultText = "";

    try {
      for await (const message of query({
        prompt,
        options: {
          systemPrompt: "You are a triage assistant. Analyze file changes and determine if other files need updating. Reply with JSON only.",
          maxTurns: 1,
          model,
          allowedTools: [],
          permissionMode: "bypassPermissions" as const,
          allowDangerouslySkipPermissions: true,
          settings: { forceLoginMethod: "claudeai" as const },
          settingSources: ["user" as const],
        } as import("@anthropic-ai/claude-agent-sdk").Options,
      })) {
        const msg = message as SDKMessage;
        if (msg.type === "result" && "result" in msg) {
          resultText = (msg as SDKResultSuccess).result || "";
        }
      }
    } catch (err) {
      console.error("[reactive] Triage query failed:", (err as Error).message);
      return { shouldReact: false, reason: "triage failed", affectedFiles: [] };
    }

    // Parse JSON response
    try {
      // Strip markdown fences if present
      let cleaned = resultText.trim();
      if (cleaned.startsWith("```")) {
        cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      }
      const parsed = JSON.parse(cleaned);
      return {
        shouldReact: !!parsed.shouldReact,
        reason: String(parsed.reason || ""),
        affectedFiles: Array.isArray(parsed.affectedFiles) ? parsed.affectedFiles : [],
      };
    } catch {
      console.error("[reactive] Failed to parse triage response:", resultText.slice(0, 200));
      return { shouldReact: false, reason: "parse error", affectedFiles: [] };
    }
  }

  /** Phase 2: Full reaction — use chatWithAgent with tools */
  private async executeReaction(
    project: string,
    canvas: string,
    filename: string,
    fileContent: string,
    triage: TriageResult,
  ): Promise<void> {
    // Broadcast that reactive agent is starting
    this.broadcast({
      type: "reactive-started",
      project,
      canvas,
      filename,
    });

    const contentExcerpt = fileContent.slice(0, 1000);
    const reactionPrompt = `[File Change Notification]
The human just edited: ${filename}

Content excerpt:
${contentExcerpt}

Triage assessment: ${triage.affectedFiles.join(", ")} may need updating because: ${triage.reason}

Review the changed file and the affected files. If updates are needed:
1. Explain what you'd change and why
2. For minor/obvious updates, go ahead and make them
3. For significant changes, ask the human first

Be concise. Don't flag unrelated files.`;

    try {
      const response = await this.chatWithAgent(
        project,
        canvas,
        reactionPrompt,
        undefined,
        (evt) => {
          this.broadcast({
            type: "agent-progress",
            project,
            canvas,
            event: evt.type,
            tool: evt.tool,
            description: evt.description,
          });
        },
      );

      // Append to chat history so the response appears in the sidebar
      const messages: ChatHistoryMessage[] = [
        {
          role: "assistant",
          content: response.message,
          agent: "Project Agent",
          filesChanged: response.filesChanged ?? false,
          reactive: true,
          trigger: filename,
        },
      ];

      await appendChatHistory(project, canvas, messages);

      console.log(`[reactive] Reaction complete for ${filename} (cost: $${(response.cost ?? 0).toFixed(4)})`);
    } catch (err) {
      console.error(`[reactive] Reaction failed for ${filename}:`, (err as Error).message);
    }
  }
}
