// LocalAgent — agent implementation using any OpenAI-compatible API (llama-server, ollama, etc).
// Mirrors chatWithAgent() from agents.ts: same tools, same system prompt structure, same
// progress events. Uses HTTP calls to an OpenAI-compatible endpoint instead of Claude Agent SDK.

import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  getAllFilesAsContext,
} from "./canvasFiles.js";
import { describeToolUse, appendToLog } from "./agentCore/logging.js";
import { getAgentIdentity, TOOL_INSTRUCTIONS, GOAL_INSTRUCTIONS } from "./agentCore/systemPrompt.js";
import type { AgentResponse, CanvasId, ProgressCallback } from "./agentCore/types.js";
import { readMicaConfig, getProjectPath } from "./projectConnection.js";
import { ensureLlamaServer } from "./llamaServer.js";

// ── Types ────────────────────────────────────────────────────

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatCompletionResponse {
  choices: Array<{
    message: {
      role: "assistant";
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
}

// ── Tool definitions (OpenAI function-calling format) ────────
// Same tools as the Claude agent's MCP server, translated to OpenAI format.

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_files",
      description: "List all files on the current canvas's whiteboard. Returns filename, type, and last modified date for each file.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a specific file's content from the whiteboard.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The filename to read (e.g., product-brief.md)" },
        },
        required: ["filename"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description: "Create or update a file on the whiteboard. Use .md for rich content, .mmd for mermaid diagrams, .html for interactive widgets, .txt for simple notes.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "Filename with extension (e.g., user-persona.md, system-flow.mmd)" },
          content: { type: "string", description: "The file content" },
          summary: { type: "string", description: "One-line summary of what you did and why (for the activity log)" },
        },
        required: ["filename", "content", "summary"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_file",
      description: "Delete a file from the whiteboard.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "The filename to delete" },
          reason: { type: "string", description: "Why this file is being deleted (for the activity log)" },
        },
        required: ["filename", "reason"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_cross_canvas",
      description: "List files on another canvas's whiteboard.",
      parameters: {
        type: "object",
        properties: {
          canvas: { type: "string", description: "Canvas name to list files from" },
        },
        required: ["canvas"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_cross_canvas",
      description: "Read a file from another canvas's whiteboard.",
      parameters: {
        type: "object",
        properties: {
          canvas: { type: "string", description: "Canvas name" },
          filename: { type: "string", description: "Filename to read" },
        },
        required: ["canvas", "filename"],
      },
    },
  },
];

// ── Mermaid sanitization ─────────────────────────────────────
// Local models often produce node labels with unquoted special chars.
// E.g. `G[Video (480p)]` → `G["Video (480p)"]`

function sanitizeMermaid(content: string): string {
  return content.replace(
    /\[([^\]"]*[(){}<>][^\]"]*)\]/g,
    '["$1"]',
  );
}

// ── Parse text-embedded tool calls ───────────────────────────
// Fallback for models that embed tool calls as XML in content instead of
// using the tool_calls array:
//   <tool_call><function=name><parameter=key>value</parameter>...</function></tool_call>

function parseTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const toolCallPattern = /<(?:tool_call|function=(\w+))>([\s\S]*?)(?:<\/(?:tool_call|function)>)/gi;
  let match: RegExpExecArray | null;
  let idCounter = 0;

  while ((match = toolCallPattern.exec(text)) !== null) {
    let block = match[2];
    let funcName = match[1] || "";

    if (!funcName) {
      const funcMatch = /<function=(\w+)>([\s\S]*?)(?:<\/function>|$)/i.exec(block);
      if (funcMatch) {
        funcName = funcMatch[1];
        block = funcMatch[2];
      }
    }
    if (!funcName) continue;

    const args: Record<string, string> = {};
    const paramPattern = /<parameter=(\w+)>\n?([\s\S]*?)\n?<\/parameter>/gi;
    let pMatch: RegExpExecArray | null;
    while ((pMatch = paramPattern.exec(block)) !== null) {
      args[pMatch[1]] = pMatch[2];
    }

    calls.push({
      id: `text-tc-${idCounter++}`,
      type: "function",
      function: { name: funcName, arguments: JSON.stringify(args) },
    });
  }

  return calls;
}

// ── Conversation memory per canvas ───────────────────────────

const canvasHistories = new Map<string, OpenAIMessage[]>();
const MAX_HISTORY_MESSAGES = 20;

