// Voice agent — single-turn handler built on the Vercel AI SDK.
//
// This replaces the legacy XML-protocol path in voiceAgent.ts. The
// model emits structured tool calls (via vLLM's qwen3_coder
// tool-call parser) instead of writing `<tool name="X">` as text;
// the SDK runtime invokes our execute functions; we just stream
// `text-delta` parts into the SentenceFanout for TTS and broadcast
// `tool_call` / `tool_result` events to the voice card UI.
//
// The caller (voiceAgent.ts) owns per-session state (history,
// delegation context, audio queue, etc.) and passes everything this
// function needs as parameters. Keeping it stateless makes the SDK
// turn easy to swap in behind an env-var flag during migration.

import { streamText, generateText, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelManager } from "./channelManager.js";
import { buildVoiceTools, type CardStatus } from "./voiceTools.sdk.js";

const LLM_URL = (process.env.LLAMA_URL || "http://172.17.0.1:8012") + "/v1";

// Per-turn diagnostic context (session tag + turn-call kind: "main" or
// "classifier"). Set by runVoiceTurn / classifyUserIntent via
// `sessionCtx.run(...)` so all logs from the fetch middleware and the
// streamText iterator carry the same tag. Lets `grep s=abc12345`
// pull the full lifecycle of one turn when multiple voice sessions
// run concurrently (the per-session hang reproduces when multiple
// voice cards are open across projects, so disambiguation matters).
type VoiceLogCtx = { tag: string; kind: "main" | "classifier" };
const sessionCtx = new AsyncLocalStorage<VoiceLogCtx>();
function ctxSuffix(): string {
  const c = sessionCtx.getStore();
  return c ? ` s=${c.tag}/${c.kind}` : "";
}

// Inject `chat_template_kwargs: { enable_thinking: false }` into every
// outgoing request body AND instrument the request/response lifecycle
// so a stuck voice turn produces a log trail of exactly where it
// stopped. The openai-compatible provider doesn't expose arbitrary
// body-field pass-through, but its `fetch` hook lets us mutate the
// JSON body verbatim. Thinking-mode produces a long reasoning-delta
// prelude that hurts voice latency and (per separate testing) makes
// the model more confident at fabrication, not less.
const fetchWithNoThink: typeof fetch = async (url, init) => {
  const t0 = Date.now();
  let bodySize = 0;
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.chat_template_kwargs = {
        ...(body.chat_template_kwargs || {}),
        enable_thinking: false,
      };
      const stringified = JSON.stringify(body);
      init = { ...init, body: stringified };
      bodySize = stringified.length;
    } catch { /* not JSON, leave alone */ }
  }
  const urlStr = String(url).slice(-40);
  const sfx = ctxSuffix();
  console.log(`[voice-agent:fetch]${sfx} → ${urlStr} body=${bodySize}ch`);
  let resp: Response;
  try {
    resp = await fetch(url as RequestInfo, init);
  } catch (err) {
    console.warn(
      `[voice-agent:fetch]${sfx} ✗ ${urlStr} threw after ${Date.now() - t0}ms: ${(err as Error).message}`,
    );
    throw err;
  }
  const tHeaders = Date.now() - t0;
  console.log(
    `[voice-agent:fetch]${sfx} ← ${urlStr} status=${resp.status} headers-in=${tHeaders}ms`,
  );
  if (resp.body) {
    let bytes = 0;
    let firstByteAt: number | null = null;
    const tap = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (firstByteAt === null) {
          firstByteAt = Date.now();
          console.log(
            `[voice-agent:fetch]${sfx} ← ${urlStr} first-byte=${firstByteAt - t0}ms`,
          );
        }
        bytes += chunk.byteLength;
        controller.enqueue(chunk);
      },
      flush() {
        console.log(
          `[voice-agent:fetch]${sfx} ← ${urlStr} stream done bytes=${bytes} total=${Date.now() - t0}ms`,
        );
      },
    });
    return new Response(resp.body.pipeThrough(tap), {
      status: resp.status,
      statusText: resp.statusText,
      headers: resp.headers,
    });
  }
  return resp;
};

