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
// Settings-panel elements. The old in-header voice selector was removed
// in favor of a gear-icon overlay panel mirroring the qwen/opencode/claude
// card pattern. voiceSelectEl now points at the dropdown inside the panel.
const settingsBtn = container.querySelector('#vc-settings-btn');
const settingsPanel = container.querySelector('#vc-settings-panel');
const settingsCloseEl = container.querySelector('#vc-settings-close');
const settingsCancelBtn = container.querySelector('#vc-settings-cancel');
const settingsSaveBtn = container.querySelector('#vc-settings-save');
const voiceSelectEl = container.querySelector('#vc-settings-voice');
const settingsAutoReadEl = container.querySelector('#vc-settings-autoread');
const settingsDefaultTargetEl = container.querySelector('#vc-settings-default-target');

// Currently-selected Kokoro voice. Default `af_sky` (calmer, lower-pitched
// reading voice) — matches the sidecar env `VOICE_TTS_VOICE=af_sky` so
// fresh instances and the ambient TTS path agree on first run. Loaded
// from this card's instance file (a JSON blob {voice: "..."}) on init;
// written back on every change. Sent to the server two ways: as a
// per-message `voice:` field on every audioB64 payload, AND as a
// session-level `set_voice` control message that updates voicePref
// so ambient announcements pick up the change too.
const DEFAULT_VOICE = 'af_sky';
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
let micSource = null; // MediaStreamAudioSourceNode — MUST be held in a long-lived ref; MDN: "It is important to keep a hard reference to the MediaStreamAudioSourceNode object so it isn't garbage-collected." Without this, the node gets GC'd under memory pressure (e.g., when the user creates/edits another card) and the analyser silently stops receiving samples — UI keeps showing "Listening" while VAD never trips.
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

