// Chat card — OpenCode agentic coding assistant
// container and mica are provided by CARD_SHIM

const messagesEl = container.querySelector("#chat-messages");
const inputEl = container.querySelector("#chat-input");
const sendBtn = container.querySelector("#chat-send");
const stopBtn = container.querySelector("#chat-stop");
const statusBar = container.querySelector("#chat-statusbar");
const statusMain = container.querySelector("#chat-status-main");
const statusDot = container.querySelector("#chat-dot");
const statusLabel = container.querySelector("#chat-status-label");
const statusMeta = container.querySelector("#chat-status-meta");
const statusToggle = container.querySelector("#chat-status-toggle");
const statusDetail = container.querySelector("#chat-status-detail");
const attachBtn = container.querySelector("#chat-attach-btn");
const attachRow = container.querySelector("#chat-attach-row");
const attachFilenameEl = container.querySelector("#chat-attach-filename");
const attachClearBtn = container.querySelector("#chat-attach-clear");
const attachPicker = container.querySelector("#chat-attach-picker");
const attachOptionsEl = container.querySelector("#chat-attach-options");
// Fuel gauge (B — future: capacity trajectory). See chat card for rationale.
// recentBaselines is misnamed — stores PEAK input_tokens; recentBaselinesActual
// stores the turn-start baseline. The gap between them on the gauge shows
// how much tool-result accumulation happened during the turn.
const fuelEl = container.querySelector("#chat-fuel");
const fuelFill = fuelEl ? fuelEl.querySelector(".fuel-fill") : null;
const fuelBaselineMarker = fuelEl ? fuelEl.querySelector(".fuel-baseline-marker") : null;
const fuelHeadroomLabel = container.querySelector("#chat-fuel-headroom");
const FUEL_HISTORY_CAP = 5;
const recentBaselines = [];
const recentBaselinesActual = [];
let lastContextWindow = 0;
const clearBtn = container.querySelector("#chat-clear-btn");
const spawnBtn = container.querySelector("#chat-spawn-btn");
const archiveBtn = container.querySelector("#chat-archive-btn");
const archivePanel = container.querySelector("#chat-archive-panel");
const archiveListEl = container.querySelector("#chat-archive-list");

let detailExpanded = false;
const ACCENT = "#7c3aed";
let busy = false;
// Context cursor — see chat card for details.
let contextCursor = 0;
let messageIndex = 0;
let lastCapacity = 0;
// Per-turn token + tool data, keyed by turn_id. Populated from the assistant
// broadcast at end-of-turn AND from saved history records on attach (so the
// chevron footer works after a page reload). Read by the chevron click
// handler to build the token chips without a server round-trip.
const turnDataByTurnId = new Map();

function projectHeaders(extra) {
  const h = { "X-Mica-Project": (typeof mica !== "undefined" && mica.project) || "" };
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

function formatK(n) {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 10000) return (n / 1000).toFixed(1) + "K";
  return Math.round(n / 1000) + "K";
}

// Toggle the busy flag AND a .wb-card--busy class on the outer card wrapper.
// Drives the breathing halo defined in whiteboard.css (same one the qwen
// chat card uses). Rings the completion chime on busy→idle so any path
// that ends a turn triggers it without needing per-branch playChime calls.
function setBusy(b) {
  const wasBusy = busy;
  busy = b;
  const card = container.closest('.wb-card');
  if (card) card.classList.toggle('wb-card--busy', b);
  inputEl.classList.toggle('chat-input--busy', b);
  inputEl.classList.toggle('chat-input--ready', !b);
  inputEl.placeholder = b ? "Working…" : "Your turn — ask OpenCode…";
  if (wasBusy && !b) playChime();
}
let queuedCount = 0;  // user messages typed during busy — server queues them
let elapsedSec = 0;
let elapsedTimer = null;
let stepCount = 0;

// Toggle detail panel
statusMain.addEventListener("click", function(e) {
  e.stopPropagation();
  detailExpanded = !detailExpanded;
  statusDetail.style.display = detailExpanded ? "block" : "none";
  statusToggle.innerHTML = detailExpanded ? "&#9650;" : "&#9660;";
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
});

function addDetailLine(text) {
  const line = window.document.createElement("div");
  line.style.cssText = "padding:1px 0;border-bottom:1px solid rgba(48,54,61,0.3);";
  line.textContent = text;
  statusDetail.appendChild(line);
  if (detailExpanded) statusDetail.scrollTop = statusDetail.scrollHeight;
}

// Open channel to server agent
const ch = mica.openChannel("agent_session");

// Hydrate fuel gauge buffer from recent turn history on mount.
hydrateFuelGauge();

// OpenCode uses the cloud — no local model-loading status to poll.
inputEl.placeholder = 'Your turn — ask OpenCode…';
sendBtn.disabled = false;

// ── Per-card LLM settings (provider + model) ────────────────
// Mirrors the qwen.qwen card's settings UX exactly: Local / OpenRouter /
// OpenAI-compatible radios, OpenRouter has a searchable model dropdown +
// key validation against openrouter.ai, OpenAI-compatible takes a custom
// baseUrl + model + key. Persistence shape `{ provider, model }` is shared
// with the chat card (same /api/cards/settings sidecar). Workspace-level
// credentials — OpenRouter key, OpenAI-compat baseUrl+key — are stored at
// /api/openrouter-key and /api/openai-config, shared across both card
// classes. server/opencodeAgent.ts reads the per-card {provider, model} on
// each prompt and maps to opencode's body.model + provider env injection.
const modelLabelEl = container.querySelector('#chat-model-label');
const settingsBtn = container.querySelector('#chat-settings-btn');
const settingsPanel = container.querySelector('#chat-settings-panel');
const settingsClose = container.querySelector('#chat-settings-close');
const settingsCancel = container.querySelector('#chat-settings-cancel');
const settingsSave = container.querySelector('#chat-settings-save');
const settingsModel = container.querySelector('#chat-settings-model');
const settingsModelHint = container.querySelector('#chat-settings-model-hint');
const settingsModelDropdown = container.querySelector('#chat-settings-model-dropdown');
const settingsKeyRow = container.querySelector('#chat-settings-key-row');
const settingsKey = container.querySelector('#chat-settings-key');
const settingsKeyStatus = container.querySelector('#chat-settings-key-status');
const settingsKeyLabel = container.querySelector('#chat-settings-key-label');
const settingsBaseurlRow = container.querySelector('#chat-settings-baseurl-row');
const settingsBaseurl = container.querySelector('#chat-settings-baseurl');
const providerRadios = container.querySelectorAll('input[name="chat-provider"]');

const MODEL_DEFAULTS = {
  local: 'opencode default',
  openrouter: 'anthropic/claude-3.5-sonnet',
  'openai-compat': 'gpt-4o-mini',
};

let currentSettings = { provider: 'local', model: '' };

function settingsUrl(qs) {
  const sep = (qs && qs.indexOf('?') >= 0) ? '&' : '?';
  return '/api/cards/settings' + (qs || '') + sep + 'path=' + encodeURIComponent(mica.filename);
}

function renderModelLabel() {
  if (!modelLabelEl) return;
  const provider = currentSettings.provider || 'local';
  let providerShort;
  if (provider === 'openrouter') providerShort = 'OpenRouter';
  else if (provider === 'openai-compat') providerShort = 'OpenAI';
  else providerShort = 'OpenCode';
  const model = currentSettings.model || '';
  const display = model ? providerShort + ' · ' + model : providerShort;
  modelLabelEl.textContent = display;
  modelLabelEl.title = display;
}

