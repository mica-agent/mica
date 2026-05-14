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
const activityListEl = container.querySelector('#vc-activity-list');
const activityClearEl = container.querySelector('#vc-activity-clear');

// Persistent activity log. Captures STT outputs, tool dispatches +
// outcomes, Mica's spoken replies, bargers, aborts, and errors so the
// user can see what's actually happening turn over turn. Cleared only
// on the explicit "clear" button (or card remount).
const ACTIVITY_MAX_ROWS = 200;
function pad2(n) { return n < 10 ? '0' + n : String(n); }
function activityTimestamp() {
  const d = new Date();
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}
function appendActivity(kind, text) {
  if (!activityListEl) return;
  const row = window.document.createElement('div');
  row.className = 'vc-activity-row';
  row.dataset.kind = kind;
  const timeEl = window.document.createElement('span');
  timeEl.className = 'vc-activity-time';
  timeEl.textContent = activityTimestamp();
  const kindEl = window.document.createElement('span');
  kindEl.className = 'vc-activity-kind';
  kindEl.textContent = kind;
  const textEl = window.document.createElement('span');
  textEl.className = 'vc-activity-text';
  textEl.textContent = String(text || '');
  row.appendChild(timeEl);
  row.appendChild(kindEl);
  row.appendChild(textEl);
  activityListEl.appendChild(row);
  // FIFO trim — keep DOM small even on long sessions.
  while (activityListEl.children.length > ACTIVITY_MAX_ROWS) {
    activityListEl.removeChild(activityListEl.firstChild);
  }
  // Auto-scroll to bottom so newest is visible.
  activityListEl.scrollTop = activityListEl.scrollHeight;
}
if (activityClearEl) {
  activityClearEl.addEventListener('click', function () {
    activityListEl.innerHTML = '';
  });
}
const audioEl = container.querySelector('#vc-audio');
const metaEl = container.querySelector('#vc-meta');
const voiceSelectEl = container.querySelector('#vc-voice-select');

// Currently-selected Kokoro voice. Default matches the sidecar's
// VOICE_TTS_VOICE fallback (af_bella). Loaded from this card's
// instance file (a JSON blob {voice: "..."}) on init; written back
// on every change. Sent to the server two ways: as a per-message
// `voice:` field on every audioB64 payload, AND as a session-level
// `set_voice` control message that updates voicePref so ambient
// announcements pick up the change too.
const DEFAULT_VOICE = 'af_bella';
let currentVoice = DEFAULT_VOICE;

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
let bargeCandidateStartedAt = 0; // when high-energy frames started during TTS playback (resets if rms drops)
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
// Barge-in (interrupting Mica's TTS) is gated by SUSTAINED speech-level
// activity. Same RMS threshold as ordinary speech detection (so normal
// conversational volume triggers) but requires the energy stay above
// threshold for BARGE_IN_DURATION_MS continuously — that filters the
// false-positive sources (cough/click/chair-creak/keyboard-tap), which
// are all sub-150ms transients that decay fast.
// Tuning notes:
//   - Bump BARGE_IN_RMS if Mica's own speaker echo trips barge (rare;
//     speaker→mic bleed is usually well below 0.02 RMS).
//   - Bump BARGE_IN_DURATION_MS if false positives still occur (e.g.
//     500 for very rapid mid-noisy environments). Trade-off: laggier
//     barge response.
const BARGE_IN_RMS = SPEECH_RMS;
const BARGE_IN_DURATION_MS = 150;
// 1500ms silence to end an utterance. 800ms tripped on normal mid-
// sentence thinking pauses and shipped partial transcripts ("I want
// to know") to STT/LLM, which then dispatched a confused half-request
// to Qwen. The completeness-check on the server side catches the
// remaining cases where the user pauses for >1.5s mid-thought.
const SILENCE_MS = 1500;
// 200ms catches short single-word answers like "yes" / "no" / "ok"
// (typical 200–300ms) without flooding STT with random blips. Server-
// side Silero VAD rejects non-speech audio (0 segments → empty
// transcript → silent drop in voiceAgent), so the cost of a slipped-
// through tiny noise blip is just a wasted STT request, not a
// hallucinated user message. Was 350ms; that bar required users to
// drag out short answers ("yeeessss") to be heard.
const MIN_UTTERANCE_MS = 200;
const MAX_UTTERANCE_MS = 30000;

