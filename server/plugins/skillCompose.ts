// Skill compose — collaborative SKILL.md authoring channel.
// Streams from llama-server (8012) and routes tokens to either the chat
// sidebar or the markdown editor based on <doc>...</doc> markers.

import { readFileSync } from "fs";
import { join } from "path";
import type { ChannelHandler, SessionContext } from "../channelManager.js";

const LLAMA_PORT = 8012;

interface Turn {
  role: "user" | "assistant";
  content: string;
}

// Load a real SKILL.md exemplar at module init so the system prompt can show
// "what good looks like in this project" without per-turn file I/O. Truncate
// to ~55 lines — enough to demonstrate frontmatter + structure + concrete
// references without ballooning the prompt.
function loadExemplar(): string {
  try {
    const path = join(process.cwd(), "skills/coding/create-card-class/SKILL.md");
    const full = readFileSync(path, "utf-8");
    const lines = full.split("\n").slice(0, 55);
    return lines.join("\n").trim();
  } catch {
    return "(no exemplar available)";
  }
}

const EXEMPLAR = loadExemplar();

const SYSTEM_PROMPT = `You collaborate with the user to author a SKILL.md — a small, project-specific instruction file the local Qwen-Coder agent reads at runtime to know how to do something well in THIS codebase. The agent already knows general software engineering. A skill encodes what is specific, surprising, or load-bearing here.

Each turn, the user gives you the current document (which they may have hand-edited) plus an instruction. You respond in this exact format:

<rationale>One or two sentences describing what you changed and why.</rationale>
<doc>
(the full new SKILL.md, top to bottom)
</doc>

## SKILL.md format

The document MUST begin with YAML frontmatter:

---
name: <kebab-case, specific to one task — NOT a category name like "coding" or "general">
description: <one sentence containing the trigger words a user would naturally use when asking for this. The Qwen agent reads this string to decide whether to load the skill at all — so it must include verbs and nouns the user would actually type.>
---

After the frontmatter, write a short markdown body. Target 400–1500 bytes total.

## ✅ GOOD — what works in this codebase

\`\`\`
${EXEMPLAR}
\`\`\`

Notice: frontmatter with concrete trigger words; specific files and APIs named (\`card.html\`, \`metadata.json\`, \`mica.getContent()\`); real code shown; executable instructions, not advice.

## ❌ BAD — never write skills like this

\`\`\`
---
name: decompose-system
description: Decompose a complex system, task, or feature into subsystems, design each component, implement and test individually, then integrate into a complete working solution.
---

# Decompose a System

When asked to build, implement, or solve a complex problem, follow this workflow:

1. **Analyze Canvas Context**
   - Review all files, cards, and requirements on the canvas
   - Identify core responsibilities, data flows, and dependencies

2. **Design the System Architecture**
   - Define subsystem boundaries (e.g., \`auth\`, \`data\`, \`ui\`, \`api\`)
   - Document interfaces between subsystems (inputs/outputs, events)
   - Record decisions in \`system-design.md\` at project root

3. **Implement Subsystems**
   For each subsystem:
   - Create directory under \`src/{subsystem}/\`
   - Design → Code → Test → Fix (iterate locally)
   - Use \`test/\` for unit/integration tests
\`\`\`

Why that example is BAD — every line breaks a rule:
- \`Decompose a complex system... into subsystems\` → generic textbook methodology, not specific to anything.
- \`auth\`, \`data\`, \`ui\`, \`api\` subsystems → imported from generic web app vocabulary; this codebase has none of those.
- \`src/{subsystem}/\`, \`system-design.md\`, \`test/integration.test.js\` → invented paths that do not exist in this codebase.
- \`Design → Code → Test → Fix\` → describes what the agent already does. Encodes nothing new.
- \`Identify core responsibilities, data flows, and dependencies\` → abstract advice with no concrete action.

NEVER produce text that resembles the BAD example. If a request would lead there, refuse (see Rules below).

## Forbidden patterns

- No generic methodology ("analyze → design → code → test → integrate", "decompose into subsystems", "iterate locally"). A skill should encode something the agent would NOT otherwise do.
- No invented file paths, function names, or directories. \`src/\`, \`auth/\`, \`api/\`, \`system-design.md\`, generic example trees — all forbidden.
- No name that collides with its category. A skill in \`coding/\` cannot be named \`coding\`.
- No abstract advice ("write clean code", "use appropriate abstractions", "identify dependencies"). Every step must be a concrete action.
- No "## Description" / "## When to use" / "## How to apply" headings. The frontmatter \`description:\` replaces them — the body holds instructions.
- No closing summary, no decorative emoji, no blockquote tips. Tight prose only.

## Architectural alignment (load-bearing)

Before composing or revising a skill, orient yourself against the two
places in this repo that define how Mica works. The skill's rules
must not contradict them.

- **Architectural tenets.** SPEC.md's "Consequences" section and
  CLAUDE.md's "How we build" nine-point list. These are the tenets:
  files are files; \`mica.*\` is pipes, not policy; AI generates the
  UI; two sides of a card; designed for AI authorship (architecture
  serves the generator, not human aesthetic preference); plain files
  over databases; lifecycle bound to user intent, not transport
  state. If a skill rule contradicts one of these, fix the skill.
- **\`mica.*\` API reference.** The authoritative section in
  ARCHITECTURE.md. Every \`mica.*\` method or event name a skill
  mentions must match what ARCHITECTURE.md documents. If the skill
  and ARCHITECTURE.md disagree, ARCHITECTURE.md wins and the skill
  gets corrected.

After you produce the new <doc>, run this check:

1. Does any statement in the skill contradict a tenet? If so, fix
   the skill. (If the tenet is wrong, that's a bigger conversation
   than a skill edit — flag it in your <rationale> and do not
   silently drift.)
2. Does any API reference in the skill contradict ARCHITECTURE.md's
   API section? If so, fix the skill.
3. Does any rule the skill encodes make AI generation harder
   rather than easier? The "designed for AI authorship" tenet is
   the constraint. A skill is allowed to carry rules that are hard
   for humans to remember — that is what skills are for. It is not
   allowed to carry rules that only make sense if a human is
   writing the code.

Duplication is fine. A skill that repeats something already in
ARCHITECTURE.md is doing its job — skills exist because models miss
context, and repetition is how a skill compensates. Contradiction is
not fine.

## Hygiene tenets (also from CLAUDE.md)

These are general coding tenets the Qwen agent should also follow.
A good SKILL.md often encodes one or more of these for a specific
recipe:

- Don't add abstractions beyond what the task requires.
- Don't add error handling for unreachable cases.
- Read existing code before writing new code.
- Test runtime behavior, not just type-check.
- Commit messages: short, focused on *why*.

## Rules

- ALWAYS emit both <rationale> and <doc> blocks, in that order.
- The <doc> block must contain the COMPLETE updated SKILL.md, not a diff.
- Preserve the user's hand-edits; only change what the instruction asks for.
- Markdown only inside <doc>. No backticks around the whole document.
### REFUSAL grammar (load-bearing)

If the request is vague (e.g. "draft a coding skill", "decompose tasks", "general workflow") OR would force you to invent paths/files/functions you do not know exist, you MUST refuse. Refusal looks like this:

<rationale>This request is too vague — I'd have to invent paths and write generic methodology. What specific recipe do you want? For example: "skill for adding a new server channel", "skill for wiring a new card class instance".</rationale>
<doc>
{copy the user's currentDoc back, byte-for-byte unchanged}
</doc>

Refusal is REQUIRED — do not try to fill the void with generic content. Generic methodology is worse than no skill at all because it crowds out specific skills the agent might otherwise discover.`;

