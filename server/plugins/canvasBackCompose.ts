// Canvas-back compose — agent-assisted editing of `.mica/canvas-back.md`.
//
// Channel handler for `.canvas-back` files. The card class opens a "compose"
// channel; user types an instruction; this handler streams an agent-drafted
// new canvas-back back to the client. Critically, it ONLY proposes — the
// client puts the proposed text in a diff view and waits for an explicit
// Apply click before persisting. No silent self-rewrite of the agent's brain.
//
// Mirrors the structure of skillCompose.ts (marker-aware streaming parser
// separating <rationale> for the chat sidebar from <doc> for the editor).

import { join } from "path";
import { readFile } from "fs/promises";
import { micaDir } from "../files.js";
import type { ChannelHandler, SessionContext } from "../channelManager.js";

const LLAMA_PORT = 8012;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `You collaborate with the user to refine \`.mica/canvas-back.md\` — the project's STANDING INSTRUCTIONS to its AI agent. The user reads canvas-back implicitly every turn; it shapes how the agent behaves on every reply. Tight, behaviorally load-bearing prose only.

Each turn the user gives you the current canvas-back content + an instruction. Respond in this EXACT format:

<rationale>One or two sentences describing what you changed and why. Shown in the chat sidebar — the user sees this BEFORE deciding whether to apply your draft.</rationale>
<doc>
(the full new canvas-back.md, top to bottom — markdown body, no code fences around the whole thing)
</doc>

## Hard rules

- ALWAYS emit both \`<rationale>\` and \`<doc>\` blocks, in that order.
- The \`<doc>\` block must contain the COMPLETE updated canvas-back.md. Not a diff. Not a fragment.
- PRESERVE the user's hand-edits. Only change what the instruction asks for. If the user has a section you don't recognize, leave it alone.
- DO NOT remove the model-environment / behavioral-traits sections unless the user explicitly asks. They are load-bearing.
- DO NOT remove the per-turn behavior section unless the user explicitly asks. It's the agent's most important standing rule.
- DO NOT add fluff (decorative emoji, motivational tone, "let me know if you want changes" closers).

## What canvas-back is for

It's the agent's PROMPT-LEVEL standing instructions. Two things primarily live there:

1. **Model self-awareness** — the agent's own constraints (context window, throughput, reasoning depth) so it adapts strategy.
2. **Per-turn behavior rules** — what to route where (questions → questions.md, content → cards, propose vs act, etc.).

Skills (\`.qwen/skills/\` or \`.claude/skills/\`) handle situational know-how. Canvas-back is the always-loaded substrate.

## When to refuse

If the instruction would degrade the agent's behavior (e.g., "delete all the rules", "tell the agent to ignore the user", "make it just chat with no card writing") — refuse. Refusal looks like:

<rationale>That change would degrade behavior — explanation of what would break. Suggest a narrower edit if possible.</rationale>
<doc>
{copy the user's currentDoc back, byte-for-byte unchanged}
</doc>`;