function setStatus(label, state) {
  statusEl.textContent = label;
  statusEl.dataset.state = state || 'idle';
}
function setMeta(text) {
  metaEl.textContent = text || '—';
}

// Reply text accumulator + markdown renderer.
//
// Streamed `assistant_speech_text` frames arrive sentence-by-sentence
// during a turn; we append to `replyRaw` and re-render the whole
// buffer to HTML on each frame. Markdown re-render is cheap for the
// reply-panel-sized content (a few sentences to a few paragraphs);
// re-rendering also handles the case where the final sentence
// completes a markdown construct (e.g. closing fence) that was
// half-formed in the prior frame.
//
// The renderer is a trimmed copy of card-classes/chat/card.js's
// renderMarkdown — same supported subset (headings, bold/italic,
// inline code, fenced blocks, tables, lists, line breaks). Mica's
// answers are the only content fed in; LLM output is trusted enough
// that we avoid a full sanitizer, but `<` / `>` / `&` are escaped
// before any markup substitution to block accidental HTML injection.
let replyRaw = '';

function renderMarkdown(text) {
  text = text.replace(/^```markdown\n([\s\S]*?)```$/gm, function(m, inner) { return inner; });
  // Extract fenced code blocks.
  const fenced = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    fenced.push('<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0"><code style="font-size:12px;font-family:monospace">' + code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</code></pre>');
    return '__FENCED__' + (fenced.length - 1) + '__';
  });
  // Extract tables (consecutive lines starting with |).
  const tables = [];
  text = text.replace(/(^\|.+\|\n?)+/gm, function(block) {
    const rows = block.trim().split('\n');
    let html = '<table style="border-collapse:collapse;margin:6px 0;font-size:12px;width:100%">';
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri].trim();
      if (/^\|[\s-:|]+\|$/.test(row)) continue;
      const cells = row.split('|').filter(function(c, i, a) { return i > 0 && i < a.length - 1; });
      const tag = ri === 0 ? 'th' : 'td';
      html += '<tr>';
      for (let ci = 0; ci < cells.length; ci++) {
        const style = tag === 'th' ? 'background:rgba(255,255,255,0.05);font-weight:600;' : '';
        html += '<' + tag + ' style="border:1px solid #333;padding:4px 8px;' + style + '">' + cells[ci].trim() + '</' + tag + '>';
      }
      html += '</tr>';
    }
    html += '</table>';
    tables.push(html);
    return '__TABLE__' + (tables.length - 1) + '__';
  });
  text = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>');
  // Wrap consecutive <li> runs in <ul>.
  text = text.replace(/(?:<li>[\s\S]*?<\/li>(?:<br\/>)?)+/g, function(m) {
    return '<ul>' + m.replace(/<br\/>/g, '') + '</ul>';
  });
  for (let fi = 0; fi < fenced.length; fi++) text = text.replace('__FENCED__' + fi + '__', fenced[fi]);
  for (let ti = 0; ti < tables.length; ti++) text = text.replace('__TABLE__' + ti + '__', tables[ti]);
  return text;
}