// Lazy-loaded OpenRouter model catalog (same /api/openrouter/models the
// chat card consumes — server caches for an hour, so two cards opening
// settings in succession share the result).
let openrouterModels = null;        // null = not loaded; [] = loaded empty/failed; [...] = loaded
let openrouterFetchInflight = null;

function formatPricePerM(usdPerM) {
  if (typeof usdPerM !== 'number' || !isFinite(usdPerM)) return null;
  if (usdPerM === 0) return '$0';
  if (usdPerM < 0.01) return '$' + usdPerM.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (usdPerM < 1) return '$' + usdPerM.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  if (usdPerM < 10) return '$' + usdPerM.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return '$' + Math.round(usdPerM);
}

function formatContextLen(n) {
  if (typeof n !== 'number' || n <= 0) return null;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M ctx';
  if (n >= 1000) return Math.round(n / 1000) + 'K ctx';
  return n + ' ctx';
}

function formatModelMeta(m) {
  const parts = [];
  const pIn = formatPricePerM(m.promptPerM);
  const pOut = formatPricePerM(m.completionPerM);
  if (m.promptPerM === 0 && m.completionPerM === 0) parts.push('free');
  else if (pIn || pOut) parts.push((pIn || '?') + '/M in · ' + (pOut || '?') + '/M out');
  const ctx = formatContextLen(m.contextLength);
  if (ctx) parts.push(ctx);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function fetchOpenrouterModels() {
  if (openrouterModels !== null) return Promise.resolve(openrouterModels);
  if (openrouterFetchInflight) return openrouterFetchInflight;
  openrouterFetchInflight = fetch('/api/openrouter/models', { headers: projectHeaders() })
    .then(function(r) { return r.ok ? r.json() : { models: [] }; })
    .then(function(j) { openrouterModels = Array.isArray(j.models) ? j.models : []; return openrouterModels; })
    .catch(function() { openrouterModels = []; return openrouterModels; })
    .finally(function() { openrouterFetchInflight = null; });
  return openrouterFetchInflight;
}

function renderModelDropdown(query) {
  if (!Array.isArray(openrouterModels) || openrouterModels.length === 0) {
    settingsModelDropdown.style.display = 'none';
    settingsModelDropdown.innerHTML = '';
    return;
  }
  const q = (query || '').trim().toLowerCase();
  const matches = [];
  for (const m of openrouterModels) {
    const id = m.id || '';
    const idLow = id.toLowerCase();
    const name = m.name || '';
    const nameLow = name.toLowerCase();
    if (!q) { matches.push({ m, rank: 0 }); continue; }
    if (idLow.startsWith(q)) matches.push({ m, rank: 0 });
    else if (idLow.includes(q)) matches.push({ m, rank: 1 });
    else if (nameLow.includes(q)) matches.push({ m, rank: 2 });
  }
  if (matches.length === 0) {
    settingsModelDropdown.innerHTML = '<div style="padding:8px;color:#6e7681;font-size:11px;">No matches. The id is still saved as-is — useful for private/preview models.</div>';
    settingsModelDropdown.style.display = 'block';
    return;
  }
  matches.sort(function(a, b) { return a.rank - b.rank || a.m.id.localeCompare(b.m.id); });
  const top = matches.slice(0, 50);
  settingsModelDropdown.innerHTML = '';
  top.forEach(function(entry) {
    const m = entry.m;
    const row = window.document.createElement('div');
    row.className = 'or-model-row';
    row.style.cssText = 'padding:6px 8px;cursor:pointer;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.04);';
    row.dataset.modelId = m.id;
    const idEl = window.document.createElement('div');
    idEl.style.cssText = 'color:#e6edf3;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
    idEl.textContent = m.id;
    row.appendChild(idEl);
    if (m.name && m.name !== m.id) {
      const nameEl = window.document.createElement('div');
      nameEl.style.cssText = 'color:#8b949e;font-size:11px;margin-top:1px;';
      nameEl.textContent = m.name;
      row.appendChild(nameEl);
    }
    const meta = formatModelMeta(m);
    if (meta) {
      const metaEl = window.document.createElement('div');
      metaEl.style.cssText = 'color:#7ec699;font-size:11px;margin-top:1px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;';
      metaEl.textContent = meta;
      row.appendChild(metaEl);
    }
    row.addEventListener('mouseenter', function() { row.style.background = 'rgba(124,58,237,0.18)'; });
    row.addEventListener('mouseleave', function() { row.style.background = 'transparent'; });
    // mousedown rather than click so the input's blur doesn't hide the
    // dropdown before the selection registers.
    row.addEventListener('mousedown', function(e) {
      e.preventDefault();
      settingsModel.value = m.id;
      hideModelDropdown();
    });
    settingsModelDropdown.appendChild(row);
  });
  if (matches.length > top.length) {
    const more = window.document.createElement('div');
    more.style.cssText = 'padding:6px 8px;color:#6e7681;font-size:11px;';
    more.textContent = '+ ' + (matches.length - top.length) + ' more — refine to narrow.';
    settingsModelDropdown.appendChild(more);
  }
  settingsModelDropdown.style.display = 'block';
}

function hideModelDropdown() {
  settingsModelDropdown.style.display = 'none';
}

function showModelDropdownIfOpenrouter() {
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') { hideModelDropdown(); return; }
  fetchOpenrouterModels().then(function() {
    renderModelDropdown(settingsModel.value);
  });
}

settingsModel.addEventListener('focus', showModelDropdownIfOpenrouter);
settingsModel.addEventListener('input', function() {
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  if (provider !== 'openrouter') return;
  if (openrouterModels === null) fetchOpenrouterModels().then(function() { renderModelDropdown(settingsModel.value); });
  else renderModelDropdown(settingsModel.value);
});
settingsModel.addEventListener('blur', function() {
  setTimeout(hideModelDropdown, 120);
});

function updateProviderUI(provider) {
  if (provider === 'openrouter') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'none';
    settingsKeyLabel.innerHTML = 'OpenRouter API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = MODEL_DEFAULTS.openrouter + ' (default)';
    settingsModelHint.textContent = 'Pick from the list or type any OpenRouter model id, e.g. anthropic/claude-3.5-sonnet, openai/gpt-4o.';
    fetchOpenrouterModels();
  } else if (provider === 'openai-compat') {
    settingsKeyRow.style.display = 'block';
    settingsBaseurlRow.style.display = 'block';
    settingsKeyLabel.innerHTML = 'API key <span style="color:#6e7681;font-weight:normal;">(saved per project)</span>';
    settingsModel.placeholder = MODEL_DEFAULTS['openai-compat'] + ' (default)';
    settingsModelHint.textContent = 'Type the model id your endpoint expects (e.g. gpt-4o-mini, mistralai/Mixtral-8x7B-Instruct-v0.1, your-vllm-model-name).';
    hideModelDropdown();
  } else {
    settingsKeyRow.style.display = 'none';
    settingsBaseurlRow.style.display = 'none';
    settingsModel.placeholder = MODEL_DEFAULTS.local + ' (default)';
    settingsModelHint.textContent = 'Uses OpenCode\'s default provider (whichever is first configured in auth.json or opencode.jsonc). Model field is informational — OpenCode picks the model from its own config.';
    hideModelDropdown();
  }
}

providerRadios.forEach(function(r) {
  r.addEventListener('change', function() { updateProviderUI(r.value); });
});

