// .voice card — Mica's voice assistant.
//
// Press-and-hold to talk. Audio captured via mica.listen()'s underlying
// MediaRecorder, base64-encoded, sent over the channel. Server replies
// with a stream of frames: transcript / sentence_text / sentence_audio /
// tool_call / tool_result / done. Audio frames are queued through a
// single <audio> element for sequential gapless playback.

const talkBtn = container.querySelector('#vc-talk');
const talkBtnIcon = container.querySelector('#vc-talk-icon');
const talkBtnLabel = container.querySelector('#vc-talk-label');
const statusEl = container.querySelector('#vc-status');
const subtitleEl = container.querySelector('#vc-subtitle');
const transcriptWrap = container.querySelector('#vc-transcript-wrap');
const transcriptEl = container.querySelector('#vc-transcript');
const replyWrap = container.querySelector('#vc-reply-wrap');
const replyEl = container.querySelector('#vc-reply');
const toolsWrap = container.querySelector('#vc-tools');
const toolsListEl = container.querySelector('#vc-tools-list');
const audioEl = container.querySelector('#vc-audio');
const metaEl = container.querySelector('#vc-meta');

// VAD-based always-listening pipeline.
//
// When the user clicks the mic on, we open a single MediaStream + a
// MediaRecorder + an AudioContext/AnalyserNode tap, then poll RMS energy
// at 50ms intervals. Crucially, the recorder runs CONTINUOUSLY between
// utterances — we don't wait for VAD to detect speech before starting
// it. If we did, we'd miss the first 50–150ms of every utterance (the
// recorder takes time to spin up, plus VAD has to see one window of
// audio above the threshold before it can fire). Instead we let VAD
// only detect end-of-utterance: when energy stays below SPEECH_RMS for
// SILENCE_MS after a window of speech, we stop the recorder, ship the
// chunks (which include pre-speech silence — Parakeet handles that
// fine), and immediately start a fresh recorder for the next utterance.
let micOn = false;
let micStream = null;
let audioCtx = null;
let analyserNode = null;
let vadSampleBuf = null;
let vadInterval = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordedMime = '';
let speechStartedAt = 0;       // when VAD first saw speech in this recording
let speechActive = false;
let silenceStartedAt = 0;
let lastSpeechMs = 0;          // captured at endUtterance() so onstop can read it
let suppressNextUtterance = false; // turnMicOff() sets this so the final partial recording is discarded

// Tunables. RMS is in [0..1]; with echoCancellation + noiseSuppression on,
// quiet rooms idle around 0.001-0.005. Speaking voice typically registers
// 0.05-0.30. The default 0.02 trips reliably on conversational speech and
// rejects fan/keyboard noise. SILENCE_MS controls how long a pause must
// be before we treat it as end-of-utterance.
const SPEECH_RMS = 0.02;
// 1500ms silence to end an utterance. 800ms tripped on normal mid-
// sentence thinking pauses and shipped partial transcripts ("I want
// to know") to STT/LLM, which then dispatched a confused half-request
// to Qwen. The completeness-check on the server side catches the
// remaining cases where the user pauses for >1.5s mid-thought.
const SILENCE_MS = 1500;
const MIN_UTTERANCE_MS = 350;
const MAX_UTTERANCE_MS = 30000;

function setStatus(label, state) {
  statusEl.textContent = label;
  statusEl.dataset.state = state || 'idle';
}
function setMeta(text) {
  metaEl.textContent = text || '—';
}

// Sequential audio playback. We bypass the <audio> element entirely
// (its play() is gated by Safari/Chrome's autoplay policy and rejects
// async after the user gesture is "consumed"). AudioContext +
// AudioBufferSourceNode plays freely once unlocked from a user gesture
// at mic-on time. Each `assistant_speech` frame is decoded into an
// AudioBuffer and played in order. New turn does NOT wipe the queue —
// click the "stop talking" button to interrupt explicitly.
let playbackCtx = null;
let wavQueue = [];   // AudioBuffer[]
let isPlayingQueue = false;
let currentSource = null;  // AudioBufferSourceNode for the in-flight buffer
const WAV_QUEUE_MAX = 12;

function updateStopSpeakingButton() {
  const stopBtn = container.querySelector('#vc-stop-speaking');
  if (!stopBtn) return;
  stopBtn.style.display = (isPlayingQueue || wavQueue.length > 0) ? '' : 'none';
}