function setReplyRaw(text) {
  replyRaw = text || '';
  replyEl.innerHTML = renderMarkdown(replyRaw);
}
function appendReplyRaw(text) {
  if (!text) return;
  // Newline (not space) separator. A markdown table row needs to start
  // its own line for the renderer to detect it; a single \n also acts
  // as a soft break for prose, which is fine. Streaming sentences land
  // one per line — pleasant for chat-style streaming UI and required
  // for any structured content (tables, lists) to render correctly.
  replyRaw += (replyRaw ? '\n' : '') + text;
  replyEl.innerHTML = renderMarkdown(replyRaw);
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
// After a barge-in (user starts speaking / hits stop talking), discard
// any `assistant_speech` frames that arrive within this window. Covers
// the WS-flight race: server's fanout cancel takes ~50ms to land, but
// frames already on the wire arrive afterward and would otherwise
// requeue into wavQueue right after stopVoicePlayback emptied it.
// 800ms is comfortable; the new user turn's TTS won't generate frames
// for 1.5–3s anyway.
let bargedInUntilMs = 0;

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
  // Barge-in gate: drop frames that arrive within the post-barge window.
  // The server's fanout cancel races with frames already on the wire;
  // without this, those late frames would requeue right after the user
  // told voice to shut up.
  if (Date.now() < bargedInUntilMs) {
    console.log('[voice] dropping assistant_speech frame (barged-in window)');
    return;
  }
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
  // Visibility gate: only the focused tab plays audio. Other tabs
  // (background tab on the same device, a different device, or a
  // different project) still render assistant_speech_text into the
  // reply panel but stay silent. Drop the buffer rather than queue it
  // — by the time the user refocuses, the answer is stale.
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
    console.log('[voice] dropping audio buffer (tab hidden)');
    playNextWav();
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
    bargedInUntilMs = Date.now() + 800;
    stopVoicePlayback();
    appendActivity('barge', 'stop-talking button — TTS canceled');
    try { ch.send({ type: 'barge_in' }); } catch (_) { /* channel may be reconnecting */ }
  });
}

// Visibility-gated playback + mic. When the tab hides:
//   1. Stop active playback and drop the queue (audio gate).
//   2. Turn the mic off — prevents continuous audio→STT→LLM→TTS work
//      on a tab no one is listening to. User has to re-click mic on
//      when they return (matches browser autoplay/gesture rules).
//   3. Notify the server (`presence: false`) so it can skip TTS work
//      for sessions where every subscriber is hidden.
// The rule applies symmetrically across same-device tabs and across
// devices — only the document-visible tab consumes upstream resources.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', function() {
    const visible = document.visibilityState === 'visible';
    if (!visible) {
      if (isPlayingQueue || wavQueue.length > 0) {
        console.log('[voice] tab hidden during playback — stopping');
        stopVoicePlayback();
      }
      if (micOn) {
        console.log('[voice] tab hidden — turning mic off');
        turnMicOff();
      }
    }
    try { ch.send({ type: 'presence', visible: visible }); } catch (_) {}
  });
}

