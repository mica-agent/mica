/**
 * Agent card class — subagent card with provider selection,
 * plan display, and bidirectional channel for task execution.
 *
 * Note: The `run_session` @mica.channel handler is managed Node-side
 * by AgentChannelManager, not by this card class. This file only handles
 * render + select_provider export.
 */

export const metadata = { extension: ".agent", badge: "AGENT", primaryFile: "task-state.json", defaultTitle: "Agent" };

const STATUS_MAP = {
  setup:       { color: "#6b7280", label: "\u25cf Setup" },
  idle:        { color: "#6b7280", label: "\u25cf Idle" },
  in_progress: { color: "#4ade80", label: "\u25cf In Progress" },
  blocked:     { color: "#f87171", label: "\u26a0 Blocked" },
  done:        { color: "#60a5fa", label: "\u2714 Done" },
  error:       { color: "#ef4444", label: "\u2717 Error" },
};

function parseState(content) {
  try {
    let body = content.trim();
    if (body.startsWith("---")) {
      const end = body.indexOf("---", 3);
      if (end !== -1) body = body.slice(end + 3).trim();
    }
    if (body) return JSON.parse(body);
  } catch {}
  return { provider: null, status: "setup", phase: "Choose an agent", plan: [], current_action: null, blocker: null, last_updated: null };
}

function stepsHtml(plan) {
  if (!plan || plan.length === 0) {
    return '<div style="color:#374151;font-size:12px;padding:6px 0;">Describe a task and click Run.</div>';
  }
  return plan.map(item => {
    const s = item.status || "pending";
    let icon, txt;
    if (s === "done") {
      icon = '<span style="color:#4ade80;font-size:11px;min-width:14px;margin-top:1px;">\u2713</span>';
      txt = `<span style="font-size:12px;line-height:1.4;color:#6b7280;text-decoration:line-through;">${item.step}</span>`;
    } else if (s === "active") {
      icon = '<span style="color:#facc15;font-size:11px;min-width:14px;margin-top:1px;">\u25b6</span>';
      txt = `<span style="font-size:12px;line-height:1.4;color:#f9fafb;font-weight:600;">${item.step}</span>`;
    } else {
      icon = '<span style="color:#374151;font-size:11px;min-width:14px;margin-top:1px;">\u25cb</span>';
      txt = `<span style="font-size:12px;line-height:1.4;color:#4b5563;">${item.step}</span>`;
    }
    return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1f2937;align-items:flex-start;">${icon}${txt}</div>`;
  }).join("");
}

function actionHtml(currentAction, blocker, status) {
  if (status === "blocked" && blocker) {
    return `<div style="margin-top:6px;padding:8px;background:#1f2937;border-radius:6px;border-left:3px solid #f87171;">
  <div style="font-size:10px;color:#f87171;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">\u26a0 Needs Your Input</div>
  <div style="font-size:11px;color:#e5e7eb;margin-bottom:6px;">${blocker}</div>
  <div style="display:flex;gap:6px;">
    <input id="blocker-input" type="text" placeholder="Your response..." style="flex:1;background:#111827;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:3px 7px;font-size:11px;outline:none;">
    <button id="blocker-send" style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;">Send</button>
  </div>
</div>`;
  }
  if (currentAction) {
    return `<div style="margin-top:6px;padding:6px 8px;background:#1f2937;border-radius:6px;border-left:3px solid #facc15;font-size:11px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${currentAction}</div>`;
  }
  return "";
}

function providerPickerHtml(providers) {
  return Object.entries(providers).map(([pid, pinfo]) => {
    const name = pinfo.name || pid;
    const icon = pinfo.icon || "\u25cf";
    const desc = pinfo.description || "";
    return `<button class="provider-btn" data-provider="${pid}"
      style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;
             background:#1f2937;border:1px solid #374151;border-radius:6px;
             color:#f9fafb;cursor:pointer;text-align:left;font-size:12px;
             transition:border-color .2s;">
      <span style="font-size:16px;">${icon}</span>
      <div>
        <div style="font-weight:600;">${name}</div>
        <div style="font-size:10px;color:#6b7280;margin-top:2px;">${desc}</div>
      </div>
    </button>`;
  }).join("\n");
}

