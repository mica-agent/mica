// SentenceFanout — sentence-by-sentence TTS streaming helper.
//
// Buffers incoming text deltas, cuts on sentence boundaries, fans out
// per-sentence TTS requests in parallel, and emits {sentence, audio}
// frames to a caller-provided callback in strict sentence order.
//
// Used by:
//   - server/index.ts /api/voice/converse (browser → STT → LLM → fanout → audio out)
//   - server/micaAgent.ts                  (Qwen tool-loop → fanout → channel broadcast)
//
// The two callers shape their own outer frame names; this helper only
// emits the abstract "sentence | audio | tts_error" frames so the wire
// format stays each caller's concern.
//
// Sentence boundary: [.!?] followed by whitespace or end-of-stream. Splits
// abbreviations like "Dr." (rare in voice replies; acceptable tradeoff).
//
// Ordering invariant: even though TTS calls overlap, the `audio` frame
// for sentence N is never emitted before the audio frame for N-1. This
// is enforced by chaining each TTS promise's emit step on the previous
// promise. If sentence N-1's TTS errors, the chain still progresses
// (errors emit a `tts_error` frame and resolve) so sentence N is not
// blocked by an upstream failure.

const SENTENCE_RE = /[.!?](?=\s|$)/;

/** Strip markdown so Kokoro doesn't pronounce formatting characters
 *  (asterisks, backticks, brackets, hash signs, etc.). The output is
 *  spoken-text-friendly: links collapse to their text, bullets to plain
 *  lines, headings to plain lines, code blocks are summarised as
 *  "code block", and bare URLs are dropped (reading "h-t-t-p-s-colon-slash-slash"
 *  is universally awful). Conservative on emphasis — `**bold**` is
 *  unwrapped but `_foo_` is left alone to avoid mangling identifiers
 *  like `snake_case`. */
