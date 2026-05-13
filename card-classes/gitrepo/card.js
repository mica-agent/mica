// gitrepo card — surfaces git status and the four actions that cover
// the "commit/push/sync against cloud" loop: stage, commit, push,
// pull (ff-only). Static card, direct REST calls to /api/git/* —
// no persistent channel.

const branchEl = container.querySelector('#gr-branch');
const countersEl = container.querySelector('#gr-counters');
const refreshBtn = container.querySelector('#gr-refresh');
const pullBtn = container.querySelector('#gr-pull');
const pushBtn = container.querySelector('#gr-push');
const notgitEl = container.querySelector('#gr-notgit');
const initBtn = container.querySelector('#gr-init');
const panelsEl = container.querySelector('#gr-panels');
const commitMsgEl = container.querySelector('#gr-commit-msg');
const commitBtn = container.querySelector('#gr-commit');
const toastEl = container.querySelector('#gr-toast');
const logEl = container.querySelector('#gr-log');
const logClearBtn = container.querySelector('#gr-log-clear');
const remoteSetupEl = container.querySelector('#gr-remote-setup');
const remoteUrlEl = container.querySelector('#gr-remote-url');
const remoteSubmitBtn = container.querySelector('#gr-remote-submit');
const remoteCancelBtn = container.querySelector('#gr-remote-cancel');

const sectionEls = {
  staged: container.querySelector('.gr-section[data-bucket="staged"]'),
  unstaged: container.querySelector('.gr-section[data-bucket="unstaged"]'),
  untracked: container.querySelector('.gr-section[data-bucket="untracked"]'),
};

let state = null;
let toastTimer = null;
let busy = false;

function showToast(text, ok) {
  if (!text) text = '(no output)';
  toastEl.className = 'gr-toast' + (ok ? ' gr-toast--ok' : '');
  toastEl.textContent = text;
  toastEl.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  // Longer dwell for errors (they need reading); okay toasts clear fast.
  toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, ok ? 2500 : 8000);
  appendLog(text, ok);
}

const LOG_MAX_ENTRIES = 100;
function appendLog(text, ok) {
  if (!logEl) return;
  // Drop the empty placeholder once we have a real entry.
  const empty = logEl.querySelector('.gr-log-empty');
  if (empty) empty.remove();
  const entry = window.document.createElement('div');
  entry.className = 'gr-log-entry ' + (ok ? 'gr-log-entry--ok' : 'gr-log-entry--err');
  const ts = window.document.createElement('span');
  ts.className = 'gr-log-ts';
  ts.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const msg = window.document.createElement('span');
  msg.className = 'gr-log-msg';
  msg.textContent = text;
  entry.appendChild(ts);
  entry.appendChild(msg);
  logEl.appendChild(entry);
  // Cap entries — drop oldest if we exceed the limit.
  while (logEl.children.length > LOG_MAX_ENTRIES) {
    logEl.firstChild.remove();
  }
  logEl.scrollTop = logEl.scrollHeight;
}
function clearLog() {
  if (!logEl) return;
  logEl.innerHTML = '<div class="gr-log-empty">no activity</div>';
}
clearLog();  // seed the placeholder
if (logClearBtn) logClearBtn.addEventListener('click', clearLog);

function setBusy(b) {
  busy = b;
  [refreshBtn, pullBtn, pushBtn, commitBtn, initBtn].forEach((el) => { if (el) el.disabled = b; });
  refreshBusyFlags();
}

function refreshBusyFlags() {
  // Commit button has an additional gating condition beyond busy.
  if (!busy) {
    commitBtn.disabled = !(state && state.staged && state.staged.length > 0 && commitMsgEl.value.trim().length > 0);
  }
}

