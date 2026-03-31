// LocalProvider — OpenAI-compatible HTTP API provider (llama-server, ollama, etc).
// Uses the shared agentCore layer for tools, prompts, and config.
// Transport: HTTP POST to /v1/chat/completions endpoint.

import type { AgentProvider } from "../agentCore/provider.js";
import type { AgentResponse, CanvasId, ProgressCallback } from "../agentCore/types.js";
import { buildSystemPrompt } from "../agentCore/systemPrompt.js";
import { resolveModel } from "../agentCore/config.js";
import { describeToolUse } from "../agentCore/logging.js";
import { executeTool, type ToolContext } from "../agentCore/toolLogic.js";
import { MICA_TOOLS, toOpenAITools } from "../agentCore/toolSchema.js";
import { ensureLlamaServer } from "../llamaServer.js";

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

// ── Text-embedded tool call parser ───────────────────────────
// Fallback for models that embed tool calls as XML in content.

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

// ── Provider implementation ──────────────────────────────────

const MAX_TURNS = 5;
const MAX_HISTORY_MESSAGES = 20;
const OPENAI_TOOLS = toOpenAITools(MICA_TOOLS);

export class LocalProvider implements AgentProvider {
  readonly name = "local";
  readonly defaultModel = "nemotron-nano-30b";

  private onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null = null;
  private histories = new Map<string, OpenAIMessage[]>();

  setWriteHook(hook: (project: string, canvas: string, filename: string) => void): void {
    this.onAgentWrite = hook;
  }

  resetCanvas(project: string, canvas: string): void {
    this.histories.delete(`${project}/${canvas}`);
  }

  resetAll(): void {
    this.histories.clear();
  }

  async chat(
    project: string,
    canvas: CanvasId,
    message: string,
    _image?: string,
    onProgress?: ProgressCallback,
  ): Promise<AgentResponse> {
    const filesChanged = { value: false };
    const baseUrl = await ensureLlamaServer();
    const systemPrompt = await buildSystemPrompt(project, canvas);
    const model = await resolveModel(project, canvas, this.defaultModel);

    const ctx: ToolContext = {
      project,
      canvas,
      onAgentWrite: this.onAgentWrite,
      filesChanged,
    };

    // Get or create conversation history
    const key = `${project}/${canvas}`;
    let history = this.histories.get(key);
    if (!history) {
      history = [];
      this.histories.set(key, history);
    }

    // Update system prompt (always index 0)
    if (history.length > 0 && history[0].role === "system") {
      history[0] = { role: "system", content: systemPrompt };
    } else {
      history.unshift({ role: "system", content: systemPrompt });
    }

    history.push({ role: "user", content: message });

    // Trim history
    if (history.length > MAX_HISTORY_MESSAGES + 2) {
      const system = history[0];
      history = [system, ...history.slice(-MAX_HISTORY_MESSAGES)];
      this.histories.set(key, history);
    }

    onProgress?.({ type: "thinking", description: "Thinking..." });

    let resultText = "";

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let data: ChatCompletionResponse;
      try {
        const res = await fetch(`${baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: history,
            tools: OPENAI_TOOLS,
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

      // Detect truncation
      if (choice.finish_reason === "length" && assistantMsg.tool_calls?.length) {
        console.warn("[local-agent] Response truncated mid-tool-call");
        history.push({
          role: "assistant",
          content: assistantMsg.content || "My response was truncated. Let me try a shorter approach.",
        });
        continue;
      }

      // Check for text-embedded XML tool calls
      if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
        const textToolCalls = parseTextToolCalls(assistantMsg.content || "");
        if (textToolCalls.length > 0) {
          console.warn(`[local-agent] Parsed ${textToolCalls.length} text-embedded tool call(s)`);
          assistantMsg.tool_calls = textToolCalls;
          assistantMsg.content = (assistantMsg.content || "").replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "").trim() || null;
        } else {
          history.push({ role: "assistant", content: assistantMsg.content });
          resultText = assistantMsg.content || "";
          break;
        }
      }

      history.push({
        role: "assistant",
        content: assistantMsg.content,
        tool_calls: assistantMsg.tool_calls,
      });

      // Execute tool calls
      for (const toolCall of assistantMsg.tool_calls) {
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;

        let parsedArgs: Record<string, unknown> | undefined;
        try { parsedArgs = JSON.parse(toolArgs); } catch { /* */ }
        onProgress?.({ type: "tool_start", tool: toolName, description: describeToolUse(toolName, parsedArgs) });

        console.log(`[local-agent] Tool call: ${toolName}(${toolArgs.slice(0, 100)})`);

        const result = await executeTool(ctx, toolName, parsedArgs || {});

        history.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // On last turn, force text response (no tools)
      if (turn === MAX_TURNS - 1) {
        try {
          const finalRes = await fetch(`${baseUrl}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, messages: history, temperature: 0.7, max_tokens: 8192 }),
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
}