const qwen = createOpenAICompatible({
  name: "qwen-voice",
  baseURL: LLM_URL,
  apiKey: "local-no-auth",
  fetch: fetchWithNoThink,
});

// Pre-turn intent classifier. Replaces the old regex-based
// post-hoc "did the model claim to dispatch without firing the
// tool?" check. Instead, we classify the user's utterance up
// front and let the main turn use `tool_choice: 'required'`
// when the intent is clearly action-shaped — that way the model
// *cannot* talk about dispatching without actually firing the
// tool, because the SDK forces at least one tool call per turn.
//
// The labels are deliberately coarse — we don't try to predict
// which specific tool fires (the model picks). We only decide:
// must a tool fire this turn, or is direct speech allowed?
export type VoiceIntent =
  | "ACTION_DISPATCH"  // route work to a chat card → send_to_card
  | "ACTION_STATUS"    // ask about a card's state/output → card_status/read_recent_replies
  | "ACTION_LOOKUP"    // get external data → search/web_fetch/time
  | "ANSWER"           // voice can answer from training
  | "CLARIFY";         // filler/ambiguous; respond conversationally

const INTENT_LABELS: readonly VoiceIntent[] = [
  "ACTION_DISPATCH",
  "ACTION_STATUS",
  "ACTION_LOOKUP",
  "ANSWER",
  "CLARIFY",
] as const;

const CLASSIFIER_SYSTEM_PROMPT = `You classify a single user voice utterance into one intent label. Output EXACTLY one of these labels on a single line, with no quotes, no punctuation, no explanation:

ACTION_DISPATCH — user wants a chat card (Qwen, Claude, etc.) to do work. Examples: "Tell Qwen to plan the trip", "Ask Claude to fix that bug", "Have it draft a one-paragraph spec", "Just let it know I want to take off from SFO", "Mention I prefer aisle seats", "Ask it to add a paragraph about pricing".
ACTION_STATUS — user wants to know what a chat card is currently doing or has just produced. Examples: "What's Qwen working on?", "Did Claude finish?", "Is it done yet?", "What did it just say?", "Read me the last reply".
ACTION_LOOKUP — user wants information the voice agent can only get via a tool (web search, URL fetch, current time). This covers any "always fresh" topic whose answer changes minute-to-minute: weather, current time, stock prices, news, sports scores, traffic, exchange rates. BARE temporal phrases count — even with no place or company named, the user always means "now." Examples with a place/entity: "What time is it in Tokyo?", "What's the weather in Paris?", "What's Apple stock at today?", "Look up the latest version of Vite". Examples WITHOUT a place/entity (still ACTION_LOOKUP): "What's the weather?", "What time is it?", "How's the market?", "Any news?", "How's traffic?", "Is it raining?". When in doubt between ACTION_LOOKUP and ANSWER for a fact that could be temporal, choose ACTION_LOOKUP — an unnecessary tool call is cheaper than a fabricated answer.
ANSWER — user asked something the voice agent can answer directly from general knowledge. Examples: "What's two plus two?", "Capital of France?", "How do clouds form?".
CLARIFY — utterance is ambiguous, low-content, conversational filler, off-topic, or barge-in. Examples: "Hmm.", "Wait.", "Uh, okay.", "Right.", "Never mind."

Pick the most action-shaped label that fits. If the user is telling the voice to relay something to a card, that's ACTION_DISPATCH even when phrased as a statement ("I want to land in JFK" mid-trip-planning = relay).

Respond with ONE label only. No reasoning. No prefix. No suffix.`;

