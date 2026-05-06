// Host-side voice helpers used by mica.speak() / mica.listen().
//
// Both helpers run inside the card's iframe-equivalent (CARD_SHIM scope),
// so they only depend on browser globals — no React, no server-bridge
// types. Cards never import this module directly; they reach the
// functionality through `mica.speak()` and `mica.listen()` which the
// CardRuntime binds onto the per-card mica object.
//
// Capture + playback are intentionally tiny: pickSupportedMimeType +
// MediaRecorder + Blob → POST → JSON. The complex bits (sidecar
// lifecycle, ffmpeg fallback, sentence streaming) live server-side.

const PREFERRED_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/wav",
];

function pickSupportedMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of PREFERRED_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

export interface ListenResult {
  transcript: string;
  durationMs: number;
  audioDurationS: number | null;
}

export interface ListenOpts {
  /** AbortSignal that ENDS the recording when aborted. The recorder keeps
   *  capturing until this fires (mirrors the user releasing a press-hold
   *  button). Required — there's no implicit "stop after Ns". */
  releaseSignal: AbortSignal;
  /** Optional — if the recording is shorter than this, resolve with an
   *  empty transcript instead of POSTing (avoids "blank" STT calls on
   *  accidental taps). Default 200ms, same threshold as voice-hello. */
  minDurationMs?: number;
}

/** Capture audio from the user's mic until `releaseSignal` aborts, then POST
 *  the blob to /api/voice/transcribe and return the transcript. The browser
 *  prompts for mic permission on first call; the caller is responsible for
 *  surfacing any denial via the rejected promise.
 *
 *  Resolves with `transcript: ""` if the recording was shorter than
 *  `minDurationMs` (probably an accidental tap). */
export async function listenViaMediaRecorder(opts: ListenOpts): Promise<ListenResult> {
  const minMs = opts.minDurationMs ?? 200;
  const mime = pickSupportedMimeType();
  if (!mime) throw new Error("MediaRecorder is unsupported in this browser");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      sampleRate: 16000,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });

  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const startedAt = Date.now();
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });
  recorder.start();

  // Stop on releaseSignal. If already aborted, stop immediately.
  const onAbort = () => {
    if (recorder.state === "recording") recorder.stop();
  };
  if (opts.releaseSignal.aborted) onAbort();
  else opts.releaseSignal.addEventListener("abort", onAbort, { once: true });

  await stopped;
  // Always release the mic — leaked tracks are visible in the OS indicator.
  stream.getTracks().forEach((t) => t.stop());

  const recordMs = Date.now() - startedAt;
  if (recordMs < minMs || chunks.length === 0) {
    return { transcript: "", durationMs: recordMs, audioDurationS: null };
  }

  const blob = new Blob(chunks, { type: mime });
  const resp = await fetch("/api/voice/transcribe", {
    method: "POST",
    headers: { "Content-Type": mime },
    body: blob,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`/transcribe failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  const json = (await resp.json()) as {
    transcript?: string;
    durationMs?: number;
    audioDurationS?: number | null;
  };
  return {
    transcript: typeof json.transcript === "string" ? json.transcript : "",
    durationMs: typeof json.durationMs === "number" ? json.durationMs : recordMs,
    audioDurationS: typeof json.audioDurationS === "number" ? json.audioDurationS : null,
  };
}

export interface SpeakOpts {
  /** Optional voice override (e.g. `af_sky`). Falls back to the sidecar's
   *  default (`VOICE_TTS_VOICE` env). */
  voice?: string;
  /** AbortSignal that interrupts playback if it fires mid-utterance. The
   *  pending fetch is also aborted. */
  signal?: AbortSignal;
}

/** POST text to /api/voice/synthesize, decode the WAV, play it through a
 *  detached `<audio>` element, resolve when playback ends. The element
 *  is added to document.body (display:none) so browser audio-policy
 *  treats this as a real playback context — Audio() constructor in some
 *  browsers gates auto-play more aggressively. */
export async function speakViaSynthesize(text: string, opts: SpeakOpts = {}): Promise<void> {
  const trimmed = (text || "").trim();
  if (!trimmed) return;

  const body: Record<string, unknown> = { text: trimmed };
  if (opts.voice) body.voice = opts.voice;

  const resp = await fetch("/api/voice/synthesize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`/synthesize failed: ${resp.status} ${errText.slice(0, 200)}`);
  }
  const wavBuf = await resp.arrayBuffer();
  const url = URL.createObjectURL(new Blob([wavBuf], { type: "audio/wav" }));

  const audio = document.createElement("audio");
  audio.src = url;
  audio.style.display = "none";
  document.body.appendChild(audio);

  const cleanup = () => {
    URL.revokeObjectURL(url);
    audio.remove();
  };

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("audio playback failed"));
    };
    if (opts.signal) {
      opts.signal.addEventListener(
        "abort",
        () => {
          audio.pause();
          cleanup();
          reject(new DOMException("aborted", "AbortError"));
        },
        { once: true },
      );
    }
    audio.play().catch((err) => {
      cleanup();
      reject(err);
    });
  });
}
