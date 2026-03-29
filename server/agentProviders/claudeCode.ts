/**
 * Claude Code Agent Provider
 *
 * Spawns a Claude Code session via the Claude Agent SDK and translates
 * its output into the standard agent channel protocol (plan, step_update,
 * action, blocked, done, error).
 *
 * Reuses the existing chatWithAgent infrastructure from agents.ts
 * but wraps it in the channel-based progress protocol.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
  readCanvasFile,
  listFiles,
  writeCanvasFile,
} from "../canvasFiles.js";
import { getProjectPath } from "../projectConnection.js";
import { createAgentSpawner } from "../dockerSpawn.js";
import { readMicaConfig } from "../projectConnection.js";
import type { SandboxManager } from "../projectSandbox.js";

// Module-level sandbox manager reference
let _sandboxManager: SandboxManager | null = null;
export function setSandboxManager(sm: SandboxManager): void {
  _sandboxManager = sm;
}

// ── Types ──────────────────────────────────────────────────

interface AgentChannel {
  send: (data: unknown) => void;
  onData: (cb: (data: unknown) => void) => void;
  close: () => void;
}

interface SessionState {
  provider: string;
  status: string;
  phase: string;
  plan: Array<{ step: string; status: string }>;
  current_action: string | null;
  blocker: string | null;
  last_updated: string | null;
}

// ── Helper: describe tool use for action display ──────────

function describeToolUse(toolName: string, input?: Record<string, unknown>): string {
  switch (toolName) {
    case "Bash": return `Running: ${(input?.command as string || "").slice(0, 60)}`;
    case "Read": return `Reading ${input?.file_path || "file"}`;
    case "Write": return `Writing ${input?.file_path || "file"}`;
    case "Edit": return `Editing ${input?.file_path || "file"}`;
    case "Glob": return `Searching for ${input?.pattern || "files"}`;
    case "Grep": return `Searching for "${(input?.pattern as string || "").slice(0, 40)}"`;
    default: return `${toolName}`;
  }
}

// ── Helper: save state to the .agent file ─────────────────

async function saveState(
  project: string,
  canvas: string,
  filename: string,
  state: SessionState,
): Promise<void> {
  state.last_updated = new Date().toLocaleTimeString("en-US", { hour12: false });
  await writeCanvasFile(project, canvas, filename, JSON.stringify(state, null, 2));
}

// ── Main: run a Claude Code session ───────────────────────

export async function runClaudeCodeSession(
  project: string,
  canvas: string,
  filename: string,
  task: string,
  sendToClient: (data: unknown) => void,
  receiveFromClient: () => Promise<unknown | null>,
): Promise<void> {
  const state: SessionState = {
    provider: "claude-code",
    status: "in_progress",
    phase: `Planning: ${task.slice(0, 60)}`,
    plan: [],
    current_action: "Analyzing task...",
    blocker: null,
    last_updated: null,
  };

  sendToClient({ type: "status", value: "in_progress" });
  sendToClient({ type: "phase", text: state.phase });
  sendToClient({ type: "action", text: "Analyzing task..." });
  await saveState(project, canvas, filename, state);

  // Build context from canvas files
  const files = await listFiles(project, canvas);
  const fileContext = files
    .filter((f) => !f.name.startsWith(".") && f.name !== filename)
    .map((f) => `### ${f.name}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  // Read brief for agent instructions
  let briefContent = "";
  try {
    const brief = await readCanvasFile(project, canvas, "_brief.brief");
    briefContent = brief.content;
  } catch { /* no brief */ }

  const systemPrompt = `You are an AI coding agent working on a Mica project canvas.

${briefContent ? `## Agent Brief\n${briefContent}\n` : ""}

## Task
${task}

## Instructions
1. First, analyze the task and create a step-by-step plan (3-6 steps).
   Output your plan as a JSON array on a single line prefixed with "PLAN:":
   PLAN: [{"step": "Short description"}, ...]

2. Then execute each step. Before starting each step, output:
   STEP: <step_number>

3. If you absolutely cannot proceed without human input, output:
   BLOCKED: <your question>
   Then wait for the response.

4. When completely done, output:
   DONE