// VAD presets — bundled (SPEECH_RMS, SILENCE_MS, BARGE_IN_DURATION_MS)
// values keyed by environment. The user picks the preset via the gear-
// icon settings panel; the active values become mutable references read
// at runtime by detectSpeech / detectBargeIn / endUtterance. Defaults
// (the "normal" row) match the historical hardcoded values exactly so
// the change is backward-compatible.
//
// RMS is in [0..1]; with echoCancellation + noiseSuppression on,
// quiet rooms idle around 0.001-0.005. Speaking voice typically registers
// 0.05-0.30. SILENCE_MS controls how long a pause must be before we
// treat it as end-of-utterance. BARGE_IN_DURATION_MS is the minimum
// sustained-speech duration that interrupts Mica's TTS playback.
const VAD_PRESETS = {
  quiet:  { speechRms: 0.015, silenceMs: 1200, bargeInMs: 120 },
  normal: { speechRms: 0.02,  silenceMs: 1500, bargeInMs: 150 },
  noisy:  { speechRms: 0.035, silenceMs: 1800, bargeInMs: 250 },
};
let SPEECH_RMS = VAD_PRESETS.normal.speechRms;
let SILENCE_MS = VAD_PRESETS.normal.silenceMs;
let BARGE_IN_DURATION_MS = VAD_PRESETS.normal.bargeInMs;
let BARGE_IN_RMS = SPEECH_RMS;
function applyVadPreset(name) {
  const p = VAD_PRESETS[name] || VAD_PRESETS.normal;
  SPEECH_RMS = p.speechRms;
  SILENCE_MS = p.silenceMs;
  BARGE_IN_DURATION_MS = p.bargeInMs;
  BARGE_IN_RMS = p.speechRms;
}
// Sentence pause — silent gap (ms) inserted between TTS sentence buffers
// in playNextWav. Default 200ms gives multi-item lists a natural beat.
let SENTENCE_PAUSE_MS = 150;
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
  // If another tab is currently holding the mic claim, the new context
  // must start suspended so the next enqueue/play call doesn't
  // immediately produce sound through the listener tab's mic.
  if (muted) {
    try { playbackCtx.suspend(); } catch (_) {}
  }
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
  // Skip resume while another tab holds the mic claim — the ctx is
  // intentionally suspended to prevent acoustic loopback. The buffer
  // still decodes + queues fine; playback resumes on mute clearance.
  if (ctx.state === 'suspended' && !muted) {
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

async function playNextWav() {
  const buffer = wavQueue.shift();
  if (!buffer) {
    isPlayingQueue = false;
    currentSource = null;
    updateStopSpeakingButton();
    updateMediaSession(false);
    if (statusEl.dataset.state === 'speaking') {
      setStatus(micOn ? 'Listening' : 'Ready', micOn ? 'recording' : 'ready');
    }
    return;
  }
  // Visibility gate removed — background tabs hear audio by design.
  // The browser's native tab speaker icon shows which tab is talking;
  // tab-mute (Chrome) / per-tab silence (Safari) is the kill switch
  // alongside our in-card "stop speaking" button.
  const ctx = ensurePlaybackCtx();
  if (!ctx) {
    isPlayingQueue = false;
    updateMediaSession(false);
    return;
  }
  // Defensive resume: AudioContext can re-suspend between enqueue and
  // play in Safari (tab briefly backgrounds, OS audio session changes,
  // headphones plugged in mid-turn). Without this, src.start() silently
  // succeeds but the destination produces nothing — no error, no audio.
  // After tab-close → reopen → mic-on, the context's user-gesture
  // grant can also become stale by the time the first response frame
  // arrives; resume() here under any active gesture window saves it.
  // Skip resume + suppress the not-running warning while another tab
  // holds the mic claim; the source still schedules and will play once
  // the mute clears (AudioContext clock pauses, source position is held).
  if (ctx.state === 'suspended' && !muted) {
    try { await ctx.resume(); }
    catch (e) { console.warn('[voice] playNextWav: ctx.resume() failed: ' + (e && e.message ? e.message : e)); }
  }
  if (ctx.state !== 'running' && !muted) {
    console.warn('[voice] playback ctx not running (state=' + ctx.state + ') — output likely silent. Click mic OFF/ON to re-grant gesture.');
  }
  isPlayingQueue = true;
  updateMediaSession(true);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.onended = function() {
    if (currentSource === src) currentSource = null;
    // Inter-sentence pause — silent gap before kicking the next buffer.
    // Skipped entirely (next tick) when SENTENCE_PAUSE_MS is 0 or the
    // queue is already empty (so the "playback finished, status →
    // Ready" path isn't delayed). Configurable via the gear panel.
    const gap = wavQueue.length > 0 ? (SENTENCE_PAUSE_MS || 0) : 0;
    if (gap > 0) setTimeout(playNextWav, gap);
    else playNextWav();
  };
  currentSource = src;
  updateStopSpeakingButton();
  try {
    src.start(0);
    console.log('[voice] started AudioBufferSource (' + buffer.duration.toFixed(2) + 's, ctxState=' + ctx.state + ')');
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
  updateMediaSession(false);
}

// ── Cross-tab TTS muting ───────────────────────────────────────────
//
// Prevents acoustic loopback across voice tabs: when tab A's mic is
// hot and tab B is doing TTS, tab B's speakers feed tab A's mic, and
// Parakeet faithfully transcribes Mica's own voice as if it were the
// user — producing spurious dispatches in tab A's project. The bug
// is acoustic, not architectural; browser AEC isn't enough across
// independent tab audio sessions.
//
// Coordination is over a same-origin BroadcastChannel — no server
// round-trip needed. Each card holds a unique TAB_ID and:
//   - broadcasts {type:'mic-claim', tabId, project, ts} while its
//     mic is hot, heartbeating every MIC_HEARTBEAT_MS so listeners
//     can detect a crashed/closed claimer via TTL expiry;
//   - broadcasts {type:'mic-release', tabId} on mic-off;
//   - on receipt of a non-self claim, suspends its playback
//     AudioContext (freezes the in-flight source mid-buffer, leaves
//     pending buffers queued) and flips the host page favicon to a
//     speaker-with-slash so the user knows that tab is muted.
//
// Edge cases:
//   - Both tabs engage mic simultaneously: neither tab is a passive
//     noise source, so we honor that and don't mute either.
//   - Claimer tab crashes / closes without release: stale claims age
//     out after CLAIM_TTL_MS via the reaper, returning audio.
//   - Card mounted mid-claim: new card broadcasts 'mic-query' so any
//     hot peers re-announce their claim.

const MIC_CHANNEL_NAME = 'mica-voice-mic';
const MIC_HEARTBEAT_MS = 2000;
const CLAIM_TTL_MS = 5000;
const TAB_ID = (typeof crypto !== 'undefined' && crypto.randomUUID)
  ? crypto.randomUUID()
  : 'tab-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
let micChannel = null;
const otherClaims = new Map();  // tabId -> { ts, project }
let micHeartbeatHandle = null;
let claimReaperHandle = null;
let muted = false;  // true while ANY non-self tab has mic hot

function broadcastMicMessage(msg) {
  if (!micChannel) return;
  try { micChannel.postMessage(msg); } catch (_) { /* channel may be closed */ }
}

function broadcastMicClaim() {
  broadcastMicMessage({
    type: 'mic-claim',
    tabId: TAB_ID,
    project: (typeof mica !== 'undefined' && mica.project) || '',
    ts: Date.now(),
  });
}

function broadcastMicRelease() {
  broadcastMicMessage({ type: 'mic-release', tabId: TAB_ID });
}

function reapStaleClaims() {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  let changed = false;
  for (const [tabId, claim] of otherClaims.entries()) {
    if (claim.ts < cutoff) {
      otherClaims.delete(tabId);
      changed = true;
    }
  }
  if (changed) refreshMuteState();
}

function refreshMuteState() {
  const nowMuted = otherClaims.size > 0;
  if (nowMuted === muted) return;
  muted = nowMuted;
  if (muted) {
    // Pick a representative project for the activity log so the user
    // knows which tab took the mic.
    let claimant = '';
    for (const claim of otherClaims.values()) {
      claimant = claim.project || '';
      break;
    }
    appendActivity('mute', 'Paused — ' + (claimant || 'another tab') + ' is listening');
    if (playbackCtx) {
      try { playbackCtx.suspend(); } catch (_) {}
    }
    setMutedFavicon(true);
  } else {
    appendActivity('mute', 'Resumed — other tab released mic');
    if (playbackCtx && playbackCtx.state === 'suspended') {
      try { playbackCtx.resume(); } catch (_) {}
    }
    setMutedFavicon(false);
  }
}

// Speaker-with-slash favicon, embedded as inline SVG so there's no
// asset to ship. encodeURIComponent escapes `#` to `%23` for the
// SVG color attribute.
const MUTED_FAVICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#d33" stroke="#d33" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M11 5L6 9H2v6h4l5 4V5z"/>' +
    '<line x1="23" y1="9" x2="17" y2="15"/>' +
    '<line x1="17" y1="9" x2="23" y2="15"/>' +
  '</svg>'
);
let originalFaviconHref = null;

function setMutedFavicon(on) {
  try {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (on) {
      if (originalFaviconHref === null) originalFaviconHref = link.href || '';
      link.href = MUTED_FAVICON;
    } else if (originalFaviconHref !== null) {
      link.href = originalFaviconHref;
    }
  } catch (_) { /* DOM access may be unavailable in some shim contexts */ }
}

function initMicCoordChannel() {
  if (typeof window.BroadcastChannel === 'undefined') return;
  try { micChannel = new window.BroadcastChannel(MIC_CHANNEL_NAME); }
  catch (_) { micChannel = null; return; }
  micChannel.onmessage = function(ev) {
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.tabId === TAB_ID) return;  // ignore self
    if (m.type === 'mic-claim') {
      otherClaims.set(m.tabId, { ts: Date.now(), project: m.project || '' });
      refreshMuteState();
    } else if (m.type === 'mic-release') {
      otherClaims.delete(m.tabId);
      refreshMuteState();
    } else if (m.type === 'mic-query') {
      // A fresh card is asking who's hot; re-announce if we are.
      if (micOn) broadcastMicClaim();
    }
  };
  // Ask peers to re-announce — covers the case where this card mounts
  // while another tab already has the mic hot.
  broadcastMicMessage({ type: 'mic-query', tabId: TAB_ID });
  claimReaperHandle = window.setInterval(reapStaleClaims, 1000);
}