export default function render(content, config) {
  const data = parseState(content);
  const provider = data.provider;
  const status = data.status || "setup";
  const phase = data.phase || "Ready";
  const plan = data.plan || [];
  const action = data.current_action || "";
  const blocker = data.blocker || "";

  const providers = typeof __providers !== "undefined" ? __providers : {};
  const providerName = (providers[provider] || {}).name || provider || "Agent";

  const st = STATUS_MAP[status] || STATUS_MAP.idle;

  // Provider picker (no provider selected yet)
  if (!provider || status === "setup") {
    const picker = providerPickerHtml(providers);
    return `
<div style="font-family:'Inter',system-ui,sans-serif;background:#111827;border-radius:8px;padding:14px;color:#f9fafb;height:260px;box-sizing:border-box;display:flex;flex-direction:column;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0;">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">Choose Agent</span>
    <span style="font-size:10px;font-weight:600;color:${st.color};">${st.label}</span>
  </div>
  <div style="flex:1;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:8px;">
    ${picker}
  </div>
</div>
<script>
(function() {
  container.querySelectorAll('.provider-btn').forEach(btn => {
    btn.addEventListener('mouseover', () => { btn.style.borderColor = '#4ade80'; });
    btn.addEventListener('mouseout', () => { btn.style.borderColor = '#374151'; });
    btn.addEventListener('click', async () => {
      await mica.call('select_provider', { provider: btn.dataset.provider });
    });
  });
})();
</script>`;
  }

  // Active agent card
  return `
<div style="font-family:'Inter',system-ui,sans-serif;background:#111827;border-radius:8px;padding:14px;color:#f9fafb;height:260px;box-sizing:border-box;display:flex;flex-direction:column;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">${providerName}</span>
    <div style="display:flex;align-items:center;gap:8px;">
      <button id="debug-toggle" style="font-size:9px;color:#4b5563;background:none;border:1px solid #374151;border-radius:3px;padding:1px 6px;cursor:pointer;">Debug</button>
      <span id="cc-status" style="font-size:10px;font-weight:600;color:${st.color};">${st.label}</span>
    </div>
  </div>
  <div id="cc-phase" style="font-size:12px;font-weight:600;color:#9ca3af;margin-bottom:8px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${phase}</div>
  <div id="cc-steps" style="flex:1;overflow-y:auto;min-height:0;">${stepsHtml(plan)}</div>
  <div id="cc-debug" style="display:none;flex:1;min-height:0;margin-bottom:4px;flex-direction:column;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span style="font-size:9px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;">Debug Log</span>
      <button id="debug-clear" style="font-size:9px;color:#4b5563;background:none;border:none;cursor:pointer;">Clear</button>
    </div>
    <div id="debug-log" style="flex:1;overflow-y:auto;background:#0d1117;border:1px solid #1f2937;border-radius:4px;padding:6px;font-family:'Fira Code','Cascadia Code',monospace;font-size:10px;line-height:1.5;color:#8b949e;white-space:pre-wrap;word-break:break-all;"></div>
  </div>
  <div id="cc-action" style="flex-shrink:0;">${actionHtml(action, blocker, status)}</div>
  <div id="cc-bottom" style="flex-shrink:0;margin-top:6px;">
    <div style="display:flex;gap:6px;">
      <input id="task-input" type="text" placeholder="Describe what to implement..."
        style="flex:1;background:#1f2937;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:5px 8px;font-size:12px;outline:none;">
      <button id="run-btn"
        style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;">Run</button>
    </div>
  </div>
</div>

<script>
(function() {
  let activeChannel = null;
  let spinnerTimer = null;
  const frames = ['\u280b','\u2819','\u2839','\u2838','\u283c','\u2834','\u2826','\u2827','\u2807','\u280f'];
  let fi = 0;

  const STATUS = {
    idle:        { color:'#6b7280', label:'\u25cf Idle' },
    in_progress: { color:'#4ade80', label:'\u25cf In Progress' },
    blocked:     { color:'#f87171', label:'\u26a0 Blocked' },
    done:        { color:'#60a5fa', label:'\u2714 Done' },
    error:       { color:'#ef4444', label:'\u2717 Error' },
  };

  function setStatus(s) {
    const el = container.querySelector('#cc-status');
    if (!el) return;
    const st = STATUS[s] || STATUS.idle;
    el.style.color = st.color;
    el.textContent = st.label;
  }

  function setPhase(text) {
    const el = container.querySelector('#cc-phase');
    if (el) el.textContent = text;
  }

  function startSpinner(label) {
    stopSpinner();
    const bottom = container.querySelector('#cc-bottom');
    if (bottom) bottom.innerHTML =
      '<div style="font-size:11px;color:#4b5563;margin-top:4px;text-align:center;">' + (label || 'Running...') + ' <span id="spinner">\u280b</span></div>';
    spinnerTimer = setInterval(() => {
      const sp = container.querySelector('#spinner');
      if (sp) sp.textContent = frames[fi++ % frames.length];
    }, 100);
  }

  function stopSpinner() {
    if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
  }

  function stepIcon(s) {
    if (s === 'done')   return '<span style="color:#4ade80;font-size:11px;min-width:14px;margin-top:1px;">\u2713</span>';
    if (s === 'active') return '<span style="color:#facc15;font-size:11px;min-width:14px;margin-top:1px;">\u25b6</span>';
    return '<span style="color:#374151;font-size:11px;min-width:14px;margin-top:1px;">\u25cb</span>';
  }

  function stepText(t, s) {
    if (s === 'done')   return '<span style="font-size:12px;line-height:1.4;color:#6b7280;text-decoration:line-through;">' + t + '</span>';
    if (s === 'active') return '<span style="font-size:12px;line-height:1.4;color:#f9fafb;font-weight:600;">' + t + '</span>';
    return '<span style="font-size:12px;line-height:1.4;color:#4b5563;">' + t + '</span>';
  }

  function renderPlan(steps) {
    const el = container.querySelector('#cc-steps');
    if (!el || !steps || !steps.length) return;
    el.innerHTML = steps.map(item => {
      const s = item.status || 'pending';
      return '<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1f2937;align-items:flex-start;">' + stepIcon(s) + stepText(item.step, s) + '</div>';
    }).join('');
  }

  function showAction(text) {
    const el = container.querySelector('#cc-action');
    if (!el) return;
    el.innerHTML = text
      ? '<div style="margin-top:6px;padding:6px 8px;background:#1f2937;border-radius:6px;border-left:3px solid #facc15;font-size:11px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + text + '</div>'
      : '';
  }

  function showBlocker(question) {
    stopSpinner();
    setStatus('blocked');
    const action = container.querySelector('#cc-action');
    if (action) action.innerHTML = '<div style="margin-top:6px;padding:8px;background:#1f2937;border-radius:6px;border-left:3px solid #f87171;">' +
      '<div style="font-size:10px;color:#f87171;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">\u26a0 Needs Your Input</div>' +
      '<div style="font-size:11px;color:#e5e7eb;margin-bottom:6px;">' + question + '</div>' +
      '<div style="display:flex;gap:6px;">' +
      '<input id="blocker-input" type="text" placeholder="Your response..." style="flex:1;background:#111827;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:3px 7px;font-size:11px;outline:none;">' +
      '<button id="blocker-send" style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;">Send</button>' +
      '</div></div>';

    const bottom = container.querySelector('#cc-bottom');
    if (bottom) bottom.innerHTML = '';

    function sendResponse() {
      const inp = container.querySelector('#blocker-input');
      const btn = container.querySelector('#blocker-send');
      const resp = inp ? inp.value.trim() : '';
      if (resp && activeChannel) {
        activeChannel.send({ response: resp });
        if (btn) { btn.disabled = true; btn.textContent = 'Sent \u2713'; }
        if (inp) inp.disabled = true;
        startSpinner('Continuing...');
      }
    }

    const sendBtn = container.querySelector('#blocker-send');
    const inp = container.querySelector('#blocker-input');
    if (sendBtn) sendBtn.addEventListener('click', sendResponse);
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') sendResponse(); });
    if (inp) inp.focus();
  }

  function showStartArea() {
    const bottom = container.querySelector('#cc-bottom');
    if (!bottom) return;
    bottom.innerHTML = '<div style="display:flex;gap:6px;">' +
      '<input id="task-input" type="text" placeholder="Describe what to implement..." style="flex:1;background:#1f2937;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:5px 8px;font-size:12px;outline:none;">' +
      '<button id="run-btn" style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;">Run</button></div>';
    attachRunListener();
  }

  let debugVisible = false;

  function appendDebug(text) {
    const log = container.querySelector('#debug-log');
    if (!log) return;
    const line = document.createElement('div');
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const isStderr = text.startsWith('[stderr]');
    line.style.color = isStderr ? '#f87171' : '#8b949e';
    line.textContent = ts + ' ' + text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  function toggleDebug() {
    debugVisible = !debugVisible;
    const dbg = container.querySelector('#cc-debug');
    const steps = container.querySelector('#cc-steps');
    const btn = container.querySelector('#debug-toggle');
    if (dbg) dbg.style.display = debugVisible ? 'flex' : 'none';
    if (steps) steps.style.display = debugVisible ? 'none' : 'block';
    if (btn) {
      btn.style.color = debugVisible ? '#4ade80' : '#4b5563';
      btn.style.borderColor = debugVisible ? '#4ade80' : '#374151';
    }
  }

  // Wire up debug toggle + clear
  const debugBtn = container.querySelector('#debug-toggle');
  if (debugBtn) debugBtn.addEventListener('click', toggleDebug);
  const clearBtn = container.querySelector('#debug-clear');
  if (clearBtn) clearBtn.addEventListener('click', () => {
    const log = container.querySelector('#debug-log');
    if (log) log.innerHTML = '';
  });

  function handleMsg(msg) {
    switch (msg.type) {
      case 'status':      setStatus(msg.value);                    break;
      case 'phase':       setPhase(msg.text);                      break;
      case 'plan':        renderPlan(msg.steps);                   break;
      case 'action':      showAction(msg.text);                    break;
      case 'blocked':     showBlocker(msg.question);               break;
      case 'unblocked':   setStatus('in_progress'); showAction(''); startSpinner('Continuing...'); break;
      case 'debug':       appendDebug(msg.text);                   break;
      case 'done':
        stopSpinner(); activeChannel = null; setStatus('done'); showAction(''); showStartArea(); break;
      case 'error':
        appendDebug('[error] ' + (msg.message || 'Unknown error'));
        stopSpinner(); activeChannel = null; setStatus('error'); showAction(msg.message || 'An error occurred.'); showStartArea(); break;
    }
  }

  function startSession() {
    const taskInput = container.querySelector('#task-input');
    const task = taskInput ? taskInput.value.trim() : '';
    if (!task) return;

    startSpinner('Planning...');
    setStatus('in_progress');
    setPhase('Planning...');
    container.querySelector('#cc-steps').innerHTML =
      '<div style="color:#374151;font-size:12px;padding:6px 0;">Generating plan...</div>';

    const ch = mica.openChannel('run_session', { task, provider: '${data.provider || ""}' });
    activeChannel = ch;
    ch.onData(handleMsg);
    ch.onClose(() => { stopSpinner(); activeChannel = null; });
  }

  function attachRunListener() {
    const btn = container.querySelector('#run-btn');
    const inp = container.querySelector('#task-input');
    if (btn) btn.addEventListener('click', startSession);
    if (inp) inp.addEventListener('keydown', e => { if (e.key === 'Enter') startSession(); });
  }

  attachRunListener();

  mica.onDestroy(() => {
    stopSpinner();
    if (activeChannel) {
      activeChannel.close();
      activeChannel = null;
    }
  });
})();
</script>`;
}

export async function select_provider(content, args, mica) {
  const provider = args.provider || "";
  const providers = typeof __providers !== "undefined" ? __providers : {};
  if (!(provider in providers)) {
    return { error: `Unknown provider: ${provider}` };
  }

  const state = parseState(content);
  state.provider = provider;
  state.status = "idle";
  state.phase = "Ready";
  state.last_updated = new Date().toTimeString().slice(0, 8);
  await mica.write('task-state.json', JSON.stringify(state, null, 2));

  return { provider };
}
