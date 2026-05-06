// voiceAgent.ts — `.voice` card class handler.
//
// Mica's voice assistant. Distinct from the chat agents (.chat / .claude /
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
import { listCanvasFiles, readProjectFile, getOrCreateCardId } from "./files.js";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  ensureVoiceServers,
  getSttUrl,
  getTtsUrl,
  getVoiceServerStatus,
} from "./voiceServers.js";
import { SentenceFanout, cleanForTts } from "./voiceStreaming.js";

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

/** Heuristic card status. Reads chat history; if last entry is a user
 *  turn, infer busy. If no history, "idle (empty)". Otherwise idle with
 *  a hint of how recent the last reply was. */
async function cardStatusFor(
  project: string | null,
  filename: string,
): Promise<{ busy: boolean; summary: string }> {
  const history = await readChatHistoryFor(project, filename);
  if (history.length === 0) return { busy: false, summary: "idle (no conversation yet)" };
  const last = history[history.length - 1];
  if (last.role === "user") return { busy: true, summary: "busy — last user turn awaiting reply" };
  return { busy: false, summary: `idle (last reply ${history.length} messages in)` };
}

const LLM_URL = "http://127.0.0.1:8012/v1/chat/completions";
// Keep the last 8 turns (4 user + 4 assistant) in context. Voice exchanges
// are short — much more would just bloat the prompt without helping.
const MAX_HISTORY = 8;

interface VoiceTurn {
  role: "user" | "assistant";
  content: string;
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

export function createVoiceAgentHandler(channelMgr: ChannelManager) {
  return async function voiceAgentFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const sessionProject = ctx.project;
    const voicePref: string | undefined =
      typeof args.voice === "string" ? (args.voice as string) : undefined;
    const history: VoiceTurn[] = [];
    let activeAbort: AbortController | null = null;
    let busy = false;

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
      text: string;
      mode: "summary" | "full";
    }
    const announcementQueue: AmbientItem[] = [];
    const seenTurnIds = new Map<string, string>(); // filename → last announced turn_id
    const muteSet = new Set<string>(); // filenames the user has muted (Phase 2.5)
    let announcementInFlight = false;

    const FULL_READ_MAX_CHARS = 1500;

    function summarizeForAnnouncement(content: string): string {
      // Take the first sentence, clean markdown/URLs, cap at ~140 chars.
      const cleaned = cleanForTts(content);
      const m = cleaned.match(/^(.{0,140}?[.!?])(\s|$)/);
      const first = m ? m[1] : cleaned.slice(0, 140);
      return first.trim();
    }

    function fullReadForAnnouncement(content: string): string {
      // Strip markdown/URLs but keep the entire reply (cap at
      // FULL_READ_MAX_CHARS). Adds a soft tail-marker if truncated so
      // the listener knows there's more in the chat card.
      const cleaned = cleanForTts(content);
      if (cleaned.length <= FULL_READ_MAX_CHARS) return cleaned;
      return cleaned.slice(0, FULL_READ_MAX_CHARS).trim() + " — there's more in the chat card.";
    }