function openSettings() {
  // Pull fresh state every time so opening the panel after another tab saved
  // shows current values, not a stale snapshot.
  Promise.allSettled([
    fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openrouter-key', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
    fetch('/api/openai-config', { headers: projectHeaders() }).then(function(r) { return r.json(); }),
  ]).then(function(results) {
    const s = results[0].status === 'fulfilled' ? results[0].value : {};
    const k = results[1].status === 'fulfilled' ? results[1].value : { hasKey: false };
    const oc = results[2].status === 'fulfilled' ? results[2].value : { baseUrl: null, hasKey: false };
    const provider = s.provider || 'local';
    providerRadios.forEach(function(r) { r.checked = (r.value === provider); });
    settingsModel.value = s.model || '';
    settingsKey.value = '';
    settingsBaseurl.value = oc.baseUrl || '';
    let hasKeyForProvider, keyHint;
    if (provider === 'openai-compat') {
      hasKeyForProvider = !!oc.hasKey;
      keyHint = hasKeyForProvider ? 'sk-••••••••••••••••' : 'sk-... (or any token your endpoint expects)';
    } else {
      hasKeyForProvider = !!k.hasKey;
      keyHint = hasKeyForProvider ? 'sk-or-••••••••••••••••' : 'sk-or-...';
    }
    settingsKey.placeholder = keyHint;
    settingsKeyStatus.style.color = '#6e7681';
    settingsModelHint.style.color = '#6e7681';
    settingsKeyStatus.textContent = hasKeyForProvider
      ? 'Key set ✓ — paste a new one to replace, or clear it to remove.'
      : 'No key set yet.';
    updateProviderUI(provider);
    settingsPanel.style.display = 'block';
    setTimeout(function() {
      (provider === 'openrouter' || provider === 'openai-compat' ? settingsKey : settingsModel).focus();
    }, 0);
  });
}

function closeSettings() { settingsPanel.style.display = 'none'; }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
settingsCancel.addEventListener('click', closeSettings);

settingsSave.addEventListener('click', function() {
  let provider = 'local';
  providerRadios.forEach(function(r) { if (r.checked) provider = r.value; });
  const model = settingsModel.value.trim();
  const keyValue = settingsKey.value;
  const baseurlValue = settingsBaseurl.value.trim();
  settingsSave.disabled = true;
  settingsSave.textContent = 'Saving...';

  settingsKeyStatus.style.color = '#6e7681';
  settingsModelHint.style.color = '#6e7681';

  // OpenAI-compat requires baseUrl. Surface a clean message before save.
  if (provider === 'openai-compat' && !baseurlValue) {
    settingsModelHint.textContent = 'Base URL required (e.g., https://api.openai.com/v1).';
    settingsModelHint.style.color = '#f87171';
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
    return;
  }

  // OpenRouter (key, model) validation BEFORE save.
  const needsValidation = provider === 'openrouter' && (keyValue.length > 0 || model.length > 0);
  const validateP = needsValidation
    ? fetch('/api/openrouter/validate', {
        method: 'POST',
        headers: projectHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: keyValue, model: model }),
      }).then(function(r) { return r.json(); })
    : Promise.resolve({ ok: true, errors: {} });

  validateP.then(function(v) {
    const errors = v.errors || {};
    if (errors.key) {
      settingsKeyStatus.textContent = errors.key;
      settingsKeyStatus.style.color = '#f87171';
    }
    if (errors.model) {
      settingsModelHint.textContent = errors.model;
      settingsModelHint.style.color = '#f87171';
    }
    if (!v.ok) { const e = new Error('validation failed'); e.validationFailure = true; throw e; }

    const cardP = fetch(settingsUrl(''), {
      method: 'PUT',
      headers: projectHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ provider: provider, model: model }),
    }).then(function(r) { return r.json(); });
    let credP;
    if (provider === 'openrouter') {
      credP = keyValue.length > 0
        ? fetch('/api/openrouter-key', {
            method: 'PUT',
            headers: projectHeaders({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({ key: keyValue }),
          }).then(function(r) { return r.json(); })
        : Promise.resolve(null);
    } else if (provider === 'openai-compat') {
      const body = { baseUrl: baseurlValue };
      if (keyValue.length > 0) body.key = keyValue;
      credP = fetch('/api/openai-config', {
        method: 'PUT',
        headers: projectHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
      }).then(function(r) { return r.json(); });
    } else {
      credP = Promise.resolve(null);
    }
    return Promise.all([cardP, credP]).then(function() {
      return { warning: v.warning };
    });
  }).then(function(meta) {
    currentSettings = { provider: provider, model: model };
    renderModelLabel();
    closeSettings();
    const saveMsg = meta && meta.warning ? 'Saved. ' + meta.warning : 'Settings saved.';
    statusBar.style.display = 'block';
    statusLabel.textContent = saveMsg;
    statusDot.style.background = meta && meta.warning ? '#d29922' : '#4ade80';
    setTimeout(function() {
      if (statusLabel.textContent === saveMsg) statusBar.style.display = 'none';
    }, 3000);
  }).catch(function(err) {
    if (!err || !err.validationFailure) {
      window.alert('Save failed: ' + (err && err.message ? err.message : 'unknown'));
    }
  }).finally(function() {
    settingsSave.disabled = false;
    settingsSave.textContent = 'Save';
  });
});

// Initial load: pull current settings, then render label.
fetch(settingsUrl(''), { headers: projectHeaders() }).then(function(r) { return r.json(); }).then(function(s) {
  currentSettings = { provider: s.provider || 'local', model: s.model || '' };
}).catch(function() { /* defaults */ }).finally(function() {
  renderModelLabel();
});

function scrollBottom() {
  requestAnimationFrame(function() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
}

function escapeHtml(s) {
  const d = window.document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function renderMarkdown(text) {
  text = text.replace(/^```markdown\n([\s\S]*?)```$/gm, function(m, inner) { return inner; });

  // Extract fenced code blocks
  const fenced = [];
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function(m, lang, code) {
    fenced.push(`<pre style="background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0"><code style="font-size:12px;font-family:monospace">${code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</code></pre>`);
    return `__FENCED__${fenced.length - 1}__`;
  });

  // Extract tables (consecutive lines starting with |)
  const tables = [];
  text = text.replace(/(^\|.+\|\n?)+/gm, function(block) {
    const rows = block.trim().split("\n");
    let html = '<table style="border-collapse:collapse;margin:6px 0;font-size:12px;width:100%">';
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri].trim();
      if (/^\|[\s-:|]+\|$/.test(row)) continue; // skip separator row
      const cells = row.split("|").filter(function(c, i, a) { return i > 0 && i < a.length - 1; });
      const tag = ri === 0 ? "th" : "td";
      html += "<tr>";
      for (let ci = 0; ci < cells.length; ci++) {
        const style = tag === "th" ? "background:rgba(255,255,255,0.05);font-weight:600;" : "";
        html += `<${tag} style="border:1px solid #333;padding:4px 8px;${style}">${cells[ci].trim()}</${tag}>`;
      }
      html += "</tr>";
    }
    html += "</table>";
    tables.push(html);
    return `__TABLE__${tables.length - 1}__`;
  });

  text = text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>')
    .replace(/^- (.+)$/gm, "<li>$1</li>")
    .replace(/^\d+\. (.+)$/gm, "<li>$1</li>")
    .replace(/\n\n/g, "<br/><br/>")
    .replace(/\n/g, "<br/>");

  // Wrap consecutive <li> runs in <ul> so browsers render bullet markers
  // inside the content box (otherwise markers leak outside the chat bubble).
  text = text.replace(/(?:<li>[\s\S]*?<\/li>(?:<br\/>)?)+/g, (m) => {
    return "<ul>" + m.replace(/<br\/>/g, "") + "</ul>";
  });

  // Restore fenced blocks and tables
  for (let fi = 0; fi < fenced.length; fi++) {
    text = text.replace(`__FENCED__${fi}__`, fenced[fi]);
  }
  for (let ti = 0; ti < tables.length; ti++) {
    text = text.replace(`__TABLE__${ti}__`, tables[ti]);
  }
  return text;
}