## Current Canvas Files
${fileContext || "(no files yet)"}`;

  // Resolve model
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.model || "claude-sonnet-4-6";

  const options: Record<string, unknown> = {
    systemPrompt,
    tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    maxTurns: 20,
    model,
    settings: { forceLoginMethod: "claudeai" as const },
    settingSources: ["user" as const],
  };

  // Run inside the shared project container
  if (_sandboxManager) {
    const containerName = await _sandboxManager.getContainerName(project);
    options.spawnClaudeCodeProcess = createAgentSpawner(containerName, project, canvas);
  }

  try {
    let currentStep = -1;

    for await (const message of query({
      prompt: task,
      options: options as Options,
    })) {
      const msg = message as Record<string, unknown>;

      // Track tool use for action display
      if (msg.type === "assistant" && msg.message) {
        const assistantMsg = msg.message as { content?: Array<Record<string, unknown>> };
        for (const block of assistantMsg.content || []) {
          if (block.type === "tool_use" && block.name) {
            const actionText = describeToolUse(
              block.name as string,
              block.input as Record<string, unknown>,
            );
            state.current_action = actionText;
            sendToClient({ type: "action", text: actionText });
          }
        }
      }

      // Parse text output for our protocol markers
      if (msg.type === "assistant" && msg.message) {
        const assistantMsg = msg.message as { content?: Array<Record<string, unknown>> };
        for (const block of assistantMsg.content || []) {
          if (block.type === "text" && block.text) {
            const text = block.text as string;

            // Check for PLAN:
            const planMatch = text.match(/PLAN:\s*(\[[\s\S]*?\])/);
            if (planMatch) {
              try {
                const steps = JSON.parse(planMatch[1]) as Array<{ step: string }>;
                state.plan = steps.map((s) => ({ step: s.step, status: "pending" }));
                state.phase = `Implementing: ${task.slice(0, 55)}`;
                sendToClient({ type: "plan", steps: state.plan });
                sendToClient({ type: "phase", text: state.phase });
                await saveState(project, canvas, filename, state);
              } catch { /* parse error, ignore */ }
            }

            // Check for STEP:
            const stepMatch = text.match(/STEP:\s*(\d+)/);
            if (stepMatch) {
              const stepIdx = parseInt(stepMatch[1], 10) - 1;
              if (stepIdx >= 0 && stepIdx < state.plan.length) {
                // Mark previous step done
                if (currentStep >= 0 && currentStep < state.plan.length) {
                  state.plan[currentStep].status = "done";
                  sendToClient({ type: "step_update", index: currentStep, status: "done" });
                }
                currentStep = stepIdx;
                state.plan[stepIdx].status = "active";
                state.current_action = `Step ${stepIdx + 1}: ${state.plan[stepIdx].step}`;
                sendToClient({ type: "step_update", index: stepIdx, status: "active" });
                sendToClient({ type: "action", text: state.current_action });
                await saveState(project, canvas, filename, state);
              }
            }

            // Check for BLOCKED:
            const blockedMatch = text.match(/BLOCKED:\s*(.+)/);
            if (blockedMatch) {
              state.status = "blocked";
              state.blocker = blockedMatch[1].trim();
              state.current_action = null;
              sendToClient({ type: "blocked", question: state.blocker });
              await saveState(project, canvas, filename, state);

              // Wait for human response
              const response = await receiveFromClient();
              if (response === null) return; // channel closed

              const humanResponse = (response as Record<string, unknown>).response as string || "";
              state.status = "in_progress";
              state.blocker = null;
              state.current_action = "Continuing with your input...";
              sendToClient({ type: "unblocked" });
              sendToClient({ type: "action", text: "Continuing with your input..." });
              await saveState(project, canvas, filename, state);
            }

            // Check for DONE
            if (text.includes("DONE")) {
              // Will be handled after the loop
            }
          }
        }
      }
    }

    // Mark remaining steps done
    if (currentStep >= 0 && currentStep < state.plan.length) {
      state.plan[currentStep].status = "done";
      sendToClient({ type: "step_update", index: currentStep, status: "done" });
    }

    state.status = "done";
    state.phase = `✔ Done: ${task.slice(0, 55)}`;
    state.current_action = null;
    sendToClient({ type: "phase", text: state.phase });
    sendToClient({ type: "done" });
    await saveState(project, canvas, filename, state);
  } catch (err) {
    state.status = "error";
    state.phase = "Error";
    state.current_action = (err as Error).message;
    sendToClient({ type: "error", message: (err as Error).message });
    await saveState(project, canvas, filename, state);
  }
}