function startMicClaimHeartbeat() {
  if (micHeartbeatHandle) return;
  broadcastMicClaim();
  micHeartbeatHandle = window.setInterval(broadcastMicClaim, MIC_HEARTBEAT_MS);
}

function stopMicClaimHeartbeat() {
  if (micHeartbeatHandle) {
    window.clearInterval(micHeartbeatHandle);
    micHeartbeatHandle = null;
  }
  broadcastMicRelease();
}

initMicCoordChannel();

// Media Session API integration. When playing, the OS-level media
// controls (lock screen on mobile, macOS Now Playing widget, hardware
// media keys, browser tab audio indicator menus) show "Mica voice — <project>"
// and route their pause/stop button to stopVoicePlayback. Mica voice
// is ephemeral (no resume — the queue is the only state), so we only
// register pause + stop; no play/resume handlers. The browser shows
// the controls automatically when it detects audio output; this adds
// metadata + the kill switch.
function _initMediaSession() {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  const ms = navigator.mediaSession;
  try { ms.setActionHandler('pause', function() { stopVoicePlayback(); }); } catch (_) {}
  try { ms.setActionHandler('stop', function() { stopVoicePlayback(); }); } catch (_) {}
  // No 'play'/'seekto'/'previoustrack'/'nexttrack' — these don't map
  // to anything sensible for ephemeral TTS. Browsers gray those buttons
  // out when no handler is registered, which is the right affordance.
}
_initMediaSession();

