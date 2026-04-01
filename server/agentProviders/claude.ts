// ClaudeProvider — Claude Agent SDK sidebar chat provider.
// Uses the shared agentCore layer for tools, prompts, and config.
// Transport: spawns Claude Code CLI subprocess via SDK query().

// Allow nested Claude Code sessions
delete process.env.CLAUDECODE;

import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";
import type { AgentProvider } from "../agentCore/provider.js";
import type { AgentResponse, CanvasId, ProgressCallback } from "../agentCore/types.js";
import { buildSystemPrompt } from "../agentCore/systemPrompt.js";
import { resolveModel } from "../agentCore/config.js";
import { describeToolUse, appendToLog, getAgentMeta } from "../agentCore/logging.js";
import { executeTool, type ToolContext } from "../agentCore/toolLogic.js";
import { MICA_TOOLS } from "../agentCore/toolSchema.js";
import { getProjectPath } from "../projectConnection.js";
import { CONTAINER_PROJECT_DIR } from "../dockerSpawn.js";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  invalidateExtensionCache,
} from "../canvasFiles.js";
import type { ProjectExecutor } from "../projectExecutor.js";
import fs from "fs";
import path from "path";

export class ClaudeProvider implements AgentProvider {
  readonly name = "claude";
  readonly defaultModel = "claude-sonnet-4-6";

  private executor: ProjectExecutor | null;
  private onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null = null;

  constructor(executor?: ProjectExecutor | null) {
    this.executor = executor || null;
  }

  setWriteHook(hook: (project: string, canvas: string, filename: string) => void): void {
    this.onAgentWrite = hook;
  }

  resetCanvas(_project: string, _canvas: string): void {
    // SDK sessions are managed externally — nothing to reset in-process
  }

  resetAll(): void {
    // Nothing to reset
  }

  async chat(
    project: string,
    canvas: CanvasId,
    userMessage: string,
    _image?: string,
    onProgress?: ProgressCallback,
    resumeSessionId?: string,
  ): Promise<AgentResponse> {
    const systemPrompt = await buildSystemPrompt(project, canvas);
    const model = await resolveModel(project, canvas, this.defaultModel);

    // MCP tool server wrapping the shared tool logic
    const mcpServer = this.createMcpToolServer(project, canvas);

    const options: Record<string, unknown> = {
      systemPrompt,
      cwd: CONTAINER_PROJECT_DIR,
      mcpServers: { "mica-tools": mcpServer },
      tools: ["Bash"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      maxTurns: 10,
      model,
      settings: { forceLoginMethod: "claudeai" as const },
      settingSources: ["user" as const, "project" as const],
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };

    if (this.executor) {
      options.spawnClaudeCodeProcess = await this.executor.createAgentSpawner(project, canvas);
    }

    onProgress?.({ type: "thinking", description: "Thinking..." });

    let resultText = "";
    let cost = 0;
    let sessionId: string | undefined;

    for await (const message of query({
      prompt: userMessage,
      options: options as import("@anthropic-ai/claude-agent-sdk").Options,
    })) {
      const msg = message as SDKMessage;

      if (onProgress && msg.type === "assistant" && msg.message?.content) {
        for (const block of msg.message.content) {
          if ("type" in block && block.type === "tool_use" && "name" in block) {
            const b = block as { name: string; input?: Record<string, unknown> };
            onProgress({ type: "tool_start", tool: b.name, description: describeToolUse(b.name, b.input) });
          }
        }
      }

      if (msg.type === "assistant" && msg.message?.content) {
        let turnText = "";
        for (const block of msg.message.content) {
          if ("type" in block && block.type === "text" && "text" in block) {
            turnText += (block as { text: string }).text;
          }
        }
        if (turnText) resultText = turnText;
      }

      if (msg.type === "result" && "result" in msg) {
        const result = msg as SDKResultSuccess;
        resultText = result.result || resultText;
        cost = result.total_cost_usd || 0;
        sessionId = result.session_id;
      }
    }

    // If agent used all turns on tool calls without producing text, provide a fallback
    if (!resultText.trim()) {
      resultText = this._filesChanged
        ? "Done — I made changes to the whiteboard. Let me know if you'd like me to continue."
        : "I looked into it but ran out of steps before I could respond. Say 'continue' and I'll pick up where I left off.";
    }

    return {
      canvas,
      message: resultText,
      consultation: null,
      filesChanged: this._filesChanged,
      cost,
      sessionId,
    };
  }

  // Track file changes for current call (reset per call)
  private _filesChanged = false;

  /**
   * Create a fresh MCP tool server wired to the shared tool logic.
   * Uses Claude SDK's tool() + createSdkMcpServer().
   */
  private createMcpToolServer(project: string, canvas: string) {
    // Reset per-call state
    this._filesChanged = false;

    const ctx: ToolContext = {
      project,
      canvas,
      onAgentWrite: this.onAgentWrite,
      filesChanged: { value: false },
      chatFn: (p, c, m) => this.chat(p, c, m),
    };

    // Wrap shared tool logic into MCP tool format
    const listFilesTool = tool(
      "list_files", "List all files on the current canvas's whiteboard.", {},
      async () => {
        const result = await executeTool(ctx, "list_files", {});
        this._filesChanged = this._filesChanged || ctx.filesChanged.value;
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const readFileTool = tool(
      "read_file", "Read a specific file from the whiteboard.",
      { filename: z.string().describe("The filename to read") },
      async (args) => {
        const result = await executeTool(ctx, "read_file", args);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const writeFileTool = tool(
      "write_file", "Create or update a file on the whiteboard.",
      {
        filename: z.string().describe("Filename or path"),
        content: z.string().describe("The file content"),
        summary: z.string().describe("One-line summary for the activity log"),
      },
      async (args) => {
        const result = await executeTool(ctx, "write_file", args);
        this._filesChanged = this._filesChanged || ctx.filesChanged.value;
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const deleteFileTool = tool(
      "delete_file", "Delete a file from the whiteboard.",
      {
        filename: z.string().describe("The filename to delete"),
        reason: z.string().describe("Why this file is being deleted"),
      },
      async (args) => {
        const result = await executeTool(ctx, "delete_file", args);
        this._filesChanged = this._filesChanged || ctx.filesChanged.value;
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const readCrossCanvasTool = tool(
      "read_cross_canvas", "Read a file from another canvas's whiteboard.",
      {
        canvas: z.string().describe("Canvas name"),
        filename: z.string().describe("Filename to read"),
      },
      async (args) => {
        const result = await executeTool(ctx, "read_cross_canvas", args);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const listCrossCanvasTool = tool(
      "list_cross_canvas", "List files on another canvas's whiteboard.",
      { canvas: z.string().describe("Canvas name") },
      async (args) => {
        const result = await executeTool(ctx, "list_cross_canvas", args);
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    const consultCanvasTool = tool(
      "consult_canvas", "Consult another canvas's agent. Q&A saved as decision record.",
      {
        target_canvas: z.string().describe("Which canvas agent to ask"),
        question: z.string().describe("The question or decision needed"),
        context: z.string().describe("Relevant context"),
      },
      async (args) => {
        const result = await executeTool(ctx, "consult_canvas", args);
        this._filesChanged = this._filesChanged || ctx.filesChanged.value;
        return { content: [{ type: "text" as const, text: result }] };
      }
    );

    return createSdkMcpServer({
      name: "mica-tools",
      tools: [listFilesTool, readFileTool, writeFileTool, deleteFileTool, readCrossCanvasTool, listCrossCanvasTool, consultCanvasTool],
    });
  }
}
