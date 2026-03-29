// LocalAgent — agent implementation using llama-server's OpenAI-compatible API.
// Mirrors chatWithAgent() from agents.ts but uses HTTP calls instead of Claude Agent SDK.
// Supports tool calling (list_files, read_file, write_file, delete_file) with a loop.

import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  getAllFilesAsContext,
} from "./canvasFiles.js";
import {
  getAgentIdentity,
  GOAL_INSTRUCTIONS,
  describeToolUse,
  appendToLog,
  getAgentMeta,
  setAgentWriteHook,
} from "./agents.js";
import type { AgentResponse, CanvasId, ProgressCallback } from "./agents.js";
import { readMicaConfig } from "./projectConnection.js";
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

// ── Tool definitions (OpenAI format) ─────────────────────────

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
      description: "Create or update a file on the whiteboard. Use .md for rich content, .mmd for mermaid diagrams, .txt for simple notes.",
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
];

// ── Local tool instructions (no cross-canvas, no Bash) ───────

const LOCAL_TOOL_INSTRUCTIONS = `
You have access to tools for managing files on the shared whiteboard.

## Your Canvas's Whiteboard
- list_files: See what files exist on your whiteboard
- read_file: Read a specific file's content
- write_file: Create or update a file (this is how you create artifacts)
- delete_file: Remove a file

When creating files, use kebab-case names with descriptive titles:
- .md for rich content (personas, briefs, analyses, decisions)
- .mmd for mermaid diagrams (flowcharts, architecture, sequences) — write RAW mermaid syntax, never wrap in \`\`\`mermaid code fences. If a node label contains parentheses, braces, or angle brackets, wrap the label in quotes: A["Label (with parens)"]
- .html for interactive widgets, styled documents, or visual layouts
- .txt for simple notes and lists

## Custom Card Classes
- To create a new card class, first read the docs: \`cat card-classes/CREATING_CARDS.md\`
- Project-specific card classes go in \`.mica/.card-classes/<classname>/render.js\`

CRITICAL RULE: You MUST use the write_file tool to create any content. NEVER paste file content (markdown, mermaid, HTML, etc.) directly in your chat response. If the user asks you to create, generate, or write something, ALWAYS use write_file to save it as a file on the whiteboard. Your chat response should only describe what you did, not contain the file content itself.

ACTIVITY LOG: When you write or delete files, provide a clear summary/reason — this is automatically logged to _log.log so the human can see what you did and why.
`;

// ── Mermaid sanitization ─────────────────────────────────────
// Local models often put parentheses/braces inside node labels without quoting,
// which breaks mermaid parsing. E.g. `G[Video (480p)]` → `G["Video (480p)"]`

function sanitizeMermaid(content: string): string {
  return content.replace(
    /\[([^\]"]*[(){}<>][^\]"]*)\]/g,
    '["$1"]',
  );
}

// ── Parse text-embedded tool calls ───────────────────────────
// Some models fall back to generating tool calls as XML in content instead of
// using the tool_calls array. This parser handles the common format:
//   <tool_call><function=name><parameter=key>value</parameter>...</function></tool_call>

function parseTextToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  // Match <tool_call>...</tool_call> blocks (or <function=...> at top level)
  const toolCallPattern = /<(?:tool_call|function=(\w+))>([\s\S]*?)(?:<\/(?:tool_call|function)>)/gi;
  let match: RegExpExecArray | null;
  let idCounter = 0;

  while ((match = toolCallPattern.exec(text)) !== null) {
    let block = match[2];
    let funcName = match[1] || "";

    // If we matched <tool_call>, look for <function=name> inside
    if (!funcName) {
      const funcMatch = /<function=(\w+)>([\s\S]*?)(?:<\/function>|$)/i.exec(block);
      if (funcMatch) {
        funcName = funcMatch[1];
        block = funcMatch[2];
      }
    }
    if (!funcName) continue;

    // Extract parameters
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

function historyKey(project: string, canvas: string): string {
  return `${project}/${canvas}`;
}

// ── Agent write hook reference ───────────────────────────────
// Set by index.ts via setAgentWriteHook — we call it before writing files
let onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null = null;

/** Register the agent write hook (called from index.ts setup) */
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
        // Strip markdown code fences from .mmd files — models often wrap mermaid in ```mermaid
        if (args.filename.endsWith(".mmd")) {
          content = content.replace(/^```(?:mermaid)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
          content = sanitizeMermaid(content);
        }
        await writeCanvasFile(project, canvas, args.filename, content);
        filesChanged.value = true;
        if (args.filename !== "_log.log") {
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

  const systemPrompt = `${getAgentIdentity(canvas)}
${briefContent}
${LOCAL_TOOL_INSTRUCTIONS}
${GOAL_INSTRUCTIONS}

## Current Whiteboard Files (${canvas} canvas)

${fileContext}`;

  // Get or create conversation history
  const key = historyKey(project, canvas);
  let history = canvasHistories.get(key);
  if (!history) {
    history = [];
    canvasHistories.set(key, history);
  }

  // Update system prompt (always index 0) or insert it
  if (history.length > 0 && history[0].role === "system") {
    history[0] = { role: "system", content: systemPrompt };
  } else {
    history.unshift({ role: "system", content: systemPrompt });
  }

  // Append user message
  history.push({ role: "user", content: userMessage });

  // Trim history if too long (keep system + last 20 messages)
  if (history.length > 22) {
    const system = history[0];
    history = [system, ...history.slice(-20)];
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
          model: "nemotron-nano-30b",
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
      // If it's a parse error (likely from broken tool call in history), try to recover
      if (errMsg.includes("parse") && history.length > 2) {
        const lastMsg = history[history.length - 1];
        if (lastMsg.role === "assistant" && lastMsg.tool_calls) {
          console.warn("[local-agent] Removing broken assistant message and retrying");
          history.pop();
          history.push({ role: "assistant", content: "Let me try a different approach." });
          continue;
        }
      }
      resultText = `I encountered an error communicating with the local model. Please try again.`;
      break;
    }

    const choice = data.choices?.[0];
    if (!choice) {
      resultText = "No response from local model.";
      break;
    }

    const assistantMsg = choice.message;

    // Detect truncation — if finish_reason is "length", the response was cut off.
    // Tool call JSON may be incomplete, so discard tool_calls and ask model to summarize.
    if (choice.finish_reason === "length" && assistantMsg.tool_calls?.length) {
      console.warn("[local-agent] Response truncated mid-tool-call, discarding broken tool calls");
      // Keep any partial text content, drop broken tool calls
      history.push({
        role: "assistant",
        content: assistantMsg.content || "I was trying to use a tool but my response was truncated. Let me try a shorter approach.",
      });
      // Continue loop — model will try again (hopefully without hitting the limit)
      continue;
    }

    // If no tool calls in the API response, check if the model embedded them as text
    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const textToolCalls = parseTextToolCalls(assistantMsg.content || "");
      if (textToolCalls.length > 0) {
        // Model fell back to text-based tool calls — execute them
        console.warn(`[local-agent] Parsed ${textToolCalls.length} text-embedded tool call(s)`);
        assistantMsg.tool_calls = textToolCalls;
        // Strip the XML from content for cleaner history
        assistantMsg.content = (assistantMsg.content || "").replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim() || null;
      } else {
        // No tool calls — we're done
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

      // Append tool result to history
      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // If this was the last turn, let the model respond without tools
    if (turn === maxTurns - 1) {
      try {
        const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "nemotron-nano-30b",
            messages: history,
            temperature: 0.7,
            max_tokens: 8192,
            // No tools — force a text response
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

  // Fallback for empty responses — don't send blank messages to the UI
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
