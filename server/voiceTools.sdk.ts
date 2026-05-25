// Voice agent tool definitions for the Vercel AI SDK migration.
//
// Today's voiceAgent.ts emits an XML protocol the LLM has to write as
// text (`<tool name="search"><query>...</query></tool>`) and the server
// has to extract via regex. That path is fragile — truncated tool tags,
// role-prefix imitation, missing closing tags. The chat / claude /
// opencode cards are rock-solid because their SDKs ride on vLLM's
// native function-calling parser; voice should do the same.
//
// This module defines each voice tool as a Vercel AI SDK `tool({...})`
// with a Zod schema + execute function. The system prompt no longer
// has to teach the XML grammar — the SDK passes tool descriptions to
// the model via OpenAI's `tools` parameter, vLLM's qwen3_coder parser
// (already enabled in start.sh) emits structured `tool_calls`, and the
// SDK runtime invokes our execute functions automatically.
//
// `buildVoiceTools(deps)` is a factory because each per-session voice
// turn needs its own dependency closure (channelMgr, sessionProject,
// the abort handler that knows which delegation to cancel, etc.).

import { tool } from "ai";
import { z } from "zod";
import { tavilySearch, webFetch, timeAt } from "./voiceTools.js";
import { listCanvasFiles, readProjectFile } from "./files.js";
import type { ChannelManager } from "./channelManager.js";

/** Cap on read_card output. The voice prompt budget is small; if a
 *  card is huge, truncate and let the agent know it's truncated. Mirrors
 *  READ_CARD_MAX_CHARS from voiceAgent.ts (kept in sync). */
const READ_CARD_MAX_CHARS = 6000;
const RECENT_REPLIES_DEFAULT_N = 1;
const RECENT_REPLIES_MAX_CHARS = 4000;

/** Whether a card extension is chat-shaped — i.e. a valid `send_to_card`
 *  target. Non-chat cards (data, terminal, csv, etc.) silently swallow
 *  conversational messages, so dispatching to them produces a "success"
 *  at the channel layer but nothing useful happens. */
const CHAT_CLASS_EXTENSIONS = new Set<string>([
  "qwen", "claude", "opencode",
  "llm-chat", "llm-direct", "llm-agent",
]);

export interface CardQueueItem {
  id: string;
  text: string;
  source: string;
  queuedAt: number;
}

export interface CardStatus {
  busy: boolean;
  summary: string;
  queueDepth: number;
  queueItems: CardQueueItem[];
  /** Preview (~first 200 chars) of the user turn the agent is
   *  currently processing. Null when the agent is idle or finished
   *  its last reply. Lets voice answer "what's X doing?" without a
   *  second tool call to read_recent_replies. */
  currentTask: string | null;
}

export interface VoiceToolDeps {
  channelMgr: ChannelManager;
  /** Per-session project name. May be null when voice runs without a
   *  scoped project; tools handle that gracefully. */
  sessionProject: string | null;
  /** Caller-provided card-status implementation (lives in voiceAgent
   *  today and reads chat history + queue file). Passing it in keeps
   *  this module test-isolated. */
  cardStatusFor: (project: string | null, file: string) => Promise<CardStatus>;
  /** Caller-provided "read recent assistant replies" — also lives in
   *  voiceAgent.ts today. */
  readRecentReplies: (project: string | null, file: string, n: number) => Promise<string>;
  /** Local-effect abort path: drop queued audio, cascade interrupt to
   *  the last delegation, clear delegation state. Voice's existing
   *  abort handler. Returns a short description for the tool result. */
  abortHandler: () => Promise<{ droppedQueue: number; cascadeTarget: string | null }>;
  /** Optional callback so voiceAgent can record a successful dispatch
   *  in its delegation state (for next-turn context). */
  onDelegationTracked?: (file: string, message: string) => void;
}

/** Build the tools map for a single voice turn. Each call captures
 *  the per-session deps in a closure; the returned object is consumed
 *  by `streamText({ tools })`. */