async function gitFetch(path, opts) {
  opts = opts || {};
  try {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON — surface the raw text as an error */ }
    if (!r.ok) {
      const err = (data && (data.error || data.stderr)) || text || ('HTTP ' + r.status);
      return { ok: false, data, error: err };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ── Render ──────────────────────────────────────────────────────────
function renderHeader() {
  if (!state || !state.hasGit) {
    branchEl.textContent = '(not a repo)';
    countersEl.textContent = '';
    return;
  }
  branchEl.textContent = state.branch;
  countersEl.className = 'gr-counters';
  const parts = [];
  if (state.ahead > 0) parts.push('↑' + state.ahead);
  if (state.behind > 0) parts.push('↓' + state.behind);
  if (state.hasRemote && parts.length === 0 && state.ahead === 0 && state.behind === 0) {
    parts.push('in sync');
  } else if (!state.hasRemote) {
    parts.push('(no remote)');
  }
  countersEl.textContent = parts.join(' ');
  if (state.ahead > 0 && state.behind > 0) countersEl.classList.add('gr-counters--both');
  else if (state.ahead > 0) countersEl.classList.add('gr-counters--ahead');
  else if (state.behind > 0) countersEl.classList.add('gr-counters--behind');
}

function renderPanels() {
  if (!state || !state.hasGit) {
    panelsEl.style.display = 'none';
    container.querySelector('#gr-commitbox').style.display = 'none';
    notgitEl.style.display = 'block';
    return;
  }
  notgitEl.style.display = 'none';
  panelsEl.style.display = '';
  container.querySelector('#gr-commitbox').style.display = '';

  renderBucket('staged', state.staged, 'unstage');
  renderBucket('unstaged', state.unstaged, 'stage');
  renderBucket('untracked', state.untracked, 'stage');
}

function renderBucket(name, files, action) {
  const section = sectionEls[name];
  const list = section.querySelector('[data-list]');
  const countEl = section.querySelector('[data-count]');
  countEl.textContent = String(files.length);
  list.innerHTML = '';
  files.forEach((path) => {
    const li = window.document.createElement('li');
    li.className = 'gr-item';
    li.title = path;
    const pathEl = window.document.createElement('span');
    pathEl.className = 'gr-item-path';
    pathEl.textContent = path;
    const actEl = window.document.createElement('span');
    actEl.className = 'gr-item-action';
    actEl.textContent = action === 'stage' ? 'stage →' : '← unstage';
    li.appendChild(pathEl);
    li.appendChild(actEl);
    li.addEventListener('click', () => {
      if (busy) return;
      doStageToggle(action, path);
    });
    list.appendChild(li);
  });
}

// ── Actions ─────────────────────────────────────────────────────────
async function refreshStatus() {
  const r = await gitFetch('/api/git/status');
  if (!r.ok) {
    showToast('Status failed: ' + r.error, false);
    return;
  }
  state = r.data || { hasGit: false };
  renderHeader();
  renderPanels();
  refreshBusyFlags();
}

async function doStageToggle(action, path) {
  setBusy(true);
  const endpoint = action === 'stage' ? '/api/git/stage' : '/api/git/unstage';
  const r = await gitFetch(endpoint, { method: 'POST', body: { files: [path] } });
  setBusy(false);
  if (!r.ok) {
    showToast((action === 'stage' ? 'Stage' : 'Unstage') + ' failed: ' + r.error, false);
    return;
  }
  refreshStatus();
}

async function doCommit() {
  const msg = commitMsgEl.value.trim();
  if (!msg) return;
  setBusy(true);
  const r = await gitFetch('/api/git/commit', { method: 'POST', body: { message: msg } });
  setBusy(false);
  if (!r.ok) {
    showToast('Commit failed: ' + r.error, false);
    return;
  }
  const sha = (r.data && r.data.sha) || '';
  showToast('Committed ' + sha, true);
  commitMsgEl.value = '';
  refreshStatus();
}

async function doPush() {
  // No remote yet: open the setup flow instead of letting git push
  // produce a cryptic "No configured push destination" error.
  if (state && state.hasGit && !state.hasRemote) {
    openRemoteSetup();
    return;
  }
  setBusy(true);
  const r = await gitFetch('/api/git/push', { method: 'POST' });
  setBusy(false);
  if (!r.ok) {
    showToast('Push failed: ' + r.error, false);
    return;
  }
  showToast('Pushed' + (r.data && r.data.stderr ? '\n\n' + r.data.stderr : ''), true);
  refreshStatus();
}

function openRemoteSetup() {
  if (!remoteSetupEl) return;
  remoteSetupEl.style.display = 'flex';
  if (remoteUrlEl) {
    remoteUrlEl.value = '';
    setTimeout(() => remoteUrlEl.focus(), 0);
  }
}
function closeRemoteSetup() {
  if (remoteSetupEl) remoteSetupEl.style.display = 'none';
}
async function doSetRemoteAndPush() {
  const url = remoteUrlEl ? remoteUrlEl.value.trim() : '';
  if (!url) {
    showToast('Enter a repo URL first', false);
    return;
  }
  setBusy(true);
  const r = await gitFetch('/api/git/set-remote', { method: 'POST', body: { url: url } });
  if (!r.ok) {
    setBusy(false);
    showToast('Set remote failed: ' + r.error, false);
    return;
  }
  closeRemoteSetup();
  showToast('Remote ' + ((r.data && r.data.action) || 'set') + ': ' + url, true);
  // Refresh status so hasRemote flips to true, then push.
  await refreshStatus();
  setBusy(false);
  await doPush();
}

async function doPull() {
  setBusy(true);
  const r = await gitFetch('/api/git/pull', { method: 'POST' });
  setBusy(false);
  if (!r.ok) {
    showToast('Pull failed: ' + r.error, false);
    return;
  }
  showToast('Pulled' + (r.data && r.data.stdout ? '\n\n' + r.data.stdout : ''), true);
  refreshStatus();
}

async function doInit() {
  setBusy(true);
  const r = await gitFetch('/api/git/init', { method: 'POST' });
  setBusy(false);
  if (!r.ok) {
    showToast('Init failed: ' + r.error, false);
    return;
  }
  showToast('Initialized repository', true);
  refreshStatus();
}

// ── Wire up ─────────────────────────────────────────────────────────
refreshBtn.addEventListener('click', refreshStatus);
pushBtn.addEventListener('click', doPush);
if (remoteSubmitBtn) remoteSubmitBtn.addEventListener('click', doSetRemoteAndPush);
if (remoteCancelBtn) remoteCancelBtn.addEventListener('click', closeRemoteSetup);
if (remoteUrlEl) remoteUrlEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); doSetRemoteAndPush(); }
  else if (e.key === 'Escape') { closeRemoteSetup(); }
});
pullBtn.addEventListener('click', doPull);
commitBtn.addEventListener('click', doCommit);
initBtn.addEventListener('click', doInit);
commitMsgEl.addEventListener('input', refreshBusyFlags);