function buildHorizonEl() {
  const horizon = window.document.createElement("div");
  horizon.className = "chat-horizon";
  horizon.style.cssText =
    "align-self:stretch;display:flex;align-items:center;gap:8px;color:#6e7681;" +
    "font-size:10px;font-family:monospace;margin:6px 0;opacity:0.7;";
  horizon.innerHTML =
    '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>' +
    '<span style="flex-shrink:0;">↑ earlier conversation (not in agent context)</span>' +
    '<span style="flex:1;height:1px;background:linear-gradient(to right,transparent,#30363d,transparent);"></span>';
  return horizon;
}

// Re-evaluate cursor-dependent display state across every rendered message
// and re-position the single horizon separator. Call after a mid-session
// cursor advance so the break is visible immediately.
function applyCursorDisplay() {
  const existing = messagesEl.querySelector(".chat-horizon");
  if (existing) existing.remove();
  const msgs = messagesEl.querySelectorAll("[data-msg-index]");
  let inserted = false;
  for (const m of msgs) {
    const idx = parseInt(m.getAttribute("data-msg-index"), 10);
    m.style.opacity = idx < contextCursor ? "0.55" : "";
    if (!inserted && contextCursor > 0 && idx >= contextCursor) {
      messagesEl.insertBefore(buildHorizonEl(), m);
      inserted = true;
    }
  }
}

function maybeRenderHorizon() {
  if (contextCursor > 0 && messageIndex === contextCursor && !messagesEl.querySelector(".chat-horizon")) {
    messagesEl.appendChild(buildHorizonEl());
  }
}

function addMessage(role, content, agent, questions, turnId) {
  if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === "center") {
    messagesEl.innerHTML = "";
  }
  maybeRenderHorizon();
  const msg = window.document.createElement("div");
  msg.setAttribute("data-msg-index", String(messageIndex));
  const aboveHorizon = messageIndex < contextCursor;
  if (aboveHorizon) msg.style.opacity = "0.55";
  messageIndex++;
  if (role === "user") {
    msg.style.cssText = "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;";
    msg.innerHTML = `<div style="color:#e6edf3;font-size:13px;line-height:1.5;">${escapeHtml(content)}</div>`;
  } else {
    msg.style.cssText = "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
    // A — past, per-turn footer chevron. See chat card for full design.
    const chevron = turnId ? `<span class="chat-bubble-toggle" data-turn-id="${escapeHtml(turnId)}" title="Show turn details" style="cursor:pointer;color:#8b949e;font-size:13px;font-weight:600;margin-left:8px;padding:1px 5px;border-radius:3px;display:inline-block;line-height:1;transition:transform 120ms ease, background-color 120ms ease;">▸</span>` : "";
    const header = agent ? `<div style="color:${ACCENT};font-size:11px;font-weight:600;margin-bottom:4px;">${escapeHtml(agent)}${chevron}</div>` : "";
    msg.innerHTML = `${header}<div class="chat-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">${renderMarkdown(content)}</div>`;
    if (questions && questions.length > 0) {
      // Per-question grouping: each question gets its own header + chip row.
      // Single-question case auto-submits on click (preserves prior UX).
      // Multi-question case stages selections per question; user clicks
      // "Send answers" once all questions have a selection. Selecting in
      // one question doesn't disable chips in other questions. multiSelect
      // questions toggle on click.
      const renderable = questions.filter(function(q) { return q.options && q.options.length > 0; });
      if (renderable.length > 0) {
        const isMulti = renderable.length > 1;
        const selections = {};  // qi -> string (single) or [string] (multiSelect)
        const allBtns = [];
        let sendBtn = null;
        function btnBase() {
          return "color:#e6edf3;border:1px solid rgba(124,58,237,0.4);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;font-family:inherit;";
        }
        function btnUnselected() { return btnBase() + "background:rgba(124,58,237,0.15);"; }
        function btnSelected() { return btnBase() + "background:rgba(124,58,237,0.55);"; }
        function isSel(qi, label) {
          const sel = selections[qi];
          if (Array.isArray(sel)) return sel.indexOf(label) >= 0;
          return sel === label;
        }
        function updateSendEnabled() {
          if (!sendBtn) return;
          const ok = renderable.every(function(q, qi) {
            const sel = selections[qi];
            if (q.multiSelect) return Array.isArray(sel) && sel.length > 0;
            return typeof sel === "string" && sel.length > 0;
          });
          sendBtn.disabled = !ok;
          sendBtn.style.opacity = ok ? "1" : "0.5";
          sendBtn.style.cursor = ok ? "pointer" : "default";
        }
        function disableAll() {
          for (let i = 0; i < allBtns.length; i++) {
            allBtns[i].disabled = true;
            allBtns[i].style.opacity = "0.4";
            allBtns[i].style.cursor = "default";
          }
          if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.style.opacity = "0.4";
            sendBtn.style.cursor = "default";
          }
        }
        function submitMulti() {
          const lines = renderable.map(function(q, qi) {
            const sel = selections[qi];
            const ans = q.multiSelect
              ? (Array.isArray(sel) ? sel.join(", ") : "")
              : (sel || "");
            return (q.question || "Question " + (qi + 1)) + " -> " + ans;
          });
          disableAll();
          inputEl.value = lines.join("\n");
          send();
        }
        const groups = window.document.createElement("div");
        groups.style.cssText = "display:flex;flex-direction:column;gap:14px;margin-top:6px;";
        renderable.forEach(function(q, qi) {
          const group = window.document.createElement("div");
          group.style.cssText = "display:flex;flex-direction:column;gap:6px;";
          if (q.question) {
            const qText = window.document.createElement("div");
            qText.style.cssText = "color:#e6edf3;font-size:13px;font-weight:500;line-height:1.4;";
            qText.textContent = q.question;
            group.appendChild(qText);
          }
          const row = window.document.createElement("div");
          row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";
          q.options.forEach(function(opt) {
            const btn = window.document.createElement("button");
            btn.textContent = opt.label;
            btn.title = opt.description || opt.label;
            btn.style.cssText = btnUnselected();
            btn.addEventListener("mouseenter", function() {
              if (btn.disabled) return;
              if (!isSel(qi, opt.label)) btn.style.background = "rgba(124,58,237,0.3)";
            });
            btn.addEventListener("mouseleave", function() {
              if (btn.disabled) return;
              btn.style.background = isSel(qi, opt.label) ? "rgba(124,58,237,0.55)" : "rgba(124,58,237,0.15)";
            });
            btn.addEventListener("click", function() {
              if (!isMulti) {
                disableAll();
                btn.style.cssText = btnSelected();
                inputEl.value = opt.label;
                send();
                return;
              }
              if (q.multiSelect) {
                const arr = Array.isArray(selections[qi]) ? selections[qi] : [];
                const idx = arr.indexOf(opt.label);
                if (idx >= 0) {
                  arr.splice(idx, 1);
                  btn.style.cssText = btnUnselected();
                } else {
                  arr.push(opt.label);
                  btn.style.cssText = btnSelected();
                }
                selections[qi] = arr;
              } else {
                selections[qi] = opt.label;
                const rowBtns = row.querySelectorAll("button");
                for (let i = 0; i < rowBtns.length; i++) rowBtns[i].style.cssText = btnUnselected();
                btn.style.cssText = btnSelected();
              }
              updateSendEnabled();
            });
            allBtns.push(btn);
            row.appendChild(btn);
          });
          group.appendChild(row);
          groups.appendChild(group);
        });
        if (isMulti) {
          sendBtn = window.document.createElement("button");
          sendBtn.textContent = "Send answers";
          sendBtn.style.cssText = "background:rgba(124,58,237,0.6);color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:12px;font-weight:600;cursor:default;font-family:inherit;align-self:flex-start;margin-top:4px;opacity:0.5;";
          sendBtn.disabled = true;
          sendBtn.addEventListener("click", function() {
            if (!sendBtn.disabled) submitMulti();
          });
          groups.appendChild(sendBtn);
        }
        msg.appendChild(groups);
      }
    }
  }
  messagesEl.appendChild(msg);
  scrollBottom();
}

