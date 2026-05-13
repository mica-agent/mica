// Lean Qwen-agent channel — runs query() through the SDK with a card-supplied
// system prompt, model, and tool exclusions. NO canvas baseline, NO auto-loaded
// skills, NO project-file scanning — that's the heavy `.chat` handler's role.
// This is the lightweight cousin: a focused tool with one job and a fixed prompt,
// configured entirely from args at openChannel time.

import { join } from "path";
import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { HandlerManifest } from "../handlerManifest.js";
import { WORKSPACE_DIR } from "../files.js";

// SDK is loaded lazily — same pattern as micaAgent.ts, so we don't pay the
// import cost on startup if no llm-agent card is ever opened. Module-level
// promise so concurrent first opens share the same load.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _query: any = null;
async function getQuery() {
  if (!_query) {
    const mod = await import("@qwen-code/sdk");
    _query = (mod as { query: typeof _query }).query;
  }
  return _query!;
}

interface AgentArgs {
  systemPrompt: string;
  model?: string;
  excludeTools?: string[];
  historyKey?: string;
}

interface ChatTurn { role: "user" | "assistant"; content: string }

// History stores keyed by historyKey, lifetime = process lifetime. Cards that
// opt into a shared key see each other's transcript on the next turn. Live
// streaming is still per-session — cross-card live updates are out of scope
// for v1 and need a different primitive.
const sharedHistories = new Map<string, ChatTurn[]>();

export function createLlmAgentHandler() {
  return async function llmAgentFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const cfg: AgentArgs = {
      systemPrompt: typeof args.systemPrompt === "string" ? args.systemPrompt : "",
      model: typeof args.model === "string" ? args.model : undefined,
      excludeTools: Array.isArray(args.excludeTools)
        ? (args.excludeTools as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      historyKey: typeof args.historyKey === "string" ? args.historyKey : undefined,
    };

    if (!cfg.systemPrompt) {
      // Fail loudly at session creation — the handler is useless without a
      // prompt. The error surfaces via the channel-open failure path; the
      // card sees a clear message instead of an agent that refuses to engage.
      throw new Error("llm-agent: args.systemPrompt is required");
    }

    // History — either dedicated per-session, or shared by historyKey.
    let history: ChatTurn[];
    if (cfg.historyKey) {
      const existing = sharedHistories.get(cfg.historyKey);
      if (existing) {
        history = existing;
      } else {
        history = [];
        sharedHistories.set(cfg.historyKey, history);
      }
    } else {
      history = [];
    }

    let activeAbort: AbortController | null = null;

    return {
      onAttach(clientId) {
        ctx.sendTo(clientId, { type: "history", messages: history });
      },

      async onData(_clientId, data) {
        const msg = data as { type?: string; message?: string };

        if (msg.type === "interrupt") {
          if (activeAbort) activeAbort.abort();
          // Broadcast a final `done` so listeners (chat-card UI, voice
          // ambient gate) see the turn end deterministically. Empty
          // content marks it as cancelled.
          ctx.broadcast({ type: "done", content: "" });
          return;
        }

        if (msg.type === "clear") {
          history.length = 0;
          ctx.broadcast({ type: "history", messages: [] });
          return;
        }

        const userMessage = msg.message?.trim();
        if (!userMessage) return;

        // Synthetic clientId from channelMgr.dispatchToFilename — voice
        // dispatched this turn. The eventual `done` broadcast carries
        // viaVoice:true for any future ambient-gate broadening.
        const turnSource: "user" | "voice" = _clientId === "voice-dispatch" ? "voice" : "user";

        history.push({ role: "user", content: userMessage });
        ctx.broadcast({ type: "user", content: userMessage });
        ctx.broadcast({ type: "thinking" });

        activeAbort = new AbortController();
        let assistantText = "";

        try {
          const queryFn = await getQuery();
          // Compose a transcript-shaped prompt so prior turns travel with the
          // current user message. The lean handler doesn't track an SDK-side
          // session id; we rebuild from history on every turn. Trim hard at
          // the front if the transcript grows long — defensive cap; cards
          // that need huge context should use the full `.chat` handler.
          const HISTORY_CAP = 12;
          const recent = history.slice(-HISTORY_CAP - 1, -1);  // exclude current user msg
          const lines: string[] = [];
          for (const m of recent) {
            const role = m.role === "user" ? "USER" : "ASSISTANT";
            lines.push(`${role}: ${m.content}`);
          }
          const prompt = lines.length > 0
            ? `${lines.join("\n\n")}\n\n---\n\nUSER: ${userMessage}`
            : userMessage;

          const projectDir = ctx.project ? join(WORKSPACE_DIR, ctx.project) : WORKSPACE_DIR;
          // SDK-bound: the qwen-code SDK gates image modality off the model
          // name via `/^qwen3-vl-/` regex (see micaAgent.ts ~line 1620 for the
          // full naming convention). Do NOT rename to `qwen-vl` here without
          // first removing the SDK regex constraint.
          const modelName = cfg.model || "qwen3-vl-local";

          const q = queryFn({
            prompt,
            options: {
              cwd: projectDir,
              model: `openai:${modelName}`,
              authType: "openai" as const,
              permissionMode: "yolo" as const,
              systemPrompt: cfg.systemPrompt,
              ...(cfg.excludeTools && cfg.excludeTools.length > 0
                ? { excludeTools: cfg.excludeTools }
                : {}),
              abortController: activeAbort,
            },
          });

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for await (const evt of q as AsyncIterable<any>) {
            if (activeAbort?.signal.aborted) break;

            // The SDK emits assistant blocks with content arrays. We surface
            // tool_use as a structured event so the card can render activity
            // indicators if it wants; text blocks stream as deltas.
            if (evt.type === "assistant" && evt.message?.content) {
              for (const block of evt.message.content) {
                if (block.type === "text" && block.text) {
                  assistantText += block.text;
                  ctx.broadcast({ type: "delta", content: block.text });
                } else if (block.type === "tool_use") {
                  ctx.broadcast({ type: "tool_use", tool: block.name, input: block.input });
                }
              }
            }

            if (evt.type === "result") {
              if ((evt as { is_error?: boolean }).is_error) {
                const e = (evt as { error?: { message?: string } }).error;
                ctx.broadcast({ type: "error", error: e?.message || "Provider error" });
                return;
              }
              const text = (evt.result as { text?: string } | undefined)?.text;
              if (text && !assistantText) assistantText = text;
            }
          }

          if (assistantText) {
            history.push({ role: "assistant", content: assistantText });
          }
          ctx.broadcast({
            type: "done",
            content: assistantText,
            // Source attribution; future-proofs the voice ambient gate
            // if it later listens for done events from this handler.
            source: turnSource,
            viaVoice: turnSource === "voice",
          });

        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            ctx.broadcast({ type: "error", error: (err as Error).message });
          }
        } finally {
          activeAbort = null;
        }
      },

      onDestroy() {
        if (activeAbort) activeAbort.abort();
      },
    };
  };
}