function ensurePlaybackCtx() {
  if (playbackCtx) return playbackCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    console.warn('[voice] no AudioContext available');
    return null;
  }
  playbackCtx = new Ctx();
  return playbackCtx;
}

async function enqueueSpeechWav(b64) {
  const bin = window.atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ctx = ensurePlaybackCtx();
  if (!ctx) return;
  // Resume context if it suspended (browser may have done so during
  // page sleep / background). resume() fails gracefully if the
  // gesture context has lapsed; we'll know from the catch.
  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (_) { /* keep going; decode below will still work */ }
  }
  let buffer;
  try {
    // decodeAudioData mutates the ArrayBuffer slice it consumes, so
    // pass a fresh ArrayBuffer copy. Wrapping bytes.buffer can fail
    // in Safari with "ArrayBuffer detached" if reused.
    buffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  } catch (err) {
    console.warn('[voice] decodeAudioData failed: ' + (err && err.message ? err.message : err));
    return;
  }
  // Bound the queue. Drop oldest pending buffer when we hit the cap
  // so the most recent answer always gets airtime.
  if (wavQueue.length >= WAV_QUEUE_MAX) {
    wavQueue.shift();
    console.log('[voice] audio queue full, dropping oldest');
  }
  wavQueue.push(buffer);
  updateStopSpeakingButton();
  console.log('[voice] enqueued AudioBuffer (' + bytes.length + ' wav bytes, ' + buffer.duration.toFixed(2) + 's); queue=' + wavQueue.length + ' isPlaying=' + isPlayingQueue + ' ctxState=' + ctx.state);
  if (!isPlayingQueue) playNextWav();
}

function playNextWav() {
  const buffer = wavQueue.shift();
  if (!buffer) {
    isPlayingQueue = false;
    currentSource = null;
    updateStopSpeakingButton();
    if (statusEl.dataset.state === 'speaking') {
      setStatus(micOn ? 'Listening' : 'Ready', micOn ? 'recording' : 'ready');
    }
    return;
  }
  const ctx = ensurePlaybackCtx();
  if (!ctx) {
    isPlayingQueue = false;
    return;
  }
  isPlayingQueue = true;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = function() {
    if (currentSource === src) currentSource = null;
    playNextWav();
  };
  currentSource = src;
  updateStopSpeakingButton();
  try {
    src.start(0);
    console.log('[voice] started AudioBufferSource (' + buffer.duration.toFixed(2) + 's)');
  } catch (err) {
    console.warn('[voice] src.start() threw: ' + (err && err.message ? err.message : err));
    playNextWav();
  }
}

function stopVoicePlayback() {
  if (currentSource) {
    try { currentSource.onended = null; currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  wavQueue = [];
  isPlayingQueue = false;
  updateStopSpeakingButton();
}

// Wire the explicit "stop talking" button. Visible only while audio
// is playing or pending. Clicking nukes the queue and pauses playback.
const _stopSpeakingBtn = container.querySelector('#vc-stop-speaking');
if (_stopSpeakingBtn) {
  _stopSpeakingBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    stopVoicePlayback();
  });
}

function resetReplyDisplay() {
  // Visual reset only. The audio queue keeps playing across user
  // utterances — wiping it would cut off long ambient full-reads the
  // moment the user asks a follow-up question. Use the explicit
  // "stop talking" button (or mica.onDestroy on card unmount) to
  // tear down audio.
  replyEl.textContent = '';
  replyWrap.style.display = 'none';
  toolsListEl.innerHTML = '';
  toolsWrap.style.display = 'none';
  // Reset the reply label in case it was tagged by a prior ambient
  // announcement ("🔔 Qwen (canvas/qwen.chat)").
  const labelEl = container.querySelector('.vc-reply-label');
  if (labelEl) labelEl.textContent = 'Mica';
  // NOTE: do NOT stopVoicePlayback() here. Audio outlives the visual
  // panel — the new bubble fills as the previous answer's audio drains.
}

// ── Mic capture (toggle + VAD) ─────────────────────────────────

