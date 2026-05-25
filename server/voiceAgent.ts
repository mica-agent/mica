// voiceAgent.ts — `.voice` card class handler.
//
// Mica's voice assistant. Distinct from the chat agents (.qwen / .claude /
// .opencode): voice runs a fast, canvas-aware LLM with a tiny tool surface
// and never enters a tool loop, so it always responds in <2s. The slow
// chat agents do real work; voice does navigation, status, and dispatch.
//
// Phase 1 protocol per turn:
//   1. STT on the audio blob (or pass-through if msg.message is set for
//      text-mode debugging).
//   2. Build a canvas-aware prompt: project name + live card list +
//      tool grammar.
//   3. Single LLM call (no streaming-parse — voice replies are 1–2
//      sentences so post-parse is simpler and fast enough).
//   4. Parse <tool>…</tool> blocks → dispatch via ChannelManager.
//      Extract <say>…</say> blocks → feed SentenceFanout for streaming
//      TTS. Anything outside both is discarded (LLM debris).
//   5. Push assistant text into history; broadcast `done`.
//
// Channel frames out:
//   { type: "history", messages }                — on attach
//   { type: "transcript", text }                  — STT result
//   { type: "thinking", phase: "stt"|"llm"|"tts" } — status
//   { type: "tool_call", name, args }              — about to dispatch
//   { type: "tool_result", name, ok, message }     — dispatch outcome
//   { type: "assistant_speech_text", sentence_idx, text } — per sentence
//   { type: "assistant_speech",      sentence_idx, wav_b64 } — per sentence
//   { type: "assistant", content }                  — full speakable text
//   { type: "done" }                                — turn end
//   { type: "error", error }                        — on failure
//
// Channel messages in:
//   { audioB64, audioMime?, voice? }  — recorded press-hold audio
//   { message: string, voice? }       — text-mode override (for debugging)
//   { type: "interrupt" }             — abort current turn
//   { type: "clear" }                 — reset conversation history

import type { ChannelHandler, SessionContext, ChannelManager } from "./channelManager.js";
import { listCanvasFiles, readProjectFile, getOrCreateCardId, loadChatQueue, micaDir } from "./files.js";
import { readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  ensureVoiceServers,
  getSttUrl,
  getTtsUrl,
  getVoiceServerStatus,
} from "./voiceServers.js";
import { SentenceFanout, cleanForTts } from "./voiceStreaming.js";
import { tavilySearch, webFetch, timeAt } from "./voiceTools.js";
import { runVoiceTurn, classifyUserIntent, toolChoiceForIntent } from "./voiceAgentSdk.js";

// Cap on read_card output. The voice prompt budget is small; if a card is
// huge the LLM should summarize it, not regurgitate. Truncated content
// gets a "(truncated)" suffix so the LLM knows there's more.
const READ_CARD_MAX_CHARS = 4000;
const RECENT_REPLIES_MAX_CHARS = 1500;
const RECENT_REPLIES_DEFAULT_N = 1;
const ANNOUNCEMENT_QUEUE_MAX = 4;
// Heuristic for "card is busy" — if the chat history's last entry is a
// user turn, the agent is mid-processing. mtime is also captured for
// "active recently" judgements.
const CHAT_HISTORY_PATH = (project: string | null | undefined, chatId: string) =>
  join(process.env.WORKSPACE_DIR || "/workspaces/testproj", project || "", ".mica", "chats", `${chatId}.json`);

interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
  agent?: string;
  turn_id?: string;
}

async function readChatHistoryFor(
  project: string | null,
  filename: string,
): Promise<ChatHistoryEntry[]> {
  try {
    const cardId = await getOrCreateCardId(project, filename);
    const path = CHAT_HISTORY_PATH(project, cardId);
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ChatHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** List card-class names registered for the project: project-scoped
 *  (under `.mica/card-classes/<name>/`) plus built-in (under
 *  `<repo>/card-classes/<name>/`). Each entry includes its scope so the
 *  voice prompt can disambiguate "this is a custom class for THIS
 *  project" vs "this is one of Mica's built-ins."
 *
 *  Used purely to inform the system prompt — voice doesn't introspect
 *  class internals beyond knowing they exist. The agent uses this to
 *  answer "is the card class for `.hotdog` built?" without having to
 *  read `.mica/card-classes/hotdog/card.html` directly. */
interface RegisteredClass { name: string; scope: "project" | "builtin" }
async function listRegisteredCardClasses(project: string | null): Promise<RegisteredClass[]> {
  const seen = new Set<string>();
  const out: RegisteredClass[] = [];
  // Project-scoped first (they shadow built-ins by the same name).
  if (project) {
    try {
      const dir = join(micaDir(project), "card-classes");
      if (existsSync(dir)) {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory() || e.name.startsWith(".")) continue;
          if (!existsSync(join(dir, e.name, "card.html"))) continue;
          if (seen.has(e.name)) continue;
          seen.add(e.name);
          out.push({ name: e.name, scope: "project" });
        }
      }
    } catch { /* readdir failed — fall through */ }
  }
  // Built-in card classes.
  try {
    const dir = join(process.cwd(), "card-classes");
    if (existsSync(dir)) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (!existsSync(join(dir, e.name, "card.html"))) continue;
        if (seen.has(e.name)) continue;
        seen.add(e.name);
        out.push({ name: e.name, scope: "builtin" });
      }
    }
  } catch { /* ignore */ }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** Read the project's spec/intent file if present. Returns the first
 *  ~500 chars (`cleanForTts`'d so heading hashes / markdown links don't
 *  bleed in). Empty string when no spec, no canvas/spec.md, or it's
 *  empty — caller suppresses the "Project intent" section entirely. */
async function loadProjectIntent(project: string | null): Promise<string> {
  // Try canvas/spec.md first (the convention). Future: scan canvasRoot
  // for any `.spec.md` if this project uses a different name.
  const candidates = ["canvas/spec.md", "spec.md"];
  for (const path of candidates) {
    try {
      const content = await readProjectFile(path, project || undefined);
      const text = String(content?.content || "").trim();
      if (text.length === 0) continue;
      const cleaned = cleanForTts(text).trim();
      if (cleaned.length === 0) continue;
      return cleaned.length > 500 ? cleaned.slice(0, 500) + "…" : cleaned;
    } catch {
      // file missing → try next candidate
    }
  }
  return "";
}

/** Small text-card content the voice agent inlines into every turn's
 *  system prompt, so the LLM doesn't need a `read_card` round-trip to
 *  know what's on the canvas. Mirrors the `loadProjectIntent` pattern
 *  but for the full set of small `.md`/`.txt` cards, sorted by recency.
 *  Capped per-file and total so a sprawling canvas can't blow the
 *  prompt; oversize files truncate with a footer that nudges the LLM
 *  toward `read_card` for the remainder. */
interface AmbientItem {
  filename: string;       // canvas-relative path
  content: string;        // text body, post-cap
  truncated: boolean;     // true if we hit the per-file cap
}

const AMBIENT_PER_FILE_CAP = 4096;
const AMBIENT_TOTAL_CAP = 16384;
const AMBIENT_MIN_REMAINING = 512;
const AMBIENT_EXTENSIONS = new Set(["md", "txt"]);
const AMBIENT_SKIP_MARKER = "<!-- voice-skip -->";

async function loadAmbientContext(
  project: string | null,
  excludePaths: Set<string>,
): Promise<AmbientItem[]> {
  const cards = await listCanvasFiles(project || undefined);
  const candidates = cards
    .filter((c) => {
      if (excludePaths.has(c.name)) return false;
      const dot = c.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
      return AMBIENT_EXTENSIONS.has(ext);
    })
    .sort((a, b) => {
      const ta = a.modifiedAt ? Date.parse(a.modifiedAt) : 0;
      const tb = b.modifiedAt ? Date.parse(b.modifiedAt) : 0;
      return tb - ta;  // newest first wins the budget
    });

  const items: AmbientItem[] = [];
  let remaining = AMBIENT_TOTAL_CAP;
  for (const card of candidates) {
    if (remaining < AMBIENT_MIN_REMAINING) break;
    try {
      const file = await readProjectFile(card.name, project || undefined);
      const body = String(file?.content || "").trim();
      if (!body) continue;
      // First-line opt-out — cheap safety valve so noisy files
      // (long meeting notes, journals) can be excluded without
      // any code/config change.
      const firstLine = body.split(/\r?\n/, 1)[0].trim();
      if (firstLine === AMBIENT_SKIP_MARKER) continue;
      const capForThis = Math.min(AMBIENT_PER_FILE_CAP, remaining);
      const truncated = body.length > capForThis;
      const content = truncated ? body.slice(0, capForThis) : body;
      items.push({ filename: card.name, content, truncated });
      remaining -= content.length;
    } catch { /* read failure → skip; voice still functions */ }
  }
  return items;
}

interface CardQueueItem {
  id: string;       // QueuedItem.id — handle for delete_queue_item / replace_queue_item
  text: string;     // first ~100 chars of the queued message
  source: string;   // "user" | "voice" | "file-changes"
  queuedAt: number; // unix ms; 0 if missing
}

/** Heuristic card status. Reads chat history AND the chat agent's
 *  persisted queue (`.mica/chats/<chatId>.queue.json`) so voice can
 *  see what's already pending and avoid piling on. Falls back to
 *  history-only signals when no queue file exists (card never had a
 *  session) or read fails. */
async function cardStatusFor(
  project: string | null,
  filename: string,
): Promise<{ busy: boolean; summary: string; queueDepth: number; queueItems: CardQueueItem[]; currentTask: string | null }> {
  const history = await readChatHistoryFor(project, filename);
  // Resolve cardId so we can read the persisted queue. Same path the
  // chat agent uses to write it.
  let cardId = "";
  try { cardId = await getOrCreateCardId(project, filename); } catch { /* leave empty */ }
  const rawQueue = cardId
    ? await loadChatQueue<{ id?: string; text?: string; source?: string; queuedAt?: number }>(cardId, project).catch(() => [])
    : [];
  const queueDepth = rawQueue.length;
  const queueItems: CardQueueItem[] = rawQueue.slice(0, 5).map((q) => ({
    id: typeof q.id === "string" ? q.id : "",
    text: typeof q.text === "string" ? q.text.slice(0, 100) : "",
    source: typeof q.source === "string" ? q.source : "user",
    queuedAt: typeof q.queuedAt === "number" ? q.queuedAt : 0,
  }));
  // Busy if a user-turn is the latest history entry (chat agent is
  // mid-reply) OR there are queued items (pending work behind it).
  const last = history[history.length - 1];
  const busy = (last && last.role === "user") || queueDepth > 0;
  // If the agent is mid-reply (last entry is a user-role message with
  // no assistant follow-up yet), surface a preview of that message so
  // voice can answer "what's Qwen working on?" in one tool call. Capped
  // at 200 chars — voice doesn't need the whole message body, just
  // enough to reason about the topic.
  const currentTask = (last && last.role === "user" && typeof last.content === "string")
    ? last.content.slice(0, 200).trim()
    : null;
  let summary: string;
  if (history.length === 0 && queueDepth === 0) {
    summary = "idle (no conversation yet)";
  } else if (currentTask && queueDepth > 0) {
    summary = `busy on a turn + ${queueDepth} item${queueDepth === 1 ? "" : "s"} queued`;
  } else if (queueDepth > 0) {
    summary = `busy — ${queueDepth} item${queueDepth === 1 ? "" : "s"} queued`;
  } else if (currentTask) {
    summary = "busy — currently processing a user turn";
  } else {
    summary = `idle (last reply ${history.length} messages in)`;
  }
  return { busy, summary, queueDepth, queueItems, currentTask };
}

/** Format a unix-ms timestamp as a relative age ("just now", "3m ago",
 *  "1h ago"). Mirrors the canvas listing's age helper so the voice
 *  agent's prompts stay consistent. */
function formatRelativeAge(ms: number): string {
  if (!ms || !isFinite(ms)) return "unknown";
  const ageSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (ageSec < 5) return "just now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const ageMin = Math.floor(ageSec / 60);
  if (ageMin < 60) return `${ageMin}m ago`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr}h ago`;
  return `${Math.floor(ageHr / 24)}d ago`;
}

// Default targets 172.17.0.1 (Linux docker bridge gateway) so the
// devcontainer reaches the host-published vLLM port. Override with
// LLAMA_URL for rollback to in-container llama-server (127.0.0.1)
// or any other base URL.
const LLM_URL = (process.env.LLAMA_URL || "http://172.17.0.1:8012") + "/v1/chat/completions";
// Keep the last 8 turns (4 user + 4 assistant) in context. Voice exchanges
// are short — much more would just bloat the prompt without helping.
const MAX_HISTORY = 8;

interface VoiceTurn {
  role: "user" | "assistant";
  /** User-visible text — what the chat-card UI renders, what the user
   *  hears (speakable). Strip of all <tool>/<say> markup. */
  content: string;
  /** LLM-only context — the raw <tool>...</tool><say>...</say> output
   *  from the assistant turn, fed back to the LLM on the NEXT turn so
   *  it sees its own prior tool calls and continues following the
   *  grammar. Without this, the LLM starts hallucinating "OK, I asked
   *  Qwen" without ever emitting a <tool> block. Only set on assistant
   *  turns; absent for user turns (their content already IS the raw). */
  raw?: string;
}

/** Minimal XML-block extractor. Greedy match; doesn't handle nested tags
 *  (none in our grammar). Returns array of `{attrs, body}` in source
 *  order.
 *  - `attrs` is the text between `<TAG` and `>` (or `/>` for self-closing).
 *  - `body` is the text between `>` and `</TAG>`, or "" for self-closing.
 *  Either may be empty. */
function extractBlocks(
  raw: string,
  tag: string,
): Array<{ attrs: string; body: string; selfClosing: boolean }> {
  const out: Array<{ attrs: string; body: string; selfClosing: boolean }> = [];
  const open = `<${tag}`;
  const close = `</${tag}>`;
  let i = 0;
  while (true) {
    const o = raw.indexOf(open, i);
    if (o < 0) break;
    // Reject `<tagX` where the next char is part of a different tag name
    // (e.g. `<say` matching `<says`). The next char must be whitespace,
    // `>`, or `/`.
    const next = raw[o + open.length];
    if (next && !/[\s>/]/.test(next)) {
      i = o + open.length;
      continue;
    }
    const gt = raw.indexOf(">", o);
    if (gt < 0) break;
    const selfClosing = raw[gt - 1] === "/";
    const attrs = raw
      .slice(o + open.length, selfClosing ? gt - 1 : gt)
      .trim();
    if (selfClosing) {
      out.push({ attrs, body: "", selfClosing: true });
      i = gt + 1;
      continue;
    }
    const c = raw.indexOf(close, gt + 1);
    if (c < 0) break;
    out.push({ attrs, body: raw.slice(gt + 1, c), selfClosing: false });
    i = c + close.length;
  }
  return out;
}

/** Pull the `name="…"` value out of a tool tag's attrs string. */
function parseToolName(attrs: string): string | null {
  const m = attrs.match(/name\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

/** Parse `<file>X</file><message>Y</message>` style payloads. */
function parseField(inner: string, field: string): string {
  const m = inner.match(new RegExp(`<${field}>([\\s\\S]*?)</${field}>`));
  return m ? m[1].trim() : "";
}

// Card-class extensions whose handlers accept conversational
// `{ message: string }` dispatches from the voice agent's
// `send_to_card` tool. Anything outside this set (data cards,
// terminal, process, voice itself) silently no-ops on a message
// payload — voice should reject the dispatch and let the LLM
// retry rather than pretend it worked. Mirrors the message-taking
// handlers in server/index.ts § registerHandler block.
const CHAT_CLASS_EXTENSIONS = new Set<string>([
  "qwen", "claude", "opencode",
  "llm-chat", "llm-direct", "llm-agent",
]);

// Default agent name shown in the voice prompt when a chat card
// hasn't written its own role description into its file body.
// The user can always override per-card by editing the file via
// the pen icon — that text becomes the role line.
const AGENT_NAME_DEFAULTS: Record<string, string> = {
  "qwen": "Qwen",
  "claude": "Claude Code",
  "opencode": "OpenCode",
  "llm-chat": "LLM",
  "llm-direct": "LLM",
  "llm-agent": "LLM agent",
};

// Read a chat card's file body as its role description. Empty body
// or read failure → empty string (caller drops the role section).
// Markdown fences and newlines are flattened so the line stays
// scannable in the prompt; truncated to ~200 chars to bound prompt
// growth when a user pastes paragraphs in by mistake.
async function readChatCardRole(project: string | null, filename: string): Promise<string> {
  try {
    const file = await readProjectFile(filename, project || undefined);
    const collapsed = file.content
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`[^`]*`/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!collapsed) return "";
    return collapsed.length > 200 ? collapsed.slice(0, 200).trim() + "…" : collapsed;
  } catch {
    return "";
  }
}