function resetReplyDisplay() {
  // Visual reset only. The audio queue keeps playing across user
  // utterances — wiping it would cut off long ambient full-reads the
  // moment the user asks a follow-up question. Use the explicit
  // "stop talking" button (or mica.onDestroy on card unmount) to
  // tear down audio.
  setReplyRaw('');
  replyWrap.style.display = 'none';
  // Activity log persists across turns — only the reply bubble resets.
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
  //
  // Force a fresh context on every mic-on. Safari can leave the prior
  // context in a stale "running but silent" state after tab inactivity
  // or output-device drift — `state` keeps reading "running" and
  // `src.start()` stops throwing, but `ctx.destination` produces nothing.
  // Page refresh recovers; recreating under the current gesture is the
  // in-page equivalent. Side effect: any in-flight queued audio is cut
  // off — that's the right call, mic-on means "ready for a new turn."
  if (playbackCtx) {
    try { playbackCtx.close(); } catch (_) {}
    playbackCtx = null;
  }
  wavQueue = [];
  isPlayingQueue = false;
  currentSource = null;
  const playCtx = ensurePlaybackCtx();
  if (playCtx) {
    // Always resume — Safari/iOS start fresh contexts in "suspended" and
    // need the explicit resume; Chromium starts in "running" but the
    // resume call is a no-op there, so it's safe to always invoke.
    try { await playCtx.resume(); }
    catch (e) { console.warn('[voice] resume() failed: ' + (e && e.message ? e.message : e)); }
    // Prime the audio graph. Both Chromium and Safari can keep the
    // context in a "running but silent" state after a soft reload
    // (window.location.reload()) — the context's `state` reads
    // "running" and src.start() doesn't throw, but ctx.destination
    // produces nothing until a real buffer flows through it. Playing
    // a 1-frame silent buffer synchronously inside this user gesture
    // physically wires the graph to the output device. Force-refresh
    // worked around this; primingthe graph in-page removes the need.
    try {
      const primeBuf = playCtx.createBuffer(1, 1, playCtx.sampleRate);
      const primeSrc = playCtx.createBufferSource();
      primeSrc.buffer = primeBuf;
      primeSrc.connect(playCtx.destination);
      primeSrc.start(0);
      console.log('[voice] playback AudioContext (re)created, resumed, primed; state=' + playCtx.state + ' sampleRate=' + playCtx.sampleRate);
    } catch (e) {
      console.warn('[voice] prime buffer failed: ' + (e && e.message ? e.message : e));
    }
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
  ch.send({ audioB64: b64, audioMime: recordedMime, voice: currentVoice });
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

  // Suppress normal utterance detection while Mica's TTS is playing.
  // Browser AEC isn't perfect — speaker output bleeds back into the mic
  // at speech-level RMS, and without this gate Parakeet transcribes
  // Mica's own voice as if it were the user's, producing a self-echo
  // feedback loop ("Hey Winston, what's up?" comes back as a user
  // turn). The barge-in path below is the explicit way to interrupt
  // TTS — it requires sustained louder activity and is unaffected by
  // this gate.
  const ttsActive = isPlayingQueue || wavQueue.length > 0;
  if (!ttsActive) {
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
  } else if (speechActive) {
    // TTS started while we were mid-utterance (rare but possible if
    // the assistant is mid-reply and the user paused, then TTS arrived
    // from an ambient or delegation path). Drop the in-progress
    // utterance rather than commit it half-formed — odds are it's
    // already partial bleed-through.
    speechActive = false;
    silenceStartedAt = 0;
    speechStartedAt = 0;
    applyMicButtonState();
  }

  // ── Barge-in detection (separate path) ─────────────────────────────
  // Only consider barging while Mica is actually speaking. Require BOTH
  // a louder threshold AND sustained activity to filter out short/quiet
  // false positives (coughs, clicks, fan noise, keyboard taps).
  if (ttsActive && Date.now() >= bargedInUntilMs) {
    if (rms > BARGE_IN_RMS) {
      if (bargeCandidateStartedAt === 0) {
        bargeCandidateStartedAt = now;
      } else if (now - bargeCandidateStartedAt >= BARGE_IN_DURATION_MS) {
        console.log(`[voice] barge-in: ${(now - bargeCandidateStartedAt)}ms of sustained activity at rms=${rms.toFixed(3)} (threshold ${BARGE_IN_RMS}) during TTS playback`);
        bargedInUntilMs = now + 800;
        bargeCandidateStartedAt = 0;
        stopVoicePlayback();
        appendActivity('barge', 'voice-detected interruption during TTS');
        try { ch.send({ type: 'barge_in' }); } catch (_) { /* channel may be reconnecting */ }
      }
    } else {
      // Activity dropped — reset candidate. A real interruption sustains;
      // a transient drops back to silence after one window.
      bargeCandidateStartedAt = 0;
    }
  } else {
    // No TTS playing, or we're inside the post-barge cooldown — keep the
    // candidate reset so we don't carry stale state into the next playback.
    bargeCandidateStartedAt = 0;
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
  // Initial presence: tell the server whether this tab is currently
  // visible. The server uses this to skip TTS for sessions where
  // every subscriber is hidden. Re-sent on every reconnect so the
  // server's per-client state is in sync after a WS blip.
  try {
    const visible = typeof document !== 'undefined'
      ? document.visibilityState === 'visible'
      : true;
    _ch.send({ type: 'presence', visible: visible });
  } catch (_) {}
  // Sync the currently-selected voice to the server so the session's
  // voicePref matches the dropdown. Updates ambient TTS path which
  // doesn't see per-message voice fields. Re-sent on reconnect.
  try {
    if (currentVoice) _ch.send({ type: 'set_voice', voice: currentVoice });
  } catch (_) {}
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

// ── Voice selection (persisted to instance file) ────────────────
//
// Load saved voice on init (if any), apply to dropdown + currentVoice,
// re-send set_voice so server matches persisted state. Dropdown
// changes update currentVoice, persist, and notify the server. The
// instance file is plain JSON: {"voice": "af_sky"}.
async function loadVoiceState() {
  try {
    const raw = await mica.getContent();
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.voice === 'string' && parsed.voice.trim()) {
      currentVoice = parsed.voice.trim();
      if (voiceSelectEl) voiceSelectEl.value = currentVoice;
      // Re-sync server in case the initial set_voice (during channel
      // open) used the default. Idempotent on the server side.
      try { ch.send({ type: 'set_voice', voice: currentVoice }); } catch (_) {}
    }
  } catch (_) { /* fresh card or non-JSON content; stick with default */ }
}
function persistVoiceState() {
  // Fire-and-forget — errors here are non-fatal (worst case, the
  // selection won't survive a reload).
  mica.files.write(mica.filename, JSON.stringify({ voice: currentVoice })).catch(() => {});
}
if (voiceSelectEl) {
  voiceSelectEl.value = currentVoice;
  voiceSelectEl.addEventListener('change', function() {
    const next = (voiceSelectEl.value || '').trim();
    if (!next || next === currentVoice) return;
    currentVoice = next;
    persistVoiceState();
    try { ch.send({ type: 'set_voice', voice: currentVoice }); } catch (_) {}
    console.log('[voice] voice changed to ' + currentVoice);
  });
}
loadVoiceState();

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
      setReplyRaw(lastAssistant.content);
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
      appendActivity('stt', data.text);
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
    // Build a short args summary from common shapes (query / url / file /
    // tz / id / message). Falls back to a truncated raw-args slice for
    // anything else so the log still shows something useful.
    let argsSummary = '';
    if (typeof data.args === 'string' && data.args) {
      const q = (data.args.match(/<query>([\s\S]*?)<\/query>/) || [])[1];
      const u = (data.args.match(/<url>([\s\S]*?)<\/url>/) || [])[1];
      const f = (data.args.match(/<file>([\s\S]*?)<\/file>/) || [])[1];
      const tz = (data.args.match(/<tz>([\s\S]*?)<\/tz>/) || [])[1];
      const m = (data.args.match(/<message>([\s\S]*?)<\/message>/) || [])[1];
      const parts = [];
      if (f) parts.push(f);
      if (q) parts.push('"' + q + '"');
      if (u) parts.push(u);
      if (tz) parts.push(tz);
      if (m) parts.push('"' + m.slice(0, 60) + (m.length > 60 ? '…' : '') + '"');
      argsSummary = parts.length ? parts.join(' · ') : String(data.args).slice(0, 80);
    }
    appendActivity('tool→', (data.name || '?') + (argsSummary ? ' ' + argsSummary : ''));
    return;
  }

  if (t === 'tool_result') {
    const kind = data.ok ? 'tool✓' : 'tool✗';
    let detail = data.name || '?';
    if (data.file) detail += ' ' + data.file;
    if (data.query) detail += ' "' + String(data.query).slice(0, 60) + '"';
    if (data.url) detail += ' ' + data.url;
    if (data.message) detail += (data.ok ? ' — ' : ': ') + String(data.message).slice(0, 120);
    appendActivity(kind, detail);
    return;
  }

  if (t === 'ambient_announcement_start') {
    // A chat card on the canvas finished a turn — voice is about to
    // speak a 1-2 sentence summary. Reset the reply panel + label it
    // so the user doesn't think this came from their last utterance.
    setReplyRaw('');
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
    const text = data.text || '';
    appendReplyRaw(text);
    if (text.trim()) appendActivity('say', text.trim());
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
    if (data.content && !replyRaw) {
      setReplyRaw(data.content);
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
    appendActivity('error', String(data.error || 'unknown error'));
    return;
  }

  if (t === 'abort') {
    appendActivity('abort', 'server-side abort — TTS canceled, delegation interrupted');
    // Server fired the abort tool (Mica recognized "stop" intent and
    // emitted <tool name="abort"/>). Stop local audio playback and
    // clear the visible reply panel — Mica's <say> confirmation
    // ("OK, stopping.") will play right after via the normal TTS path.
    stopVoicePlayback();
    resetReplyDisplay();
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