function updateMediaSession(speaking) {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return;
  try {
    if (speaking) {
      if (typeof window.MediaMetadata !== 'undefined') {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: 'Mica voice',
          artist: (typeof mica !== 'undefined' && mica.project) || 'Mica',
          album: 'Voice card',
        });
      }
      navigator.mediaSession.playbackState = 'playing';
    } else {
      navigator.mediaSession.playbackState = 'none';
      // Leave metadata in place briefly — the OS widget gracefully fades
      // when playbackState goes to 'none'; clearing metadata would yank
      // the title mid-fade and look glitchy.
    }
  } catch (_) { /* mediaSession is best-effort across browsers */ }
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

// Visibility handling: when the tab hides, turn the mic off (privacy +
// avoids continuous STT/LLM work on an unattended tab — user re-clicks
// mic on return). Audio OUTPUT continues regardless of visibility — a
// background tab keeps speaking so the user can listen while working
// elsewhere. They can hit the "stop speaking" button (or unmount the
// card) to silence it. `presence` is still broadcast to the server in
// case future per-tab routing wants the info, but it no longer gates TTS.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', function() {
    const visible = document.visibilityState === 'visible';
    if (!visible && micOn) {
      console.log('[voice] tab hidden — turning mic off');
      turnMicOff();
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
  // announcement ("🔔 Qwen (canvas/qwen.qwen)").
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
    // a buffer synchronously inside this user gesture physically wires
    // the graph to the output device.
    //
    // Was a 1-frame silent buffer; upgraded to a 100ms buffer at very
    // low non-zero amplitude (-60dB, well below audibility). The
    // longer + non-zero signal forces macOS Safari to fully claim the
    // output device rather than treat the prime as a no-op the audio
    // session can ignore. The level is low enough not to be heard;
    // the duration is long enough for the OS audio session to commit.
    //
    // Caveat: when Safari's audio session is wedged at the *process*
    // level (e.g. after closing the last voice tab and reopening), no
    // in-page prime can recover — only Cmd+Q + relaunch. This is a
    // known Safari/WebKit limitation, not something this code can fix.
    try {
      const primeSec = 0.1;                  // 100 ms
      const primeFrames = Math.max(1, Math.floor(playCtx.sampleRate * primeSec));
      const primeBuf = playCtx.createBuffer(1, primeFrames, playCtx.sampleRate);
      const data = primeBuf.getChannelData(0);
      // -60 dB ≈ 0.001 linear amplitude. Sub-perceptual on speakers,
      // sub-perceptual on headphones at normal listening volume, but
      // a real signal the audio session can lock onto.
      const amp = 0.001;
      for (let i = 0; i < primeFrames; i++) {
        // Tiny triangle wave at sub-audible frequency. Anything non-DC
        // works; this just keeps the signal moving rather than letting
        // any optimizer treat it as silence.
        data[i] = amp * (((i * 4 / primeFrames) % 2) - 1);
      }
      const primeSrc = playCtx.createBufferSource();
      primeSrc.buffer = primeBuf;
      primeSrc.connect(playCtx.destination);
      primeSrc.start(0);
      console.log('[voice] playback AudioContext (re)created, resumed, primed (' + (primeSec * 1000) + 'ms @ -60dB); state=' + playCtx.state + ' sampleRate=' + playCtx.sampleRate);
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
  micSource = audioCtx.createMediaStreamSource(stream);
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 1024;
  analyserNode.smoothingTimeConstant = 0.4;
  micSource.connect(analyserNode);
  vadSampleBuf = new Uint8Array(analyserNode.frequencyBinCount);

  micOn = true;
  speechActive = false;
  silenceStartedAt = 0;
  speechStartedAt = 0;
  lastSpeechMs = 0;
  suppressNextUtterance = false;
  // Announce mic-hot to peer tabs so they pause TTS — prevents their
  // speakers from bleeding into this mic and producing spurious
  // dispatches in their projects. Heartbeats every MIC_HEARTBEAT_MS
  // so peers can detect a crash via TTL.
  startMicClaimHeartbeat();
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
  // Release the cross-tab mic claim so peer tabs resume TTS playback.
  // Broadcast first (cheap) before tearing down the recorder/stream.
  stopMicClaimHeartbeat();
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
  if (micSource) {
    try { micSource.disconnect(); } catch (_) {}
    micSource = null;
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
  // Sync per-card settings to the server on (re)connect:
  //   - voice → ambient TTS pref
  //   - autoReadAmbient → ambient-announcement TTS gate
  //   - defaultDispatchTarget → voice system-prompt hint for send_to_card
  // VAD preset and sentence pause are client-only (no server signal).
  try {
    if (currentVoice) _ch.send({ type: 'set_voice', voice: currentVoice });
    _ch.send({
      type: 'set_settings',
      autoReadAmbient: currentSettings.autoReadAmbient !== false,
      defaultDispatchTarget: currentSettings.defaultDispatchTarget || '',
    });
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

// ── Settings panel (gear icon → overlay) ─────────────────────────
//
// All persisted per-card settings live in the instance file as a JSON
// blob. Shape (back-compat: older files with just `{voice}` keep working):
//   {
//     voice: "af_sky",
//     autoReadAmbient: true,
//     defaultDispatchTarget: "",
//     vadPreset: "normal",          // "quiet" | "normal" | "noisy"
//     sentencePauseMs: 150,         // one of the radio-button values
//                                   // (0/150/250/400) so the panel always
//                                   // has a selected option on open
//   }
//
// On mount: load → apply VAD preset + sentence pause locally, notify
// server of voice + autoRead + defaultTarget via control messages.
// On save: write the blob back, re-apply locally, re-notify server.
// Default pronunciation table — seeded into the persisted settings the
// first time a voice card is loaded without a `pronunciations` field at
// all. Kokoro otherwise reads "Qwen" with the English Q-convention
// (queue-wen); the intended pronunciation is "kwen". Users can edit or
// clear via the gear panel; an empty array is preserved (the seed only
// applies when the field is missing entirely).
const DEFAULT_PRONUNCIATIONS = [{ from: 'Qwen', to: 'Kwen' }];

const currentSettings = {
  voice: DEFAULT_VOICE,
  autoReadAmbient: true,
  defaultDispatchTarget: '',
  vadPreset: 'normal',
  sentencePauseMs: 150,
  // Array of { from, to }. Whole-word, case-insensitive TTS-only
  // substitutions. Display text is unaffected.
  pronunciations: DEFAULT_PRONUNCIATIONS.slice(),
};

async function loadSettings() {
  try {
    const raw = await mica.getContent();
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.voice === 'string' && parsed.voice.trim()) currentSettings.voice = parsed.voice.trim();
    if (typeof parsed.autoReadAmbient === 'boolean') currentSettings.autoReadAmbient = parsed.autoReadAmbient;
    if (typeof parsed.defaultDispatchTarget === 'string') currentSettings.defaultDispatchTarget = parsed.defaultDispatchTarget.trim();
    if (typeof parsed.vadPreset === 'string' && VAD_PRESETS[parsed.vadPreset]) currentSettings.vadPreset = parsed.vadPreset;
    if (typeof parsed.sentencePauseMs === 'number' && parsed.sentencePauseMs >= 0) currentSettings.sentencePauseMs = parsed.sentencePauseMs;
    // pronunciations: present-but-empty array is RESPECTED (user explicitly
    // cleared the table). Only the absent-field case falls back to defaults.
    if (Array.isArray(parsed.pronunciations)) {
      currentSettings.pronunciations = parsed.pronunciations
        .filter(function(r) { return r && typeof r.from === 'string' && typeof r.to === 'string'; })
        .map(function(r) { return { from: r.from, to: r.to }; });
    }
  } catch (_) { /* fresh card or non-JSON; stick with defaults */ }
  // Apply local-only settings immediately.
  currentVoice = currentSettings.voice;
  applyVadPreset(currentSettings.vadPreset);
  SENTENCE_PAUSE_MS = currentSettings.sentencePauseMs;
  // Re-sync server so the session's voicePref + autoRead + defaultTarget
  // + pronunciations match the persisted values. Idempotent on the
  // server side; sent on every load (including reconnects) so newly
  // spawned sessions inherit the user's table.
  try {
    ch.send({ type: 'set_voice', voice: currentVoice });
    ch.send({
      type: 'set_settings',
      autoReadAmbient: currentSettings.autoReadAmbient,
      defaultDispatchTarget: currentSettings.defaultDispatchTarget,
      pronunciations: currentSettings.pronunciations,
    });
  } catch (_) {}
}

// Render the pronunciation rows into the gear-panel container based on
// `currentSettings.pronunciations`. Called each time the panel opens so
// the form always reflects state, never stale DOM from a prior open.
const pronunciationsContainer = container.querySelector('#vc-settings-pronunciations');
const pronunciationAddBtn = container.querySelector('#vc-settings-pronunciation-add');
function renderPronunciationRows(rows) {
  if (!pronunciationsContainer) return;
  pronunciationsContainer.innerHTML = '';
  rows.forEach(function(r) { appendPronunciationRow(r.from || '', r.to || ''); });
}
function appendPronunciationRow(fromVal, toVal) {
  if (!pronunciationsContainer) return;
  const row = window.document.createElement('div');
  row.className = 'vc-pron-row';
  row.style.cssText = 'display:flex;gap:4px;align-items:center;';
  const fromEl = window.document.createElement('input');
  fromEl.type = 'text';
  fromEl.className = 'vc-pron-from';
  fromEl.placeholder = 'Word';
  fromEl.value = fromVal || '';
  fromEl.autocomplete = 'off';
  fromEl.spellcheck = false;
  fromEl.style.cssText = 'flex:1;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:4px 6px;color:#e6edf3;font-size:11px;font-family:inherit;outline:none;box-sizing:border-box;min-width:0;';
  const arrow = window.document.createElement('span');
  arrow.style.cssText = 'color:#6e7681;font-size:11px;flex-shrink:0;';
  arrow.textContent = '→';
  const toEl = window.document.createElement('input');
  toEl.type = 'text';
  toEl.className = 'vc-pron-to';
  toEl.placeholder = 'Say as';
  toEl.value = toVal || '';
  toEl.autocomplete = 'off';
  toEl.spellcheck = false;
  toEl.style.cssText = 'flex:1;background:#161b22;border:1px solid #30363d;border-radius:4px;padding:4px 6px;color:#e6edf3;font-size:11px;font-family:inherit;outline:none;box-sizing:border-box;min-width:0;';
  const removeBtn = window.document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.title = 'Remove row';
  removeBtn.textContent = '×';
  removeBtn.style.cssText = 'background:transparent;color:#8b949e;border:none;cursor:pointer;font-size:14px;padding:0 4px;line-height:1;flex-shrink:0;';
  removeBtn.addEventListener('click', function() { row.remove(); });
  row.appendChild(fromEl);
  row.appendChild(arrow);
  row.appendChild(toEl);
  row.appendChild(removeBtn);
  pronunciationsContainer.appendChild(row);
}
function collectPronunciationRows() {
  if (!pronunciationsContainer) return [];
  const rows = pronunciationsContainer.querySelectorAll('.vc-pron-row');
  const out = [];
  rows.forEach(function(row) {
    const from = (row.querySelector('.vc-pron-from')?.value || '').trim();
    const to = (row.querySelector('.vc-pron-to')?.value || '').trim();
    if (from) out.push({ from: from, to: to });   // drop empty-from rows; empty-to is a valid "say nothing" override
  });
  return out;
}
if (pronunciationAddBtn) {
  pronunciationAddBtn.addEventListener('click', function() { appendPronunciationRow('', ''); });
}

function persistSettings() {
  // Fire-and-forget — errors here are non-fatal (worst case, the change
  // won't survive a reload). Written as pretty-JSON for human edits.
  mica.files.write(mica.filename, JSON.stringify(currentSettings, null, 2)).catch(() => {});
}

function openSettingsPanel() {
  // Populate fields from currentSettings every time the panel opens so
  // the form reflects state, not stale dropdown values.
  if (voiceSelectEl) voiceSelectEl.value = currentSettings.voice;
  if (settingsAutoReadEl) settingsAutoReadEl.checked = currentSettings.autoReadAmbient !== false;
  if (settingsDefaultTargetEl) settingsDefaultTargetEl.value = currentSettings.defaultDispatchTarget || '';
  const vadRadios = container.querySelectorAll('input[name="vc-vad-preset"]');
  vadRadios.forEach(function(r) { r.checked = (r.value === currentSettings.vadPreset); });
  // Snap an out-of-range sentencePauseMs (e.g. legacy 200 from earlier
  // builds, or an arbitrary value the user wrote into the JSON file)
  // to the nearest radio option so the panel always shows a selection.
  // Without this, an unmatched value leaves all radios unchecked and the
  // user can't tell which option is in effect.
  const pauseRadios = container.querySelectorAll('input[name="vc-sentence-pause"]');
  const pauseValues = Array.from(pauseRadios).map(function(r) { return parseInt(r.value, 10); });
  let nearest = pauseValues[0];
  for (let i = 1; i < pauseValues.length; i++) {
    if (Math.abs(pauseValues[i] - currentSettings.sentencePauseMs) < Math.abs(nearest - currentSettings.sentencePauseMs)) {
      nearest = pauseValues[i];
    }
  }
  pauseRadios.forEach(function(r) { r.checked = (parseInt(r.value, 10) === nearest); });
  renderPronunciationRows(currentSettings.pronunciations || []);
  settingsPanel.style.display = 'block';
}

function closeSettingsPanel() { settingsPanel.style.display = 'none'; }

if (settingsBtn) settingsBtn.addEventListener('click', openSettingsPanel);
if (settingsCloseEl) settingsCloseEl.addEventListener('click', closeSettingsPanel);
if (settingsCancelBtn) settingsCancelBtn.addEventListener('click', closeSettingsPanel);

if (settingsSaveBtn) {
  settingsSaveBtn.addEventListener('click', function() {
    // Collect form state.
    const nextVoice = (voiceSelectEl && voiceSelectEl.value || '').trim() || currentSettings.voice;
    const nextAutoRead = settingsAutoReadEl ? !!settingsAutoReadEl.checked : true;
    const nextTarget = (settingsDefaultTargetEl && settingsDefaultTargetEl.value || '').trim();
    let nextVadPreset = 'normal';
    container.querySelectorAll('input[name="vc-vad-preset"]').forEach(function(r) {
      if (r.checked) nextVadPreset = r.value;
    });
    let nextPause = 200;
    container.querySelectorAll('input[name="vc-sentence-pause"]').forEach(function(r) {
      if (r.checked) nextPause = parseInt(r.value, 10) || 0;
    });

    const nextPronunciations = collectPronunciationRows();

    // Track what changed for the server-notify decision.
    const voiceChanged = nextVoice !== currentSettings.voice;
    const autoReadChanged = nextAutoRead !== currentSettings.autoReadAmbient;
    const targetChanged = nextTarget !== (currentSettings.defaultDispatchTarget || '');
    const prevPron = currentSettings.pronunciations || [];
    const pronChanged = nextPronunciations.length !== prevPron.length
      || nextPronunciations.some(function(r, i) { return r.from !== prevPron[i]?.from || r.to !== prevPron[i]?.to; });

    currentSettings.voice = nextVoice;
    currentSettings.autoReadAmbient = nextAutoRead;
    currentSettings.defaultDispatchTarget = nextTarget;
    currentSettings.vadPreset = nextVadPreset;
    currentSettings.sentencePauseMs = nextPause;
    currentSettings.pronunciations = nextPronunciations;

    // Apply client-side immediately.
    currentVoice = nextVoice;
    applyVadPreset(nextVadPreset);
    SENTENCE_PAUSE_MS = nextPause;

    // Persist + notify server. Only send messages for the slices the
    // server cares about and that actually changed.
    persistSettings();
    if (voiceChanged) {
      try { ch.send({ type: 'set_voice', voice: currentVoice }); } catch (_) {}
    }
    if (autoReadChanged || targetChanged || pronChanged) {
      try {
        ch.send({
          type: 'set_settings',
          autoReadAmbient: currentSettings.autoReadAmbient,
          defaultDispatchTarget: currentSettings.defaultDispatchTarget,
          pronunciations: currentSettings.pronunciations,
        });
      } catch (_) {}
    }

    console.log('[voice] settings saved: ' + JSON.stringify(currentSettings));
    closeSettingsPanel();
  });
}

loadSettings();

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
  updateMediaSession(false);
  if (playbackCtx) {
    try { playbackCtx.close(); } catch (_) {}
    playbackCtx = null;
  }
  // Restore the favicon if we left it on speaker-with-slash, so an
  // unmount during muted state doesn't leave the host page stuck on
  // the muted icon.
  if (muted) setMutedFavicon(false);
  // Tear down the cross-tab coordination channel.
  if (claimReaperHandle) {
    window.clearInterval(claimReaperHandle);
    claimReaperHandle = null;
  }
  if (micChannel) {
    try { micChannel.close(); } catch (_) {}
    micChannel = null;
  }
  // Explicitly close the channel so the server detaches this client from
  // the voice session. Without this, the React unmount cleans local
  // state but the server's session keeps clientCount > 0, hasSubscriber()
  // stays true, and the voice agent keeps emitting TTS for a card no
  // one is looking at — leaking audio across projects when the user
  // navigates from project A to project B.
  try { if (typeof ch !== 'undefined' && ch) ch.close(); } catch (_) {}
});