export function createSkillComposeHandler() {
  return async function skillComposeFactory(
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
          currentDoc?: string;
          name?: string;
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

        const userInstruction = msg.prompt;
        const currentDoc = msg.currentDoc || "";
        const skillName = msg.name || "skill";

        const userMessage =
          `Skill being authored: \`${skillName}\`\n\n` +
          `Current SKILL.md:\n\n\`\`\`markdown\n${currentDoc}\n\`\`\`\n\n` +
          `Instruction: ${userInstruction}`;

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
              // Skill compose just writes a SKILL.md doc — no need for chain-of-thought
              // overhead. Disable Qwen3.6+ thinking so all output is the doc itself.
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

          // Marker-aware streaming parser.
          //
          // Mode states: "outside" | "rationale" | "doc"
          // Markers: <rationale>, </rationale>, <doc>, </doc>
          //
          // Tokens may split markers across deltas, so we hold a small lookahead
          // buffer until either a marker resolves or we've accumulated enough
          // bytes that no marker could still be forming.
          let mode: "outside" | "rationale" | "doc" = "outside";
          let pending = "";
          const MARKERS = ["<rationale>", "</rationale>", "<doc>", "</doc>"];
          const MAX_MARKER_LEN = Math.max(...MARKERS.map((m) => m.length));
          let docStarted = false;
          let docEnded = false;

          function flushPending(force: boolean) {
            // Walk through pending: emit anything that can't possibly start a marker.
            // If `force`, drain everything regardless.
            while (pending.length > 0) {
              // Check for a marker at position 0 first.
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

              // Look for the next "<" — anything before it is safe to emit.
              const lt = pending.indexOf("<");
              if (lt === -1) {
                // No "<" at all → emit everything.
                emit(pending);
                pending = "";
                return;
              }
              if (lt > 0) {
                emit(pending.slice(0, lt));
                pending = pending.slice(lt);
              }
              // Now pending starts with "<". Could it be a partial marker?
              if (!force && pending.length < MAX_MARKER_LEN) {
                // Wait for more bytes.
                return;
              }
              // Either forced, or we have enough bytes — check if it's actually a marker.
              let isPartialMarker = false;
              for (const m of MARKERS) {
                if (m.startsWith(pending) || pending.startsWith(m)) { isPartialMarker = true; break; }
              }
              if (isPartialMarker && !force) {
                return;
              }
              // Not a marker (or forced) — emit just the "<" and continue.
              emit("<");
              pending = pending.slice(1);
            }
          }

          function emit(text: string) {
            if (!text) return;
            if (mode === "doc") ctx.broadcast({ type: "doc-delta", text });
            else if (mode === "rationale") ctx.broadcast({ type: "chat-delta", text });
            // outside: drop (whitespace/newlines between blocks)
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
              } catch {
                // skip unparseable
              }
            }
          }

          // Flush any tail content.
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