// Poll + react. 10s cadence is plenty for typical editing flows; we
// also refresh eagerly on any file-changed event in the project since
// those are the mutations that matter.
let pollTimer = null;
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    // Skip polling if the tab isn't visible — saves work and avoids
    // hammering git in backgrounded tabs.
    if (window.document.visibilityState === 'hidden') return;
    refreshStatus();
  }, 10000);
}
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}
startPolling();

let reactTimer = null;
function scheduleReact() {
  if (reactTimer) clearTimeout(reactTimer);
  reactTimer = setTimeout(() => { reactTimer = null; refreshStatus(); }, 400);
}
const unsubs = [
  mica.on('file-created', scheduleReact),
  mica.on('file-changed', (ev) => {
    // Ignore our own card writes (if any) and purely .mica/ noise that
    // doesn't affect git state. File watcher already filters most
    // infra paths; this is belt-and-suspenders.
    if (ev && ev.filename && ev.filename.indexOf('.mica/') === 0) return;
    scheduleReact();
  }),
  mica.on('file-deleted', scheduleReact),
];

mica.onDestroy(() => {
  stopPolling();
  if (reactTimer) clearTimeout(reactTimer);
  if (toastTimer) clearTimeout(toastTimer);
  for (const u of unsubs) u();
});

await refreshStatus();