// Past per-turn footer chips. Source of truth is `turnDataByTurnId` — the
// in-memory map populated from the assistant broadcast (live) and the
// history record on attach (durable). Server fetch is no longer required;
// it's still attempted as a best-effort enrichment for skills/subagents
// chips that come from the optional /api/agent/turn-record endpoint (which
// opencode doesn't write today — qwen does).
function chip(label, title) {
  return '<span class="chat-turn-chip" title="' + escapeHtml(title) + '">' + escapeHtml(label) + '</span>';
}

function formatTokenChips(td) {
  if (!td) return "";
  const parts = [];
  // Input chip: billed sum across all model calls this turn. Tooltip shows
  // the peak (largest single call's input) — that's the number that maps
  // to ctx for overflow risk. Cached reads broken out so users can see the
  // discount.
  const inLabel = formatK(td.input || 0) + " in";
  const peakLine = td.peak ? "Peak (largest single call): " + formatK(td.peak) + (td.ctx ? " / " + formatK(td.ctx) + " ctx (" + Math.round((td.peak / td.ctx) * 100) + "%)" : "") : "";
  const cacheReadLine = td.cache_read > 0 ? "Cache read: " + formatK(td.cache_read) + " (cheap)" : "";
  const cacheWriteLine = td.cache_write > 0 ? "Cache write: " + formatK(td.cache_write) : "";
  const inTitle = ["Billed input total (sum across steps): " + (td.input || 0), peakLine, cacheReadLine, cacheWriteLine].filter(Boolean).join("\n");
  parts.push(chip(inLabel, inTitle));

  // Output chip: completion tokens this turn.
  const outLabel = formatK(td.output || 0) + " out";
  parts.push(chip(outLabel, "Output total this turn: " + (td.output || 0)));

  // Reasoning chip (only when non-zero — reasoning models only). Claude
  // extended thinking, o1/o3, deepseek-r1, gpt-5-thinking, gemini-2.5-flash-thinking.
  if (td.reasoning > 0) {
    parts.push(chip(formatK(td.reasoning) + " thinking", "Reasoning / thinking tokens: " + td.reasoning + "\n(billed as output by most providers)"));
  }

  // Tools chip: total tool calls + top three by name in the tooltip.
  const tc = td.tool_calls || {};
  const toolEntries = Object.keys(tc).map(function(k) { return [k, tc[k]]; }).sort(function(a, b) { return b[1] - a[1]; });
  const totalToolCalls = toolEntries.reduce(function(s, e) { return s + e[1]; }, 0);
  if (totalToolCalls > 0) {
    const topTools = toolEntries.slice(0, 6).map(function(e) { return e[0] + " ×" + e[1]; }).join("\n");
    parts.push(chip(totalToolCalls + " tools", topTools));
  }

  // Duration chip.
  if (td.duration_ms > 0) {
    const durationSec = Math.round(td.duration_ms / 100) / 10;
    const durationLabel = durationSec < 60 ? durationSec + "s" : formatDuration(Math.round(durationSec));
    parts.push(chip(durationLabel, "Wall-clock turn duration"));
  }

  return parts.join("");
}

// Legacy qwen-shape chips (skills, subagents) — populated only when the
// turn-record endpoint returns data (qwen writes it; opencode doesn't yet).
function formatLegacyChips(turn, subagents) {
  if (!turn) return "";
  const skillsList = Array.isArray(turn.skills_invoked) ? turn.skills_invoked : [];
  const subList = Array.isArray(subagents) ? subagents : [];
  const parts = [];
  if (skillsList.length > 0) {
    parts.push(chip(skillsList.length + " skills", skillsList.join(", ")));
  }
  if (subList.length > 0) {
    const subsTitle = subList.map(function(s) { return s.subagent_name + " · " + Math.round(s.duration_ms / 100) / 10 + "s"; }).join("\n");
    parts.push(chip(subList.length + " subagents", subsTitle));
  }
  return parts.join("");
}

messagesEl.addEventListener("click", function(e) {
  const toggle = e.target.closest && e.target.closest(".chat-bubble-toggle");
  if (!toggle) return;
  e.stopPropagation();
  const bubble = toggle.closest("[data-msg-index]");
  if (!bubble) return;
  const turnId = toggle.getAttribute("data-turn-id");
  if (!turnId) return;
  let footer = bubble.querySelector(".chat-turn-footer");
  if (footer) {
    const isHidden = footer.style.display === "none";
    footer.style.display = isHidden ? "flex" : "none";
    toggle.style.transform = isHidden ? "rotate(90deg)" : "rotate(0deg)";
    return;
  }
  // Build the footer immediately from in-memory token data — no server
  // round-trip needed for the common case. Optional best-effort fetch of
  // the legacy /api/agent/turn-record endpoint enriches the strip with
  // skills/subagents chips when available (qwen path; opencode 404s and
  // we silently skip).
  toggle.textContent = "▸";
  toggle.style.transform = "rotate(90deg)";
  footer = window.document.createElement("div");
  footer.className = "chat-turn-footer";
  footer.style.cssText = "display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px;padding-top:6px;border-top:1px solid rgba(48,54,61,0.5);font-size:11px;color:#8b949e;";
  const td = turnDataByTurnId.get(turnId);
  const tokenChips = formatTokenChips(td);
  const snapHref = "/api/agent/turn-snapshot/" + encodeURIComponent(mica.cardId) + "/" + encodeURIComponent(turnId)
    + "?project=" + encodeURIComponent(mica.project || "");
  footer.innerHTML = tokenChips +
    '<a class="chat-turn-snapshot-link" href="' + snapHref + '" target="_blank" rel="noopener" ' +
    'style="color:#7c3aed;text-decoration:none;font-size:11px;margin-left:auto;" ' +
    'title="Open the captured rendered system prompt for this turn">view snapshot →</a>';
  bubble.appendChild(footer);

  // Best-effort enrichment from the legacy metrics endpoint. Silently skip
  // on 404 (the opencode-handler doesn't write recordTurn today).
  fetch("/api/agent/turn-record/" + encodeURIComponent(mica.cardId) + "/" + encodeURIComponent(turnId), {
    headers: projectHeaders(),
  }).then(function(r) {
    if (!r.ok) return null;
    return r.json();
  }).then(function(extra) {
    if (!extra || !footer) return;
    const legacyChips = formatLegacyChips(extra.turn || {}, extra.subagents || []);
    if (legacyChips) {
      // Prepend so skills/subagents appear before the token chips.
      const tmp = window.document.createElement("div");
      tmp.innerHTML = legacyChips;
      while (tmp.firstChild) footer.insertBefore(tmp.firstChild, footer.firstChild);
    }
  }).catch(function() { /* enrichment is optional */ });
});

function setStatus(text, dot, pulsing) {
  statusBar.style.display = "block";
  statusDot.style.background = dot;
  statusDot.style.animation = pulsing ? "chatpulse 1.2s ease-in-out infinite" : "none";
  statusLabel.textContent = text;
}

// Mirrors chat card's formatDuration. Switches from "Ns" to "M:SS" when the
// turn passes 60s and to "H:MM:SS" past an hour. Long opencode turns on
// local Qwen routinely cross both thresholds.
function formatDuration(s) {
  if (s < 60) return s + "s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => (n < 10 ? "0" + n : String(n));
  return h > 0
    ? h + ":" + pad(m) + ":" + pad(sec)
    : m + ":" + pad(sec);
}