/** Classify a voice utterance into one of five coarse intents.
 *  Used to gate tool_choice on the main turn: action intents
 *  force a tool call; ANSWER/CLARIFY leave it on 'auto'.
 *
 *  Implementation: a small generateText() call with low temp
 *  and a 24-token cap. We use plain text + parse rather than
 *  generateObject() because the openai-compatible provider
 *  doesn't advertise structured-output support, so the SDK's
 *  schema-validation path fails. The model output is reliable
 *  enough at 24 tokens that the parse step is robust. */
export async function classifyUserIntent(
  userMessage: string,
  sessionTag = "unknown",
): Promise<VoiceIntent> {
  return sessionCtx.run({ tag: sessionTag, kind: "classifier" }, async () => {
    try {
      const { text } = await generateText({
        model: qwen.chatModel("qwen-voice"),
        system: CLASSIFIER_SYSTEM_PROMPT,
        prompt: userMessage,
        temperature: 0.1,
        // Labels are at most ~17 chars; 24 tokens is plenty even
        // with whitespace/punctuation noise, and keeps latency low.
        // Past tests showed full classifier round-trips in ~350ms.
        maxOutputTokens: 24,
      });
      const upper = text.toUpperCase();
      for (const label of INTENT_LABELS) {
        if (upper.includes(label)) return label;
      }
      console.warn(
        `[voice-agent:classifier] s=${sessionTag} unrecognized output: ${JSON.stringify(text.slice(0, 100))}; defaulting to ANSWER`,
      );
      return "ANSWER";
    } catch (err) {
      console.warn(
        `[voice-agent:classifier] s=${sessionTag} error: ${(err as Error).message}; defaulting to ANSWER`,
      );
      return "ANSWER";
    }
  });
}

/** Map a classified intent to the tool_choice setting we pass
 *  to streamText. Action intents force a tool call; ANSWER and
 *  CLARIFY leave the model free to answer directly. */
export function toolChoiceForIntent(intent: VoiceIntent): "auto" | "required" | "none" {
  switch (intent) {
    case "ACTION_DISPATCH":
    case "ACTION_STATUS":
    case "ACTION_LOOKUP":
      return "required";
    case "ANSWER":
    case "CLARIFY":
      return "auto";
  }
}

export interface RunVoiceTurnArgs {
  systemPrompt: string;
  /** Conversation history INCLUDING the current user utterance as the
   *  last message. The caller is responsible for trimming to MAX_HISTORY. */
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  channelMgr: ChannelManager;
  sessionProject: string | null;
  /** Per-turn abort. Caller wires this to e.g. user-said-stop. */
  abortSignal: AbortSignal;
  /** Channel-broadcast context. */
  ctx: {
    broadcast: (msg: unknown) => void;
    sendTo: (clientId: string, msg: unknown) => void;
  };
  /** Per-session callbacks the tools delegate to. */
  cardStatusFor: (project: string | null, file: string) => Promise<CardStatus>;
  readRecentReplies: (project: string | null, file: string, n: number) => Promise<string>;
  onDelegationTracked: (file: string, message: string) => void;
  abortHandler: () => Promise<{ droppedQueue: number; cascadeTarget: string | null }>;
  /** Forces tool-call discipline. `'auto'` (default) — model decides;
   *  `'required'` — model MUST emit at least one tool call this turn;
   *  `'none'` — model must NOT emit tool calls. Used by the caller to
   *  retry a hallucinated-dispatch turn with `'required'` so the model
   *  can't talk about dispatching without actually firing the tool. */
  toolChoice?: "auto" | "required" | "none";
  /** Cap on tool-loop steps. Defaults to 4 (lets the model do read →
   *  result → answer → write → result → speak across multiple rounds).
   *  Caller passes `1` for retries to prevent the model from repeating
   *  a forced tool call across steps. */
  maxSteps?: number;
  /** Short tag (e.g. first 8 chars of session id) prefixed on every
   *  diagnostic log line so multiple concurrent voice sessions stay
   *  separable in the log. Defaults to "unknown" if the caller doesn't
   *  pass one — useful while migrating callers. */
  sessionTag?: string;
}