export const manifest: HandlerManifest = {
  name: "llm-agent",
  version: "1.0.0",
  description: "Tool-using agent with a card-supplied system prompt and tool exclusions. Lightweight cousin of the project-wide chat card.",
  whenToUse:
    "Pick this when your card class needs an agent that can read files, run shell commands, and write files — but with a focused system prompt instead of the full project-wide chat baseline. NOT for plain chat (use llm-direct, no tool-loop overhead). NOT for the project-wide agent role with skills + canvas baseline (use the existing chat card). For multi-card collaboration with shared transcript, set the same historyKey on each card; live streaming stays per-card, but history syncs on the next turn.",
  argsSchema: {
    type: "object",
    required: ["systemPrompt"],
    properties: {
      systemPrompt: { type: "string", description: "Required. The full system prompt — defines role, constraints, tool usage style. NOT appended to a Mica preset; this IS the prompt." },
      model: { type: "string", description: "Model id. Default: 'qwen3-vl-local' (the SDK-bound alias for the local Qwen3.6-35B-A3B-NVFP4 vLLM; the `qwen3-vl-` prefix is required by the qwen-code SDK's modality regex)." },
      excludeTools: { type: "array", items: { type: "string" }, description: "Tool names to block. Common values: 'write_file', 'edit', 'run_shell_command', 'agent'. Default: no exclusions (yolo mode)." },
      historyKey: { type: "string", description: "Optional. Shared in-process key — multiple cards passing the same value share transcript history. Live streaming remains per-card; sync happens on the next turn." },
    },
  },
  sendShapes: {
    type: "object",
    description:
      "What the card may send via channel.send(). Three message types: " +
      "{ message: string } for a user turn; " +
      "{ type: 'interrupt' } to abort the in-flight turn; " +
      "{ type: 'clear' } to reset history.",
  },
  recvShapes: {
    type: "object",
    description:
      "What the card receives via channel.onData(). Event types: " +
      "{ type: 'history', messages: [...] } on attach; " +
      "{ type: 'user', content: string } user-turn echo; " +
      "{ type: 'thinking' } before tokens start; " +
      "{ type: 'tool_use', tool: string, input: object } when the agent invokes a tool (card may render an activity indicator); " +
      "{ type: 'delta', content: string } per-text-block streaming; " +
      "{ type: 'done', content: string } turn end; " +
      "{ type: 'error', error: string } on failure.",
  },
  examples:
    "// card.js skeleton\n" +
    "const channel = mica.openChannel('turn', {\n" +
    "  systemPrompt: 'You review code. Use only read_file, glob, and grep_search. Reply in bullet points.',\n" +
    "  excludeTools: ['write_file', 'edit', 'run_shell_command'],\n" +
    "});\n" +
    "channel.onData((evt) => {\n" +
    "  if (evt.type === 'tool_use') showActivity(`reading ${evt.input.file_path}`);\n" +
    "  if (evt.type === 'delta') appendToBubble(evt.content);\n" +
    "  if (evt.type === 'done') finishBubble(evt.content);\n" +
    "  if (evt.type === 'error') showError(evt.error);\n" +
    "});\n" +
    "// channel.send({ message: 'Review src/api/auth.ts' });\n",
};