    async function drainAnnouncementQueue(): Promise<void> {
      if (announcementInFlight || busy) return;
      const next = announcementQueue.shift();
      if (!next) return;
      announcementInFlight = true;
      try {
        // Summary mode prefixes "<Agent> just finished. " so the listener
        // knows the source. Full-read mode just speaks the reply itself —
        // the user dispatched it via voice and is expecting THE answer,
        // not a meta-announcement about it.
        const text = next.mode === "full" ? next.text : `${next.agent} just finished. ${next.text}`;
        ctx.broadcast({
          type: "ambient_announcement_start",
          file: next.filename,
          agent: next.agent,
          mode: next.mode,
        });
        const fanout = new SentenceFanout({
          ttsUrl: getTtsUrl(),
          voice: voicePref,
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
        fanout.feed(text);
        fanout.end();
        await fanout.drain();
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
    // The user picked the most aggressive ambient option: announce when
    // ANY chat card finishes a turn. Skip the voice card itself, skip
    // muted cards, dedupe by turn_id.
    const unsubscribeBroadcastListener = channelMgr.onAnyBroadcast(
      (project, filename, data) => {
        if (project !== sessionProject) return;
        if (filename === ctx.filename) return; // never echo our own replies
        if (muteSet.has(filename)) return;
        const d = data as {
          type?: string;
          content?: string;
          turn_id?: string;
          agent?: string;
          viaVoice?: boolean;
        };
        if (d.type !== "assistant" || !d.content) return;
        const turnId = typeof d.turn_id === "string" ? d.turn_id : "";
        // Dedupe: same turn_id seen twice on the same file = ignore.
        if (turnId && seenTurnIds.get(filename) === turnId) return;
        if (turnId) seenTurnIds.set(filename, turnId);
        const agent = typeof d.agent === "string" ? d.agent : "the agent";
        // Pick the announcement mode. If the chat agent's broadcast carries
        // viaVoice:true, the user dispatched this turn THROUGH voice and
        // wants to hear the full reply, not a one-line summary.
        const mode: AmbientItem["mode"] = d.viaVoice === true ? "full" : "summary";
        const text = mode === "full" ? fullReadForAnnouncement(d.content) : summarizeForAnnouncement(d.content);
        if (!text) return;
        // Cap queue to avoid flooding when many cards finish at once.
        if (announcementQueue.length >= ANNOUNCEMENT_QUEUE_MAX) {
          console.log(`[voice-agent:ambient] queue full, dropping announcement for ${filename}`);
          return;
        }
        announcementQueue.push({ filename, agent, text, mode });
        console.log(`[voice-agent:ambient] queued ${mode}-mode announcement for ${filename} (${text.length} chars)`);
        setImmediate(() => { void drainAnnouncementQueue(); });
      },
    );

    return {
      onAttach(clientId) {
        ctx.sendTo(clientId, {
          type: "history",
          messages: history,
        });
      },

      async onData(_clientId, data) {
        const msg = data as {
          type?: string;
          audioB64?: string;
          audioMime?: string;
          message?: string;
          voice?: string;
        };

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
        if (busy) {
          ctx.broadcast({
            type: "error",
            error: "Voice card is busy with the previous turn — wait a moment.",
          });
          return;
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
        try {
          // 1. STT (or text-mode passthrough).
          let userText = "";
          if (msg.audioB64) {
            ctx.broadcast({ type: "thinking", phase: "stt" });
            const audioBuf = Buffer.from(msg.audioB64, "base64");
            const audioMime = msg.audioMime || "audio/webm";
            try {
              const sttForm = new FormData();
              sttForm.append(
                "audio",
                new Blob([audioBuf], { type: audioMime }),
                "audio.webm",
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

          ctx.broadcast({ type: "transcript", text: userText });
          if (!userText) {
            // Empty utterance — probably an accidental tap or silence.
            ctx.broadcast({ type: "done" });
            return;
          }

          history.push({ role: "user", content: userText });
          if (history.length > MAX_HISTORY) {
            history.splice(0, history.length - MAX_HISTORY);
          }

          // 2. Build canvas-aware prompt.
          const cards = (await listCanvasFiles(sessionProject || undefined))
            .filter((c) => !c.name.startsWith(".") && c.name !== ctx.filename);
          const cardSummary = cards.length
            ? cards
                .map((c) => {
                  const dot = c.name.lastIndexOf(".");
                  const kind = dot === -1 ? "file" : c.name.slice(dot + 1);
                  const ageMs = Date.now() - new Date(c.modifiedAt).getTime();
                  const ageMin = Math.floor(ageMs / 60_000);
                  const age =
                    ageMin <= 0
                      ? "just now"
                      : ageMin < 60
                        ? `${ageMin}m ago`
                        : `${Math.floor(ageMin / 60)}h ago`;
                  return `  - ${c.name} (.${kind}, last activity ${age})`;
                })
                .join("\n")
            : "  (none)";

          const projectLabel = sessionProject || "(workspace)";

          // Pick a representative chat-style card filename to use in
          // examples — grounds the LLM in the actual canvas vocabulary.
          // Falls back to a generic "chat.chat" when no chat-style card
          // exists, in which case the LLM should still recognize that
          // dispatch isn't possible without a target.
          const chatLikeKinds = new Set(["chat", "claude", "opencode", "llm-chat", "persona-chat"]);
          const exampleCard = cards.find((c) => {
            const dot = c.name.lastIndexOf(".");
            return dot !== -1 && chatLikeKinds.has(c.name.slice(dot + 1));
          });
          const exampleFilename = exampleCard ? exampleCard.name : "chat.chat";

          const systemPrompt =
            `You are Mica's voice assistant for the "${projectLabel}" project. ` +
            "You run on Qwen3.6 — the same model behind the canvas's chat cards — but with a voice persona: " +
            "every word inside <say>…</say> is read aloud, so reply in 1–2 short conversational sentences, " +
            "no markdown, no lists, no code, no URLs.\n\n" +

            "## Cards on this canvas (the only valid <file> values for send_to_card)\n" +
            cardSummary + "\n\n" +

            "## Default to answering yourself\n" +
            "You're a capable assistant — answer most questions directly using your own knowledge. " +
            "General knowledge (people, history, science, definitions, math, jokes, advice), questions about " +
            "what's on the canvas, conversational replies — handle them yourself in 1–2 spoken sentences. " +
            "The user is talking to you out loud and wants a fast back-and-forth, not a relay to another card.\n\n" +

            "## When to dispatch (rare)\n" +
            "Only use send_to_card when the user clearly wants action that requires the slow agent's tools: " +
            "writing or editing files, running commands, searching the web, refactoring code, multi-step planning, " +
            "or anything else that needs file-system / shell / web access. Phrases like \"tell qwen\", " +
            "\"have the agent\", \"write a file\", \"edit the code\", \"open up\", \"run\" usually mean dispatch. " +
            "Phrases like \"who is\", \"what is\", \"explain\", \"summarize from memory\", \"what do you think\" " +
            "do NOT — answer those yourself.\n\n" +

            "## Tools\n" +
            `<tool name="list_cards"/>` + " — fresh canvas listing. Rare; the list above is usually enough.\n" +
            `<tool name="read_card"><file>EXACT_FILENAME</file></tool>` + " — read a card's contents (text files only — markdown, spec, JSON, etc). Use when the user asks about a specific file's contents and the answer isn't in your memory.\n" +
            `<tool name="card_status"><file>EXACT_FILENAME</file></tool>` + " — check whether a chat card's agent is currently busy or idle, plus a one-line activity hint. Use to answer \"is Qwen still working?\".\n" +
            `<tool name="read_recent_replies"><file>EXACT_FILENAME</file><n>1</n></tool>` + " — fetch the last N assistant replies from a chat card so you can summarize what it just said. <n> is optional, default 1. Use for \"what did Qwen just say?\".\n" +
            `<tool name="send_to_card"><file>EXACT_FILENAME_FROM_LIST_ABOVE</file><message>WHAT_TO_DO_IN_PLAIN_ENGLISH</message></tool>` + " — forward a request to a chat card. ONLY for action — see rules above.\n\n" +

            "## Hard rules\n" +
            "1. Tools go OUTSIDE <say>. NEVER nest a tool inside say tags — the XML would be read aloud.\n" +
            "2. <file> MUST be one of the filenames listed above, copied verbatim. NEVER put a code path, output path, or URL there.\n" +
            "3. <message> is plain English — NOT code, NOT XML.\n" +
            "4. After dispatching, give a brief spoken confirmation in <say>.\n\n" +

            "## Examples\n" +

            "User: who's Bruce Springsteen?\n" +
            "Assistant: <say>He's a New Jersey rock musician famous for the E Street Band and albums like Born to Run and Born in the U.S.A.</say>\n\n" +

            "User: what cards do I have?\n" +
            "Assistant: <say>You have a chat card, a spec, and a couple of notes on this canvas.</say>\n\n" +

            "User: what's the capital of France?\n" +
            "Assistant: <say>Paris.</say>\n\n" +

            "User: what is Mica?\n" +
            "Assistant: <say>It's a canvas where humans and agents work on context together — the project you're in right now.</say>\n\n" +

            "User: tell Qwen to write a hello world script to slash tmp slash hi dot py\n" +
            `Assistant: <tool name="send_to_card"><file>${exampleFilename}</file><message>Write a hello world script to /tmp/hi.py</message></tool><say>OK, told Qwen.</say>\n\n` +

            "User: have the agent refactor card dot js to use async await\n" +
            `Assistant: <tool name="send_to_card"><file>${exampleFilename}</file><message>Refactor card.js to use async/await.</message></tool><say>On it — Qwen will refactor it.</say>\n\n` +

            "User: what did Qwen just say?\n" +
            `Assistant: <tool name="read_recent_replies"><file>${exampleFilename}</file></tool>\n` +
            "  (then, in the SAME response after seeing the result, summarize:)\n" +
            "Assistant: <say>Qwen said the script is ready and it explained how to run it.</say>\n\n" +

            "User: is Qwen still working?\n" +
            `Assistant: <tool name="card_status"><file>${exampleFilename}</file></tool><say>Yes — still busy on the last request.</say>\n\n` +

            "User: what's in the spec?\n" +
            `Assistant: <tool name="read_card"><file>canvas/spec.md</file></tool><say>The spec describes an interactive map of SFO with terminal pins and a search box.</say>\n\n` +

            "User: what's the weather?\n" +
            "Assistant: <say>I don't have weather access from here — but the rest of your canvas is quiet.</say>";

          const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
            { role: "system", content: systemPrompt },
            ...history.map((h) => ({ role: h.role, content: h.content })),
          ];

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
          const READ_TOOLS = new Set(["read_card", "card_status", "read_recent_replies"]);
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
                  model: "voice",
                  messages,
                  max_tokens: 280,
                  temperature: 0.5,
                  stream: true,
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
            lastLlmRaw = llmRaw;

            const tools = extractBlocks(llmRaw, "tool");
            const says = extractBlocks(llmRaw, "say");

            // Categorize: read vs action. Unknown tools surface as errors.
            const reads: Array<typeof tools[number]> = [];
            for (const tb of tools) {
              const name = parseToolName(tb.attrs);
              if (!name) continue;
              if (READ_TOOLS.has(name)) reads.push(tb);
              else pendingActionTools.push({ name, tb });
            }

            // On the final iteration, OR if no read tools were called,
            // accept the say blocks and stop looping.
            if (iter === 1 || reads.length === 0) {
              allSayBlocks.push(...says);
              break;
            }

            // Iter 0 with read tools: execute, append synthetic followup.
            const readResultLines: string[] = [];
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
                  });
                  readResultLines.push(`<result tool="card_status" file="${file}">\n${status.busy ? "BUSY" : "IDLE"} — ${status.summary}\n</result>`);
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
                }
              } catch (err) {
                const msg = (err as Error).message;
                ctx.broadcast({ type: "tool_result", name, ok: false, file, message: msg });
                readResultLines.push(`<result tool="${name}" file="${file}" error="true">\n${msg}\n</result>`);
              }
            }

            // Append the LLM's tool-calling output and the synthetic
            // tool-results as a follow-up turn so iter 1 can summarize.
            messages.push({ role: "assistant", content: llmRaw });
            messages.push({
              role: "user",
              content:
                `Tool results below. Use them to write your final spoken reply now. ` +
                `Do NOT call any more tools — give a 1-2 sentence <say> answer.\n\n` +
                readResultLines.join("\n\n"),
            });
          }

          // 4. Dispatch action tools (deferred so spoken text is paired
          //    with the actual side effect).
          // Track queue-depth aggregates so the spoken-confirmation
          // fallback below can mention "queued behind N" if the LLM
          // didn't already.
          let dispatchMaxQueueDepth = 0;
          let dispatchHadQueueing = false;
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
                const result = channelMgr.dispatchToFilename(
                  sessionProject,
                  file,
                  { message },
                );
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
          if (!speakable) {
            if (pendingActionTools.length === 0) {
              // (a) Plain answer with no <say>: speak the cleaned raw output.
              const noTools = lastLlmRaw.replace(/<tool[\s\S]*?<\/tool>/g, " ").replace(/<tool[^>]*\/>/g, " ");
              const cleaned = cleanForTts(noTools).trim();
              if (cleaned) {
                speakable = cleaned.slice(0, 600);
                usedFallback = true;
                console.log(`[voice-agent] LLM skipped <say> grammar; speaking cleaned text instead. raw=${JSON.stringify(lastLlmRaw.slice(0, 200))}`);
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

          if (speakable) {
            console.log(`[voice-agent] speaking ${speakable.length} chars (fallback=${usedFallback})`);
            ctx.broadcast({ type: "thinking", phase: "tts" });
            let audioFramesEmitted = 0;
            const fanout = new SentenceFanout({
              ttsUrl: getTtsUrl(),
              voice: msg.voice || voicePref,
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
            fanout.feed(speakable);
            fanout.end();
            await fanout.drain();
            console.log(`[voice-agent] turn done — audio frames emitted=${audioFramesEmitted}`);

            history.push({ role: "assistant", content: speakable });
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
          busy = false;
          // User turn done — flush any ambient announcements that arrived
          // while we were busy.
          setImmediate(() => { void drainAnnouncementQueue(); });
        }
      },

      onDestroy() {
        if (activeAbort) {
          try { activeAbort.abort(); } catch { /* ignore */ }
        }
        unsubscribeBroadcastListener();
        announcementQueue.length = 0;
      },
    };
  };
}