function historyKey(project: string, canvas: string): string {
  return `${project}/${canvas}`;
}

// ── Agent write hook reference ───────────────────────────────
let onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null = null;

export function setLocalAgentWriteHook(hook: (project: string, canvas: string, filename: string) => void): void {
  onAgentWrite = hook;
}

// ── Tool executor ────────────────────────────────────────────

async function executeTool(
  project: string,
  canvas: string,
  name: string,
  argsJson: string,
  filesChanged: { value: boolean },
): Promise<string> {
  let args: Record<string, string>;
  try {
    args = JSON.parse(argsJson);
  } catch {
    return `Error: Invalid JSON arguments: ${argsJson.slice(0, 200)}`;
  }

  try {
    switch (name) {
      case "list_files": {
        const files = await listFiles(project, canvas);
        const listing = files
          .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
          .join("\n");
        return listing || "(No files yet)";
      }

      case "read_file": {
        const file = await readCanvasFile(project, canvas, args.filename);
        return file.content;
      }

      case "write_file": {
        onAgentWrite?.(project, canvas, args.filename);
        let content = args.content;
        // Handle .card-classes/ routing (same as Claude agent)
        if (args.filename.startsWith(".card-classes/")) {
          const projectPath = await getProjectPath(project);
          const fs = await import("fs");
          const path = await import("path");
          const fullPath = path.join(projectPath, ".mica", args.filename);
          await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
          await fs.promises.writeFile(fullPath, content, "utf-8");
          filesChanged.value = true;
          return `Card class file "${args.filename}" written.`;
        }
        // Strip markdown fences from .mmd files and sanitize
        if (args.filename.endsWith(".mmd")) {
          content = content.replace(/^```(?:mermaid)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
          content = sanitizeMermaid(content);
        }
        await writeCanvasFile(project, canvas, args.filename, content);
        filesChanged.value = true;
        if (args.filename !== "log.md") {
          await appendToLog(project, canvas, `Updated **${args.filename}**: ${args.summary || "(no summary)"}`);
        }
        return `File "${args.filename}" written to whiteboard.`;
      }

      case "delete_file": {
        onAgentWrite?.(project, canvas, args.filename);
        await deleteCanvasFile(project, canvas, args.filename);
        filesChanged.value = true;
        await appendToLog(project, canvas, `Deleted **${args.filename}**: ${args.reason || "(no reason)"}`);
        return `File "${args.filename}" deleted.`;
      }

      case "list_cross_canvas": {
        const files = await listFiles(project, args.canvas);
        const listing = files
          .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
          .join("\n");
        return `[${args.canvas} canvas files]\n${listing || "(No files)"}`;
      }

      case "read_cross_canvas": {
        const file = await readCanvasFile(project, args.canvas, args.filename);
        return `[From ${args.canvas} canvas — ${args.filename}]\n\n${file.content}`;
      }

      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ── Main agent function ──────────────────────────────────────

export async function chatWithLocalAgent(
  project: string,
  canvas: CanvasId,
  userMessage: string,
  _imageBase64?: string,
  onProgress?: ProgressCallback,
): Promise<AgentResponse> {
  const maxTurns = 5;
  const filesChanged = { value: false };

  // Ensure llama-server is running
  const baseUrl = await ensureLlamaServer();

  // Build system prompt (refreshed each call for up-to-date file context)
  const fileContext = await getAllFilesAsContext(project, canvas);

  let briefContent = "";
  try {
    const brief = await readCanvasFile(project, canvas, "_brief.brief");
    briefContent = `\n## Canvas Brief (from _brief.brief)\n\n${brief.content}\n`;
  } catch {
    // No _brief.brief yet
  }

  // Use the same TOOL_INSTRUCTIONS as the Claude agent for consistency
  const systemPrompt = `${getAgentIdentity(canvas)}
${briefContent}
${TOOL_INSTRUCTIONS}
${GOAL_INSTRUCTIONS}

## Current Whiteboard Files (${canvas} canvas)

${fileContext}`;

  // Resolve model: per-agent config > project default > fallback
  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[canvas]?.model
    || micaConfig?.model
    || "nemotron-nano-30b";

  // Get or create conversation history
  const key = historyKey(project, canvas);
  let history = canvasHistories.get(key);
  if (!history) {
    history = [];
    canvasHistories.set(key, history);
  }

  // Update system prompt (always index 0)
  if (history.length > 0 && history[0].role === "system") {
    history[0] = { role: "system", content: systemPrompt };
  } else {
    history.unshift({ role: "system", content: systemPrompt });
  }

  // Append user message
  history.push({ role: "user", content: userMessage });

  // Trim history if too long (keep system + last N messages)
  if (history.length > MAX_HISTORY_MESSAGES + 2) {
    const system = history[0];
    history = [system, ...history.slice(-(MAX_HISTORY_MESSAGES))];
    canvasHistories.set(key, history);
  }

  onProgress?.({ type: "thinking", description: "Thinking..." });

  let resultText = "";

  // Tool use loop
  for (let turn = 0; turn < maxTurns; turn++) {
    let data: ChatCompletionResponse;
    try {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: history,
          tools: TOOLS,
          tool_choice: "auto",
          temperature: 0.7,
          max_tokens: 8192,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`llama-server returned ${res.status}: ${errText.slice(0, 200)}`);
      }

      data = await res.json() as ChatCompletionResponse;
    } catch (err) {
      const errMsg = (err as Error).message;
      console.error("[local-agent] API call failed:", errMsg);
      // If history has a broken assistant message with tool_calls, recover
      if (errMsg.includes("parse") && history.length > 2) {
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.tool_calls) {
          console.warn("[local-agent] Removing broken assistant message and retrying");
          history.pop();
          history.push({ role: "assistant", content: "Let me try a different approach." });
          continue;
        }
      }
      resultText = "I encountered an error communicating with the local model. Please try again.";
      break;
    }

    const choice = data.choices?.[0];
    if (!choice) {
      resultText = "No response from local model.";
      break;
    }

    const assistantMsg = choice.message;

    // Detect truncation — if finish_reason is "length", tool call JSON may be incomplete
    if (choice.finish_reason === "length" && assistantMsg.tool_calls?.length) {
      console.warn("[local-agent] Response truncated mid-tool-call, discarding broken tool calls");
      history.push({
        role: "assistant",
        content: assistantMsg.content || "I was trying to use a tool but my response was truncated. Let me try a shorter approach.",
      });
      continue;
    }

    // If no tool calls in the API response, check for text-embedded XML tool calls
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const textToolCalls = parseTextToolCalls(assistantMsg.content || "");
      if (textToolCalls.length > 0) {
        console.warn(`[local-agent] Parsed ${textToolCalls.length} text-embedded tool call(s)`);
        assistantMsg.tool_calls = textToolCalls;
        assistantMsg.content = (assistantMsg.content || "").replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim() || null;
      } else {
        // No tool calls — done
        history.push({ role: "assistant", content: assistantMsg.content });
        resultText = assistantMsg.content || "";
        break;
      }
    }

    // Append assistant message to history
    history.push({
      role: "assistant",
      content: assistantMsg.content,
      tool_calls: assistantMsg.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of assistantMsg.tool_calls) {
      const toolName = toolCall.function.name;
      const toolArgs = toolCall.function.arguments;

      // Emit progress
      let parsedArgs: Record<string, unknown> | undefined;
      try { parsedArgs = JSON.parse(toolArgs); } catch { /* */ }
      const detail = describeToolUse(toolName, parsedArgs);
      onProgress?.({ type: "tool_start", tool: toolName, description: detail });

      console.log(`[local-agent] Tool call: ${toolName}(${toolArgs.slice(0, 100)})`);

      const result = await executeTool(project, canvas, toolName, toolArgs, filesChanged);

      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // If this was the last turn, force a text response (no tools)
    if (turn === maxTurns - 1) {
      try {
        const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: history,
            temperature: 0.7,
            max_tokens: 8192,
          }),
        });
        if (finalRes.ok) {
          const finalData = await finalRes.json() as ChatCompletionResponse;
          const finalMsg = finalData.choices?.[0]?.message;
          if (finalMsg?.content) {
            resultText = finalMsg.content;
            history.push({ role: "assistant", content: resultText });
          }
        }
      } catch {
        resultText = "Reached maximum tool iterations.";
      }
    }
  }

  if (!resultText.trim()) {
    resultText = "I wasn't able to generate a response. Please try again.";
  }

  return {
    canvas,
    message: resultText,
    consultation: null,
    filesChanged: filesChanged.value,
    cost: 0,
  };
}

export function resetLocalCanvas(project: string, canvas: string): void {
  canvasHistories.delete(historyKey(project, canvas));
}

export function resetAllLocal(): void {
  canvasHistories.clear();
}