// Words that, when they're the last word of a transcript, strongly suggest
// the user paused mid-thought rather than finishing. Voice should buffer
// the partial and wait for the next utterance instead of dispatching.
//
// Curated to avoid false positives on common short complete sentences:
// - Demonstratives (this/that/these/those) REMOVED — "Look at that!",
//   "I love that.", "What's this?" are all complete and very common.
// - "if" REMOVED — "only if", "even if" mid-sentence is rare; many
//   sentences end naturally with conditional clauses already complete.
// - Auxiliary verbs are kept (their bare-end form like "I will." in
//   conversation is uncommon and easily confirmed by re-asking).
const INCOMPLETE_TRAILING_WORDS = new Set([
  // Conjunctions
  "and", "or", "but", "so", "because", "since", "while", "though",
  "although", "then", "plus", "also", "when", "whenever",
  "before", "after", "until", "unless",
  // Fillers / hedges. "well" REMOVED — "as well", "do well", "oh well"
  // are common complete sentence-enders. Better to dispatch a maybe-
  // truncated turn than to stall the whole pipeline; the LLM can ask
  // for clarification if needed.
  "um", "uh", "hmm", "er", "like", "actually",
  // Articles / determiners (true mid-phrase markers — "I want a." is gibberish)
  "the", "a", "an", "some", "any",
  // Prepositions (always lead into something)
  "of", "to", "for", "with", "from", "on", "in", "at", "by", "into",
  "onto", "about", "around", "through", "across", "between", "over",
  "under", "near", "next",
  // Auxiliary / modal verbs
  "is", "are", "was", "were", "be", "been", "being",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "do", "does", "did", "doing",
  "has", "have", "had", "having",
  // Possessives that need a noun
  "my", "your", "his", "her", "its", "our", "their",
  // Comma-trailing fragments
  "and,", "or,", "but,",
]);

/** Returns `true` if the transcript looks like a complete spoken thought,
 *  `false` if it likely trailed off mid-utterance (so voice should buffer
 *  it and wait for the user to continue). Heuristic-only: regex on the
 *  trailing word + a couple of fragment shapes. Misses "open the file"
 *  → "in the docs folder" style semantic continuations, which is the
 *  trade-off vs running an extra LLM call on every utterance. */
function looksComplete(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true; // empty → caller handles separately
  // Single word: "hello", "yes", "stop" — treat as complete.
  const words = trimmed.split(/\s+/);
  if (words.length === 1) return true;
  // Trailing comma or em-dash → mid-thought.
  if (/[,—–-]\s*$/.test(trimmed)) return false;
  // Trailing ellipsis → explicit trailing-off.
  if (/\.\.\.\s*$/.test(trimmed)) return false;
  // Last word ends with hyphen → mid-word cut.
  const last = words[words.length - 1].toLowerCase().replace(/[.!?,]+$/, "");
  if (!last) return true;
  if (last.endsWith("-")) return false;
  // Last word is a "stay-tuned" trailing word.
  if (INCOMPLETE_TRAILING_WORDS.has(last)) return false;
  return true;
}