function updateMeta() {
  const parts = [];
  if (elapsedSec > 0) parts.push(formatDuration(elapsedSec));
  if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? " step" : " steps"));
  statusMeta.textContent = parts.join(" . ");
}

// Two-note chime played when a turn finishes (success or error). One
// AudioContext per card, lazily created. resume() flips a suspended ctx to
// running once a user gesture has occurred.
let _audioCtx = null;
function playChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!_audioCtx) _audioCtx = new Ctx();
    const ac = _audioCtx;
    const fire = function() {
      const now = ac.currentTime;
      [880, 1320].forEach(function(freq, i) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        const t0 = now + i * 0.08;
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.06, t0 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
        osc.connect(gain).connect(ac.destination);
        osc.start(t0);
        osc.stop(t0 + 0.5);
      });
    };
    if (ac.state === "suspended") {
      ac.resume().then(fire).catch(function() {});
    } else {
      fire();
    }
  } catch (_) { /* audio unavailable */ }
}

// B (future) — fuel gauge with capacity trajectory. See chat card for the
// full design rationale. Pushes (peak, baseline) into rolling buffers,
// redraws fill from peak with a marker at baseline.
function updateFuelGauge(peakTokens, baselineTokens, contextWindow) {
  if (typeof peakTokens === "number" && peakTokens > 0) {
    recentBaselines.push(peakTokens);
    while (recentBaselines.length > FUEL_HISTORY_CAP) recentBaselines.shift();
  }
  if (typeof baselineTokens === "number" && baselineTokens > 0) {
    recentBaselinesActual.push(baselineTokens);
    while (recentBaselinesActual.length > FUEL_HISTORY_CAP) recentBaselinesActual.shift();
  }
  if (typeof contextWindow === "number" && contextWindow > 0) lastContextWindow = contextWindow;
  renderFuelGauge();
}

function renderFuelGauge() {
  if (!fuelEl || !fuelFill) return;
  const cw = lastContextWindow;
  const latest = recentBaselines.length > 0 ? recentBaselines[recentBaselines.length - 1] : 0;
  if (!latest || !cw || cw <= 0) { fuelEl.style.display = "none"; return; }
  fuelEl.style.display = "inline-flex";
  const pct = Math.max(0, Math.min(100, Math.round((latest / cw) * 100)));
  fuelFill.style.width = pct + "%";
  let color = "#4ade80";
  if (pct >= 80) color = "#f87171";
  else if (pct >= 50) color = "#fbbf24";
  fuelFill.style.background = color;
  // Baseline marker — vertical line at baseline%, hidden when no baseline
  // is available (hydration path with peak-only history).
  const latestBaseline = recentBaselinesActual.length > 0
    ? recentBaselinesActual[recentBaselinesActual.length - 1]
    : 0;
  let baselinePct = 0;
  if (fuelBaselineMarker) {
    if (latestBaseline > 0) {
      baselinePct = Math.max(0, Math.min(100, Math.round((latestBaseline / cw) * 100)));
      fuelBaselineMarker.style.left = baselinePct + "%";
      fuelBaselineMarker.style.opacity = "1";
    } else {
      fuelBaselineMarker.style.opacity = "0";
    }
  }
  let headroomText = "";
  let headroomTitle = "";
  if (recentBaselines.length >= 2) {
    const oldest = recentBaselines[0];
    const delta = (latest - oldest) / (recentBaselines.length - 1);
    if (delta > 0) {
      const turnsToCap = Math.max(0, Math.floor((cw - latest) / delta));
      headroomText = "~" + turnsToCap + " turns";
      headroomTitle = "~" + turnsToCap + " turns to cap";
    } else {
      headroomText = "—";
      headroomTitle = "headroom stable";
    }
  } else {
    headroomText = "—";
    headroomTitle = "tracking…";
  }
  fuelHeadroomLabel.textContent = formatK(latest) + "/" + formatK(cw) + " · " + headroomText;
  fuelHeadroomLabel.style.color = color;
  const peakList = recentBaselines.map(formatK).join(", ");
  let title = "Peak: " + formatK(latest) + " / " + formatK(cw) + " (" + pct + "%)\n";
  if (latestBaseline > 0) {
    title += "Baseline: " + formatK(latestBaseline) + " (" + baselinePct + "%)\n";
  }
  title += "Recent peaks: " + peakList + "\n" + headroomTitle;
  fuelEl.title = title;
}

function hydrateFuelGauge() {
  fetch("/api/agent/turn-history/" + encodeURIComponent(mica.cardId) + "?limit=" + FUEL_HISTORY_CAP, {
    headers: projectHeaders(),
  }).then(function(r) { return r.json(); }).then(function(items) {
    if (!Array.isArray(items) || items.length === 0) return;
    items.reverse();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const peak = (typeof it.input_tokens === "number" && it.input_tokens > 0)
        ? it.input_tokens
        : (typeof it.baseline_tokens === "number" ? it.baseline_tokens : 0);
      if (peak > 0) recentBaselines.push(peak);
      if (typeof it.context_window === "number" && it.context_window > 0) {
        lastContextWindow = it.context_window;
      }
    }
    while (recentBaselines.length > FUEL_HISTORY_CAP) recentBaselines.shift();
    renderFuelGauge();
  }).catch(function() { /* swallow */ });
}

function addContextSuggestion(text, opts) {
  opts = opts || {};
  const wrap = window.document.createElement("div");
  wrap.className = "chat-suggestion";
  wrap.style.cssText =
    "align-self:stretch;background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.35);" +
    "border-radius:8px;padding:10px 12px;font-size:12px;color:#cdd6f4;";
  const msg = window.document.createElement("div");
  msg.style.cssText = "margin-bottom:8px;line-height:1.4;";
  msg.textContent = text;
  wrap.appendChild(msg);
  const row = window.document.createElement("div");
  row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
  const mkBtn = function(label, primary, onClick) {
    const b = window.document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "background:" + (primary ? "#7c3aed" : "transparent") + ";color:#fff;" +
      "border:1px solid " + (primary ? "#7c3aed" : "#30363d") + ";" +
      "border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;";
    b.addEventListener("click", function() {
      const siblings = row.querySelectorAll("button");
      for (let i = 0; i < siblings.length; i++) {
        siblings[i].disabled = true;
        siblings[i].style.opacity = "0.4";
        siblings[i].style.cursor = "default";
      }
      onClick();
    });
    return b;
  };
  row.appendChild(mkBtn("Clear this card", true, function() { clearCard({ fromSuggestion: true }); }));
  row.appendChild(mkBtn("Spawn new card", false, function() { spawnSiblingCard(); }));
  if (!opts.forceChoice) {
    row.appendChild(mkBtn("Keep going", false, function() { /* dismissed */ }));
  }
  wrap.appendChild(row);
  messagesEl.appendChild(wrap);
  scrollBottom();
}

