// voice-hello — press-and-hold voice round-trip card.
//
// 1. Query into container (CARD_SHIM injects it).
const talkBtn = container.querySelector('#vh-talk');
const statusEl = container.querySelector('#vh-status');
const transcriptWrap = container.querySelector('#vh-transcript-wrap');
const transcriptEl = container.querySelector('#vh-transcript');
const audioEl = container.querySelector('#vh-audio');
const metaEl = container.querySelector('#vh-meta');

// 2. Script-scoped state.
let mediaRecorder = null;
let recordedChunks = [];
let recordedMime = '';
let recordStartedAt = 0;
let stream = null;

// 3. Functions at script scope.
function setStatus(label, state) {
  statusEl.textContent = label;
  statusEl.dataset.state = state || 'idle';
}

function setMeta(text) {
  metaEl.textContent = text || '—';
}

async function ensureMicAccess() {
  if (stream) return stream;
  try {
    // Browser handles the permission prompt. echoCancellation + noiseSuppression
    // help mask Mica's own TTS output if the user later plays it through speakers.
    stream = await window.navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    return stream;
  } catch (err) {
    setStatus('Mic blocked', 'error');
    setMeta('Grant microphone permission and reload the card.');
    throw err;
  }
}

async function startRecording() {
  await ensureMicAccess();
  // Pick a MIME the browser supports. webm/opus is the broadest. Parakeet's
  // server side decodes via librosa which handles webm/ogg/wav/m4a.
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/wav',
  ];
  recordedMime = candidates.find(function(m) {
    return window.MediaRecorder && window.MediaRecorder.isTypeSupported(m);
  }) || '';
  if (!recordedMime) {
    setStatus('No supported audio format', 'error');
    return;
  }
  mediaRecorder = new window.MediaRecorder(stream, { mimeType: recordedMime });
  recordedChunks = [];
  mediaRecorder.ondataavailable = function(e) {
    if (e.data && e.data.size > 0) recordedChunks.push(e.data);
  };
  mediaRecorder.onstop = handleStop;
  mediaRecorder.start();
  recordStartedAt = Date.now();
  setStatus('Listening', 'recording');
  talkBtn.dataset.recording = 'true';
}

function stopRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === 'recording') mediaRecorder.stop();
  talkBtn.dataset.recording = 'false';
  setStatus('Processing', 'processing');
}

async function handleStop() {
  const recordMs = Date.now() - recordStartedAt;
  const blob = new window.Blob(recordedChunks, { type: recordedMime });
  if (blob.size < 200) {
    // Probably a tap — too short to transcribe.
    setStatus('Hold longer', 'idle');
    setMeta('Recording was ~' + recordMs + 'ms; try holding the button while speaking.');
    return;
  }
  const t0 = Date.now();
  let resp;
  try {
    resp = await window.fetch('/api/voice/echo', {
      method: 'POST',
      headers: { 'Content-Type': recordedMime },
      body: blob,
    });
  } catch (err) {
    setStatus('Network error', 'error');
    setMeta(String(err && err.message ? err.message : err));
    return;
  }
  if (!resp.ok) {
    setStatus('Server error', 'error');
    let msg = resp.status + ' ' + resp.statusText;
    try {
      const j = await resp.json();
      if (j && j.error) msg = j.error;
    } catch (_) { /* not json */ }
    setMeta(msg);
    return;
  }
  const transcriptHeader = resp.headers.get('x-transcript');
  const transcript = transcriptHeader ? decodeURIComponent(transcriptHeader) : '(no transcript)';
  const wavBuf = await resp.arrayBuffer();
  const wavBlob = new window.Blob([wavBuf], { type: 'audio/wav' });
  const wavUrl = window.URL.createObjectURL(wavBlob);

  transcriptEl.textContent = transcript;
  transcriptWrap.style.display = '';
  audioEl.src = wavUrl;
  audioEl.style.display = '';
  // Auto-play the response. Browsers allow this when the user just
  // interacted with the page (button release), so it should work.
  audioEl.play().catch(function() { /* user can press play manually */ });

  const elapsed = Date.now() - t0;
  setStatus('Ready', 'ready');
  setMeta(
    'Recorded ' + recordMs + 'ms · round-trip ' + elapsed + 'ms · ' +
    (blob.size / 1024).toFixed(1) + ' KB ↑'
  );
}

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
      // Re-poll until ready.
      window.setTimeout(checkServerReady, 2000);
      return;
    }
    setStatus('Ready', 'ready');
    setMeta('STT: Parakeet · TTS: Kokoro · all local.');
  } catch (err) {
    setStatus('Backend offline', 'error');
    setMeta('Could not reach /api/voice/status.');
  }
}

// 4. DOM events on container's buttons. Press-and-hold semantics for both
//    mouse and touch. Click is also supported (toggle start/stop) for users
//    on devices where pointerdown/up don't pair cleanly.
function bindPressHold() {
  let pointerActive = false;
  function onDown(e) {
    if (talkBtn.disabled) return;
    e.preventDefault();
    pointerActive = true;
    startRecording().catch(function(err) { console.error('[voice-hello] start failed', err); });
  }
  function onUp() {
    if (!pointerActive) return;
    pointerActive = false;
    stopRecording();
  }
  talkBtn.addEventListener('pointerdown', onDown);
  talkBtn.addEventListener('pointerup', onUp);
  talkBtn.addEventListener('pointercancel', onUp);
  talkBtn.addEventListener('pointerleave', function() {
    if (pointerActive) onUp();
  });
  // Spacebar shortcut while card is focused — accessibility nicety.
  container.addEventListener('keydown', function(e) {
    if (e.key === ' ' && !pointerActive && !talkBtn.disabled) {
      e.preventDefault();
      onDown(e);
    }
  });
  container.addEventListener('keyup', function(e) {
    if (e.key === ' ' && pointerActive) {
      e.preventDefault();
      onUp();
    }
  });
}

bindPressHold();

// 5. Cleanup on unmount.
mica.onDestroy(function() {
  try {
    if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
  } catch (_) { /* ignore */ }
  if (stream) {
    stream.getTracks().forEach(function(t) { t.stop(); });
    stream = null;
  }
});

// 6. First render — check the backend status; the talkBtn starts disabled
//    by intent only when status reports voice disabled.
checkServerReady();