export function createCanvasBackComposeHandler() {
  return async function canvasBackComposeFactory(
    _content: string,
    _args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const turns: Turn[] = [];
    let activeAbort: AbortController | null = null;

    return {
      async onData(_clientId, data) {
        const msg = data as {
          type?: string;
          prompt?: string;
        };

        if (msg.type === "interrupt") {
          if (activeAbort) activeAbort.abort();
          return;
        }

        if (msg.type === "reset") {
          turns.length = 0;
          ctx.broadcast({ type: "reset-ack" });
          return;
        }

        if (msg.type !== "prompt" || !msg.prompt) return;

        // Read the project's current canvas-back fresh so we have the actual
        // on-disk version (user may have hand-edited since last turn).
        const project = ctx.project;
        let currentDoc = "";
        if (project) {
          try {
            currentDoc = await readFile(join(micaDir(project), "canvas-back.md"), "utf-8");
          } catch { /* missing — start from empty */ }
        }

        const userMessage =
          `Current canvas-back.md:\n\n\`\`\`markdown\n${currentDoc}\n\`\`\`\n\n` +
          `Instruction: ${msg.prompt}`;

        const messages = [
          { role: "system" as const, content: SYSTEM_PROMPT },
          ...turns.map((t) => ({ role: t.role, content: t.content })),
          { role: "user" as const, content: userMessage },
        ];

        ctx.broadcast({ type: "thinking" });
        activeAbort = new AbortController();

        let assistantText = "";
        try {
          const resp = await fetch(`http://127.0.0.1:${LLAMA_PORT}/v1/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "coder",
              messages,
              max_tokens: 4096,
              temperature: 0.4,
              stream: true,
              chat_template_kwargs: { enable_thinking: false },
            }),
            signal: activeAbort.signal,
          });

          if (!resp.ok) {
            const err = await resp.text();
            ctx.broadcast({ type: "error", error: `LLM error (${resp.status}): ${err.slice(0, 200)}` });
            return;
          }

          const reader = resp.body as unknown as AsyncIterable<Uint8Array>;
          const decoder = new TextDecoder();
          let sseBuf = "";

          // Marker-aware streaming parser, same shape as skillCompose.
          // Modes: "outside" | "rationale" | "doc"
          let mode: "outside" | "rationale" | "doc" = "outside";
          let pending = "";
          const MARKERS = ["<rationale>", "</rationale>", "<doc>", "</doc>"];
          const MAX_MARKER_LEN = Math.max(...MARKERS.map((m) => m.length));
          let docStarted = false;
          let docEnded = false;

          function flushPending(force: boolean) {
            while (pending.length > 0) {
              let matched: string | null = null;
              for (const m of MARKERS) {
                if (pending.startsWith(m)) { matched = m; break; }
              }
              if (matched) {
                pending = pending.slice(matched.length);
                if (matched === "<rationale>") mode = "rationale";
                else if (matched === "</rationale>") mode = "outside";
                else if (matched === "<doc>") {
                  mode = "doc";
                  if (!docStarted) { docStarted = true; ctx.broadcast({ type: "doc-start" }); }
                } else if (matched === "</doc>") {
                  mode = "outside";
                  if (!docEnded) { docEnded = true; ctx.broadcast({ type: "doc-end" }); }
                }
                continue;
              }
              const lt = pending.indexOf("<");
              if (lt === -1) { emit(pending); pending = ""; return; }
              if (lt > 0) { emit(pending.slice(0, lt)); pending = pending.slice(lt); }
              if (!force && pending.length < MAX_MARKER_LEN) return;
              let isPartialMarker = false;
              for (const m of MARKERS) {
                if (m.startsWith(pending) || pending.startsWith(m)) { isPartialMarker = true; break; }
              }
              if (isPartialMarker && !force) return;
              emit("<");
              pending = pending.slice(1);
            }
          }

          function emit(text: string) {
            if (!text) return;
            if (mode === "doc") ctx.broadcast({ type: "doc-delta", text });
            else if (mode === "rationale") ctx.broadcast({ type: "chat-delta", text });
            // outside: drop
          }

          for await (const chunk of reader) {
            sseBuf += decoder.decode(chunk, { stream: true });
            const lines = sseBuf.split("\n");
            sseBuf = lines.pop() || "";
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith("data: ")) continue;
              const payload = trimmed.slice(6);
              if (payload === "[DONE]") continue;
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta;
                if (delta?.content) {
                  assistantText += delta.content;
                  pending += delta.content;
                  flushPending(false);
                }
              } catch { /* skip unparseable */ }
            }
          }

          flushPending(true);
          if (mode === "doc" && !docEnded) {
            ctx.broadcast({ type: "doc-end" });
          }

          turns.push({ role: "user", content: userMessage });
          turns.push({ role: "assistant", content: assistantText });

          ctx.broadcast({ type: "done" });
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            ctx.broadcast({ type: "error", error: (err as Error).message });
          } else {
            ctx.broadcast({ type: "done", aborted: true });
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