// Handle channel data from server
ch.onData(function(data) {
  switch (data.type) {
    case "history":
      messagesEl.innerHTML = "";
      contextCursor = typeof data.cursor === "number" ? data.cursor : 0;
      messageIndex = 0;
      turnDataByTurnId.clear();
      if (data.messages && data.messages.length > 0) {
        for (let i = 0; i < data.messages.length; i++) {
          const m = data.messages[i];
          // Hydrate the chevron-footer cache from persisted tokens so
          // expanding a past bubble doesn't require a server fetch.
          if (m.turn_id && m.tokens) turnDataByTurnId.set(m.turn_id, m.tokens);
          addMessage(m.role, m.content, m.agent, undefined, m.turn_id);
        }
      } else {
        messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start OpenCode.</div>';
      }
      setStatus("Ready", "#3fb950", false);
      break;
    case "user":
      addMessage("user", data.content);
      break;
    case "user_question": {
      // Mid-turn structured question from the agent. Broadcast immediately
      // by server when ask_user_question is intercepted so it surfaces even
      // if the agent misinterprets the deny message and keeps running. The
      // chip widget renders each question's text as a header above its row
      // of options, so we don't pre-format the question text into the
      // markdown content (would duplicate).
      const qs = data.questions || [];
      addMessage("assistant", "", "OpenCode", qs);
      break;
    }
    case "thinking":
      setBusy(true);
      // One queued message just started processing; decrement.
      if (queuedCount > 0) queuedCount--;
      updateSendButton();
      // Keep send button visible/clickable so user can queue more.
      stopBtn.style.display = "";
      stepCount = 0;
      elapsedSec = 0;
      statusDetail.innerHTML = "";
      addDetailLine("Starting...");
      setStatus("Thinking...", ACCENT, true);
      elapsedTimer = setInterval(function() { elapsedSec++; updateMeta(); }, 1000);
      break;
    case "progress":
      if (data.description) {
        stepCount++;
        setStatus(data.description, ACCENT, true);
        updateMeta();
        addDetailLine(`[${stepCount}] ${data.description}`);
      }
      break;
    case "assistant":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      // Advance cursor locally and re-render cursor-dependent display
      // (greyed pre-cursor messages + horizon separator) so a mid-session
      // advance is visible immediately, not delayed to the next message.
      {
        const prevCursor = contextCursor;
        if (typeof data.cursor === "number") contextCursor = data.cursor;
        if (contextCursor !== prevCursor) applyCursorDisplay();
      }
      // Prefer the turn's PEAK input tokens over turn-start baseline for
      // the fill — peak tells you whether the turn brushed the ceiling.
      // Baseline goes alongside as the marker on the track.
      updateFuelGauge(
        data.inputTokens || data.baselineTokens || 0,
        data.baselineTokens || 0,
        data.contextWindow || 0,
      );
      lastCapacity = typeof data.capacity === "number" ? data.capacity : 0;
      const doneMsg = data.filesChanged ? "Canvas updated" : "Done";
      const elapsedLabel = formatDuration(elapsedSec);
      setStatus(`${doneMsg} (${elapsedLabel}, ${stepCount} steps)`, "#3fb950", false);
      addDetailLine(`Completed in ${elapsedLabel} with ${stepCount} steps`);
      // Cache token + tool data for chevron-footer hover. Server sends
      // `tokens: { input, output, peak, reasoning, cache_read, cache_write,
      // ctx, duration_ms, tool_calls, files_changed }` on the assistant event.
      if (data.turn_id && data.tokens) turnDataByTurnId.set(data.turn_id, data.tokens);
      addMessage("assistant", data.content, data.agent || "OpenCode", undefined, data.turn_id);
      if (data.arcComplete && lastCapacity >= 0.80) {
        addContextSuggestion(
          "Arc complete. This conversation is at " + Math.round(lastCapacity * 100) +
          "% of the context window. Clearing or spawning a new card keeps the agent sharp.",
          { forceChoice: false }
        );
      } else if (!data.arcComplete && lastCapacity >= 0.95) {
        addContextSuggestion(
          "Context is almost full (" + Math.round(lastCapacity * 100) +
          "% of the window). Clear this card or spawn a new one before continuing.",
          { forceChoice: true }
        );
      }
      break;
    case "error":
      setBusy(false);
      stopBtn.style.display = "none";
      if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
      setStatus("Error", "#f87171", false);
      addDetailLine("ERROR: " + (data.error || "Unknown"));
      addMessage("assistant", "Error: " + (data.error || "Unknown"), "System");
      // retry:true marks a recoverable config failure (the health-gated
      // initialize scan was skipped because the model endpoint was
      // unreachable). Offer a Retry button that re-probes after the user fixes
      // settings in the ⚙️ gear; the server (retry_init) fires the pending
      // scan if the endpoint is now healthy.
      if (data.retry) {
        const retryWrap = window.document.createElement("div");
        retryWrap.style.cssText = "align-self:flex-start;margin:2px 0 6px;";
        const retryBtn = window.document.createElement("button");
        retryBtn.textContent = "Retry";
        retryBtn.style.cssText = "color:#e6edf3;background:rgba(124,58,237,0.25);border:1px solid rgba(124,58,237,0.5);border-radius:6px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;";
        retryBtn.addEventListener("click", function() {
          retryBtn.disabled = true;
          retryBtn.textContent = "Retrying…";
          ch.send({ type: "retry_init" });
        });
        retryWrap.appendChild(retryBtn);
        messagesEl.appendChild(retryWrap);
        scrollBottom();
      }
      break;
  }
});

ch.onClose(function() {});

// Pending screenshot attachment — set when the user picks a canvas file via
// the 📷 picker, cleared on send or on 'x'. When set, the send() below
// includes `attachmentFilename` in the outgoing message; server captures the
// card and inlines it as a FilePartInput in the opencode prompt.
let pendingAttachment = null;

function updateAttachChip() {
  if (pendingAttachment) {
    attachFilenameEl.textContent = pendingAttachment;
    attachRow.style.display = "flex";
  } else {
    attachRow.style.display = "none";
  }
}

function clearAttachment() {
  pendingAttachment = null;
  updateAttachChip();
}

attachClearBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  clearAttachment();
});

function hidePicker() { attachPicker.style.display = "none"; }

function openPicker() {
  attachOptionsEl.innerHTML = '<div style="color:#6e7681;font-size:11px;padding:6px 8px;">Loading&hellip;</div>';
  attachPicker.style.display = "block";
  fetch("/api/files?canvas=true", { headers: projectHeaders() })
    .then(function(r) { return r.json(); })
    .then(function(files) {
      const candidates = (files || []).filter(function(f) { return !f.meta && f.name !== mica.filename; });
      if (candidates.length === 0) {
        attachOptionsEl.innerHTML = '<div style="color:#6e7681;font-size:11px;padding:6px 8px;">No other cards on canvas.</div>';
        return;
      }
      attachOptionsEl.innerHTML = "";
      candidates.forEach(function(f) {
        const opt = window.document.createElement("div");
        opt.textContent = f.name;
        opt.style.cssText = "padding:6px 8px;color:#e6edf3;font-size:12px;cursor:pointer;border-radius:3px;";
        opt.addEventListener("mouseenter", function() { opt.style.background = "rgba(124,58,237,0.15)"; });
        opt.addEventListener("mouseleave", function() { opt.style.background = "transparent"; });
        opt.addEventListener("click", function() {
          pendingAttachment = f.name;
          updateAttachChip();
          hidePicker();
          inputEl.focus();
        });
        attachOptionsEl.appendChild(opt);
      });
    })
    .catch(function(err) {
      attachOptionsEl.innerHTML = '<div style="color:#f87171;font-size:11px;padding:6px 8px;">Failed to load files: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</div>';
    });
}

attachBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  if (attachPicker.style.display === "block") hidePicker(); else openPicker();
});

window.document.addEventListener("click", function(e) {
  if (attachPicker.style.display !== "block") return;
  if (attachPicker.contains(e.target) || attachBtn.contains(e.target)) return;
  hidePicker();
});