export function cleanForTts(text: string): string {
  let s = text;
  // Fenced code blocks ``` ``` → short placeholder (don't read code aloud).
  s = s.replace(/```[\s\S]*?```/g, " code block. ");
  // Markdown tables: contiguous `|...|` lines → comma-separated prose,
  // with the alignment-row (`|---|---|`) skipped. Without this, TTS would
  // read "vertical bar Item vertical bar Price vertical bar" for every
  // row. Must run before the bullet/heading strips so the per-line `|`
  // markers are gone before whitespace collapses everything onto a line.
  s = s.replace(/(?:^\|.*\|\s*$\n?)+/gm, (block) => {
    const rows = block.trim().split(/\n/);
    const out: string[] = [];
    for (const r of rows) {
      const trimmed = r.trim();
      if (/^\|[\s\-:|]+\|$/.test(trimmed)) continue;
      const cells = trimmed.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length) out.push(cells.join(", "));
    }
    return out.length ? out.join(". ") + ". " : "";
  });
  // Inline code `foo` → keep content, drop ticks.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Markdown links [text](url) → keep just the text.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, "$1");
  // Bare URLs → drop. Reading them character-by-character is unhelpful.
  s = s.replace(/\bhttps?:\/\/\S+/g, "");
  s = s.replace(/\b[a-z0-9.-]+\.(?:com|org|net|io|dev|ai|co|edu|gov)\/\S*/gi, "");
  // Bold **foo** and __foo__ → unwrap.
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "$1");
  s = s.replace(/__([^_\n]+)__/g, "$1");
  // Italic *foo* — only when bounded by whitespace/punctuation, so
  // we don't strip stars inside literal product names etc.
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,!?;:]|$)/g, "$1$2");
  // Heading markers at line start (# / ## / ###).
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  // Bullet markers at line start (- / * / +).
  s = s.replace(/^\s*[-*+]\s+/gm, "");
  // Numbered list markers (1. 2. ...).
  s = s.replace(/^\s*\d+\.\s+/gm, "");
  // Blockquote markers.
  s = s.replace(/^\s*>\s+/gm, "");
  // Backslash-escaped markdown chars: \* \_ \` etc.
  s = s.replace(/\\([\\*_`[\](){}#>+\-.!])/g, "$1");
  // Strip any leftover XML/HTML-style tags (last-line-of-defense for LLM
  // grammar slips like `<tool name="say">...</say>` that weren't caught
  // by the parsers upstream). We delete the tag itself but keep the
  // content between tags. Doesn't affect plain `<` or `>` symbols inside
  // running prose.
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, "");
  // Collapse runs of whitespace (newlines from heading/bullet trims, etc).
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export type FanoutFrame =
  | { type: "sentence"; idx: number; text: string }
  | { type: "audio"; idx: number; wavB64: string }
  | { type: "tts_error"; idx: number; message: string };

export interface SentenceFanoutOpts {
  /** Base URL of the Kokoro TTS sidecar, e.g. `http://127.0.0.1:8014`. */
  ttsUrl: string;
  /** Optional voice override (e.g. `af_sky`). Falls back to the sidecar's default. */
  voice?: string;
  /** Called for each frame, in strict sentence order for `audio` frames. */
  onFrame: (frame: FanoutFrame) => void;
  /** When true, skip the TTS round-trip and emit no `audio` frames. Sentence
   *  text frames still fire so the client can update its reply panel even when
   *  no listener is currently audible. Used when every subscribed client is
   *  hidden — saves Kokoro GPU on a stream nobody will hear. */
  skipTts?: boolean;
}

export class SentenceFanout {
  private pending = "";
  private nextIdx = 0;
  /** Tail of the per-sentence emit chain. Awaiting this drains everything. */
  private chain: Promise<void> = Promise.resolve();
  /** Wall-clock time the first `audio` frame was emitted (for caller metrics). */
  public firstAudioAt: number | null = null;
  /** Set true by cancel(). After this, feed/end/dispatch all short-circuit
   *  and any in-flight TTS HTTP request gets aborted via abortInFlight. */
  private cancelled = false;
  /** Per-call AbortController for the in-flight TTS fetch. cancel() aborts
   *  whichever request is currently waiting on Kokoro; subsequent dispatches
   *  no-op anyway, so a single controller is enough. */
  private abortInFlight: AbortController | null = null;

  constructor(private opts: SentenceFanoutOpts) {}

  /** Append more text from the LLM stream. Triggers TTS for every newly-completed sentence. */
  feed(delta: string): void {
    if (this.cancelled || !delta) return;
    this.pending += delta;
    this.cutCompleteSentences();
  }

  /** Force-flush any remaining buffered text as a final sentence (no terminal punctuation).
   *  Call this when the LLM stream ends to capture trailing fragments. */
  end(): void {
    if (this.cancelled) return;
    const tail = this.pending.trim();
    this.pending = "";
    if (tail) this.dispatch(tail);
  }

  /** Stop all further sentence emits and abort any in-flight TTS request.
   *  Idempotent. After cancel() returns, drain() resolves promptly because
   *  the chain has nothing else queued. Used by the voice agent's barge-in
   *  path so user-spoken interruption silences the current TTS without
   *  letting trailing sentences leak through. */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.abortInFlight) {
      try { this.abortInFlight.abort(); } catch { /* already torn down */ }
    }
  }

  /** Resolves once every dispatched sentence's `audio` (or `tts_error`) frame has fired. */
  async drain(): Promise<void> {
    await this.chain;
  }

  private cutCompleteSentences(): void {
    while (true) {
      const m = this.pending.match(SENTENCE_RE);
      if (!m || m.index === undefined) return;
      const cut = m.index + 1; // include the punctuation
      const sentence = this.pending.slice(0, cut).trim();
      this.pending = this.pending.slice(cut).replace(/^\s+/, "");
      if (sentence) this.dispatch(sentence);
    }
  }

  private dispatch(sentence: string): void {
    if (this.cancelled) return;
    const idx = this.nextIdx++;
    // Emit the sentence text immediately so callers can render it before the
    // audio is back. The audio frame follows in-order.
    this.opts.onFrame({ type: "sentence", idx, text: sentence });

    // skipTts: every subscriber is hidden — there's no audible listener.
    // Keep the sentence text frame above so the reply panel still renders;
    // skip the TTS fetch and the `audio` emit entirely. No GPU spent.
    if (this.opts.skipTts) return;

    // Strip markdown formatting BEFORE sending to TTS. The on-screen text
    // (the `sentence` frame above) keeps the original markup so the chat
    // bubble renders normally; only Kokoro sees the cleaned version.
    const ttsText = cleanForTts(sentence);
    if (!ttsText) {
      // After cleaning, sentence is empty (e.g. a bare URL or a header
      // with no body). Skip the TTS round-trip — emit a tts_error with a
      // skip note so the caller can preserve idx ordering downstream.
      const prior = this.chain;
      this.chain = prior.then(() => {
        this.opts.onFrame({ type: "tts_error", idx, message: `sentence ${idx} empty after markdown strip` });
      });
      return;
    }

    const prior = this.chain;
    const p = (async () => {
      let wavBuf: Buffer | null = null;
      let errMsg: string | null = null;
      // Per-sentence AbortController. cancel() aborts whichever fetch
      // currently owns this slot; the catch below detects AbortError and
      // skips the audio emit cleanly.
      const abortCtl = new AbortController();
      this.abortInFlight = abortCtl;
      try {
        const body: Record<string, unknown> = { text: ttsText };
        if (this.opts.voice) body.voice = this.opts.voice;
        const ttsResp = await fetch(`${this.opts.ttsUrl}/synthesize`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: abortCtl.signal,
        });
        if (!ttsResp.ok) {
          errMsg = `TTS failed for sentence ${idx}: ${ttsResp.status}`;
        } else {
          wavBuf = Buffer.from(await ttsResp.arrayBuffer());
        }
      } catch (err) {
        errMsg = `TTS request failed for sentence ${idx}: ${(err as Error).message}`;
      } finally {
        if (this.abortInFlight === abortCtl) this.abortInFlight = null;
      }
      // Wait for prior sentence's audio (or error) to flush before emitting
      // ours. `prior` resolves even if it errored — `tts_error` frames don't
      // throw — so a single failure doesn't stall the chain.
      await prior;
      // After cancellation: skip the audio emit silently. The card already
      // dropped local playback at barge-in; there's no listener for stale
      // frames. tts_error gets noisy, audio frame would replay on the
      // card if it arrives within the bargedInUntilMs window.
      if (this.cancelled) return;
      if (errMsg) {
        this.opts.onFrame({ type: "tts_error", idx, message: errMsg });
        return;
      }
      if (this.firstAudioAt === null) this.firstAudioAt = Date.now();
      this.opts.onFrame({ type: "audio", idx, wavB64: wavBuf!.toString("base64") });
    })();
    this.chain = p;
  }
}
