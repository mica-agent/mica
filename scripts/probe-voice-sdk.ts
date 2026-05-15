// Standalone probe: verify the Vercel AI SDK round-trips cleanly with
// our local vLLM (Qwen3.6-35B-A3B-NVFP4) before refactoring voiceAgent.ts.
//
// What it tests:
//   1. Plain text generation — `streamText` with no tools. Should emit
//      a stream of `text-delta` parts followed by `finish`.
//   2. Single tool call — one `time` tool defined. Asked "what time is
//      it in Tokyo?" expects exactly one `tool-call` (`time` with
//      `tz: "Asia/Tokyo"`), one `tool-result`, then a `text-delta`
//      stream with the answer.
//
// Run inside the devcontainer with the chat vLLM up:
//   npx tsx scripts/probe-voice-sdk.ts
//
// Exit 0 on success, non-zero if any assertion fails.

import { streamText, tool, stepCountIs } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { z } from "zod";

const LLM_URL = (process.env.LLAMA_URL || "http://172.17.0.1:8012") + "/v1";

// fetch middleware: inject `chat_template_kwargs: { enable_thinking: false }`
// into the request body so vLLM's Qwen chat template doesn't run the
// thinking pass. The openai-compatible provider doesn't expose
// chat_template_kwargs directly, but its `fetch` hook lets us mutate
// the body verbatim before it goes out.
const fetchWithNoThink: typeof fetch = async (url, init) => {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      body.chat_template_kwargs = { ...(body.chat_template_kwargs || {}), enable_thinking: false };
      init = { ...init, body: JSON.stringify(body) };
    } catch { /* not JSON, leave alone */ }
  }
  return fetch(url as RequestInfo, init);
};

const qwen = createOpenAICompatible({
  name: "qwen-voice",
  baseURL: LLM_URL,
  apiKey: "local-no-auth",
  fetch: fetchWithNoThink,
});

async function probePlainText() {
  console.log("\n=== Probe 1: plain text generation, no tools ===");
  const result = streamText({
    model: qwen.chatModel("qwen-voice"),
    system: "You are a terse helper. Answer in one short sentence.",
    messages: [{ role: "user", content: "Name three primary colors." }],
    temperature: 0.6,
    topP: 0.95,
    topK: 20,
  });

  const textChunks: string[] = [];
  let sawFinish = false;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      textChunks.push(part.text);
    } else if (part.type === "finish") {
      sawFinish = true;
    } else if (part.type === "error") {
      console.error("[probe] ERROR part:", part.error);
      throw new Error("streamText emitted an error");
    } else {
      console.log("[probe]   part:", part.type);
    }
  }
  const fullText = textChunks.join("");
  console.log("[probe]   chunks:", textChunks.length);
  console.log("[probe]   final:", JSON.stringify(fullText.slice(0, 200)));
  console.log("[probe]   sawFinish:", sawFinish);
  if (textChunks.length === 0) throw new Error("no text-delta chunks emitted");
  if (!sawFinish) throw new Error("no finish part emitted");
  if (fullText.length < 5) throw new Error("response too short, probably a vLLM/model misconfiguration");
  console.log("[probe] PASS plain text");
}

async function probeToolCall() {
  console.log("\n=== Probe 2: single tool call (`time`) ===");
  let timeExecuteCalled = 0;
  let timeArgs: { tz?: string } = {};

  const result = streamText({
    model: qwen.chatModel("qwen-voice"),
    system: "You are a terse voice helper. For time-of-day questions, ALWAYS call the `time` tool with the IANA timezone matching the user's location. After the tool returns, briefly state the time in one sentence.",
    messages: [{ role: "user", content: "What time is it in Tokyo right now?" }],
    temperature: 0.6,
    topP: 0.95,
    // Thinking is disabled via the provider's fetch middleware above
    // (chat_template_kwargs injection).
    stopWhen: stepCountIs(3),
    tools: {
      time: tool({
        description: "Get the current time in a given IANA timezone (e.g. 'Asia/Tokyo'). Use whenever the user asks for the current time anywhere.",
        inputSchema: z.object({
          tz: z.string().describe("IANA timezone identifier"),
        }),
        execute: async ({ tz }) => {
          timeExecuteCalled += 1;
          timeArgs = { tz };
          const now = new Date();
          const fmt = new Intl.DateTimeFormat("en-US", {
            timeZone: tz,
            weekday: "short", hour: "numeric", minute: "2-digit",
            timeZoneName: "short",
          });
          return { tz, formatted: fmt.format(now) };
        },
      }),
    },
  });

  const events: string[] = [];
  const textChunks: string[] = [];
  for await (const part of result.fullStream) {
    events.push(part.type);
    if (part.type === "text-delta") {
      textChunks.push(part.text);
    } else if (part.type === "tool-call") {
      console.log("[probe]   tool-call:", part.toolName, JSON.stringify(part.input));
    } else if (part.type === "tool-result") {
      const r = (part as unknown as { output: unknown }).output;
      console.log("[probe]   tool-result:", part.toolName, JSON.stringify(r));
    } else if (part.type === "error") {
      console.error("[probe] ERROR part:", part.error);
      throw new Error("streamText emitted an error");
    } else {
      console.log("[probe]   part:", part.type);
    }
  }
  const fullText = textChunks.join("");
  console.log("[probe]   events:", events.join(" → "));
  console.log("[probe]   final text:", JSON.stringify(fullText.slice(0, 200)));
  console.log("[probe]   time tool calls:", timeExecuteCalled, "args:", JSON.stringify(timeArgs));

  if (timeExecuteCalled === 0) throw new Error("model did not call the `time` tool");
  if (timeArgs.tz?.toLowerCase().indexOf("tokyo") === -1 && timeArgs.tz?.toLowerCase().indexOf("asia") === -1) {
    throw new Error(`time tool called with unexpected tz: ${timeArgs.tz}`);
  }
  if (fullText.length < 3) throw new Error("no final text-delta after tool call");
  console.log("[probe] PASS tool call");
}

async function main() {
  console.log("[probe] LLM_URL =", LLM_URL);
  try {
    await probePlainText();
    await probeToolCall();
    console.log("\n[probe] ALL PROBES PASSED ✓");
    process.exit(0);
  } catch (err) {
    console.error("\n[probe] FAILED:", (err as Error).message);
    console.error(err);
    process.exit(1);
  }
}

main();