export function buildVoiceTools(deps: VoiceToolDeps) {
  const { channelMgr, sessionProject, cardStatusFor, readRecentReplies,
    abortHandler, onDelegationTracked } = deps;

  return {
    list_cards: tool({
      description: "Get a fresh listing of every card on the canvas. Usually unnecessary — the system prompt includes a current listing. Use only when the user explicitly asks 'what's on the canvas?' and you suspect a recent change.",
      inputSchema: z.object({}),
      execute: async () => {
        const cards = await listCanvasFiles(sessionProject || undefined);
        return { cards: cards.map((c) => c.name) };
      },
    }),

    read_card: tool({
      description: "Read a card's text content. Use when answering needs project-specific data you don't already have from the system-prompt context. IMPORTANT: empty content does NOT mean the card is missing or doesn't exist — agent cards (.qwen, .opencode, .voice), shared-library, skills, and canvas-back instance files are almost always empty placeholders. Those cards render purely from their class definition; the instance file is just a handle for layout + session. If `content` is empty and `present: true`, the card IS on the canvas — say so, don't tell the user the card doesn't exist. If you actually need to verify presence, call `list_cards` instead.",
      inputSchema: z.object({
        file: z.string().describe("Exact filename from the canvas listing, e.g. canvas/info.md"),
      }),
      execute: async ({ file }) => {
        try {
          const c = await readProjectFile(file, sessionProject || undefined);
          const text = String(c?.content || "");
          const truncated = text.length > READ_CARD_MAX_CHARS;
          const body = truncated ? text.slice(0, READ_CARD_MAX_CHARS) + "\n(truncated)" : text;
          return {
            file,
            present: true,
            content: body,
            truncated,
            originalLength: text.length,
            // Explicit marker so the LLM never confuses "empty placeholder
            // card" with "no such card." Set when the file exists but has
            // no readable body — common for agent cards (.qwen, .opencode,
            // .voice), shared-library, skills, canvas-back instances, etc.
            isEmptyPlaceholder: text.length === 0,
          };
        } catch (err) {
          // Distinguish ACTUAL missing files (ENOENT) from other failures.
          // present:false means the card is genuinely not on the canvas;
          // any other error is a read failure (perms, IO, etc.).
          const message = (err as Error).message || String(err);
          const isMissing = /ENOENT/i.test(message);
          return {
            file,
            present: false,
            content: "",
            truncated: false,
            originalLength: 0,
            error: isMissing ? "file not found" : message,
          };
        }
      },
    }),

    read_recent_replies: tool({
      description: "Fetch the last N assistant replies from a chat card. Use for 'what did Qwen just say?' or to verify a chat card's recent thread before dispatching a follow-up.",
      inputSchema: z.object({
        file: z.string().describe("Chat-card filename, e.g. canvas/qwen.qwen"),
        n: z.number().int().min(1).max(5).default(RECENT_REPLIES_DEFAULT_N).describe("How many recent replies to fetch (1–5)"),
      }),
      execute: async ({ file, n }) => {
        const body = await readRecentReplies(sessionProject, file, n);
        const trimmed = body.length > RECENT_REPLIES_MAX_CHARS
          ? body.slice(0, RECENT_REPLIES_MAX_CHARS) + "\n(truncated)"
          : body;
        return { file, replies: trimmed, count: n };
      },
    }),

    card_status: tool({
      description: "Check a chat card's CURRENT status: busy/idle, what user request the agent is processing right now (currentTask), queue depth, and the first 5 queued items with their IDs. You MUST call this when the user asks 'what's X doing?', 'is X busy?', 'what's queued?' — DO NOT guess or fabricate an agent's state from training data or context. Returns `currentTask` (a preview of the in-flight user request) so you can answer 'what's Qwen doing?' in one tool call without also reading replies. Also call BEFORE a dispatch to a chat card that may be busy — reason over the queue to decide whether to add, replace, delete, or wait. Speaking 'Qwen is working on X' or 'Qwen has N items queued' WITHOUT first calling this tool is a hallucination.",
      inputSchema: z.object({
        file: z.string().describe("Chat-card filename, e.g. canvas/qwen.qwen"),
      }),
      execute: async ({ file }) => {
        const status = await cardStatusFor(sessionProject, file);
        return {
          file,
          busy: status.busy,
          summary: status.summary,
          currentTask: status.currentTask,
          queueDepth: status.queueDepth,
          queueItems: status.queueItems,
        };
      },
    }),

    search: tool({
      description: "Web search via Tavily. Use for facts you don't know — current events, today's news/weather/prices/scores, latest software versions, lookups where guessing would mislead. Combine search results with your own knowledge for the spoken answer; tools give the precise data, knowledge gives the context.",
      inputSchema: z.object({
        query: z.string().describe("Focused search query, one short phrase (not a sentence)"),
      }),
      execute: async ({ query }) => {
        const body = await tavilySearch(query);
        return { query, results: body };
      },
    }),

    web_fetch: tool({
      description: "Fetch a URL and return its text content. Use after `search` to drill into a specific result, or when the user gives a URL directly. Don't guess URLs; the tool is for known links.",
      inputSchema: z.object({
        url: z.string().describe("HTTP/HTTPS URL"),
      }),
      execute: async ({ url }) => {
        const body = await webFetch(url);
        return { url, content: body };
      },
    }),

    time: tool({
      description: "Get the current time in a given IANA timezone (e.g. 'America/Los_Angeles', 'Asia/Tokyo', 'Europe/London'). Zero latency. Use whenever the user asks 'what time is it in X'.",
      inputSchema: z.object({
        tz: z.string().describe("IANA timezone identifier, e.g. 'Asia/Tokyo'"),
      }),
      execute: async ({ tz }) => {
        const body = timeAt(tz);
        return { tz, time: body };
      },
    }),

    send_to_card: tool({
      description: "Route a message to a chat-card agent (Qwen, Claude Code, OpenCode) — the only way to ask them to do work. You MUST call this tool whenever you decide to dispatch. Saying 'let me ask Qwen' or 'I'll send this to X' in your spoken response WITHOUT calling this tool is a lie; the user expects the dispatch to actually happen. Use for: (a) project work — edit files, write code, draft a spec, create cards, build a visualization, run analysis on canvas data; (b) help with hard analytical questions where a quick voice reply short-changes the user; (c) anything that needs file access, code execution, or multi-step reasoning that voice can't do. Look at the 'Chat cards' section in the system prompt for the target filename (e.g. canvas/qwen.qwen).",
      inputSchema: z.object({
        file: z.string().describe("Exact filename from the 'Chat cards' section, e.g. canvas/qwen.qwen"),
        message: z.string().describe("The exact words Parakeet transcribed from the user — pass through unchanged, no rewriting"),
      }),
      execute: async ({ file, message }) => {
        const dot = file.lastIndexOf(".");
        const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
        if (!CHAT_CLASS_EXTENSIONS.has(ext)) {
          return {
            ok: false,
            file,
            message: `"${file}" isn't a chat card. send_to_card only routes to chat-class cards. Pick one from the 'Chat cards' section and retry.`,
          };
        }
        // Lazy-creates the chat card's session if it hasn't opened yet.
        // Per CLAUDE.md tenet 5 ("user intent, not transport"), voice can
        // dispatch to chat cards that are in the layout but haven't been
        // clicked on — the agent processes the message with no UI clients
        // attached, and the message + reply show up when the user later
        // opens the card (onAttach replays from chat history).
        const result = await channelMgr.dispatchOrCreate(sessionProject, file, { message });
        if (!result.ok) {
          return {
            ok: false,
            file,
            message: `Couldn't reach "${file}" — the file may not exist on this canvas, or its card class has no registered handler.`,
          };
        }
        onDelegationTracked?.(file, message);
        let detail: string;
        if (result.created) {
          detail = "Dispatched to a freshly-spawned session — the chat card will populate when the user opens it.";
        } else if (result.clientCount === 0) {
          detail = "Dispatched, but the chat card isn't currently visible — the user should open it to see the message arrive.";
        } else if (typeof result.queueDepth === "number" && result.queueDepth > 0) {
          detail = `Queued behind ${result.queueDepth} other request${result.queueDepth === 1 ? "" : "s"}.`;
        } else {
          detail = "Dispatched.";
        }
        return {
          ok: true,
          file,
          message: detail,
          clientCount: result.clientCount,
          queueDepth: result.queueDepth,
        };
      },
    }),

    delete_queue_item: tool({
      description: "Drop a pending item from a chat card's queue. Target by id (from card_status). Use when the user cancels a request that hasn't been picked up yet ('never mind', 'drop that').",
      inputSchema: z.object({
        file: z.string().describe("Chat-card filename"),
        id: z.string().describe("Queue item id (from card_status)"),
      }),
      execute: async ({ file, id }) => {
        const result = channelMgr.dispatchToFilename(sessionProject, file, { type: "cancel_queued", id });
        if (!result.ok) {
          return { ok: false, file, id, message: `Card "${file}" isn't open.` };
        }
        return { ok: true, file, id, message: "Removed from queue (or already drained)." };
      },
    }),

    replace_queue_item: tool({
      description: "Rewrite a pending queue item's text in place. Preserves the item's position, source, and queuedAt — only the text changes. Use when the user amends a request that's still queued.",
      inputSchema: z.object({
        file: z.string().describe("Chat-card filename"),
        id: z.string().describe("Queue item id (from card_status)"),
        message: z.string().describe("Replacement text for the queued item"),
      }),
      execute: async ({ file, id, message }) => {
        const result = channelMgr.dispatchToFilename(sessionProject, file, { type: "replace_queued", id, text: message });
        if (!result.ok) {
          return { ok: false, file, id, message: `Card "${file}" isn't open.` };
        }
        return { ok: true, file, id, message: "Queue item text replaced (or already drained)." };
      },
    }),

    abort: tool({
      description: "User wants to stop. Cancels the last delegation (if any) and stops in-flight TTS playback. Use when the user says 'stop', 'cancel', 'never mind', 'wait', or paraphrases. Pair with a brief spoken acknowledgement ('OK, stopping.').",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await abortHandler();
        return {
          ok: true,
          droppedQueue: result.droppedQueue,
          cascadeTarget: result.cascadeTarget,
          message: result.cascadeTarget
            ? `Cancelled in-flight TTS and asked ${result.cascadeTarget} to stop.`
            : "Cancelled in-flight TTS.",
        };
      },
    }),
  };
}