function blobToBase64(blob) {
  return new Promise(function(resolve, reject) {
    const reader = new window.FileReader();
    reader.onload = function() {
      const result = reader.result || '';
      const idx = result.indexOf(',');
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/wav',
  ];
  return candidates.find(function(m) {
    return window.MediaRecorder && window.MediaRecorder.isTypeSupported(m);
  }) || '';
}

function applyMicButtonState() {
  talkBtn.dataset.mic = micOn ? 'on' : 'off';
  if (!micOn) {
    delete talkBtn.dataset.hearing;
    talkBtnIcon.textContent = '\u{1F3A4}';  // 🎤
    talkBtnLabel.textContent = 'Click to turn on';
    return;
  }
  if (speechActive) {
    talkBtn.dataset.hearing = 'true';
    talkBtnIcon.textContent = '\u{1F50A}';  // 🔊
    talkBtnLabel.textContent = 'Hearing you';
  } else {
    delete talkBtn.dataset.hearing;
    talkBtnIcon.textContent = '\u{1F3A4}';
    talkBtnLabel.textContent = 'Listening';
  }
}

async function turnMicOn() {
  if (micOn) return;
  recordedMime = pickRecorderMime();
  if (!recordedMime) {
    setStatus('No supported audio format', 'error');
    setMeta('This browser cannot record audio.');
    return;
  }
  // Unlock the playback AudioContext from this user-gesture click.
  // Without this, async audio frames arriving after a server round-trip
  // get blocked by Safari/Chrome's autoplay policy with NotAllowedError.
  // The context, once resumed under a gesture, stays unlocked for the
  // session lifetime.
  const playCtx = ensurePlaybackCtx();
  if (playCtx && playCtx.state === 'suspended') {
    try { await playCtx.resume(); console.log('[voice] playback AudioContext resumed'); }
    catch (e) { console.warn('[voice] resume() failed: ' + (e && e.message ? e.message : e)); }
  }
  let stream;
  try {
    stream = await window.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    setStatus('Mic blocked', 'error');
    setMeta('Grant microphone permission in the browser, then click again.');
    return;
  }
  micStream = stream;
  // Web Audio analyser for VAD energy sampling.
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  const source = audioCtx.createMediaStreamSource(stream);
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 1024;
  analyserNode.smoothingTimeConstant = 0.4;
  source.connect(analyserNode);
  vadSampleBuf = new Uint8Array(analyserNode.frequencyBinCount);

  micOn = true;
  speechActive = false;
  silenceStartedAt = 0;
  speechStartedAt = 0;
  lastSpeechMs = 0;
  suppressNextUtterance = false;
  // Start the recorder NOW — before the user has spoken — so we capture
  // the first phoneme without spin-up lag. VAD only marks where speech
  // starts/ends within this rolling recording.
  startUtteranceRecorder();
  applyMicButtonState();
  setStatus('Listening', 'recording');
  setMeta('Mic on. Speak whenever — pauses end the utterance.');
  vadInterval = window.setInterval(checkVad, 50);
}

function turnMicOff() {
  if (!micOn) return;
  micOn = false;
  speechActive = false;
  silenceStartedAt = 0;
  speechStartedAt = 0;
  if (vadInterval) {
    window.clearInterval(vadInterval);
    vadInterval = null;
  }
  // Suppress the in-flight recorder's onstop — we don't want to ship a
  // partial recording when the user is just turning the mic off.
  suppressNextUtterance = true;
  if (mediaRecorder) {
    try {
      if (mediaRecorder.state === 'recording') mediaRecorder.stop();
    } catch (_) { /* ignore */ }
    mediaRecorder = null;
  }
  if (micStream) {
    micStream.getTracks().forEach(function(t) { try { t.stop(); } catch (_) {} });
    micStream = null;
  }
  if (audioCtx) {
    try { audioCtx.close(); } catch (_) {}
    audioCtx = null;
  }
  analyserNode = null;
  vadSampleBuf = null;
  applyMicButtonState();
  setStatus('Mic off', 'idle');
  setMeta('Click the mic to turn it back on.');
}

function startUtteranceRecorder() {
  if (!micStream) return;
  try {
    mediaRecorder = new window.MediaRecorder(micStream, { mimeType: recordedMime });
  } catch (err) {
    console.warn('[voice] failed to create MediaRecorder:', err && err.message);
    return;
  }
  recordedChunks = [];
  speechStartedAt = 0;
  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) {
      recordedChunks.push(e.data);
      console.log('[voice] ondataavailable: chunk size=' + e.data.size + ' total=' + recordedChunks.length);
    } else {
      console.log('[voice] ondataavailable fired but data was empty');
    }
  };
  mediaRecorder.onstop = onUtteranceRecorderStopped;
  mediaRecorder.onerror = function(e) {
    console.error('[voice] MediaRecorder.onerror:', e && e.error ? e.error : e);
  };
  // iOS Safari requires a timeslice (>0) for ondataavailable to fire
  // reliably during recording. Without timeslice some Safari builds emit
  // 0 chunks even on stop. 1000ms is a reasonable default.
  mediaRecorder.start(1000);
  console.log('[voice] MediaRecorder.start() with mime=' + recordedMime);
}