function send() {
  const text = inputEl.value.trim();
  if (!text && !pendingAttachment) return;
  inputEl.value = "";
  // Server queues if busy — let the user keep typing while the agent works.
  if (busy) {
    queuedCount++;
    addDetailLine(`Queued: ${text.slice(0, 80)}${text.length > 80 ? '...' : ''}`);
  }
  const payload = { message: text || "(no prompt)" };
  if (pendingAttachment) {
    payload.attachmentFilename = pendingAttachment;
    clearAttachment();
  }
  ch.send(payload);
  if (!busy) setBusy(true);
  updateSendButton();
}

function updateSendButton() {
  sendBtn.textContent = queuedCount > 0 ? `Send (${queuedCount} queued)` : "Send";
}

sendBtn.addEventListener("click", send);

stopBtn.addEventListener("click", function() {
  ch.send({ type: "interrupt" });
  setBusy(false);
  stopBtn.style.display = "none";
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  setStatus("Stopped", "#fbbf24", false);
});

inputEl.addEventListener("keydown", function(e) {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});

// ── Clear / Spawn / Archive browser ────────────────────────

function clearCard(opts) {
  opts = opts || {};
  if (!opts.fromSuggestion) {
    const ok = window.confirm(
      "Archive this card's conversation and start fresh? The previous messages " +
      "will still be browsable from the clock icon."
    );
    if (!ok) return;
  }
  fetch("/api/chats/" + encodeURIComponent(mica.cardId) + "/clear", {
    method: "POST",
    headers: projectHeaders({ "Content-Type": "application/json" }),
  }).then(function(r) { return r.json(); }).then(function() {
    messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared. Send a message to start a new one.</div>';
    contextCursor = 0;
    messageIndex = 0;
    if (fuelEl) fuelEl.style.display = "none";
    recentBaselines.length = 0;
    recentBaselinesActual.length = 0;
    lastCapacity = 0;
  }).catch(function(err) { console.error("[opencode] clear failed:", err); });
}

function spawnSiblingCard() {
  const match = (mica.filename || "").match(/\.([^./]+)$/);
  const ext = match ? match[1] : "opencode";
  const base = (mica.filename || "").replace(/\.[^./]+$/, "").replace(/[^a-zA-Z0-9_-]/g, "-");
  const prompt = window.prompt(
    "Name for the new " + ext + " card (without ." + ext + " extension):",
    base ? (base + "-next") : "new-" + ext
  );
  if (!prompt) return;
  const name = prompt.trim().replace(new RegExp("\\." + ext + "$", "i"), "");
  if (!name) return;
  const parts = mica.filename.split("/");
  parts.pop();
  const dir = parts.join("/");
  const target = (dir ? dir + "/" : "") + name + "." + ext;
  mica.files.write(target, "").catch(function(err) {
    window.alert("Could not create " + target + ": " + (err && err.message ? err.message : "unknown"));
  });
}

function loadArchiveList() {
  archiveListEl.innerHTML = "Loading...";
  fetch("/api/chats/" + encodeURIComponent(mica.cardId) + "/archived", {
    headers: projectHeaders(),
  }).then(function(r) { return r.json(); }).then(function(data) {
    const entries = data.entries || [];
    if (entries.length === 0) {
      archiveListEl.innerHTML = '<div style="color:#6e7681;font-style:italic;">No previous conversations.</div>';
      return;
    }
    archiveListEl.innerHTML = "";
    entries.forEach(function(e) {
      const row = window.document.createElement("div");
      row.style.cssText = "padding:6px 8px;border-radius:4px;cursor:pointer;display:flex;justify-content:space-between;gap:8px;";
      row.addEventListener("mouseenter", function() { row.style.background = "rgba(255,255,255,0.05)"; });
      row.addEventListener("mouseleave", function() { row.style.background = ""; });
      const when = new Date(e.archivedAt);
      const left = window.document.createElement("span");
      left.textContent = when.toLocaleString();
      const right = window.document.createElement("span");
      right.style.cssText = "color:#6e7681;font-size:10px;";
      right.textContent = e.messageCount + (e.messageCount === 1 ? " msg" : " msgs");
      row.appendChild(left);
      row.appendChild(right);
      row.addEventListener("click", function() { openArchiveViewer(e.filename); });
      archiveListEl.appendChild(row);
    });
  }).catch(function(err) {
    archiveListEl.innerHTML = '<div style="color:#f87171;">Failed to load: ' + escapeHtml(err.message || "") + '</div>';
  });
}

function openArchiveViewer(archiveName) {
  fetch(
    "/api/chats/" + encodeURIComponent(mica.cardId) + "/archived/" + encodeURIComponent(archiveName),
    { headers: projectHeaders() }
  ).then(function(r) { return r.json(); }).then(function(data) {
    const modal = window.document.createElement("div");
    modal.style.cssText = "position:absolute;inset:0;background:rgba(13,17,23,0.96);backdrop-filter:blur(2px);z-index:25;display:flex;flex-direction:column;padding:12px 16px;font-size:12px;color:#e6edf3;";
    const header = window.document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
    const title = window.document.createElement("div");
    title.style.cssText = "font-weight:600;";
    title.textContent = "Archived: " + archiveName.replace(/\.json$/, "");
    const closeBtn = window.document.createElement("span");
    closeBtn.style.cssText = "cursor:pointer;color:#8b949e;font-size:18px;padding:0 4px;";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", function() { modal.remove(); });
    header.appendChild(title);
    header.appendChild(closeBtn);
    modal.appendChild(header);
    const scroller = window.document.createElement("div");
    scroller.style.cssText = "flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:8px;";
    const msgs = data.messages || [];
    if (msgs.length === 0) {
      const empty = window.document.createElement("div");
      empty.style.cssText = "color:#6e7681;font-style:italic;text-align:center;padding:24px 0;";
      empty.textContent = "(empty)";
      scroller.appendChild(empty);
    } else {
      msgs.forEach(function(m) {
        const bubble = window.document.createElement("div");
        const isUser = m.role === "user";
        bubble.style.cssText = isUser
          ? "align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;"
          : "align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;";
        if (isUser) {
          bubble.innerHTML = '<div style="color:#e6edf3;line-height:1.5;">' + escapeHtml(m.content || "") + '</div>';
        } else {
          const agentHdr = m.agent
            ? '<div style="color:' + ACCENT + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(m.agent) + '</div>'
            : "";
          bubble.innerHTML = agentHdr + '<div class="chat-md" style="color:#e6edf3;line-height:1.5;">' + renderMarkdown(m.content || "") + '</div>';
        }
        scroller.appendChild(bubble);
      });
    }
    modal.appendChild(scroller);
    container.appendChild(modal);
  }).catch(function(err) { console.error("[opencode] archive viewer failed:", err); });
}

clearBtn.addEventListener("click", function() { clearCard(); });
spawnBtn.addEventListener("click", function() { spawnSiblingCard(); });

let archiveOpen = false;
archiveBtn.addEventListener("click", function(e) {
  e.stopPropagation();
  archiveOpen = !archiveOpen;
  archivePanel.style.display = archiveOpen ? "block" : "none";
  if (archiveOpen) loadArchiveList();
});
window.addEventListener("click", function(e) {
  if (!archiveOpen) return;
  if (archivePanel.contains(e.target) || archiveBtn.contains(e.target)) return;
  archiveOpen = false;
  archivePanel.style.display = "none";
});

const _unsubChatCleared = mica.on("chat-cleared", function(ev) {
  if (!ev || ev.chatId !== mica.cardId) return;
  messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Conversation cleared.</div>';
  contextCursor = 0;
  messageIndex = 0;
  if (fuelEl) fuelEl.style.display = "none";
  recentBaselines.length = 0;
  recentBaselinesActual.length = 0;
  lastCapacity = 0;
});
mica.onDestroy(_unsubChatCleared);

mica.onDestroy(function() {
  ch.close();
  if (elapsedTimer) clearInterval(elapsedTimer);
});