export interface RunVoiceTurnResult {
  /** Full text emitted by the LLM, concatenated from all text-delta parts. */
  speakable: string;
  /** How many tool-call parts the SDK observed in this turn. */
  toolCallsFired: number;
  /** True iff at least one successful send_to_card tool dispatch landed. */
  sendDispatchedOk: boolean;
  /** True iff abortSignal fired before finish. */
  cancelled: boolean;
  /** Errors emitted by the stream (rare; usually surfaced via the
   *  `error` part). */
  error?: string;
}

/** Run one voice turn against the configured chat vLLM. Streams
 *  text-delta into the fanout, broadcasts tool events to the channel,
 *  returns a summary for the caller's bookkeeping. */
export async function runVoiceTurn(args: RunVoiceTurnArgs): Promise<RunVoiceTurnResult> {
  const sessionTag = args.sessionTag ?? "unknown";
  return sessionCtx.run({ tag: sessionTag, kind: "main" }, async () => {
    const tools = buildVoiceTools({
      channelMgr: args.channelMgr,
      sessionProject: args.sessionProject,
      cardStatusFor: args.cardStatusFor,
      readRecentReplies: args.readRecentReplies,
      abortHandler: args.abortHandler,
      onDelegationTracked: args.onDelegationTracked,
    });

    args.ctx.broadcast({ type: "thinking", phase: "llm" });

    // Entry diagnostic — print the shape of the call so a stuck turn
    // can be correlated with its inputs (huge system prompt? lots of
    // messages? heavy tool schema?). Followed by fetch/header/stream
    // events from the fetch middleware as the request makes its way
    // to vLLM.
    const tStart = Date.now();
    const toolNames = Object.keys(tools);
    console.log(
      `[voice-agent:sdk] s=${sessionTag} runVoiceTurn entering toolChoice=${args.toolChoice ?? "auto"} maxSteps=${args.maxSteps ?? 4} systemPrompt=${args.systemPrompt.length}ch messages=${args.messages.length} tools=${toolNames.length}`,
    );

    const result = streamText({
      model: qwen.chatModel("qwen-voice"),
      system: args.systemPrompt,
      messages: args.messages,
      // Tighter sampling for tool-calling discipline. Higher temps
      // let the model "answer from training" instead of picking the
      // appropriate tool — saw this with send_to_card / card_status
      // being talked about but never emitted at temp 0.7. 0.5 matches
      // the chat agent's effective sampling (vLLM server default 0.6).
      temperature: 0.5,
      topP: 0.9,
      // top_k=20 is the server-side default in start.sh; the
      // openai-compatible provider doesn't forward topK so we rely on
      // vLLM's `--override-generation-config`.
      abortSignal: args.abortSignal,
      tools,
      toolChoice: args.toolChoice ?? "auto",
      // Per-step toolChoice override. When the caller asks for
      // toolChoice='required' (action-shaped intent from the
      // classifier), we want it on STEP 0 only — that's when
      // the model decides whether to call a tool. On step 1+
      // we MUST relax to 'auto' or the SDK will force another
      // tool call every step (observed in production: 4×
      // identical send_to_card with the default stopWhen=4).
      // Step 0 'required' guarantees one dispatch; step 1+
      // 'auto' lets the model produce a brief spoken
      // confirmation or stop naturally.
      prepareStep: args.toolChoice === "required"
        ? ({ stepNumber }) =>
          stepNumber === 0
            ? undefined  // first step: keep the 'required' from above
            : { toolChoice: "auto" }
        : undefined,
      // Tool-result re-enter: when a tool fires, the SDK feeds the
      // result back to the model and re-runs it. Cap at 4 steps so
      // we don't pile up tool calls on a confused turn.
      stopWhen: stepCountIs(args.maxSteps ?? 4),
    });

    const textChunks: string[] = [];
    let toolCallsFired = 0;
    let sendDispatchedOk = false;
    let streamError: string | undefined;
    let partsSeen = 0;
    const partTypeCounts: Record<string, number> = {};

    // Heartbeat — proves the iterator is alive even when no events
    // are arriving. A ticking heartbeat with `parts seen=0` is the
    // signature of a fetch hung in the wait-for-vLLM phase; a beat
    // with parts seen growing slowly is vLLM-slow not vLLM-stuck.
    const heartbeatHandle = setInterval(() => {
      console.log(
        `[voice-agent:sdk] s=${sessionTag} heartbeat ${Math.round((Date.now() - tStart) / 1000)}s parts=${partsSeen} tools=${toolCallsFired}`,
      );
    }, 5000);

    try {
      for await (const part of result.fullStream) {
        if (args.abortSignal.aborted) break;
        partsSeen += 1;
        partTypeCounts[part.type] = (partTypeCounts[part.type] || 0) + 1;
        switch (part.type) {
          case "text-delta": {
            const text = part.text;
            if (text) textChunks.push(text);
            break;
          }
          case "tool-call": {
            toolCallsFired += 1;
            const argsPreview = JSON.stringify(part.input ?? {}).slice(0, 200);
            args.ctx.broadcast({
              type: "tool_call",
              name: part.toolName,
              args: argsPreview,
            });
            console.log(
              `[voice-agent:sdk] s=${sessionTag} tool_call ${part.toolName} ${argsPreview}`,
            );
            break;
          }
          case "tool-result": {
            // The SDK exposes the execute() return value at `part.output`
            // (typed as unknown to keep the SDK shape flexible).
            const output = (part as unknown as { output: unknown }).output as
              | { ok?: boolean; message?: string; file?: string; query?: string; url?: string; tz?: string }
              | undefined;
            const ok = output?.ok !== false; // tool-result without explicit ok counts as success
            if (part.toolName === "send_to_card" && output?.ok) sendDispatchedOk = true;
            args.ctx.broadcast({
              type: "tool_result",
              name: part.toolName,
              ok,
              message: output?.message,
              file: output?.file,
              query: output?.query,
              url: output?.url,
              tz: output?.tz,
            });
            console.log(
              `[voice-agent:sdk] s=${sessionTag} tool_result ${part.toolName} ok=${ok}`,
            );
            break;
          }
          case "error": {
            streamError = String((part as unknown as { error: unknown }).error || "unknown");
            args.ctx.broadcast({ type: "error", error: streamError });
            console.warn(
              `[voice-agent:sdk] s=${sessionTag} stream error: ${streamError}`,
            );
            break;
          }
          default:
            // Other part types — reasoning-*, tool-input-*, start/finish,
            // start-step/finish-step — are bookkeeping the SDK uses
            // internally. Log the first occurrence of each type so we
            // know what's actually arriving (vs noise on every frame).
            if (partTypeCounts[part.type] === 1) {
              console.log(`[voice-agent:sdk] s=${sessionTag} part type=${part.type} (first)`);
            }
            break;
        }
      }
    } catch (err) {
      streamError = (err as Error).message;
      console.warn(
        `[voice-agent:sdk] s=${sessionTag} iterator threw: ${streamError}`,
      );
      args.ctx.broadcast({ type: "error", error: streamError });
    } finally {
      clearInterval(heartbeatHandle);
      console.log(
        `[voice-agent:sdk] s=${sessionTag} iterator exit ${Math.round(Date.now() - tStart)}ms parts=${partsSeen} types=${JSON.stringify(partTypeCounts)} tools=${toolCallsFired} sendOk=${sendDispatchedOk} err=${streamError ?? "none"}`,
      );
    }

    return {
      speakable: textChunks.join(""),
      toolCallsFired,
      sendDispatchedOk,
      cancelled: args.abortSignal.aborted,
      error: streamError,
    };
  });
}