async function onUtteranceRecorderStopped() {
  // Capture the frozen chunk list and speech-duration before any restart
  // can clobber them.
  const chunks = recordedChunks;
  const speechMs = lastSpeechMs;
  recordedChunks = [];
  lastSpeechMs = 0;
  // Immediately spin up a fresh recorder for the next utterance — so the
  // gap between this stop and the next phrase is as small as possible.
  if (micOn) startUtteranceRecorder();

  if (suppressNextUtterance) {
    suppressNextUtterance = false;
    console.log('[voice] onstop: suppressed (mic-off path)');
    return;
  }
  // Filter blips: speech window shorter than MIN_UTTERANCE_MS is likely a
  // VAD spike (cough, click, brief breath). Don't ship to STT.
  if (speechMs < MIN_UTTERANCE_MS) {
    console.log('[voice] onstop: speech too short (' + speechMs + 'ms < ' + MIN_UTTERANCE_MS + 'ms), skipping');
    return;
  }
  if (chunks.length === 0) {
    console.warn('[voice] onstop: NO CHUNKS captured (MediaRecorder produced no data) — speech was ' + speechMs + 'ms');
    return;
  }
  const blob = new window.Blob(chunks, { type: recordedMime });
  console.log('[voice] onstop: ' + chunks.length + ' chunks, blob.size=' + blob.size + ' speechMs=' + speechMs);
  if (blob.size < 500) {
    console.warn('[voice] onstop: blob too small (' + blob.size + ' bytes), skipping');
    return;
  }
  let b64;
  try {
    b64 = await blobToBase64(blob);
  } catch (err) {
    setMeta('Encode failed: ' + String(err && err.message ? err.message : err));
    return;
  }
  console.log('[voice] sending to server: ' + b64.length + ' b64chars mime=' + recordedMime);
  resetReplyDisplay();
  ch.send({ audioB64: b64, audioMime: recordedMime });
}

function checkVad() {
  if (!analyserNode || !vadSampleBuf) return;
  analyserNode.getByteTimeDomainData(vadSampleBuf);
  // RMS over the time-domain sample. getByteTimeDomainData centers at 128;
  // map back to [-1, 1] before squaring.
  let sumSq = 0;
  for (let i = 0; i < vadSampleBuf.length; i++) {
    const x = (vadSampleBuf[i] - 128) / 128;
    sumSq += x * x;
  }
  const rms = Math.sqrt(sumSq / vadSampleBuf.length);
  const now = Date.now();

  if (rms > SPEECH_RMS) {
    if (!speechActive) {
      // Speech just started — recorder is already running, so the audio
      // BEFORE this point is captured too (no missing-first-word issue).
      speechActive = true;
      speechStartedAt = now;
      applyMicButtonState();
    }
    silenceStartedAt = 0;
  } else if (speechActive) {
    if (silenceStartedAt === 0) silenceStartedAt = now;
    if (now - silenceStartedAt >= SILENCE_MS) {
      endUtterance();
    }
  }
  // Force-cut overly long utterances (catch-all for stuck VAD).
  if (speechActive && speechStartedAt > 0 && now - speechStartedAt >= MAX_UTTERANCE_MS) {
    endUtterance();
  }
}

function endUtterance() {
  if (!speechActive) return;
  // Capture the speech duration NOW so onUtteranceRecorderStopped can
  // filter sub-MIN_UTTERANCE_MS blips. silenceStartedAt holds the
  // moment speech ended; speechStartedAt holds the moment it began.
  lastSpeechMs = silenceStartedAt > 0 && speechStartedAt > 0
    ? silenceStartedAt - speechStartedAt
    : 0;
  speechActive = false;
  silenceStartedAt = 0;
  speechStartedAt = 0;
  applyMicButtonState();
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    try { mediaRecorder.stop(); } catch (_) {}
  }
}