export function createVoiceAgentHandler(channelMgr: ChannelManager) {
  return async function voiceAgentFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const sessionProject = ctx.project;
    // Short tag for diagnostic logs — prefixed to every voice-agent log
    // line that goes through runVoiceTurn / classifier / fetch middleware
    // via AsyncLocalStorage. Lets us disambiguate concurrent voice
    // sessions when a stuck turn on one project's voice card needs to be
    // distinguished from a healthy one on another.
    const sessionTag = ctx.sessionId.slice(0, 8);
    // Mutable: starts from openChannel args, can be updated mid-session
    // via the `set_voice` channel message when the user picks a voice
    // from the card's dropdown. Drives both per-turn TTS (voice agent's
    // own replies) and ambient announcements (chat-card replies read
    // aloud) so a voice change applies everywhere.
    let voicePref: string | undefined =
      typeof args.voice === "string" ? (args.voice as string) : undefined;
    // Per-session settings, updated via `set_settings` control messages
    // from the card. Defaults preserve the historical behavior so
    // pre-rollout sessions keep working unchanged.
    //   autoReadAmbient: gates the assistant_speech (TTS audio) emission
    //     on the ambient-announcement path. When false, the reply panel
    //     still receives assistant_speech_text (the text appears), but
    //     no audio frames are broadcast. Default true.
    //   defaultDispatchTarget: when non-empty, injected into the voice
    //     system prompt as a hint for send_to_card so phrases like
    //     "ask the agent" route to this card without naming it.
    let autoReadAmbient = true;
    let defaultDispatchTarget = "";
    // User-defined pronunciation overrides for the TTS path. Managed by
    // the voice card's gear panel and sent via `set_settings`. Each rule
    // is a whole-word, case-insensitive substitution applied AFTER
    // markdown cleanup but BEFORE Kokoro. On-screen text is untouched.
    let pronunciations: import("./voiceStreaming.js").PronunciationRule[] = [];
    const history: VoiceTurn[] = [];
    let activeAbort: AbortController | null = null;
    // `busy` gates new USER utterances. True from STT through the LLM
    // loop and action dispatch. Released BEFORE TTS so the user can ask
    // a follow-up while the previous answer's audio is still draining —
    // TTS is just confirmation, it shouldn't block conversation.
    let busy = false;
    // `ttsActive` gates AMBIENT announcements (chat-card-finished pings).
    // Held high through fanout.drain() so an ambient doesn't barge in
    // mid-sentence over the user's own answer audio.
    let ttsActive = false;
    // The fanout currently emitting frames over this session's channel.
    // Set when a fanout is actively draining (user-turn TTS or ambient
    // announcement); null otherwise. The `barge_in` channel message
    // calls cancel() on this so the user can speak to silence Mica
    // without waiting for the LLM-recognized abort tool.
    let currentFanout: SentenceFanout | null = null;
    // Queued audio items waiting for the current turn to complete.
    // The client sends audio via onUtteranceRecorderStopped() while a
    // turn is in-flight; the server buffers these and processes them
    // sequentially after the current turn finishes.
    interface QueuedAudio {
      audioB64: string;
      audioMime: string;
      voice?: string;
    }
    let queuedAudio: QueuedAudio[] = [];

    // Tracks the most recent send_to_card dispatch so Mica's next-turn
    // system prompt knows what's pending. Drives three behaviours from
    // a single signal: (1) corrections re-dispatch to the SAME agent,
    // (2) non-sequiturs are recognized as topic changes, (3) a
    // user-said "stop" knows whom to cascade interrupt to. Cleared
    // after 2 turns without re-delegation — older context is more
    // likely a fresh request than a correction.
    interface DelegationContext {
      filename: string;     // e.g. "qwen.qwen"
      agentName: string;    // resolved via AGENT_NAME_DEFAULTS
      summary: string;      // first ~150 chars of the dispatched <message>
      turnsAgo: number;     // 0 = just dispatched; cleared at >2
    }
    let delegation: DelegationContext | null = null;

    // Tracks the most recent ambient announcement from a delegated agent.
    // Without this, Mica's history shows only her own user/assistant
    // turns — she's blind to what just played as ambient TTS, so she
    // can't recognize "yes" / "no" / answers as responses to a question
    // the agent asked. We surface the announcement as a prompt hint
    // alongside the delegation context. Cleared after one consumed
    // user turn (the answer or non-answer drains it) or when delegation
    // expires.
    interface AmbientHint {
      filename: string;
      agentName: string;
      preview: string;       // first ~250 chars of the ambient text
      looksLikeQuestion: boolean;
    }
    let lastAmbient: AmbientHint | null = null;

    // Cache of recent agent replies. Mica's next-turn prompt surfaces
    // these so she can answer follow-up questions ("more about the
    // dough") from prompt-resident memory without dispatching again.
    // Older content beyond the cache is still fetchable via
    // read_recent_replies — Mica's prompt explains the choice.
    // Newest at index 0; FIFO trim at RECENT_REPLIES_MAX.
    interface CachedReply {
      filename: string;
      agent: string;
      userRequest: string;        // user's voice utterance that triggered the dispatch
      dispatchedMessage: string;  // what Mica sent via send_to_card
      content: string;            // reply text, truncated to REPLY_CONTENT_CAP
      truncated: boolean;         // true if content was clipped
      receivedAt: number;         // unix ms for age display
    }
    const recentAgentReplies: CachedReply[] = [];

    // Partial-utterance buffer. When the user pauses mid-thought, VAD
    // cuts the recording and STT returns a partial like "I want to know".
    // Heuristic completeness check (looksComplete()) flags it; we stash
    // the text here and wait for the next utterance to arrive, then
    // prepend the buffer. PARTIAL_EXPIRY_MS auto-flushes the buffer if
    // the user falls silent for too long — better to dispatch a partial
    // than leave them hanging.
    let pendingPartial: string | null = null;
    let pendingPartialAt = 0;
    let pendingPartialTimer: NodeJS.Timeout | null = null;
    // 4s expiry — long enough for a normal mid-thought pause + the next
    // STT round-trip, short enough that an unrelated follow-up question
    // doesn't accidentally inherit a stale partial. Was 8s; changing
    // topics within 8s was too easy to bridge by mistake.
    const PARTIAL_EXPIRY_MS = 4000;

    function clearPendingPartialTimer(): void {
      if (pendingPartialTimer) {
        clearTimeout(pendingPartialTimer);
        pendingPartialTimer = null;
      }
    }

    // Per-client visibility. Updated by `presence` messages from the
    // voice card and by onAttach/onDetach. Kept for diagnostics + future
    // per-tab routing; no longer gates TTS (background tabs receive
    // audio by design).
    const clientVisibility = new Map<string, boolean>();
    function anyVisible(): boolean {
      if (clientVisibility.size === 0) return true;
      for (const v of clientVisibility.values()) if (v) return true;
      return false;
    }
    // True when at least one client is attached to this voice session.
    // Zero clients means the card was deleted from the canvas OR every
    // browser tab subscribed to this voice session has closed — there's
    // literally no one to hear, so TTS would burn Kokoro GPU for nothing.
    // This is the right gate post-visibility-removal: "any subscriber",
    // not "any visible subscriber."
    function hasSubscriber(): boolean {
      return ctx.clientCount() > 0;
    }

    // ── Phase 2: ambient announcement queue ─────────────────────
    //
    // When any chat card on the same project broadcasts a completed
    // assistant turn, queue a short TTS notification. The queue drains
    // when the voice handler isn't currently processing a user turn.
    // Dedupe by turn_id so intra-turn `saveHistory` rewrites don't
    // produce multiple announcements for the same turn.
    //
    // Two announcement modes:
    //   - "summary" (default): brief notification — first sentence,
    //     ~140 chars max, prefixed with "<Agent> just finished. ".
    //     Used when the chat card was driven directly (you typed the
    //     question into the chat textarea).
    //   - "full": read the entire reply with no summarization.
    //     Triggered when the assistant broadcast carries `viaVoice:true`
    //     — meaning the user dispatched the request VIA voice, so
    //     they're using voice as their primary interface and want to
    //     hear the whole answer. Capped at ~1500 chars to keep one
    //     reply from monopolizing the speaker for minutes.
    interface AmbientItem {
      filename: string;
      agent: string;
      text: string;             // summary-mode: final ready-to-TTS text. full-mode: empty until drained.
      rawContent?: string;       // full-mode only: raw broadcast content; presented at drain time.
      mode: "summary" | "full";
      // Captured at enqueue time so the presenter has the user's intent
      // when drain fires later. Both empty for non-voice-dispatched items.
      userRequest?: string;      // user's voice utterance that triggered the dispatch
      dispatchedMessage?: string; // what Mica sent via send_to_card
    }
    const announcementQueue: AmbientItem[] = [];
    const seenTurnIds = new Map<string, string>(); // filename → last announced turn_id
    const muteSet = new Set<string>(); // filenames the user has muted (Phase 2.5)
    let announcementInFlight = false;

    // Bounds for the new present-not-summarize model. See plan in
    // /home/vscode/.claude/plans/question-check-logs-swirling-castle.md.
    //   PRESENT_INPUT_CAP — chars shipped to LLM for the initial
    //     presentation. 6000 leaves room for detailed answers; we cap
    //     here so a 50K-char code dump doesn't blow the prompt.
    //   RECENT_REPLIES_MAX — how many full agent replies we keep in
    //     prompt-resident cache. 3 covers most multi-turn voice
    //     interactions; older replies still reachable via
    //     read_recent_replies.
    //   REPLY_CONTENT_CAP — per-reply cap in the cache. Truncated tails
    //     are fetchable via read_recent_replies; the truncation marker
    //     tells Mica when to ask for more.
    const PRESENT_INPUT_CAP = 6000;
    const RECENT_REPLIES_MAX = 3;
    const REPLY_CONTENT_CAP = 2000;

    function summarizeForAnnouncement(content: string): string {
      // Take the first sentence, cap at ~140 chars. Keep raw markdown —
      // SentenceFanout applies cleanForTts per-sentence for the TTS
      // round-trip while emitting raw text in the `sentence` frame,
      // so the voice card's markdown renderer can format correctly.
      const m = content.match(/^(.{0,140}?[.!?])(\s|$)/);
      const first = m ? m[1] : content.slice(0, 140);
      return first.trim();
    }

    /** Generate Mica's spoken presentation of an agent's reply.
     *
     *  Replaces the previous generic "summarize for voice" path. The key
     *  difference: this gets BOTH the user's original voice request AND
     *  what Mica actually dispatched to the agent, so it can produce a
     *  response tuned to "did we answer the user's question" rather than
     *  a generic distillation that drops detail.
     *
     *  No char-cap output bound — length is whatever the answer requires.
     *  max_tokens caps the LLM at ~1200 chars worst case (well above
     *  typical answers, doesn't artificially clip a step-list).
     *
     *  Short replies (≤300 cleaned chars) bypass the LLM and pass
     *  through verbatim — the cost of a 6-sec LLM call isn't worth it
     *  for a one-sentence answer that's already in the right shape. */
    async function presentForVoice(
      reply: string,
      userRequest: string,
      dispatchedMessage: string,
      agentName: string,
    ): Promise<string> {
      const raw = reply.trim();
      if (!raw) return "";
      // Very short replies are already in the right shape for speech.
      if (raw.length <= 300) return raw;
      const llmInput = raw.length > PRESENT_INPUT_CAP
        ? raw.slice(0, PRESENT_INPUT_CAP)
        : raw;
      try {
        console.log(`[voice-agent:ambient] presenting ${raw.length}-char reply for ${agentName} (request: ${JSON.stringify(userRequest.slice(0, 80))})`);
        const resp = await fetch(LLM_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen-voice",
            messages: [
              { role: "system", content:
                "You're Mica's voice. The user asked an agent for help, and the agent " +
                "replied. Your job: give the user a spoken response that ACTUALLY " +
                "answers their question, using the agent's reply as source material. " +
                "Preserve concrete details the user needs (numbers, measurements, " +
                "names, exact steps). KEEP markdown structure when it's the right " +
                "shape for the content — tables for tabular data, fenced code blocks " +
                "for code, short bullet lists when comparing options. The reply panel " +
                "renders markdown visually, and TTS strips it cleanly — so a table is " +
                "read aloud as flowing prose but shown as a table on screen. Drop " +
                "chatty meta-commentary, pleasantries, filenames, and phrases like " +
                "'in summary' or 'the agent said'. Speak as if you're the one " +
                "explaining it. Length is whatever the answer requires — short for a " +
                "one-fact question, longer for an inherently detailed answer." },
              { role: "user", content:
                `User's voice request: "${userRequest}"\n\n` +
                `What I asked ${agentName}: "${dispatchedMessage}"\n\n` +
                `${agentName}'s reply:\n${llmInput}\n\n` +
                `Now: speak the answer to the user.` },
            ],
            max_tokens: 600,
            temperature: 0.3,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const presentation = (data.choices?.[0]?.message?.content || "").trim();
        if (presentation) {
          console.log(`[voice-agent:ambient] presented ${presentation.length} chars`);
          return presentation;
        }
      } catch (err) {
        console.warn(`[voice-agent:ambient] present failed, falling back to raw truncate: ${(err as Error).message}`);
      }
      // Fallback: truncate to ~1000 chars at a sentence boundary, append
      // a tail telling Mica's downstream loop where the rest lives.
      const truncate = raw.slice(0, 1000);
      const lastBoundary = Math.max(
        truncate.lastIndexOf(". "),
        truncate.lastIndexOf("! "),
        truncate.lastIndexOf("? "),
      );
      if (lastBoundary > 500) {
        return truncate.slice(0, lastBoundary + 1).trim() + " There's more in the chat card.";
      }
      return truncate.trim() + "… there's more in the chat card.";
    }

    async function drainAnnouncementQueue(): Promise<void> {
      if (announcementInFlight || busy || ttsActive) return;
      const next = announcementQueue.shift();
      if (!next) return;
      announcementInFlight = true;
      try {
        // Full mode: present the rawContent now (deferred from enqueue
        // time so a bursty stream queues without blocking on the LLM).
        // presentForVoice takes the user's voice request + what Mica
        // dispatched, generating an answer-shaped response (not a
        // generic summary). Short-content fast-path + LLM-with-fallback.
        let fullText = next.text;
        if (next.mode === "full" && next.rawContent !== undefined) {
          fullText = await presentForVoice(
            next.rawContent,
            next.userRequest || "",
            next.dispatchedMessage || "",
            next.agent,
          );
          if (!fullText) {
            console.log(`[voice-agent:ambient] empty presentation, dropping announcement for ${next.filename}`);
            return;
          }
          // Cache the full reply so Mica's NEXT turn can drill in via
          // prompt-resident memory (or via read_recent_replies for the
          // truncated tail). Newest at index 0.
          const truncated = next.rawContent.length > REPLY_CONTENT_CAP;
          const cachedContent = truncated
            ? next.rawContent.slice(0, REPLY_CONTENT_CAP).replace(/\s+\S*$/, "")
            : next.rawContent;
          recentAgentReplies.unshift({
            filename: next.filename,
            agent: next.agent,
            userRequest: next.userRequest || "",
            dispatchedMessage: next.dispatchedMessage || "",
            content: cachedContent,
            truncated,
            receivedAt: Date.now(),
          });
          if (recentAgentReplies.length > RECENT_REPLIES_MAX) {
            recentAgentReplies.length = RECENT_REPLIES_MAX;
          }
          console.log(`[voice-agent:ambient] cached reply for ${next.filename} (${cachedContent.length}${truncated ? "/" + next.rawContent.length : ""} chars); cache depth=${recentAgentReplies.length}`);
        }
        // Summary mode prefixes "<Agent> just finished. " so the listener
        // knows the source. Full-read mode just speaks the summary itself —
        // the user dispatched it via voice and is expecting THE answer,
        // not a meta-announcement about it.
        const text = next.mode === "full" ? fullText : `${next.agent} just finished. ${fullText}`;
        // Surface the ambient text to Mica's NEXT prompt build so she's
        // not blind to what the user just heard. Particularly important
        // when the agent's reply contains a question — without this
        // hint, Mica's history shows only her own user/assistant turns
        // and she can't recognize "yes"/"no" as answers to the agent's
        // question. Only track ambient from the active delegation —
        // unrelated chat cards' replies don't need a special hint.
        if (delegation && next.filename === delegation.filename) {
          lastAmbient = {
            filename: next.filename,
            agentName: next.agent,
            preview: text.slice(0, 250),
            looksLikeQuestion: /\?\s*$/.test(text.trim()) || /\?\s/.test(text),
          };
        }
        ctx.broadcast({
          type: "ambient_announcement_start",
          file: next.filename,
          agent: next.agent,
          mode: next.mode,
        });
        // Skip Kokoro round-trip when:
        //   - the user has turned off "Auto-read replies" (autoReadAmbient = false), OR
        //   - no client is attached to this voice session (every voice card
        //     tab has been closed, or the card was deleted from the canvas).
        // Visibility-hidden tabs still get audio — only zero-subscriber
        // sessions skip. Sentence text frames still go out so the reply
        // panel keeps updating if anyone reconnects.
        const skipTts = !autoReadAmbient || !hasSubscriber();
        if (skipTts) {
          const why = !autoReadAmbient ? "autoReadAmbient=false" : "no subscribers attached";
          console.log(`[voice-agent:ambient] ${why} — skipping TTS for ${next.filename}`);
        }
        const fanout = new SentenceFanout({
          ttsUrl: getTtsUrl(),
          voice: voicePref,
          skipTts,
          pronunciations,
          onFrame: (f) => {
            if (f.type === "sentence") {
              ctx.broadcast({
                type: "assistant_speech_text",
                sentence_idx: f.idx,
                text: f.text,
                ambient: true,
              });
            } else if (f.type === "audio") {
              ctx.broadcast({
                type: "assistant_speech",
                sentence_idx: f.idx,
                wav_b64: f.wavB64,
                ambient: true,
              });
            } else {
              console.warn(`[voice-agent:ambient] ${f.message}`);
            }
          },
        });
        currentFanout = fanout;
        try {
          fanout.feed(text);
          fanout.end();
          await fanout.drain();
        } finally {
          if (currentFanout === fanout) currentFanout = null;
        }
        ctx.broadcast({
          type: "ambient_announcement_done",
          file: next.filename,
        });
      } catch (err) {
        console.warn(`[voice-agent:ambient] announcement failed: ${(err as Error).message}`);
      } finally {
        announcementInFlight = false;
        // Drain any further queued items.
        if (announcementQueue.length > 0) setImmediate(() => { void drainAnnouncementQueue(); });
      }
    }

    // Subscribe to broadcasts from other sessions in the same project.
    // Ambient quiet mode: only voice-dispatched turns announce, and
    // file-only replies (mechanical "I created X" enumeration) stay
    // silent even when voice-dispatched. Direct-typed-into-chat turns
    // never produce a surprise audio announcement; user can read the
    // chat card visually if they want to see what changed.
    const unsubscribeBroadcastListener = channelMgr.onAnyBroadcast(
      (project, filename, data) => {
        // Mica announces chat-card replies via ambient TTS so the user
        // hears Qwen's output without having to look at the chat card.
        // To suppress this entirely, set MICA_VOICE_AMBIENT=0. To suppress
        // for a specific card, toggle that card's 🔊 to muted (its mute
        // state is in muteSet, populated via channel messages).
        if (process.env.MICA_VOICE_AMBIENT === "0") return;
        if (project !== sessionProject) return;
        if (filename === ctx.filename) return; // never echo our own replies
        if (muteSet.has(filename)) return;
        const d = data as {
          type?: string;
          content?: string;
          turn_id?: string;
          agent?: string;
          viaVoice?: boolean;
          filesChanged?: boolean;
        };
        if (d.type !== "assistant" || !d.content) return;
        // Gate 1: only voice-dispatched turns get an ambient TTS.
        // Direct chat-card use stays silent. micaAgent (and the other
        // chat handlers, once plumbed) sets viaVoice:true when the
        // turn was kicked off via the synthetic "voice-dispatch"
        // clientId from channelMgr.dispatchToFilename.
        if (d.viaVoice !== true) return;
        // No upstream regex suppression — presentForVoice (the LLM-with-
        // short-reply-bypass at the bottom of the ambient queue) handles
        // signal-vs-noise judgment. Short replies pass through verbatim
        // (so the chat agent's approval-gate question lands intact); long
        // replies are LLM-summarized; if the LLM returns empty the
        // announcement is dropped. Adding a regex gate here was misclassifying
        // short approval asks ("Drafted X — OK to build?") as "file-only
        // enumeration" and silently dropping them.
        const turnId = typeof d.turn_id === "string" ? d.turn_id : "";
        // Dedupe: same turn_id seen twice on the same file = ignore.
        if (turnId && seenTurnIds.get(filename) === turnId) return;
        if (turnId) seenTurnIds.set(filename, turnId);
        const agent = typeof d.agent === "string" ? d.agent : "the agent";
        // Pick the announcement mode. If the chat agent's broadcast carries
        // viaVoice:true, the user dispatched this turn THROUGH voice and
        // wants to hear the full reply, not a one-line summary.
        const mode: AmbientItem["mode"] = d.viaVoice === true ? "full" : "summary";
        // Summary mode: cheap synchronous first-sentence trim — used for
        // direct-typed turns (already brief, no LLM needed).
        // Full mode: store rawContent and defer the LLM summarize until
        // drain time, so a bursty stream of voice-dispatched replies
        // queues immediately and summarization serializes 1-at-a-time.
        // Capture the user's intent at enqueue time so the presenter
        // can tune the spoken response. For voice-dispatched (full mode),
        // userRequest is the most recent user turn from history.
        // dispatchedMessage is what Mica actually sent via send_to_card
        // — already tracked on `delegation` for the active card.
        const userRequest = mode === "full"
          ? (() => {
              for (let i = history.length - 1; i >= 0; i--) {
                if (history[i].role === "user") return history[i].content;
              }
              return "";
            })()
          : undefined;
        const dispatchedMessage = mode === "full" && delegation && filename === delegation.filename
          ? delegation.summary
          : undefined;
        const item: AmbientItem = mode === "full"
          ? { filename, agent, text: "", rawContent: d.content, mode, userRequest, dispatchedMessage }
          : { filename, agent, text: summarizeForAnnouncement(d.content), mode };
        if (mode === "summary" && !item.text) return;  // empty summary → skip
        // Cap queue to avoid flooding when many cards finish at once.
        if (announcementQueue.length >= ANNOUNCEMENT_QUEUE_MAX) {
          console.log(`[voice-agent:ambient] queue full, dropping announcement for ${filename}`);
          return;
        }
        announcementQueue.push(item);
        const sizeHint = mode === "full" ? `${(d.content || "").length} raw chars` : `${item.text.length} chars`;
        console.log(`[voice-agent:ambient] queued ${mode}-mode announcement for ${filename} (${sizeHint})`);
        setImmediate(() => { void drainAnnouncementQueue(); });
      },
    );

    const handler: ChannelHandler = {
      onAttach(clientId) {
        ctx.sendTo(clientId, {
          type: "history",
          messages: history,
        });
        // Default to visible until the client tells us otherwise. The
        // voice card sends a `presence` message right after openChannel
        // (and on every visibilitychange) — this default just covers
        // the brief window before that message arrives, and any client
        // that doesn't speak the presence protocol at all.
        clientVisibility.set(clientId, true);
      },

      onDetach(clientId) {
        clientVisibility.delete(clientId);
      },

      async onData(_clientId, data) {
        const msg = data as {
          type?: string;
          audioB64?: string;
          audioMime?: string;
          message?: string;
          voice?: string;
          // Internal flag: set when the partial-expiry timer re-enters
          // onData with the buffered text. Bypasses the completeness
          // heuristic so we don't loop on a transcript whose trailing
          // word still looks incomplete (the whole point of the timeout
          // is "give up waiting and dispatch what we have").
          _forceDispatch?: boolean;
          // Presence ping: the voice card reports its tab visibility so
          // the server can skip TTS work when every subscriber is hidden.
          visible?: boolean;
          // set_settings payload (sent by the card's gear panel on save
          // + on reconnect echo). All fields optional; only the slices
          // that changed need to be sent, but the card always sends them.
          autoReadAmbient?: boolean;
          defaultDispatchTarget?: string;
          pronunciations?: Array<{ from: string; to: string }>;
        };

        // Diagnostic log: every inbound channel message. Helps debug
        // "iOS isn't sending audio" type issues — we can see whether
        // the channel is alive at all and what shape the payload has.
        const shape = msg.audioB64
          ? `audioB64 (${msg.audioB64.length} b64chars, mime=${msg.audioMime || "?"})`
          : msg.type
            ? `type=${msg.type}`
            : msg.message
              ? `message (${msg.message.length} chars)`
              : "unknown";
        console.log(`[voice-agent] onData ← ${shape}`);

        if (msg.type === "interrupt") {
          if (activeAbort) {
            try { activeAbort.abort(); } catch { /* ignore */ }
          }
          return;
        }
        if (msg.type === "clear") {
          history.length = 0;
          ctx.broadcast({ type: "history", messages: [] });
          return;
        }
        if (msg.type === "clear_queue") {
          const n = queuedAudio.length;
          queuedAudio.length = 0;
          console.log(`[voice-agent] clear_queue: dropped ${n} items`);
          return;
        }
        if (msg.type === "presence") {
          // Lightweight; not logged via the diagnostic line above
          // (would spam every tab focus change).
          clientVisibility.set(_clientId, !!msg.visible);
          return;
        }
        if (msg.type === "barge_in") {
          // User spoke / hit "stop talking" → silence Mica's TTS now.
          // Distinct from <tool name="abort"/>: barge-in only stops
          // local TTS playback and the active fanout. It does NOT
          // cascade interrupt to the delegated chat agent and does
          // NOT clear delegation context. The user can still speak
          // their next utterance immediately; the new turn flows
          // through the normal busy/queue path.
          if (currentFanout) {
            console.log(`[voice-agent] barge_in: cancelling active fanout`);
            currentFanout.cancel();
          }
          return;
        }
        if (msg.type === "set_voice") {
          // Card's voice-select dropdown was changed (or echoed on
          // connect). Update session pref so subsequent ambient and
          // user-turn TTS uses the new Kokoro voice. Sidecar accepts
          // any of its built-in voice IDs per-request — no restart.
          if (typeof msg.voice === "string" && msg.voice.trim()) {
            const next = msg.voice.trim();
            if (next !== voicePref) {
              voicePref = next;
              console.log(`[voice-agent] voicePref updated to ${voicePref}`);
            }
          }
          return;
        }
        if (msg.type === "set_settings") {
          // Card's gear-panel save (or reconnect echo). Updates the
          // session-scoped autoReadAmbient and defaultDispatchTarget
          // knobs. Cheap, idempotent — call as many times as the card
          // wants without side effects on in-flight turns.
          if (typeof msg.autoReadAmbient === "boolean") {
            if (msg.autoReadAmbient !== autoReadAmbient) {
              autoReadAmbient = msg.autoReadAmbient;
              console.log(`[voice-agent] autoReadAmbient → ${autoReadAmbient}`);
            }
          }
          if (typeof msg.defaultDispatchTarget === "string") {
            const next = msg.defaultDispatchTarget.trim();
            if (next !== defaultDispatchTarget) {
              defaultDispatchTarget = next;
              console.log(`[voice-agent] defaultDispatchTarget → "${defaultDispatchTarget}"`);
            }
          }
          if (Array.isArray(msg.pronunciations)) {
            // Sanitize: keep only rules with a non-empty `from`. Empty
            // entries in the array would degrade the regex pass to a no-op
            // but cost a per-sentence loop iteration each — strip them.
            const clean = msg.pronunciations
              .filter((r): r is { from: string; to: string } =>
                !!r && typeof r.from === "string" && r.from.length > 0 && typeof r.to === "string")
              .map((r) => ({ from: r.from, to: r.to }));
            // Detect change to avoid spamming the log when reconnect-echoes
            // resend an identical payload.
            const changed = clean.length !== pronunciations.length ||
              clean.some((r, i) => r.from !== pronunciations[i]?.from || r.to !== pronunciations[i]?.to);
            if (changed) {
              pronunciations = clean;
              console.log(`[voice-agent] pronunciations → ${pronunciations.length} rule${pronunciations.length === 1 ? "" : "s"}`);
            }
          }
          return;
        }
        if (busy) {
          // Queue the audio instead of rejecting. The server runs Mica's
          // interrupt-or-queue decision logic (system prompt) and sends a
          // `{ type: "queued", depth: N }` frame so the client can show
          // the queue indicator. The audio is buffered and processed after
          // the current turn completes.
          queuedAudio.push({ audioB64: msg.audioB64, audioMime: msg.audioMime, voice: msg.voice });
          const depth = queuedAudio.length;
          ctx.broadcast({ type: "queued", depth });
          console.log(`[voice-agent] audio queued (depth=${depth})`);
          return;
        }

        // Bump delegation age. The next prompt build sees `turnsAgo`
        // and either keeps the section or omits it (cleared at >2).
        if (delegation) {
          delegation.turnsAgo++;
          if (delegation.turnsAgo > 2) {
            console.log(`[voice-agent] delegation context expired (was: ${delegation.filename})`);
            delegation = null;
            lastAmbient = null;  // delegation gone → ambient hint stale
          }
        }
        // Consume the ambient hint after one user turn. Either Mica acted
        // on it (re-dispatched the user's answer) or she didn't; either
        // way, replaying the same hint next turn would loop.
        if (lastAmbient) {
          // Defer the clear so this turn's prompt build still sees it.
          // Use a closure-captured copy so the clear at the end doesn't
          // race with concurrent ambient drains.
          const consume = lastAmbient;
          setImmediate(() => { if (lastAmbient === consume) lastAmbient = null; });
        }

        // Lazy-ensure voice servers are up.
        const status = getVoiceServerStatus();
        if (status.disabled) {
          ctx.broadcast({
            type: "error",
            error: "Voice servers disabled (MICA_DISABLE_VOICE=1)",
          });
          return;
        }
        if (!status.stt.ready || !status.tts.ready) {
          try {
            await ensureVoiceServers();
          } catch (err) {
            ctx.broadcast({
              type: "error",
              error: `Voice servers not ready: ${(err as Error).message}`,
            });
            return;
          }
        }

        busy = true;
        const tBusyStart = Date.now();
        console.log(`[voice-agent] s=${sessionTag} busy=true (onData turn begin)`);
        try {
          // 1. STT (or text-mode passthrough).
          let userText = "";
          if (msg.audioB64) {
            ctx.broadcast({ type: "thinking", phase: "stt" });
            const audioBuf = Buffer.from(msg.audioB64, "base64");
            const audioMime = msg.audioMime || "audio/webm";
            // Map mime → file extension. iOS Safari can only record
            // audio/mp4 (no webm support); other browsers do webm/opus.
            // Parakeet-side, librosa+ffmpeg uses the suffix as a hint
            // for the demuxer, so picking the right extension matters.
            const extByMime: Record<string, string> = {
              "audio/webm": ".webm",
              "audio/webm;codecs=opus": ".webm",
              "audio/ogg": ".ogg",
              "audio/ogg;codecs=opus": ".ogg",
              "audio/mp4": ".mp4",
              "audio/mp4;codecs=mp4a.40.2": ".mp4",
              "audio/aac": ".aac",
              "audio/wav": ".wav",
              "audio/wave": ".wav",
            };
            const ext = extByMime[audioMime] || extByMime[audioMime.split(";")[0]] || ".webm";
            const filename = `audio${ext}`;
            console.log(`[voice-agent] STT request: mime=${audioMime} bytes=${audioBuf.length} filename=${filename}`);
            try {
              const sttForm = new FormData();
              sttForm.append(
                "audio",
                new Blob([audioBuf], { type: audioMime }),
                filename,
              );
              const sttResp = await fetch(`${getSttUrl()}/transcribe`, {
                method: "POST",
                body: sttForm,
              });
              if (!sttResp.ok) {
                ctx.broadcast({
                  type: "error",
                  error: `STT failed: ${sttResp.status} ${(await sttResp.text()).slice(0, 200)}`,
                });
                return;
              }
              const sttJson = (await sttResp.json()) as { text?: string };
              userText = (sttJson.text || "").trim();
            } catch (err) {
              ctx.broadcast({
                type: "error",
                error: `STT request failed: ${(err as Error).message}`,
              });
              return;
            }
          } else if (typeof msg.message === "string") {
            userText = msg.message.trim();
          }

          if (!userText) {
            // Empty utterance — probably an accidental tap or silence.
            // If we had a buffered partial, leave it alone — user might
            // try again. Don't broadcast a fresh transcript event.
            ctx.broadcast({ type: "done" });
            return;
          }

          // Concatenate any buffered partial from a recent utterance so
          // the LLM sees the full continued thought ("I want to know"
          // + "what time it is in tokyo" → one message). The partial
          // expires after PARTIAL_EXPIRY_MS to avoid stale prefixes.
          if (pendingPartial && Date.now() - pendingPartialAt < PARTIAL_EXPIRY_MS) {
            userText = `${pendingPartial} ${userText}`;
            console.log(`[voice-agent] continuing buffered partial: ${JSON.stringify(userText.slice(0, 120))}`);
          }
          pendingPartial = null;
          clearPendingPartialTimer();

          // Heuristic completeness check. If the transcript trails off
          // (ends with conjunction, filler, article, preposition, etc.),
          // buffer it and wait for the user to continue rather than
          // dispatching a half-formed request to Qwen.
          //
          // _forceDispatch from the partial-expiry timer skips this —
          // otherwise we'd re-buffer the same text every 4 seconds
          // forever (the LLM never sees it, the user gets stuck in
          // italics with no response).
          if (!msg._forceDispatch && !looksComplete(userText)) {
            pendingPartial = userText;
            pendingPartialAt = Date.now();
            console.log(`[voice-agent] partial detected, buffering: ${JSON.stringify(userText.slice(0, 120))}`);
            ctx.broadcast({
              type: "transcript_partial",
              text: userText,
              waitingForMore: true,
            });
            // Auto-flush if no follow-up arrives — dispatch what we have.
            pendingPartialTimer = setTimeout(() => {
              if (pendingPartial) {
                console.log(`[voice-agent] partial expired after ${PARTIAL_EXPIRY_MS}ms, force-dispatching`);
                const expired = pendingPartial;
                pendingPartial = null;
                pendingPartialTimer = null;
                // Re-enter onData with the buffered text as a synthetic
                // user message. This routes through the regular dispatch
                // path including LLM tool loop.
                handler.onData?.(_clientId, { message: expired, voice: msg.voice, _forceDispatch: true });
              }
            }, PARTIAL_EXPIRY_MS);
            ctx.broadcast({ type: "done" });
            return;
          }

          console.log(`[voice-agent] transcript dispatched (${userText.length} chars): ${JSON.stringify(userText)}`);
          ctx.broadcast({ type: "transcript", text: userText });

          history.push({ role: "user", content: userText });
          if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
          }

          // 2. Build canvas-aware prompt.
          const cards = (await listCanvasFiles(sessionProject || undefined))
            .filter((c) => !c.name.startsWith(".") && c.name !== ctx.filename);

          // Full canvas listing for read_card / read_recent_replies /
          // card_status — these tools work on any file.
          const allCardsLines = cards
            .map((c) => {
              const dot = c.name.lastIndexOf(".");
              const kind = dot === -1 ? "file" : c.name.slice(dot + 1);
              return `  - ${c.name} (.${kind})`;
            })
            .join("\n");

          // Chat-class-only listing for `send_to_card`. Each line carries
          // the card's agent name (default per extension) and an optional
          // role description read from the card's file body — written by
          // the user via the pen icon (✎) on the card frame. Files-as-
          // identity, no separate settings UI.
          const chatCards = cards.filter((c) => {
            const dot = c.name.lastIndexOf(".");
            const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
            return CHAT_CLASS_EXTENSIONS.has(ext);
          });
          const chatCardRoles = await Promise.all(
            chatCards.map((c) => readChatCardRole(sessionProject, c.name)),
          );
          const chatCardsLines = chatCards.length === 0
            ? "  (none — open a .qwen / .claude / .opencode / .llm-chat card to route work)"
            : chatCards
                .map((c, i) => {
                  const dot = c.name.lastIndexOf(".");
                  const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
                  const agentName = AGENT_NAME_DEFAULTS[ext] || ext;
                  const role = chatCardRoles[i];
                  return role
                    ? `  - ${c.name} — ${agentName} — "${role}"`
                    : `  - ${c.name} — ${agentName}`;
                })
                .join("\n");

          // Top 3 most-recently-modified cards, with relative ages, so
          // voice can answer "what's new?" without firing a tool. Section
          // is omitted entirely when there's nothing meaningful to show.
          const recentLines = [...cards]
            .sort((a, b) => +new Date(b.modifiedAt) - +new Date(a.modifiedAt))
            .slice(0, 3)
            .map((c) => {
              const ageMs = Date.now() - new Date(c.modifiedAt).getTime();
              const ageMin = Math.floor(ageMs / 60_000);
              const age =
                ageMin <= 0
                  ? "just now"
                  : ageMin < 60
                    ? `${ageMin}m ago`
                    : `${Math.floor(ageMin / 60)}h ago`;
              return `  - ${c.name} — modified ${age}`;
            })
            .join("\n");

          const projectLabel = sessionProject || "(workspace)";

          // Project intent: first ~500 chars of canvas/spec.md, if any.
          // Empty string when there's no spec — section is omitted.
          const projectIntent = await loadProjectIntent(sessionProject);

          // Registered card classes — project-scoped (custom, in
          // .mica/card-classes/) + built-in. Inlined in the prompt so
          // the agent can answer "is the .hotdog class built?" without
          // introspecting class files (which it can't). The agent uses
          // this with canvas instance listing to distinguish:
          //   - Instance exists, class registered → card renders normally
          //   - Instance exists, class missing    → broken card (rare)
          //   - No instance, class registered     → user hasn't placed it
          const registeredClasses = await listRegisteredCardClasses(sessionProject);
          const projectClasses = registeredClasses.filter((c) => c.scope === "project");
          const builtinClasses = registeredClasses.filter((c) => c.scope === "builtin");

          // Ambient context: every small .md/.txt card on the canvas
          // root, content-inlined so voice "just knows" what's there
          // without a read_card round-trip. Spec.md is excluded when
          // projectIntent already covered it. See loadAmbientContext
          // for the budget and the <!-- voice-skip --> opt-out.
          const ambientExclude = new Set<string>(
            projectIntent ? ["canvas/spec.md", "spec.md"] : [],
          );
          const ambient = await loadAmbientContext(sessionProject, ambientExclude);

          // Pick a representative chat-style card filename to use in
          // examples — grounds the LLM in the actual canvas vocabulary.
          // Falls back to a generic "qwen.qwen" when no chat-style card
          // exists, in which case the LLM should still recognize that
          // dispatch isn't possible without a target.
          const chatLikeKinds = new Set(["qwen", "claude", "opencode", "llm-chat"]);
          const exampleCard = cards.find((c) => {
            const dot = c.name.lastIndexOf(".");
            return dot !== -1 && chatLikeKinds.has(c.name.slice(dot + 1));
          });
          const exampleFilename = exampleCard ? exampleCard.name : "qwen.qwen";

          // ── System prompt ───────────────────────────────────────
          //
          // Posture, not modes. The LLM gets whatever context exists
          // (project name always, intent + recent activity if present)
          // and a description of how voice should behave as that
          // context emerges. No branching on "blank vs full" — the
          // sections themselves carry the gradient.

          const promptParts: string[] = [];

          promptParts.push(
            `You are Mica, speaking on canvas "${projectLabel}". Use she/her pronouns when referring to yourself ("I sent that to Qwen", "let me check"). Reply in 1–2 spoken sentences. Speed matters.\n\n` +

            "CORE RULES\n\n" +

            "1. Call a tool to get specifics. When you need a specific value — a number, date, name, address, price, current event, or the status of an agent on this canvas — call the matching tool first, then speak the result:\n" +
            "  • search / web_fetch — current facts, news, prices, what's recently opened\n" +
            "  • time              — current time in any timezone\n" +
            "  • card_status       — an agent's busy/idle state and queue\n" +
            "  • read_card / read_recent_replies — canvas contents and a chat card's last reply\n\n" +

            "2. Pair every action with its tool call. Your prose describes what's happening; the tool call makes it happen. Emit them together in the same turn:\n" +
            "  • search → spoken answer woven from the results\n" +
            "  • send_to_card → spoken confirmation of what you sent\n" +
            "  • card_status → spoken status with reasoning over the queue\n\n" +

            "3. Treat every turn as a fresh decision. When the user asks for something done, emit a new tool call — past dispatches don't carry over. If \"still too subtle\" follows a prior fix, send a NEW send_to_card with the refined request.\n\n" +

            "4. Voice is the routing layer between the user and the chat agents. For send_to_card, the `message` argument is the exact words Parakeet transcribed from the user — send them as-is, no rewriting. The chat-card agent handles all interpretation, implementation choices, and follow-up questions. To inspect a card, use read_card or read_recent_replies. To check on an agent, card_status.\n\n" +

            "5. When uncertain, offer rather than guess. \"Want me to look that up?\" / \"Want me to ask Qwen?\" / \"Should I check what Qwen's working on?\" — let the user opt in. Better than fabricating.\n\n" +

            "6. Edit the queue, don't pile onto it. When the user is amending or cancelling something they JUST sent to a chat agent (within the last few turns — \"actually make it three paragraphs\", \"never mind, drop that\", \"change the city to Boston\"), don't dispatch a new message. Call card_status on that agent to read the queue items and their ids, then:\n" +
            "  • replace_queue_item — amendment to a still-pending item (preserves its position, just rewrites the text)\n" +
            "  • delete_queue_item  — cancellation of a still-pending item\n" +
            "  • send_to_card       — genuinely new work, or work the in-flight turn already started so it's too late to edit\n" +
            "If the user references the in-flight item (currentTask) rather than a queued one, you can't edit it — speak that and offer to send the amendment as a follow-up instead.\n",
          );

          // World-model primer — explicit definition of the Mica card
          // abstraction. Without this, the model reasons from generic
          // "card / file" intuitions and conflates instance-file
          // emptiness with "the card isn't built." This block defines
          // the three distinct files involved (spec / class / instance)
          // and forbids build-status inference from file size alone.
          promptParts.push(
            "## What a Mica card is\n" +
            "A Mica project has THREE different kinds of files that can describe one feature; do not conflate them:\n" +
            "1. **Spec** (e.g. `canvas/foo-spec.md`) — a Markdown design doc the user wrote. Tells you what the feature should do. Has nothing to do with whether the renderer exists.\n" +
            "2. **Card class definition** (e.g. `.mica/card-classes/foo/card.html` + `card.js` + `card.css` + `metadata.json`) — the actual rendered code. You can NOT see this directly; rely on the \"Registered card classes\" list below to know whether `.foo` has a class defined.\n" +
            "3. **Instance file** (e.g. `canvas/myfoo.foo`) — a tiny handle on the canvas. The extension routes to the card class; the file body is OFTEN EMPTY or a small JSON blob. For ALL card classes (built-in or custom), an empty instance file is the normal default state — it means \"this card is placed on the canvas; no per-instance content has been authored.\" It does NOT mean the card class is unbuilt, broken, or missing.\n\n" +
            "Therefore: if you see `canvas/myfoo.foo` on the canvas AND `.foo` appears in the registered-classes list below, the card IS built and rendering — period. Whether the user has typed anything INTO that instance file is irrelevant to build-status. NEVER say phrases like \"the card is still empty\", \"the card hasn't been built\", \"nothing's been built yet\", or \"the card file is empty\" based on `read_card` returning empty content. Those statements confuse the user, who is looking at a working card on their screen.\n\n" +
            "If the user asks \"where are we?\" or \"is the card built?\", check the registered-classes list AND the canvas listing below before answering. If a card class isn't registered, you can truthfully say the class needs to be built. If the class IS registered, say the card is on the canvas and ready, even if its instance file is empty.\n",
          );

          // Registered card classes — class definitions actually present.
          // Splits into built-in (ship with Mica) and project-scoped
          // (custom classes in .mica/card-classes/). The voice agent
          // uses this with the canvas listing below to answer build-
          // status questions truthfully.
          if (registeredClasses.length > 0) {
            const builtinLine = builtinClasses.length > 0
              ? "Built-in classes: " + builtinClasses.map((c) => `.${c.name}`).join(", ") + ".\n"
              : "";
            const projectLine = projectClasses.length > 0
              ? "Project-scoped classes (custom for THIS project): " + projectClasses.map((c) => `.${c.name}`).join(", ") + ". These ARE built — their definitions live in `.mica/card-classes/`.\n"
              : "No project-scoped classes registered yet (no entries under `.mica/card-classes/`). Any instance file whose extension matches a built-in class is still a working card.\n";
            promptParts.push(
              "## Registered card classes (renderers that exist)\n" +
              projectLine +
              builtinLine +
              "An instance file (e.g. `canvas/foo.bar`) is a working, rendered card on the canvas if AND ONLY IF `.bar` appears above. The instance file's body content has no bearing on whether the class is built.\n",
            );
          }

          if (projectIntent) {
            promptParts.push(
              "## Project intent (from canvas/spec.md — already in your context)\n" +
              projectIntent + "\n\n" +
              "Answer questions about the project directly from the section above. The spec.md content is already loaded — read_card on it is redundant.\n",
            );
          }

          if (ambient.length > 0) {
            const blocks = ambient.map((it) => {
              const trailer = it.truncated ? "\n…(truncated; call read_card for more)" : "";
              return `### ${it.filename}\n${it.content}${trailer}`;
            }).join("\n\n");
            promptParts.push(
              "## Ambient context (canvas .md/.txt cards — already loaded; don't read_card these unless you need a different angle)\n" +
              blocks + "\n",
            );
          }

          if (recentLines) {
            promptParts.push(
              "## What's recent on the canvas\n" +
              recentLines + "\n",
            );
          }

          if (allCardsLines) {
            promptParts.push(
              "## Cards on the canvas (use with read_card / read_recent_replies / card_status)\n" +
              allCardsLines + "\n",
            );
          }

          promptParts.push(
            "## Chat cards (the only valid targets for send_to_card)\n" +
            chatCardsLines + "\n" +
            "Empty instance files are NORMAL — agent cards render from their " +
            "class definition, not from file content. If `read_card` returns " +
            "empty content for a card listed here (or anywhere in the canvas " +
            "above), the card IS on the canvas; do NOT tell the user it " +
            "doesn't exist.\n",
          );

          // Default-target hint from the gear panel. When set, the LLM
          // should default to this filename when the user says "ask the
          // agent" / "send it to the agent" / similar without naming a
          // specific card. Only injected when defaultDispatchTarget
          // points at a card that's actually in the chatCards list —
          // otherwise it'd send the LLM toward a target send_to_card
          // would reject as not-open.
          if (defaultDispatchTarget && chatCards.some((c) => c.name === defaultDispatchTarget)) {
            promptParts.push(
              "## Default dispatch target\n" +
              `When the user says "ask the agent" / "send this along" / similar without naming a specific card, default the send_to_card target to: \`${defaultDispatchTarget}\`.\n` +
              "If the user explicitly names a different card, route to that one instead.\n",
            );
          }

          if (delegation) {
            const turnsLabel = delegation.turnsAgo === 0
              ? "just now"
              : delegation.turnsAgo === 1
                ? "1 turn ago"
                : `${delegation.turnsAgo} turns ago`;
            // Optional inline ambient hint — the user just heard <agent>
            // speak something via TTS. If it was a question, the user's
            // next utterance is almost certainly the answer. Without
            // this, Mica's history shows only her own user/assistant
            // turns and she can't connect "yes" to the agent's "want
            // me to use TypeScript?". Question detection is heuristic
            // ('?' anywhere); the LLM judges intent.
            const ambientHintLine = lastAmbient && lastAmbient.filename === delegation.filename
              ? `\nAmbient just played from ${delegation.agentName}${lastAmbient.looksLikeQuestion ? " (CONTAINS A QUESTION — user is likely answering it)" : ""}: "${lastAmbient.preview}"\n`
              : "";
            promptParts.push(
              "## Last delegation\n" +
              `You delegated to ${delegation.filename} (${delegation.agentName}) ${turnsLabel}.\n` +
              `Summary: "${delegation.summary}"\n` +
              ambientHintLine + "\n" +
              "When the user's next utterance is:\n" +
              `- An answer to a question ${delegation.agentName} just asked (see ambient above if any) → re-dispatch the user's answer to ${delegation.filename} via send_to_card with their words as the <message>. Pair with a brief <say> confirming you sent it.\n` +
              `- A correction or clarification of that delegation → re-dispatch to the SAME ${delegation.filename} with an updated <message>; pair it with a fresh <say> that says what you sent.\n` +
              "- A follow-up or elaboration in the same context → answer directly (small clarifications) or re-dispatch to the same agent with the elaboration.\n" +
              "- An unrelated topic (non-sequitur) → answer directly if you can, or open a fresh delegation. Don't conflate with the prior context.\n" +
              `- An explicit stop intent (\"stop\", \"cancel\", \"never mind\", \"wait\", or paraphrase) → emit <tool name=\"abort\"/> + a brief <say> confirmation (\"OK, stopping\"). The server cascades the cancel to ${delegation.filename}.\n`,
            );
          }

          // ── Recent agent replies (prompt-resident working memory) ──
          // The user often asks follow-ups on what they just heard
          // ("more about the dough", "how long does it rest?", "what
          // about the last step?"). Surface the recent reply text so
          // Mica answers directly without re-dispatching. For truncated
          // tails or older replies, read_recent_replies pages in more.
          if (recentAgentReplies.length > 0) {
            const ageStr = (ts: number) => {
              const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
              if (sec < 60) return `${sec}s ago`;
              if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
              return `${Math.floor(sec / 3600)}h ago`;
            };
            const lines: string[] = [];
            lines.push("## Recent agent replies (your working memory)\n");
            lines.push(
              "You have the recent agent replies below in prompt-resident memory. " +
              "For follow-up questions (\"more about X\", \"how long\", \"give me the steps\") " +
              "answer directly from this text — no re-dispatch needed unless the user wants " +
              "NEW work. If a reply is marked [TRUNCATED] and you need the tail, call " +
              "`<tool name=\"read_recent_replies\"><file>FILENAME</file><n>1</n></tool>` " +
              "to fetch the full text. Pick the entry matching the user's topic by filename + " +
              "their original request.\n\n",
            );
            for (let i = 0; i < recentAgentReplies.length; i++) {
              const r = recentAgentReplies[i];
              const label = i === 0 ? "Most recent (just spoken aloud)" : `Earlier #${i}`;
              const dispatchedLine = r.dispatchedMessage
                ? `What you sent ${r.agent}: "${r.dispatchedMessage}"\n`
                : "";
              const userRequestLine = r.userRequest
                ? `User's request: "${r.userRequest}"\n`
                : "";
              const truncMarker = r.truncated ? " [TRUNCATED — call read_recent_replies for full text]" : "";
              lines.push(
                `### ${label}\n` +
                `Agent: ${r.agent} on ${r.filename}\n` +
                userRequestLine +
                dispatchedLine +
                `Received: ${ageStr(r.receivedAt)}\n` +
                `Reply text${truncMarker}:\n${r.content}\n\n`,
              );
            }
            promptParts.push(lines.join(""));
          }

          // Tool table + XML-grammar hard rules — only useful for the
          // legacy XML path. The SDK injects tool descriptions
          // automatically from `description` fields; teaching the model
          // XML format here makes it imitate the format in its TEXT
          // output instead of using vLLM's native function-calling API.
          if (process.env.MICA_VOICE_SDK !== "1") {
            promptParts.push(
              "## Tools\n" +
              `<tool name="list_cards"/>` + " — fresh canvas listing. Rare; the list above is usually enough.\n" +
              `<tool name="read_card"><file>EXACT_FILENAME</file></tool>` + " — read a card's contents (markdown, spec, json, etc). Use when answering needs project-specific data you don't already have.\n" +
              `<tool name="card_status"><file>EXACT_FILENAME</file></tool>` + " — busy/idle hint for a chat card. Use for \"is Qwen still working?\".\n" +
              `<tool name="read_recent_replies"><file>EXACT_FILENAME</file><n>1</n></tool>` + " — fetch the last N assistant replies from a chat card. Use for \"what did Qwen just say?\".\n" +
              `<tool name="send_to_card"><file>EXACT_FILENAME</file><message>WHAT_TO_DO</message></tool>` + " — forward to a chat card from the \"Chat cards\" section above. Targets outside that section are rejected. Pick by role description when present; pick by filename when names collide.\n" +
              `<tool name="delete_queue_item"><file>EXACT_FILENAME</file><id>QUEUE_ITEM_ID</id></tool>` + " — remove a pending item from a chat card's queue. Get the id from card_status. Use when the user cancels a request that hasn't been picked up yet (\"never mind\", \"drop that\").\n" +
              `<tool name="replace_queue_item"><file>EXACT_FILENAME</file><id>QUEUE_ITEM_ID</id><message>NEW_TEXT</message></tool>` + " — rewrite a pending item's text in place. Get the id from card_status. Use when the user amends a request that's still queued.\n" +
              `<tool name="abort"/>` + " — user wants to stop. Cancels the last delegation (if any) and stops in-flight playback. Pair with a brief <say> confirmation (\"OK, stopping\").\n" +
              `<tool name="search"><query>SEARCH_QUERY</query></tool>` + " — web search via Tavily. Use for facts you don't know (current events, latest versions, simple lookups). Returns top results; you summarize.\n" +
              `<tool name="web_fetch"><url>URL</url></tool>` + " — fetch a URL and return its text. Use after search to drill into a specific result, or when the user gives a URL directly.\n" +
              `<tool name="time"><tz>IANA_TIMEZONE</tz></tool>` + " — current time in the given IANA timezone (e.g. \"America/Los_Angeles\", \"Asia/Tokyo\"). Zero latency. Use whenever the user asks \"what time is it in X\".\n",
            );

            promptParts.push(
              "## Hard rules\n" +
              "1. Place every <tool> as a sibling of <say>, outside it. Tools and say blocks live side-by-side at the top level.\n" +
              "2. For send_to_card, copy the <file> verbatim from the \"Chat cards\" section. Cards from \"Cards on the canvas\" are read-only — use them with read_card / read_recent_replies / card_status.\n" +
              "3. For send_to_card, <message> is the user's request forwarded — fix obvious ASR errors only. The chat-card agent handles everything else.\n" +
              "4. Speak only what's true. Claim a dispatch in <say> (\"I asked Qwen\", \"I sent that to X\") only when you also emit a matching <tool name=\"send_to_card\"> in the same response. When you're not dispatching, offer instead: \"want me to ask Qwen?\" or \"I can route that to Qwen if you'd like.\"\n" +
              "5. Speak agent status only when you've verified it. Don't say \"Qwen finished\" / \"Qwen is still working\" / \"Qwen is busy\" from a guess — call <tool name=\"card_status\"> to check, then speak the verified state. When the user asks for status and you haven't checked, either call card_status now or say \"I'm not sure — want me to check?\". The ambient hint above (if present) IS verified ground truth — you can paraphrase it. Anything else about an agent's state is hallucination.\n" +
              "6. After dispatching, give a brief spoken confirmation in <say>. If a follow-up step is obvious, mention it.\n",
            );
          }
          // SDK path: no extra rules block — the 5 CORE RULES above
          // already cover behavior, and tool descriptions are injected
          // into the model's context by the SDK automatically.

          promptParts.push(
            "## Interrupt vs queue (your judgment)\n" +
            "A user may speak while you're already processing a turn. You decide whether to\n" +
            "interrupt (cancel the current turn and handle the new input) or queue (let the\n" +
            "current turn finish, then handle the new input next).\n\n" +
            "**Interrupt when:**\n" +
            "- The user corrects themselves: \"actually I meant…\", \"no wait…\", \"correction…\"\n" +
            "- The user says something unrelated to the current task (non-sequitur)\n" +
            "- The user explicitly asks you to stop\n\n" +
            "**Queue when:**\n" +
            "- The user adds to the current task: \"also…\", \"and also…\", \"while you're at it…\"\n" +
            "- The user is elaborating or following up on the current task\n\n" +
            "**When unsure:** Briefly ask: \"Should I stop what I'm doing and handle that, or let it finish first?\"\n\n" +
            "The user doesn't need to choose — you handle it. Only ask when you're genuinely uncertain.\n",
          );

          // Output-grammar examples — XML-format only; skipped for SDK
          // path where the model emits structured tool calls natively.
          if (process.env.MICA_VOICE_SDK !== "1") promptParts.push(
            "## Output grammar — shape templates\n" +
            "These show the SHAPE of your output for different intents. Speak the actual answer in your own words; the brackets and pseudo-content are placeholders. Do NOT emit the role labels \"Assistant:\" or \"User:\" — your response is ALWAYS just the <tool> and/or <say> blocks, never wrapped in a role prefix.\n\n" +

            "General knowledge — direct answer:\n" +
            "  <say>brief spoken answer in your own words</say>\n\n" +

            "Time-bound fact — tool first, then speak the result:\n" +
            "  <tool name=\"time\"><tz>Asia/Tokyo</tz></tool><say>spoken answer from the tool result</say>\n" +
            "  <tool name=\"search\"><query>focused query string</query></tool><say>spoken answer woven from the search results plus context you know</say>\n\n" +

            "Unsure of a specific — offer to look it up rather than fabricate:\n" +
            "  <say>I don't have that on hand — want me to look it up?</say>\n\n" +

            "Hard or analytical work — route to a chat-card agent:\n" +
            `  <tool name="send_to_card"><file>${exampleFilename}</file><message>concrete description of the work to do</message></tool><say>brief confirmation of what you sent</say>\n\n` +

            "Status / queue check on a chat card — call card_status first, then REASON over the result:\n" +
            `  <tool name="card_status"><file>${exampleFilename}</file></tool><say>plain status with reasoning, e.g. \"Qwen is busy with X; one item queued behind. Want me to add yours, replace what's queued, or wait?\"</say>\n\n` +

            "Reading what a chat card last said:\n" +
            `  <tool name="read_recent_replies"><file>${exampleFilename}</file></tool><say>summary or excerpt of the reply</say>`,
          );

          const systemPrompt = promptParts.join("\n");

          const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
            { role: "system", content: systemPrompt },
            // Feed the LLM its raw prior outputs (with <tool>/<say> tags)
            // so it sees its own past tool calls and keeps following the
            // grammar. User turns have no raw — content IS the raw.
            ...history.map((h) => ({ role: h.role, content: h.raw || h.content })),
          ];

          // ── SDK path (env-gated) ─────────────────────────────────
          // When MICA_VOICE_SDK=1, use the Vercel AI SDK + vLLM native
          // function calling instead of the legacy XML protocol below.
          // Tool calls come back structured (no text-regex parsing).
          //
          // Two-phase: (1) run the LLM, buffer text + count tool calls;
          // (2) override-check the buffered text (catches "I asked Qwen"
          // claims when toolCallsFired === 0); (3) TTS the final text
          // via the SentenceFanout. We can't stream TTS DURING the LLM
          // run because we don't know whether to scrub the text until
          // the stream finishes and we can count tool calls — once audio
          // has played, scrubbing is impossible.
          if (process.env.MICA_VOICE_SDK === "1") {
            // Speak unless the session has zero attached subscribers
            // (every tab/card consumer gone). Visibility-hidden tabs still
            // hear audio; only fully-disconnected sessions skip.
            const skipTts = !hasSubscriber();
            console.log(
              `[voice-agent:sdk] s=${sessionTag} turn start skipTts=${skipTts} systemPrompt=${systemPrompt.length}ch history=${history.length}msgs`,
            );
            ctx.broadcast({ type: "thinking", phase: "llm" });
            activeAbort = new AbortController();
            const sdkMessages = history.map((h) => ({ role: h.role, content: h.content }));
            const runArgs = {
              systemPrompt,
              messages: sdkMessages,
              channelMgr,
              sessionProject,
              abortSignal: activeAbort.signal,
              ctx: { broadcast: ctx.broadcast, sendTo: ctx.sendTo },
              cardStatusFor,
              sessionTag,
              readRecentReplies: async (project: string | null, file: string, n: number) => {
                const hist = await readChatHistoryFor(project, file);
                const replies = hist.filter((m) => m.role === "assistant").slice(-n);
                return replies.map((m, i) => `Reply ${i + 1}: ${m.content}`).join("\n\n") || "(no assistant replies yet)";
              },
              onDelegationTracked: (file: string, message: string) => {
                const dot = file.lastIndexOf(".");
                const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
                delegation = {
                  filename: file,
                  agentName: AGENT_NAME_DEFAULTS[ext] || ext,
                  summary: message.slice(0, 150),
                  turnsAgo: 0,
                };
                console.log(`[voice-agent:sdk] delegation tracked: ${file} (${delegation.agentName})`);
              },
              abortHandler: async () => {
                const droppedQueue = queuedAudio.length;
                queuedAudio.length = 0;
                let cascadeTarget: string | null = null;
                if (delegation) {
                  cascadeTarget = delegation.filename;
                  try { channelMgr.dispatchToFilename(sessionProject, delegation.filename, { type: "interrupt" }); } catch { /* best effort */ }
                }
                ctx.broadcast({ type: "abort" });
                delegation = null;
                return { droppedQueue, cascadeTarget };
              },
            };

            // Pre-turn intent classification. Tiny LLM call labels
            // the utterance (ACTION_DISPATCH / ACTION_STATUS /
            // ACTION_LOOKUP / ANSWER / CLARIFY) and we set
            // toolChoice='required' for action intents — that way
            // the model literally cannot claim to dispatch without
            // firing a tool, because the SDK refuses to finish the
            // turn without at least one tool call. The regex-based
            // post-hoc override below stays as a backstop for cases
            // the classifier mis-labels.
            const lastUserMsg = sdkMessages.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";
            let intent: Awaited<ReturnType<typeof classifyUserIntent>> | null = null;
            let intentToolChoice: "auto" | "required" | "none" = "auto";
            if (lastUserMsg) {
              intent = await classifyUserIntent(lastUserMsg, sessionTag);
              intentToolChoice = toolChoiceForIntent(intent);
              console.log(`[voice-agent:sdk] s=${sessionTag} intent=${intent} → toolChoice=${intentToolChoice}`);
              ctx.broadcast({ type: "intent", intent, toolChoice: intentToolChoice });
            }

            // First pass: classifier-gated toolChoice. Action intents
            // force a tool call; ANSWER / CLARIFY leave the model free
            // to answer directly.
            //
            // The first pass is wrapped in a 30s timeout. Observed
            // failure: vLLM's guided decoder occasionally hangs after
            // streaming the SSE framing markers (`start` + `start-step`)
            // when `toolChoice: 'required'` is combined with a large
            // tool schema (11 tools) and a sizeable prompt (>15KB body).
            // Heartbeat keeps ticking with `parts=2`; nothing else
            // arrives. Without a timeout, `busy` stays true forever
            // and the user sees STT silently dropping audio. The
            // timeout aborts the stuck call, then we recover (below).
            const tFirstPass = Date.now();
            let firstPassTimedOut = false;
            const firstPassTimeout = setTimeout(() => {
              console.warn(
                `[voice-agent:sdk] s=${sessionTag} first pass exceeded 30s — aborting`,
              );
              firstPassTimedOut = true;
              try { activeAbort?.abort(); } catch { /* ignore */ }
            }, 30000);
            console.log(`[voice-agent:sdk] s=${sessionTag} runVoiceTurn(first pass) awaiting…`);
            let result: Awaited<ReturnType<typeof runVoiceTurn>>;
            try {
              result = await runVoiceTurn({ ...runArgs, toolChoice: intentToolChoice });
            } finally {
              clearTimeout(firstPassTimeout);
              console.log(
                `[voice-agent:sdk] s=${sessionTag} runVoiceTurn(first pass) returned after ${Date.now() - tFirstPass}ms cancelled=${result?.cancelled ?? "?"} timedOut=${firstPassTimedOut}`,
              );
            }

            // Recovery pass. When the first pass timed out (not
            // user-aborted), retry once with `toolChoice: 'auto'` so
            // vLLM is free to pick a tool or stream text normally —
            // the stall is specifically triggered by forced tool
            // generation under guided decoding. Loses the *guarantee*
            // that a tool fires, but in exchange recovers from the
            // wedge and usually still serves the user's intent (the
            // model picks the right tool unforced in the same way it
            // did on the immediately preceding turn). We don't loop;
            // one recovery is enough. If the recovery also times out,
            // vLLM is genuinely unhealthy — speak a static error.
            if (firstPassTimedOut && result.cancelled) {
              console.warn(
                `[voice-agent:sdk] s=${sessionTag} first-pass timed out; starting recovery with toolChoice='auto'`,
              );
              ctx.broadcast({
                type: "error",
                error: "Model stalled on forced tool call; retrying without constraint.",
              });
              // Fresh abort controller — the previous one fired on
              // timeout and would short-circuit the recovery.
              activeAbort = new AbortController();
              const tRecovery = Date.now();
              let recoveryTimedOut = false;
              const recoveryTimeout = setTimeout(() => {
                console.warn(
                  `[voice-agent:sdk] s=${sessionTag} recovery pass exceeded 30s — aborting`,
                );
                recoveryTimedOut = true;
                try { activeAbort?.abort(); } catch { /* ignore */ }
              }, 30000);
              try {
                result = await runVoiceTurn({
                  ...runArgs,
                  abortSignal: activeAbort.signal,
                  toolChoice: "auto",
                });
              } finally {
                clearTimeout(recoveryTimeout);
                console.log(
                  `[voice-agent:sdk] s=${sessionTag} runVoiceTurn(recovery) returned after ${Date.now() - tRecovery}ms cancelled=${result?.cancelled ?? "?"} timedOut=${recoveryTimedOut}`,
                );
              }
              // If recovery also stalled, vLLM is sick. Speak a
              // concrete error so the user knows to try again.
              if (recoveryTimedOut && result.cancelled) {
                console.warn(
                  `[voice-agent:sdk] s=${sessionTag} recovery also timed out — substituting error speakable`,
                );
                result = {
                  ...result,
                  speakable: "I'm having trouble reaching the model right now. Try again in a moment.",
                  cancelled: false,
                };
              }
            }

            // Hallucinated-dispatch detector. Fires when the model SAID
            // it did something (claim/promise/nameDrop) but emitted ZERO
            // tool calls. The detection uses the regex heuristics from
            // the legacy override — same patterns, but now serves a
            // different purpose: trigger a retry, not just substitute.
            const detectHallucinatedDispatch = (text: string): {
              fired: boolean; explicitClaim: boolean; implicitPromise: boolean; nameDrop: boolean;
            } => {
              // Verbs that indicate the assistant CLAIMS a completed
              // dispatch/edit action. Each was observed in production
              // as a false claim where no tool actually fired.
              const explicitClaim = /\b(?:asked|sent (?:that |it )?to|told|dispatched|routed (?:that|it)|forwarded (?:that|it)|kicked off|kicked it off|handed (?:that|it) (?:off|over)|added|updated|included|passed (?:that |it )?along|shared|submitted|ran by|run by|put in|noted)\b/i.test(text);
              // Verbs that indicate the assistant PROMISES to do
              // something — same fail mode if no tool fires.
              const implicitPromise = /\b(?:let me (?:check|find out|look into|see (?:what|if|whether)|ask|pull (?:that|it) up|get|get back|consult|verify|grab|add|update|include|share|submit)|i(?:'ll| will) (?:check|find out|look into|see|ask|pull|get|consult|verify|grab|bring (?:that|it) up|run (?:that|it) by|pass (?:that|it) along|add|update|include|share|submit)|i(?:'m| am) (?:checking|asking|looking|consulting|adding|updating|including|sharing|submitting)|hold on while|just a (?:moment|second|sec)|one (?:moment|second|sec)|give me a (?:moment|second|sec)|on it|let's see what|getting that for you)\b/i.test(text);
              const chatAgentNames = chatCards
                .map((c) => {
                  const dot = c.name.lastIndexOf(".");
                  const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
                  return AGENT_NAME_DEFAULTS[ext] || ext;
                })
                .filter(Boolean);
              const nameDrop = chatAgentNames.length > 0
                && new RegExp(`\\b(?:${chatAgentNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i").test(text);
              const offerPhrasing = /\b(?:want me to|do you want me to|would you (?:like|want) me to|should i|shall i|i could (?:ask|have|send|route|forward|run by)|i can (?:ask|have|send|route|forward|run by)|let me know if you want)\b/i.test(text);
              const selfIntro = /^\s*(?:I(?:'m| am)\s+(?:Qwen|Claude(?:\s+Code)?|OpenCode))\b/i.test(text);
              const nameDropIsOffer = nameDrop && !explicitClaim && !implicitPromise && offerPhrasing;
              const nameDropIsSelfIntro = nameDrop && !explicitClaim && !implicitPromise && selfIntro;
              const fired = (explicitClaim || implicitPromise || nameDrop) && !nameDropIsOffer && !nameDropIsSelfIntro;
              return { fired, explicitClaim, implicitPromise, nameDrop };
            };

            // Retry once with toolChoice='required' + an injection if the
            // first pass produced a dispatch-claim with no tool. The
            // injected user message tells the model exactly what to do:
            // call the appropriate tool now. tool_choice='required'
            // forces the model to emit a tool call this round — it
            // can't repeat the same hallucinated prose.
            let retried = false;
            // Trigger retry only when the user's intent was a dispatch
            // AND no send_to_card actually fired AND the model said
            // something (so there's prose to scrub). For ACTION_STATUS /
            // ACTION_LOOKUP / ANSWER / CLARIFY, `!sendDispatchedOk` is
            // the EXPECTED outcome — those intents shouldn't dispatch
            // anything. Without this gate, the regex below fires on
            // legitimate status answers that name a chat agent
            // ("Qwen's idle — no code exists yet") because `nameDrop`
            // sees "Qwen" and assumes hallucinated dispatch.
            const shouldConsiderRetry = intent === "ACTION_DISPATCH"
              && !result.sendDispatchedOk
              && !!result.speakable;
            if (shouldConsiderRetry) {
              const detection = detectHallucinatedDispatch(result.speakable);
              if (detection.fired) {
                console.log(`[voice-agent:sdk] retry with toolChoice='required' (tools=${result.toolCallsFired}, sendOk=false, explicit=${detection.explicitClaim} implicit=${detection.implicitPromise} nameDrop=${detection.nameDrop}): ${JSON.stringify(result.speakable.slice(0, 200))}`);
                const retryMessages = [
                  ...sdkMessages,
                  { role: "assistant" as const, content: result.speakable },
                  { role: "user" as const, content:
                    "(System note: your previous reply claimed an action but you did not call any tool. Emit EXACTLY ONE tool call now — the single tool that matches what you said you would do: send_to_card for a dispatch claim, card_status for a status claim, search or web_fetch for a lookup claim. Do NOT repeat the call. Do NOT call multiple tools. One call, then stop.)"
                  },
                ];
                // Wrap the retry in a 15s timeout. Without this, a stuck
                // retry (model loops through tool-input deltas without
                // committing, or vLLM hangs) blocks the whole onData
                // handler — busy stays true, queued audio piles up, all
                // subsequent user utterances stall. Race with a timeout
                // so we always recover within 15s.
                const retryAbort = new AbortController();
                const retryTimeout = setTimeout(() => {
                  console.warn(`[voice-agent:sdk] s=${sessionTag} retry exceeded 15s — aborting`);
                  retryAbort.abort();
                }, 15000);
                const tRetry = Date.now();
                console.log(`[voice-agent:sdk] s=${sessionTag} runVoiceTurn(retry) awaiting…`);
                try {
                  const retry = await runVoiceTurn({
                    ...runArgs,
                    messages: retryMessages,
                    abortSignal: retryAbort.signal,
                    toolChoice: "required",
                    // Hard cap retry to one step so the model can't
                    // pile on by repeatedly calling send_to_card across
                    // sequential steps (seen in production: 3× same
                    // send_to_card with identical message).
                    maxSteps: 1,
                  });
                  console.log(
                    `[voice-agent:sdk] s=${sessionTag} runVoiceTurn(retry) returned after ${Date.now() - tRetry}ms`,
                  );
                  retried = true;
                  if (retry.toolCallsFired > 0) {
                    console.log(`[voice-agent:sdk] retry succeeded (tools=${retry.toolCallsFired}, sendOk=${retry.sendDispatchedOk})`);
                    // If retry succeeded with tools but produced no
                    // spoken text (common when toolChoice='required'
                    // makes the model emit tools and stop), synthesize
                    // a brief stock confirmation so the user hears
                    // SOMETHING after their request landed.
                    if (!retry.speakable.trim()) {
                      if (retry.sendDispatchedOk) {
                        retry.speakable = "Done — I just sent that over.";
                      } else {
                        retry.speakable = "Done.";
                      }
                      console.log(`[voice-agent:sdk] retry had empty speakable; substituted stock confirmation`);
                    }
                    result = retry;
                  } else {
                    console.log(`[voice-agent:sdk] retry produced no tool call — falling through to fallback`);
                  }
                } catch (err) {
                  // AbortError from timeout, or any other retry-side
                  // failure. Fall through to fallback substitution.
                  console.warn(
                    `[voice-agent:sdk] s=${sessionTag} runVoiceTurn(retry) threw after ${Date.now() - tRetry}ms: ${(err as Error).message} — falling through to fallback`,
                  );
                  retried = true;
                } finally {
                  clearTimeout(retryTimeout);
                }
              }
            }

            // Fallback substitution if BOTH passes failed to dispatch
            // while making a dispatch claim. Gated on intent ===
            // ACTION_DISPATCH for the same reason as the retry gate:
            // `!sendDispatchedOk` is the expected outcome for status /
            // lookup / answer / clarify intents and must not trigger
            // a substitution that would clobber a legitimate answer.
            let speakable = result.speakable;
            let usedFallback = false;
            if (intent === "ACTION_DISPATCH" && !result.sendDispatchedOk && speakable) {
              const detection = detectHallucinatedDispatch(speakable);
              if (detection.fired) {
                console.log(`[voice-agent:sdk] fallback substitution after ${retried ? "failed retry" : "no-retry"}: ${JSON.stringify(speakable.slice(0, 200))}`);
                const chatAgentNames = chatCards
                  .map((c) => {
                    const dot = c.name.lastIndexOf(".");
                    const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
                    return AGENT_NAME_DEFAULTS[ext] || ext;
                  })
                  .filter(Boolean);
                const namedAgent = chatAgentNames.find((n) =>
                  new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(speakable)
                );
                const namedCard = namedAgent
                  ? chatCards.find((c) => {
                      const ext = c.name.slice(c.name.lastIndexOf(".") + 1).toLowerCase();
                      return (AGENT_NAME_DEFAULTS[ext] || ext).toLowerCase() === namedAgent.toLowerCase();
                    })
                  : undefined;
                const targetName = namedCard?.name || (chatCards[0]?.name ?? "a chat card");
                const targetAgent = namedAgent || (chatCards[0] ? (AGENT_NAME_DEFAULTS[chatCards[0].name.slice(chatCards[0].name.lastIndexOf(".") + 1).toLowerCase()] || "the agent") : "the agent");

                if (detection.implicitPromise && !detection.explicitClaim && !detection.nameDrop) {
                  speakable = "I didn't actually look that up. Want me to search the web for it?";
                } else if (detection.nameDrop && !detection.explicitClaim && !detection.implicitPromise) {
                  speakable = `I didn't actually check on ${targetAgent} — want me to look at the status, or send it something?`;
                } else {
                  speakable = chatCards.length > 0
                    ? `I didn't actually route that anywhere — want me to send it to ${targetName}?`
                    : `I didn't route that anywhere — open a chat card first if you want me to forward work.`;
                }
                usedFallback = true;
              }
            }

            console.log(`[voice-agent:sdk] speaking ${speakable.length} chars (tools=${result.toolCallsFired}, sendOk=${result.sendDispatchedOk}, fallback=${usedFallback}): ${JSON.stringify(speakable.slice(0, 500))}`);

            // Phase 3: TTS the final text via SentenceFanout. The fanout
            // splits by sentence and broadcasts assistant_speech_text +
            // assistant_speech (audio) per sentence — same shape the
            // voice card UI consumed from the legacy path.
            let audioFramesEmitted = 0;
            const fanout = new SentenceFanout({
              ttsUrl: getTtsUrl(),
              voice: msg.voice || voicePref,
              skipTts,
              pronunciations,
              onFrame: (f) => {
                if (f.type === "sentence") {
                  ctx.broadcast({ type: "assistant_speech_text", sentence_idx: f.idx, text: f.text });
                } else if (f.type === "audio") {
                  audioFramesEmitted++;
                  ctx.broadcast({ type: "assistant_speech", sentence_idx: f.idx, wav_b64: f.wavB64 });
                } else {
                  console.warn(`[voice-agent:sdk] ${f.message}`);
                }
              },
            });
            ttsActive = true;
            currentFanout = fanout;
            ctx.broadcast({ type: "thinking", phase: "tts" });
            try {
              if (speakable) {
                fanout.feed(speakable);
                fanout.end();
                await fanout.drain();
              }
            } finally {
              ttsActive = false;
              if (currentFanout === fanout) currentFanout = null;
              setImmediate(() => { void drainAnnouncementQueue(); });
            }
            console.log(`[voice-agent:sdk] turn done — audio frames emitted=${audioFramesEmitted}`);

            history.push({ role: "assistant", content: speakable });
            if (history.length > MAX_HISTORY) {
              history.splice(0, history.length - MAX_HISTORY);
            }
            ctx.broadcast({ type: "assistant", content: speakable, fallback: usedFallback });
            ctx.broadcast({ type: "done" });
            return;
          }

          // 3. LLM loop.
          //
          // Read tools (read_card, card_status, read_recent_replies) need
          // their results fed back to the LLM so it can summarize in the
          // SAME turn. Action tools (list_cards, send_to_card) don't —
          // their effect is immediate and the LLM already chose what to
          // say alongside them. So the loop runs at most twice:
          //   iter 0: initial LLM call. If only action tools, finish.
          //           If read tools, execute them, append results, loop.
          //   iter 1: LLM sees the read results, emits the final <say>.
          // After the loop, action tools are dispatched (deferred so the
          // spoken confirmation is timed with the actual dispatch).
          const READ_TOOLS = new Set(["read_card", "card_status", "read_recent_replies", "search", "web_fetch", "time"]);
          const allSayBlocks: Array<{ attrs: string; body: string; selfClosing: boolean }> = [];
          const pendingActionTools: Array<{ name: string; tb: { attrs: string; body: string; selfClosing: boolean } }> = [];
          let lastLlmRaw = "";

          for (let iter = 0; iter < 2; iter++) {
            ctx.broadcast({ type: "thinking", phase: "llm" });
            activeAbort = new AbortController();
            let llmRaw = "";
            try {
              const llmResp = await fetch(LLM_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  model: "qwen-voice",
                  messages,
                  max_tokens: 280,
                  // Sampling for a tool-emitting agent, not for general
                  // chat. Qwen3.6's published recommendations
                  // (temp 1.0 / presence_penalty 1.5) are tuned for
                  // chat variety — when applied here they destabilize
                  // the <say>/<tool> XML protocol: presence_penalty
                  // actively suppresses recently-emitted tokens, and
                  // our format tags MUST repeat ("<tool>" then later
                  // "<say>" in the same turn, plus <say> repeating
                  // across turns). The penalty was producing truncated
                  // tool calls and bare opens like "<say>" with no
                  // content. Tightening to typical tool-agent values:
                  //   - temp 0.7 → still varied enough; format-stable
                  //   - presence_penalty 0 → format tags free to repeat
                  //   - top_p 0.95 / top_k 20 / min_p 0.0 → as Qwen recs
                  temperature: 0.7,
                  top_p: 0.95,
                  top_k: 20,
                  presence_penalty: 0.0,
                  min_p: 0.0,
                  stream: true,
                  // Thinking off. Tried `enable_thinking: true` once and
                  // it made the LLM MORE confident at fabricating — it
                  // reasoned itself into plausible-sounding answers for
                  // weather/news/etc. without realizing those needed
                  // tool calls. Prompt-level discipline (below) is the
                  // right lever, not thinking mode.
                  chat_template_kwargs: { enable_thinking: false },
                }),
                signal: activeAbort.signal,
              });
              if (!llmResp.ok) {
                ctx.broadcast({
                  type: "error",
                  error: `LLM error (${llmResp.status}): ${(await llmResp.text()).slice(0, 200)}`,
                });
                return;
              }
              const reader = llmResp.body as unknown as AsyncIterable<Uint8Array>;
              const decoder = new TextDecoder();
              let sseBuf = "";
              for await (const chunk of reader) {
                sseBuf += decoder.decode(chunk, { stream: true });
                let nl: number;
                while ((nl = sseBuf.indexOf("\n")) !== -1) {
                  const line = sseBuf.slice(0, nl).trim();
                  sseBuf = sseBuf.slice(nl + 1);
                  if (!line.startsWith("data:")) continue;
                  const payload = line.slice(5).trim();
                  if (payload === "[DONE]") break;
                  try {
                    const obj = JSON.parse(payload);
                    const delta: string =
                      obj?.choices?.[0]?.delta?.content || "";
                    if (delta) llmRaw += delta;
                  } catch {
                    /* skip unparseable */
                  }
                }
              }
            } catch (err) {
              if ((err as Error).name === "AbortError") return;
              ctx.broadcast({
                type: "error",
                error: `LLM stream failed: ${(err as Error).message}`,
              });
              return;
            } finally {
              activeAbort = null;
            }
            // Normalize a common LLM grammar slip: `<tool name="say">...</say>`
            // (conflating the <tool> shape with the <say> wrapper). Rewrite
            // these to plain `<say>...</say>` BEFORE parsing so the extractor
            // catches them. Without this, the malformed block isn't picked
            // up as a tool call OR a say block, and the spoken-text fallback
            // ends up reading the raw XML aloud.
            llmRaw = llmRaw.replace(/<tool\s+name\s*=\s*["']say["']\s*>/gi, "<say>");
            lastLlmRaw = llmRaw;

            const tools = extractBlocks(llmRaw, "tool");
            const says = extractBlocks(llmRaw, "say");

            // Categorize: read vs action. Unknown tools surface as errors.
            // Reject send_to_card targets that aren't chat-class HERE so we
            // can give the LLM a retry on iter 1 — the LLM committed its
            // <say> alongside the bad tool, so we drop the say + the bad
            // tool, feed the rejection back, and let it try again with the
            // correct target. Without this retry, every misroute ships a
            // misleading "OK, asked Qwen" to TTS and the user has no
            // recovery path within the same turn.
            const reads: Array<typeof tools[number]> = [];
            const iterSendRejections: Array<{ file: string; ext: string }> = [];
            const iterPendingActions: Array<{ name: string; tb: typeof tools[number] }> = [];
            for (const tb of tools) {
              const name = parseToolName(tb.attrs);
              if (!name) continue;
              if (READ_TOOLS.has(name)) {
                reads.push(tb);
              } else if (name === "send_to_card") {
                const file = parseField(tb.body, "file") || "";
                const dot = file.lastIndexOf(".");
                const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
                if (file && !CHAT_CLASS_EXTENSIONS.has(ext)) {
                  iterSendRejections.push({ file, ext });
                } else {
                  iterPendingActions.push({ name, tb });
                }
              } else {
                iterPendingActions.push({ name, tb });
              }
            }

            // Final iteration, OR no follow-up needed (no reads, no
            // rejections to retry): accept the say blocks + actions
            // from this iter and stop looping.
            const needsRetry = iter < 1 && iterSendRejections.length > 0;
            if (iter === 1 || (reads.length === 0 && !needsRetry)) {
              allSayBlocks.push(...says);
              pendingActionTools.push(...iterPendingActions);
              // Surface the rejections so the override-speakable path
              // below sees them and can replace the LLM's now-misleading
              // <say> on the final iter (when retry didn't recover).
              if (iter === 1 && iterSendRejections.length > 0) {
                for (const r of iterSendRejections) {
                  console.log(`[voice-agent] send_to_card retry rejected non-chat target: ${r.file} (.${r.ext})`);
                  pendingActionTools.push({
                    name: "send_to_card",
                    tb: { attrs: ` name="send_to_card"`, body: `<file>${r.file}</file>`, selfClosing: false },
                  });
                }
              }
              break;
            }

            // Iter 0 with read tools and/or send_to_card rejections:
            // execute reads, build synthetic followup with results +
            // rejection notes, loop to iter 1 so the LLM can summarize
            // and/or retry the dispatch.
            const readResultLines: string[] = [];
            for (const r of iterSendRejections) {
              console.log(`[voice-agent] send_to_card iter-0 rejected non-chat target: ${r.file} (.${r.ext}) — feeding back for retry`);
              ctx.broadcast({
                type: "tool_result",
                name: "send_to_card",
                ok: false,
                file: r.file,
                message: `"${r.file}" isn't a chat card — pick from "Chat cards".`,
              });
              readResultLines.push(
                `<result tool="send_to_card" file="${r.file}" error="true">\n` +
                `Rejected: "${r.file}" has extension .${r.ext} which isn't a chat card. ` +
                `send_to_card only routes to chat-class cards listed under "Chat cards" in your context. ` +
                `Pick one of those and emit a fresh <tool name="send_to_card"> with the correct <file>, plus a new <say>.\n` +
                `</result>`,
              );
            }
            // Add the iter-0's valid pending actions to the master list
            // (only the rejected ones triggered the retry path).
            pendingActionTools.push(...iterPendingActions);
            for (const tb of reads) {
              const name = parseToolName(tb.attrs)!;
              const file = parseField(tb.body, "file");
              ctx.broadcast({ type: "tool_call", name, args: tb.body.slice(0, 200) });
              try {
                if (name === "read_card") {
                  if (!file) throw new Error("missing <file>");
                  const c = await readProjectFile(file, sessionProject || undefined);
                  const text = String(c?.content || "");
                  const truncated = text.length > READ_CARD_MAX_CHARS;
                  const body = truncated
                    ? text.slice(0, READ_CARD_MAX_CHARS) + "\n(truncated)"
                    : text;
                  ctx.broadcast({
                    type: "tool_result",
                    name,
                    ok: true,
                    file,
                    contentLength: text.length,
                    truncated,
                  });
                  readResultLines.push(`<result tool="read_card" file="${file}">\n${body}\n</result>`);
                } else if (name === "card_status") {
                  if (!file) throw new Error("missing <file>");
                  const status = await cardStatusFor(sessionProject, file);
                  ctx.broadcast({
                    type: "tool_result",
                    name,
                    ok: true,
                    file,
                    busy: status.busy,
                    summary: status.summary,
                    currentTask: status.currentTask,
                    queueDepth: status.queueDepth,
                    queueItems: status.queueItems,
                  });
                  // Format a richer body for the LLM. Lines we want
                  // visible: busy/idle + summary, the in-flight task
                  // preview (if any), then the queued items list.
                  const head = `${status.busy ? "BUSY" : "IDLE"} — ${status.summary}`;
                  const taskLine = status.currentTask
                    ? `\nCurrently processing: "${status.currentTask.replace(/"/g, "'")}"`
                    : "";
                  const queueLines = status.queueItems.length === 0
                    ? ""
                    : "\nQueue:\n" + status.queueItems.map((q, i) => {
                        const age = formatRelativeAge(q.queuedAt);
                        const text = q.text.replace(/"/g, "'");
                        return `${i + 1}. id=${q.id} (${q.source}, ${age}): "${text}"`;
                      }).join("\n");
                  readResultLines.push(`<result tool="card_status" file="${file}">\n${head}${taskLine}${queueLines}\n</result>`);
                } else if (name === "read_recent_replies") {
                  if (!file) throw new Error("missing <file>");
                  const nStr = parseField(tb.body, "n");
                  const n = Math.max(1, Math.min(5, parseInt(nStr || "", 10) || RECENT_REPLIES_DEFAULT_N));
                  const hist = await readChatHistoryFor(sessionProject, file);
                  const replies = hist.filter((m) => m.role === "assistant").slice(-n);
                  let body = replies.map((m, i) => `Reply ${i + 1}: ${m.content}`).join("\n\n") || "(no assistant replies yet)";
                  if (body.length > RECENT_REPLIES_MAX_CHARS) body = body.slice(0, RECENT_REPLIES_MAX_CHARS) + "\n(truncated)";
                  ctx.broadcast({
                    type: "tool_result",
                    name,
                    ok: true,
                    file,
                    count: replies.length,
                  });
                  readResultLines.push(`<result tool="read_recent_replies" file="${file}">\n${body}\n</result>`);
                } else if (name === "search") {
                  // Tavily web search; result body is already LLM-friendly
                  // (numbered list of titles + snippets). See voiceTools.ts.
                  const query = parseField(tb.body, "query") || "";
                  const body = await tavilySearch(query);
                  ctx.broadcast({ type: "tool_result", name, ok: true, query });
                  readResultLines.push(`<result tool="search" query="${query.replace(/"/g, "&quot;")}">\n${body}\n</result>`);
                } else if (name === "web_fetch") {
                  // Generic URL fetch with SSRF guard + HTML→text strip.
                  // Used after a search to drill into a specific result, or
                  // when the user gives a URL directly.
                  const url = parseField(tb.body, "url") || "";
                  const body = await webFetch(url);
                  ctx.broadcast({ type: "tool_result", name, ok: true, url });
                  readResultLines.push(`<result tool="web_fetch" url="${url.replace(/"/g, "&quot;")}">\n${body}\n</result>`);
                } else if (name === "time") {
                  // IANA timezone → formatted current time. No network.
                  // Empty <tz> defaults to the server's local timezone.
                  const tz = parseField(tb.body, "tz") || "";
                  const body = timeAt(tz);
                  ctx.broadcast({ type: "tool_result", name, ok: true, tz });
                  readResultLines.push(`<result tool="time" tz="${tz.replace(/"/g, "&quot;")}">\n${body}\n</result>`);
                }
              } catch (err) {
                const msg = (err as Error).message;
                ctx.broadcast({ type: "tool_result", name, ok: false, file, message: msg });
                readResultLines.push(`<result tool="${name}" file="${file}" error="true">\n${msg}\n</result>`);
              }
            }

            // Append the LLM's tool-calling output and the synthetic
            // tool-results as a follow-up turn so iter 1 can summarize
            // (read tools) and/or retry (rejected send_to_cards).
            //
            // Instruction wording depends on what's needed: a read-only
            // followup tells the LLM "no more tools, just <say>"; a
            // followup with send_to_card rejections needs the LLM to
            // emit a corrected tool call AND a matching <say>. Mixing
            // those instructions ("don't call tools" + "call this tool
            // now") is what triggers hallucinated <say>s like "I asked
            // Qwen…" without an actual dispatch.
            messages.push({ role: "assistant", content: llmRaw });
            const followupInstruction = iterSendRejections.length > 0
              ? `Your previous send_to_card was rejected (see <result error="true"> below). ` +
                `Pick a <file> from the "Chat cards" section and emit a fresh <tool name="send_to_card"> with that file, ` +
                `paired with a <say> that describes what you just dispatched. ` +
                `When no chat card fits, emit a <say> alone that offers the user a chat card by name (e.g. "want me to ask Qwen?") — ` +
                `keep <say> truthful: claim a dispatch only when a matching tool call goes out in the same response.`
              : `Tool results below. Write your final spoken reply now using them. ` +
                `Skip further tools — give a 1-2 sentence <say> answer.`;
            messages.push({
              role: "user",
              content: followupInstruction + "\n\n" + readResultLines.join("\n\n"),
            });
          }

          // 4. Dispatch action tools (deferred so spoken text is paired
          //    with the actual side effect).
          // Track queue-depth aggregates so the spoken-confirmation
          // fallback below can mention "queued behind N" if the LLM
          // didn't already.
          let dispatchMaxQueueDepth = 0;
          let dispatchHadQueueing = false;
          // Track send_to_card outcomes so we can override the LLM's
          // (often misleading) <say> when a dispatch was rejected.
          // The LLM speaks the confirmation alongside the tool call in
          // the same iter — by the time validation fires, the say block
          // is already chosen. If every send_to_card was rejected, the
          // confirmation is a lie; override with the rejection so the
          // user hears truth instead of "OK, asked Qwen" when nothing
          // actually got asked.
          const rejectedSendTargets: string[] = [];
          let sendDispatchedOk = false;
          for (const { name, tb } of pendingActionTools) {
            ctx.broadcast({ type: "tool_call", name, args: tb.body.slice(0, 200) });
            try {
              if (name === "list_cards") {
                const fresh = await listCanvasFiles(sessionProject || undefined);
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: true,
                  cards: fresh.map((c) => c.name),
                });
              } else if (name === "send_to_card") {
                const file = parseField(tb.body, "file");
                const message = parseField(tb.body, "message");
                if (!file || !message) {
                  ctx.broadcast({
                    type: "tool_result",
                    name,
                    ok: false,
                    message: "missing <file> or <message>",
                  });
                  continue;
                }
                // Reject non-chat targets early. Data cards (port-table,
                // csv, json, terminal, process-backed cards…) silently
                // ignore conversational payloads on their channels — the
                // dispatch would "succeed" at the channel layer but
                // nothing meaningful happens, leaving Mica's <say>
                // confirmation a lie. Strict rejection lets the LLM
                // retry within the same turn.
                const dot = file.lastIndexOf(".");
                const ext = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
                if (!CHAT_CLASS_EXTENSIONS.has(ext)) {
                  console.log(`[voice-agent] send_to_card rejected non-chat target: ${file} (.${ext})`);
                  rejectedSendTargets.push(file);
                  ctx.broadcast({
                    type: "tool_result",
                    name,
                    ok: false,
                    file,
                    message: `"${file}" isn't a chat card — send_to_card only routes to chat-class cards. Pick one from the "Chat cards" list and retry.`,
                  });
                  continue;
                }
                const result = channelMgr.dispatchToFilename(
                  sessionProject,
                  file,
                  { message },
                );
                if (result.ok) {
                  sendDispatchedOk = true;
                  // Update delegation context so the next turn's prompt
                  // shows what's pending. AGENT_NAME_DEFAULTS resolves
                  // chat → "Qwen", claude → "Claude Code", etc.
                  delegation = {
                    filename: file,
                    agentName: AGENT_NAME_DEFAULTS[ext] || ext,
                    summary: message.slice(0, 150),
                    turnsAgo: 0,
                  };
                  console.log(`[voice-agent] delegation tracked: ${file} (${delegation.agentName})`);
                }
                let detail: string;
                if (!result.ok) {
                  detail = `card "${file}" isn't open — open it once first, then voice can route to it`;
                } else if (result.clientCount === 0) {
                  detail = "dispatched, but the chat card isn't currently visible — open it to see the message arrive";
                } else if (typeof result.queueDepth === "number" && result.queueDepth > 0) {
                  detail = `queued behind ${result.queueDepth} other request${result.queueDepth === 1 ? "" : "s"}`;
                  dispatchHadQueueing = true;
                  if (result.queueDepth > dispatchMaxQueueDepth) {
                    dispatchMaxQueueDepth = result.queueDepth;
                  }
                } else {
                  detail = "dispatched";
                }
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: result.ok,
                  file,
                  message: detail,
                  clientCount: result.clientCount,
                  queueDepth: result.queueDepth,
                });
              } else if (name === "delete_queue_item") {
                // Drop a pending item from a chat card's queue. Target by
                // id (from card_status). Uses the same `cancel_queued`
                // control message the chat card UI already sends on its
                // own X-out, so the queue UI updates everywhere.
                const file = parseField(tb.body, "file");
                const id = parseField(tb.body, "id");
                if (!file || !id) {
                  ctx.broadcast({ type: "tool_result", name, ok: false, message: "missing <file> or <id>" });
                  continue;
                }
                const result = channelMgr.dispatchToFilename(
                  sessionProject,
                  file,
                  { type: "cancel_queued", id },
                );
                const detail = result.ok
                  ? "removed from queue (or already drained)"
                  : `card "${file}" isn't open — open it once first`;
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: result.ok,
                  file,
                  message: detail,
                });
              } else if (name === "replace_queue_item") {
                // Mutate a pending item's text in place. Preserves the
                // item's position in the queue, source, and queuedAt —
                // only the text changes. Same posture as delete: target
                // by id; the chat agent's `replace_queued` handler
                // commits and broadcasts.
                const file = parseField(tb.body, "file");
                const id = parseField(tb.body, "id");
                const text = parseField(tb.body, "message");
                if (!file || !id || !text) {
                  ctx.broadcast({ type: "tool_result", name, ok: false, message: "missing <file>, <id>, or <message>" });
                  continue;
                }
                const result = channelMgr.dispatchToFilename(
                  sessionProject,
                  file,
                  { type: "replace_queued", id, text },
                );
                const detail = result.ok
                  ? "queue item text replaced (or already drained)"
                  : `card "${file}" isn't open — open it once first`;
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: result.ok,
                  file,
                  message: detail,
                });
              } else if (name === "abort") {
                // User-initiated stop. Side effects in order:
                //  1. Drop queued audio so a "stop" doesn't get followed
                //     by stale utterances queued during the current turn.
                //  2. Cascade {type:"interrupt"} to the last delegation's
                //     chat-card session if any. The target handler aborts
                //     its in-flight LLM and broadcasts done.
                //  3. Broadcast {type:"abort"} to the voice card so it
                //     stops in-flight playback locally.
                //  4. Clear delegation. The user just bailed; reset.
                // Mica's <say> confirmation continues to TTS normally —
                // that's the audible acknowledgement.
                const droppedQueue = queuedAudio.length;
                queuedAudio.length = 0;
                let cascaded = false;
                if (delegation) {
                  console.log(`[voice-agent] abort tool: cascading interrupt to ${delegation.filename}`);
                  const cascadeResult = channelMgr.dispatchToFilename(
                    sessionProject,
                    delegation.filename,
                    { type: "interrupt" },
                  );
                  cascaded = cascadeResult.ok === true;
                }
                ctx.broadcast({ type: "abort" });
                const cascadeTarget = delegation?.filename || null;
                delegation = null;
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: true,
                  cascaded,
                  cascadeTarget,
                  droppedQueue,
                });
              } else {
                ctx.broadcast({
                  type: "tool_result",
                  name,
                  ok: false,
                  message: `unknown tool "${name}"`,
                });
              }
            } catch (err) {
              ctx.broadcast({
                type: "tool_result",
                name,
                ok: false,
                message: (err as Error).message,
              });
            }
          }

          // 5. Speakable text → SentenceFanout → TTS frames.
          //
          // Three failure modes the LLM commits regularly that we recover from:
          //   (a) Plain answer with no <say> wrapper — strip leftover tags,
          //       speak the raw text.
          //   (b) Action tool call with no <say> confirmation — synthesize
          //       a default spoken confirmation so the user always hears
          //       something after dispatch.
          //   (c) Both <say> and tools missing — error.
          let speakable = allSayBlocks.map((s) => s.body).join(" ").trim();
          let usedFallback = false;

          // Override the LLM's <say> when send_to_card was rejected and
          // no other dispatch succeeded — the spoken confirmation is
          // a lie ("OK, asked Qwen…") because the LLM committed to it
          // before validation fired. Replace with a truthful note so
          // the user knows nothing was actually routed and can retry.
          if (rejectedSendTargets.length > 0 && !sendDispatchedOk) {
            const target = rejectedSendTargets[0];
            const rest = rejectedSendTargets.length - 1;
            const tail = rest > 0 ? ` (and ${rest} other${rest === 1 ? "" : "s"})` : "";
            speakable = `I tried to route that to ${target}${tail}, but only chat cards can take messages. Open a chat card first, then ask again.`;
            usedFallback = true;
            console.log(`[voice-agent] overrode LLM <say> due to rejected send_to_card: ${rejectedSendTargets.join(", ")}`);
          }

          // Hallucinated-dispatch safety net. The LLM regularly says "I
          // asked Qwen" / "I routed that" / "let me check with Qwen" /
          // "I'll find out" without emitting an actual
          // <tool name="send_to_card">. The hard-rule in the system
          // prompt curbs this but doesn't eliminate it. Two checks:
          //   (a) explicit dispatch verbs ("asked", "sent it to", ...)
          //   (b) implicit promises ("let me check / find out / look
          //       into / get back to you / pull that up", etc.)
          //   (c) name-drop check: mentioning any chat card's agent
          //       name (e.g. "Qwen") when we didn't actually dispatch.
          // If any of those fire and no send_to_card succeeded, scrub
          // the lie and surface a corrigible alternative.
          else if (!sendDispatchedOk && speakable) {
            const explicitClaim = /\b(?:asked|sent (?:that |it )?to|told|dispatched|routed (?:that|it)|forwarded (?:that|it)|kicked off|kicked it off|handed (?:that|it) (?:off|over))\b/i.test(speakable);
            const implicitPromise = /\b(?:let me (?:check|find out|look into|see (?:what|if|whether)|ask|pull (?:that|it) up|get|get back|consult|verify|grab)|i(?:'ll| will) (?:check|find out|look into|see|ask|pull|get|consult|verify|grab|bring (?:that|it) up|run (?:that|it) by|pass (?:that|it) along)|i(?:'m| am) (?:checking|asking|looking|consulting)|hold on while|just a (?:moment|second|sec)|one (?:moment|second|sec)|give me a (?:moment|second|sec)|on it|let's see what|getting that for you)\b/i.test(speakable);
            // Name-drop: any chat card's agent name appearing when we
            // didn't dispatch. Use the chat-cards listing as ground truth.
            const chatAgentNames = chatCards
              .map((c) => {
                const dot = c.name.lastIndexOf(".");
                const ext = dot === -1 ? "" : c.name.slice(dot + 1).toLowerCase();
                return AGENT_NAME_DEFAULTS[ext] || ext;
              })
              .filter(Boolean);
            const nameDrop = chatAgentNames.length > 0
              && new RegExp(`\\b(?:${chatAgentNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i").test(speakable);

            // Suppress nameDrop when the agent name is wrapped in offer
            // phrasing ("want me to ask Qwen?", "should I have Qwen…",
            // "I could ask Qwen") — that's a legit dispatch OFFER, not a
            // hallucinated claim. The system prompt explicitly encourages
            // this phrasing, so flagging it would override good behavior
            // with the worse canned fallback.
            const offerPhrasing = /\b(?:want me to|do you want me to|would you (?:like|want) me to|should i|shall i|i could (?:ask|have|send|route|forward|run by)|i can (?:ask|have|send|route|forward|run by)|let me know if you want)\b/i.test(speakable);
            // Self-identification ("I'm Qwen", "I am Qwen") is not a
            // dispatch claim — it's the model introducing itself. Suppress
            // the nameDrop trigger when the name appears in self-intro
            // shape near the start of the response.
            const selfIntro = /^\s*(?:I(?:'m| am)\s+(?:Qwen|Claude(?:\s+Code)?|OpenCode))\b/i.test(speakable);
            const nameDropIsOffer = nameDrop && !explicitClaim && !implicitPromise && offerPhrasing;
            const nameDropIsSelfIntro = nameDrop && !explicitClaim && !implicitPromise && selfIntro;

            if ((explicitClaim || implicitPromise || nameDrop) && !nameDropIsOffer && !nameDropIsSelfIntro) {
              console.log(`[voice-agent] overrode LLM <say> due to hallucinated dispatch claim (explicit=${explicitClaim} implicit=${implicitPromise} nameDrop=${nameDrop}): ${JSON.stringify(speakable.slice(0, 200))}`);
              // Three failure modes, three different recoveries:
              //  - implicitPromise only ("let me check") → user wanted info →
              //    offer a search.
              //  - nameDrop only (no claim, no promise) → user probably
              //    asked ABOUT the named agent (status / what it's doing)
              //    or the LLM fabricated about it → offer both paths:
              //    check on it OR send it something.
              //  - anything with explicitClaim or claim+nameDrop → real
              //    dispatch lie → offer the dispatch.
              // Find the specific agent the LLM name-dropped, so the
              // fallback references THAT card (not arbitrary chatCards[0]
              // — which can alphabetize to "llm-chat" when the LLM was
              // clearly talking about Qwen). Falls back to chatCards[0]
              // if no specific name appears.
              const namedAgent = chatAgentNames.find((n) =>
                new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(speakable)
              );
              const namedCard = namedAgent
                ? chatCards.find((c) => {
                    const ext = c.name.slice(c.name.lastIndexOf(".") + 1).toLowerCase();
                    return (AGENT_NAME_DEFAULTS[ext] || ext).toLowerCase() === namedAgent.toLowerCase();
                  })
                : undefined;
              const targetName = namedCard?.name || (chatCards[0]?.name ?? "a chat card");
              const targetAgent = namedAgent || (chatCards[0] ? (AGENT_NAME_DEFAULTS[chatCards[0].name.slice(chatCards[0].name.lastIndexOf(".") + 1).toLowerCase()] || "") : "the agent");

              if (implicitPromise && !explicitClaim && !nameDrop) {
                speakable = "I didn't actually look that up. Want me to search the web for it?";
              } else if (nameDrop && !explicitClaim && !implicitPromise) {
                speakable = `I didn't actually check on ${targetAgent} — want me to look at the status, or send it something?`;
              } else {
                speakable = chatCards.length > 0
                  ? `I didn't actually route that anywhere — want me to send it to ${targetName}?`
                  : `I didn't route that anywhere — open a chat card first if you want me to forward work.`;
              }
              usedFallback = true;
            } else if (nameDropIsOffer) {
              console.log(`[voice-agent] nameDrop suppressed (offer phrasing detected): ${JSON.stringify(speakable.slice(0, 200))}`);
            } else if (nameDropIsSelfIntro) {
              console.log(`[voice-agent] nameDrop suppressed (self-introduction detected): ${JSON.stringify(speakable.slice(0, 200))}`);
            }
          }
          if (!speakable) {
            if (pendingActionTools.length === 0) {
              // (a) Plain answer with no <say>: speak the cleaned raw output —
              //     but first detect truncated/malformed tool emits. The LLM
              //     occasionally produces partial output like `<tool name="send`
              //     (cut off mid-tag). The cleanForTts regex requires a
              //     closing `>` to strip a tag, so a truncated open survives
              //     and gets spoken literally. Speaking angle brackets aloud
              //     is the worst UX. Detect and substitute a recovery message.
              const looksTruncated =
                /<tool\b[^>]*$/.test(lastLlmRaw.trim()) ||      // open <tool ... with no close
                /<say\b[^>]*$/.test(lastLlmRaw.trim()) ||       // open <say ... with no close
                /<\/?(?:tool|say|file|message|query|url|tz)\s*$/.test(lastLlmRaw.trim()); // dangling closing-tag fragment
              if (looksTruncated) {
                speakable = "My response got cut off mid-send. Try again?";
                usedFallback = true;
                console.log(`[voice-agent] LLM emitted truncated/malformed output; substituting recovery message. raw=${JSON.stringify(lastLlmRaw.slice(0, 200))}`);
              } else {
                const noTools = lastLlmRaw.replace(/<tool[\s\S]*?<\/tool>/g, " ").replace(/<tool[^>]*\/>/g, " ");
                const cleaned = cleanForTts(noTools).trim();
                if (cleaned) {
                  speakable = cleaned.slice(0, 600);
                  usedFallback = true;
                  console.log(`[voice-agent] LLM skipped <say> grammar; speaking cleaned text instead. raw=${JSON.stringify(lastLlmRaw.slice(0, 200))}`);
                }
              }
            } else {
              // (b) Tool dispatched but no spoken confirmation — synthesize
              //     a sensible default so the user always hears feedback
              //     about what voice did.
              const sendToCardCount = pendingActionTools.filter((t) => t.name === "send_to_card").length;
              const listCardsOnly = pendingActionTools.every((t) => t.name === "list_cards");
              if (sendToCardCount > 0) {
                if (dispatchHadQueueing) {
                  speakable = sendToCardCount === 1
                    ? `OK, queued behind ${dispatchMaxQueueDepth} other request${dispatchMaxQueueDepth === 1 ? "" : "s"}.`
                    : `OK, dispatched ${sendToCardCount} requests; one is queued behind ${dispatchMaxQueueDepth} other${dispatchMaxQueueDepth === 1 ? "" : "s"}.`;
                } else {
                  speakable = sendToCardCount === 1
                    ? "OK, sent that along."
                    : `OK, dispatched ${sendToCardCount} requests.`;
                }
              } else if (listCardsOnly) {
                speakable = "Refreshing the canvas now.";
              } else {
                speakable = "OK.";
              }
              usedFallback = true;
              console.log(`[voice-agent] LLM dispatched tools without <say>; using default confirmation: ${JSON.stringify(speakable)}`);
            }
          }

          // User-facing work (STT + LLM + dispatch) is done. Release `busy`
          // BEFORE TTS so the user can ask a follow-up while the previous
          // answer's audio is still playing. `ttsActive` keeps the ambient
          // queue gated through TTS so a chat-card-finished ping doesn't
          // barge in mid-sentence over the user's own answer.
          busy = false;
          console.log(`[voice-agent] s=${sessionTag} busy=false (normal release, ${Date.now() - tBusyStart}ms)`);
          // Drain any ambient announcements queued during STT/LLM. Their
          // own gate (announcementInFlight + busy + ttsActive) keeps them
          // serialized; if ttsActive is about to be true below, this no-ops.
          setImmediate(() => { void drainAnnouncementQueue(); });

          if (speakable) {
            // Speak unless the session has zero attached subscribers
            // (every tab/card consumer gone). Visibility-hidden tabs still
            // hear audio; only fully-disconnected sessions skip.
            const skipTts = !hasSubscriber();
            console.log(`[voice-agent] speaking ${speakable.length} chars (fallback=${usedFallback}${skipTts ? ", skipTts=true (no subscribers)" : ""}): ${JSON.stringify(speakable.slice(0, 200))}`);
            ctx.broadcast({ type: "thinking", phase: "tts" });
            let audioFramesEmitted = 0;
            const fanout = new SentenceFanout({
              ttsUrl: getTtsUrl(),
              voice: msg.voice || voicePref,
              skipTts,
              pronunciations,
              onFrame: (f) => {
                if (f.type === "sentence") {
                  ctx.broadcast({
                    type: "assistant_speech_text",
                    sentence_idx: f.idx,
                    text: f.text,
                  });
                } else if (f.type === "audio") {
                  audioFramesEmitted++;
                  ctx.broadcast({
                    type: "assistant_speech",
                    sentence_idx: f.idx,
                    wav_b64: f.wavB64,
                  });
                } else {
                  console.warn(`[voice-agent] ${f.message}`);
                }
              },
            });
            ttsActive = true;
            currentFanout = fanout;
            try {
              fanout.feed(speakable);
              fanout.end();
              await fanout.drain();
            } finally {
              ttsActive = false;
              if (currentFanout === fanout) currentFanout = null;
              setImmediate(() => { void drainAnnouncementQueue(); });
            }
            console.log(`[voice-agent] turn done — audio frames emitted=${audioFramesEmitted}`);

            history.push({ role: "assistant", content: speakable, raw: lastLlmRaw });
            if (history.length > MAX_HISTORY) {
              history.splice(0, history.length - MAX_HISTORY);
            }
            ctx.broadcast({ type: "assistant", content: speakable, fallback: usedFallback });
          } else if (pendingActionTools.length === 0) {
            // Truly empty response.
            console.log(`[voice-agent] empty LLM response; raw=${JSON.stringify(lastLlmRaw.slice(0, 200))}`);
            ctx.broadcast({ type: "error", error: "Empty LLM response" });
          }

          ctx.broadcast({ type: "done" });
        } finally {
          // Belt-and-suspenders: an early throw before the explicit release
          // above would otherwise leave `busy` stuck true. Setting it again
          // is idempotent.
          if (busy) {
            console.log(`[voice-agent] s=${sessionTag} busy=false (finally release, ${Date.now() - tBusyStart}ms) — early-throw path`);
          }
          busy = false;
          ttsActive = false;
          setImmediate(() => { void drainAnnouncementQueue(); });
          // Process queued audio items. Each item triggers a new turn.
          // We use setImmediate to avoid re-entrant calls on the same onData
          // stack. The new onData call will set busy=true again.
          if (queuedAudio.length > 0) {
            const next = queuedAudio.shift()!;
            console.log(`[voice-agent] processing queued audio (depth=${queuedAudio.length})`);
            setImmediate(() => {
              void handler.onData?.(_clientId, { audioB64: next.audioB64, audioMime: next.audioMime, voice: next.voice });
            });
          }
        }
      },

      onDestroy() {
        if (activeAbort) {
          try { activeAbort.abort(); } catch { /* ignore */ }
        }
        clearPendingPartialTimer();
        pendingPartial = null;
        unsubscribeBroadcastListener();
        announcementQueue.length = 0;
      },
    };
    return handler;
  };
}