// ── Channel ────────────────────────────────────────────────────
//
// Wrapper around mica.openChannel that auto-reopens after WS-level
// disconnects (tab backgrounded, network blip, proxy idle-timeout).
// The card sees a stable `ch` API; under the hood we replace the
// underlying channel object on reconnect and re-register handlers.
let _ch = null;
let _onDataCb = null;
let _onCloseCb = null;
let _reconnectAttempts = 0;
function _openVoiceChannel() {
  _ch = mica.openChannel('voice_session');
  if (_onDataCb) _ch.onData(_onDataCb);
  _ch.onClose(function() {
    console.warn('[voice] channel closed; will retry');
    if (_onCloseCb) {
      try { _onCloseCb(); } catch (e) { console.error(e); }
    }
    // Backoff: 500ms, 1s, 2s, 4s, max 8s.
    const delay = Math.min(8000, 500 * Math.pow(2, _reconnectAttempts++));
    window.setTimeout(function() {
      console.log('[voice] reopening channel (attempt ' + _reconnectAttempts + ')');
      _openVoiceChannel();
    }, delay);
  });
  _reconnectAttempts = 0;
}
_openVoiceChannel();
const ch = {
  onData: function(cb) { _onDataCb = cb; if (_ch) _ch.onData(cb); },
  onClose: function(cb) { _onCloseCb = cb; },
  send: function(payload) { if (_ch) _ch.send(payload); },
};

let turnStartedAt = 0;
let firstAudioMs = null;

ch.onData(function(data) {
  if (!data || typeof data !== 'object') return;
  const t = data.type;

  if (t === 'history') {
    // Show last assistant reply if any (mostly for re-attaches).
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    const lastAssistant = [...msgs].reverse().find(function(m) { return m.role === 'assistant'; });
    if (lastAssistant) {
      replyEl.textContent = lastAssistant.content;
      replyWrap.style.display = '';
    }
    setStatus('Ready', 'ready');
    return;
  }

  if (t === 'thinking') {
    if (data.phase === 'stt') setStatus('Transcribing', 'processing');
    else if (data.phase === 'llm') setStatus('Thinking', 'processing');
    else if (data.phase === 'tts') setStatus('Speaking', 'speaking');
    return;
  }

  if (t === 'transcript') {
    if (data.text) {
      transcriptEl.textContent = data.text;
      transcriptEl.style.fontStyle = '';
      transcriptEl.style.opacity = '';
      transcriptWrap.style.display = '';
    } else {
      setStatus('No speech detected', 'idle');
      setMeta('Hold the button while speaking — release when done.');
    }
    if (turnStartedAt === 0) turnStartedAt = Date.now();
    return;
  }

  if (t === 'transcript_partial') {
    // Voice paused mid-thought — server is buffering, waiting for the
    // user to continue. Show the partial in italics + a "go on" hint.
    transcriptEl.textContent = (data.text || '') + ' …';
    transcriptEl.style.fontStyle = 'italic';
    transcriptEl.style.opacity = '0.75';
    transcriptWrap.style.display = '';
    setStatus('Go on…', 'processing');
    setMeta('Sounds like you paused — keep going.');
    return;
  }

  if (t === 'tool_call') {
    toolsWrap.style.display = '';
    const row = window.document.createElement('div');
    row.className = 'vc-tool';
    row.dataset.ok = 'pending';
    row.textContent = '→ ' + (data.name || '?') + (data.args ? ' (' + String(data.args).slice(0, 80) + ')' : '');
    row.dataset.toolName = data.name || '';
    toolsListEl.appendChild(row);
    return;
  }

  if (t === 'tool_result') {
    const rows = toolsListEl.querySelectorAll('.vc-tool');
    let target = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].dataset.ok === 'pending' && rows[i].dataset.toolName === data.name) {
        target = rows[i];
        break;
      }
    }
    if (!target) {
      target = window.document.createElement('div');
      target.className = 'vc-tool';
      toolsListEl.appendChild(target);
    }
    target.dataset.ok = data.ok ? 'true' : 'false';
    const msg = data.ok ? '✓' : '✗';
    let detail = '';
    if (data.name === 'send_to_card' && data.file) detail = ' → ' + data.file;
    if (data.message && !data.ok) detail += ': ' + String(data.message).slice(0, 80);
    target.textContent = msg + ' ' + (data.name || '?') + detail;
    return;
  }

  if (t === 'ambient_announcement_start') {
    // A chat card on the canvas finished a turn — voice is about to
    // speak a 1-2 sentence summary. Reset the reply panel + label it
    // so the user doesn't think this came from their last utterance.
    replyEl.textContent = '';
    replyWrap.style.display = '';
    const labelEl = container.querySelector('.vc-reply-label');
    if (labelEl) labelEl.textContent = '\u{1F514} ' + (data.agent || 'Agent') + ' (' + (data.file || 'card') + ')';
    return;
  }

  if (t === 'ambient_announcement_done') {
    // Restore the regular reply label so the next user-prompted reply
    // doesn't keep the bell + filename header.
    const labelEl = container.querySelector('.vc-reply-label');
    if (labelEl) labelEl.textContent = 'Mica';
    return;
  }

  if (t === 'assistant_speech_text') {
    replyWrap.style.display = '';
    replyEl.textContent += (replyEl.textContent ? ' ' : '') + (data.text || '');
    return;
  }

  if (t === 'assistant_speech') {
    if (firstAudioMs === null && turnStartedAt > 0) {
      firstAudioMs = Date.now() - turnStartedAt;
    }
    console.log('[voice] received assistant_speech idx=' + data.sentence_idx + ' wav=' + (data.wav_b64 ? data.wav_b64.length : 0) + 'b64chars ambient=' + !!data.ambient);
    enqueueSpeechWav(data.wav_b64);
    return;
  }

  if (t === 'assistant') {
    // Already shown via assistant_speech_text frames, but if fanout was
    // empty (LLM didn't emit <say>) this carries the fallback text.
    if (data.content && !replyEl.textContent) {
      replyEl.textContent = data.content;
      replyWrap.style.display = '';
    }
    return;
  }

  if (t === 'done') {
    const elapsed = turnStartedAt > 0 ? Date.now() - turnStartedAt : null;
    setMeta(
      (elapsed != null ? 'turn ' + elapsed + 'ms · ' : '') +
      (firstAudioMs != null ? 'first audio ' + firstAudioMs + 'ms' : 'no audio')
    );
    turnStartedAt = 0;
    firstAudioMs = null;
    // After a turn, return the status to whatever matches mic state. If
    // audio is still queued (we just finished synthesizing but playback
    // is mid-utterance), playNextWav's onended handler will flip it.
    if (!isPlayingQueue) setStatus(micOn ? 'Listening' : 'Ready', micOn ? 'recording' : 'ready');
    return;
  }

  if (t === 'error') {
    setStatus('Error', 'error');
    setMeta(String(data.error || 'unknown error'));
    return;
  }
});

ch.onClose(function() {
  setStatus('Reconnecting…', 'processing');
  setMeta('Channel dropped — auto-reopening.');
});

// ── Toggle bindings ────────────────────────────────────────────
talkBtn.addEventListener('click', function() {
  if (talkBtn.disabled) return;
  if (micOn) turnMicOff();
  else turnMicOn();
});
// Spacebar shortcut while card is focused — also a toggle.
container.addEventListener('keydown', function(e) {
  if (e.key === ' ' && !talkBtn.disabled && !e.target.matches('input, textarea')) {
    e.preventDefault();
    if (micOn) turnMicOff();
    else turnMicOn();
  }
});

// ── Server status check (model loading on first run) ──────────
async function checkServerReady() {
  try {
    const r = await window.fetch('/api/voice/status');
    if (!r.ok) return;
    const s = await r.json();
    if (s.disabled) {
      setStatus('Voice disabled', 'error');
      setMeta('Server started with MICA_DISABLE_VOICE=1');
      talkBtn.disabled = true;
      return;
    }
    if (!s.stt.ready || !s.tts.ready) {
      setStatus('Loading models', 'processing');
      const missing = [];
      if (!s.stt.ready) missing.push('STT');
      if (!s.tts.ready) missing.push('TTS');
      setMeta('Waiting for: ' + missing.join(', ') + ' (first run downloads weights, ~5-10 min).');
      window.setTimeout(checkServerReady, 2000);
      return;
    }
    setStatus('Ready', 'ready');
    setMeta('STT: Parakeet · TTS: Kokoro · LLM: Qwen3.6 — all local.');
  } catch (err) {
    setStatus('Backend offline', 'error');
    setMeta('Could not reach /api/voice/status.');
  }
}
checkServerReady();

// ── Cleanup ────────────────────────────────────────────────────
mica.onDestroy(function() {
  turnMicOff();
  stopVoicePlayback();
  if (playbackCtx) {
    try { playbackCtx.close(); } catch (_) {}
    playbackCtx = null;
  }
});
