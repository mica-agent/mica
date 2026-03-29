import mica
import json
import os
from datetime import datetime


# ─────────────────────────────────────────────
# State helpers
# ─────────────────────────────────────────────

def parse_state(content):
    try:
        body = content.strip()
        if body.startswith("---"):
            end = body.find("---", 3)
            if end != -1:
                body = body[end + 3:].strip()
        if body:
            return json.loads(body)
    except Exception:
        pass
    return default_state()


def default_state():
    return {
        "provider": None,
        "status": "setup",
        "phase": "Choose an agent",
        "plan": [],
        "current_action": None,
        "blocker": None,
        "last_updated": None,
    }


def save_state(state):
    state["last_updated"] = datetime.now().strftime("%H:%M:%S")
    mica.write(json.dumps(state, indent=2))


# ─────────────────────────────────────────────
# Load providers registry
# ─────────────────────────────────────────────

def _load_providers():
    try:
        providers_path = os.path.join(os.path.dirname(__file__), "providers.json")
        with open(providers_path) as f:
            return json.load(f)
    except Exception:
        return {}


# ─────────────────────────────────────────────
# HTML helpers
# ─────────────────────────────────────────────

STATUS_MAP = {
    "setup":       ("#6b7280", "● Setup"),
    "idle":        ("#6b7280", "● Idle"),
    "in_progress": ("#4ade80", "● In Progress"),
    "blocked":     ("#f87171", "⚠ Blocked"),
    "done":        ("#60a5fa", "✔ Done"),
    "error":       ("#ef4444", "✗ Error"),
}


def _steps_html(plan):
    if not plan:
        return '<div style="color:#374151;font-size:12px;padding:6px 0;">Describe a task and click Run.</div>'
    parts = []
    for item in plan:
        s = item.get("status", "pending")
        step = item.get("step", "")
        if s == "done":
            icon = '<span style="color:#4ade80;font-size:11px;min-width:14px;margin-top:1px;">✓</span>'
            txt = f'<span style="font-size:12px;line-height:1.4;color:#6b7280;text-decoration:line-through;">{step}</span>'
        elif s == "active":
            icon = '<span style="color:#facc15;font-size:11px;min-width:14px;margin-top:1px;">▶</span>'
            txt = f'<span style="font-size:12px;line-height:1.4;color:#f9fafb;font-weight:600;">{step}</span>'
        else:
            icon = '<span style="color:#374151;font-size:11px;min-width:14px;margin-top:1px;">○</span>'
            txt = f'<span style="font-size:12px;line-height:1.4;color:#4b5563;">{step}</span>'
        parts.append(f'<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1f2937;align-items:flex-start;">{icon}{txt}</div>')
    return "".join(parts)


def _action_html(current_action, blocker, status):
    if status == "blocked" and blocker:
        return f"""<div style="margin-top:6px;padding:8px;background:#1f2937;border-radius:6px;border-left:3px solid #f87171;">
  <div style="font-size:10px;color:#f87171;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">⚠ Needs Your Input</div>
  <div style="font-size:11px;color:#e5e7eb;margin-bottom:6px;">{blocker}</div>
  <div style="display:flex;gap:6px;">
    <input id="blocker-input" type="text" placeholder="Your response..." style="flex:1;background:#111827;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:3px 7px;font-size:11px;outline:none;">
    <button id="blocker-send" style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;">Send</button>
  </div>
</div>"""
    elif current_action:
        return f'<div style="margin-top:6px;padding:6px 8px;background:#1f2937;border-radius:6px;border-left:3px solid #facc15;font-size:11px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{current_action}</div>'
    return ""


def _provider_picker_html(providers):
    items = []
    for pid, pinfo in providers.items():
        name = pinfo.get("name", pid)
        icon = pinfo.get("icon", "●")
        desc = pinfo.get("description", "")
        items.append(f"""
        <button class="provider-btn" data-provider="{pid}"
          style="display:flex;align-items:center;gap:10px;width:100%;padding:10px 12px;
                 background:#1f2937;border:1px solid #374151;border-radius:6px;
                 color:#f9fafb;cursor:pointer;text-align:left;font-size:12px;
                 transition:border-color .2s;">
          <span style="font-size:16px;">{icon}</span>
          <div>
            <div style="font-weight:600;">{name}</div>
            <div style="font-size:10px;color:#6b7280;margin-top:2px;">{desc}</div>
          </div>
        </button>""")
    return "\n".join(items)


# ─────────────────────────────────────────────
# Render
# ─────────────────────────────────────────────

@mica.render
def render(content, config):
    data = parse_state(content)
    provider = data.get("provider")
    status = data.get("status", "setup")
    phase = data.get("phase", "Ready")
    plan = data.get("plan", [])
    action = data.get("current_action") or ""
    blocker = data.get("blocker") or ""

    providers = _load_providers()
    provider_name = providers.get(provider, {}).get("name", provider or "Agent")

    sc, sl = STATUS_MAP.get(status, ("#6b7280", "● Idle"))

    # ── Provider picker (no provider selected yet) ──
    if not provider or status == "setup":
        picker_html = _provider_picker_html(providers)
        return f"""
<div style="font-family:'Inter',system-ui,sans-serif;background:#111827;border-radius:8px;padding:14px;color:#f9fafb;height:260px;box-sizing:border-box;display:flex;flex-direction:column;">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-shrink:0;">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">Choose Agent</span>
    <span style="font-size:10px;font-weight:600;color:{sc};">{sl}</span>
  </div>
  <div style="flex:1;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:8px;">
    {picker_html}
  </div>
</div>

<script>
(function() {{
  container.querySelectorAll('.provider-btn').forEach(btn => {{
    btn.addEventListener('mouseover', () => {{ btn.style.borderColor = '#4ade80'; }});
    btn.addEventListener('mouseout', () => {{ btn.style.borderColor = '#374151'; }});
    btn.addEventListener('click', async () => {{
      const provider = btn.dataset.provider;
      await mica.call('select_provider', {{ provider }});
    }});
  }});
}})();
</script>
"""

    # ── Active agent card (provider selected) ──
    return f"""
<div style="font-family:'Inter',system-ui,sans-serif;background:#111827;border-radius:8px;padding:14px;color:#f9fafb;height:260px;box-sizing:border-box;display:flex;flex-direction:column;">

  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-shrink:0;">
    <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;">{provider_name}</span>
    <span id="cc-status" style="font-size:10px;font-weight:600;color:{sc};">{sl}</span>
  </div>

  <div id="cc-phase" style="font-size:12px;font-weight:600;color:#9ca3af;margin-bottom:8px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">{phase}</div>

  <div id="cc-steps" style="flex:1;overflow-y:auto;min-height:0;">{_steps_html(plan)}</div>

  <div id="cc-action" style="flex-shrink:0;">{_action_html(action, blocker, status)}</div>

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
(function() {{
  let activeChannel = null;
  let spinnerTimer  = null;
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let fi = 0;

  const STATUS = {{
    idle:        {{ color:'#6b7280', label:'● Idle' }},
    in_progress: {{ color:'#4ade80', label:'● In Progress' }},
    blocked:     {{ color:'#f87171', label:'⚠ Blocked' }},
    done:        {{ color:'#60a5fa', label:'✔ Done' }},
    error:       {{ color:'#ef4444', label:'✗ Error' }},
  }};

  function setStatus(s) {{
    const el = container.querySelector('#cc-status');
    if (!el) return;
    const st = STATUS[s] || STATUS.idle;
    el.style.color = st.color;
    el.textContent = st.label;
  }}

  function setPhase(text) {{
    const el = container.querySelector('#cc-phase');
    if (el) el.textContent = text;
  }}

  function startSpinner(label) {{
    stopSpinner();
    const bottom = container.querySelector('#cc-bottom');
    if (bottom) bottom.innerHTML =
      `<div style="font-size:11px;color:#4b5563;margin-top:4px;text-align:center;">${{label || 'Running...'}} <span id="spinner">⠋</span></div>`;
    spinnerTimer = setInterval(() => {{
      const sp = container.querySelector('#spinner');
      if (sp) sp.textContent = frames[fi++ % frames.length];
    }}, 100);
  }}

  function stopSpinner() {{
    if (spinnerTimer) {{ clearInterval(spinnerTimer); spinnerTimer = null; }}
  }}

  function stepIcon(s) {{
    if (s === 'done')   return `<span style="color:#4ade80;font-size:11px;min-width:14px;margin-top:1px;">✓</span>`;
    if (s === 'active') return `<span style="color:#facc15;font-size:11px;min-width:14px;margin-top:1px;">▶</span>`;
    return                     `<span style="color:#374151;font-size:11px;min-width:14px;margin-top:1px;">○</span>`;
  }}

  function stepText(t, s) {{
    if (s === 'done')   return `<span style="font-size:12px;line-height:1.4;color:#6b7280;text-decoration:line-through;">${{t}}</span>`;
    if (s === 'active') return `<span style="font-size:12px;line-height:1.4;color:#f9fafb;font-weight:600;">${{t}}</span>`;
    return                     `<span style="font-size:12px;line-height:1.4;color:#4b5563;">${{t}}</span>`;
  }}

  function renderPlan(steps) {{
    const el = container.querySelector('#cc-steps');
    if (!el || !steps || !steps.length) return;
    el.innerHTML = steps.map(item => {{
      const s = item.status || 'pending';
      return `<div style="display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1f2937;align-items:flex-start;">${{stepIcon(s)}}${{stepText(item.step, s)}}</div>`;
    }}).join('');
  }}

  function updateStep(idx, status) {{
    const rows = container.querySelectorAll('#cc-steps > div');
    if (!rows[idx]) return;
    const row = rows[idx];
    const textEl = row.querySelector('span:last-child');
    const text   = textEl ? textEl.textContent : '';
    row.innerHTML = stepIcon(status) + stepText(text, status);
  }}

  function showAction(text) {{
    const el = container.querySelector('#cc-action');
    if (!el) return;
    el.innerHTML = text
      ? `<div style="margin-top:6px;padding:6px 8px;background:#1f2937;border-radius:6px;border-left:3px solid #facc15;font-size:11px;color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${{text}}</div>`
      : '';
  }}

  function showBlocker(question) {{
    stopSpinner();
    setStatus('blocked');
    const action = container.querySelector('#cc-action');
    if (action) action.innerHTML = `
      <div style="margin-top:6px;padding:8px;background:#1f2937;border-radius:6px;border-left:3px solid #f87171;">
        <div style="font-size:10px;color:#f87171;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em;">⚠ Needs Your Input</div>
        <div style="font-size:11px;color:#e5e7eb;margin-bottom:6px;">${{question}}</div>
        <div style="display:flex;gap:6px;">
          <input id="blocker-input" type="text" placeholder="Your response..."
            style="flex:1;background:#111827;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:3px 7px;font-size:11px;outline:none;">
          <button id="blocker-send"
            style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;">Send</button>
        </div>
      </div>`;

    const bottom = container.querySelector('#cc-bottom');
    if (bottom) bottom.innerHTML = '';

    function sendResponse() {{
      const inp  = container.querySelector('#blocker-input');
      const btn  = container.querySelector('#blocker-send');
      const resp = inp ? inp.value.trim() : '';
      if (resp && activeChannel) {{
        activeChannel.send({{ response: resp }});
        if (btn) {{ btn.disabled = true; btn.textContent = 'Sent ✓'; }}
        if (inp) inp.disabled = true;
        startSpinner('Continuing...');
      }}
    }}

    const sendBtn = container.querySelector('#blocker-send');
    const inp     = container.querySelector('#blocker-input');
    if (sendBtn) sendBtn.addEventListener('click', sendResponse);
    if (inp)     inp.addEventListener('keydown', e => {{ if (e.key === 'Enter') sendResponse(); }});
    if (inp)     inp.focus();
  }}

  function showStartArea() {{
    const bottom = container.querySelector('#cc-bottom');
    if (!bottom) return;
    bottom.innerHTML = `
      <div style="display:flex;gap:6px;">
        <input id="task-input" type="text" placeholder="Describe what to implement..."
          style="flex:1;background:#1f2937;border:1px solid #374151;color:#f9fafb;border-radius:4px;padding:5px 8px;font-size:12px;outline:none;">
        <button id="run-btn"
          style="background:#4ade80;color:#111827;border:none;border-radius:4px;padding:5px 12px;font-size:11px;font-weight:700;cursor:pointer;">Run</button>
      </div>`;
    attachRunListener();
  }}

  function handleMsg(msg) {{
    switch (msg.type) {{
      case 'status':      setStatus(msg.value);                    break;
      case 'phase':       setPhase(msg.text);                      break;
      case 'plan':        renderPlan(msg.steps);                   break;
      case 'step_update': updateStep(msg.index, msg.status);       break;
      case 'action':      showAction(msg.text);                    break;
      case 'blocked':     showBlocker(msg.question);               break;
      case 'unblocked':   setStatus('in_progress'); showAction(''); startSpinner('Continuing...'); break;
      case 'done':
        stopSpinner();
        activeChannel = null;
        setStatus('done');
        showAction('');
        showStartArea();
        break;
      case 'error':
        stopSpinner();
        activeChannel = null;
        setStatus('error');
        showAction(msg.message || 'An error occurred.');
        showStartArea();
        break;
    }}
  }}

  function startSession() {{
    const taskInput = container.querySelector('#task-input');
    const task = taskInput ? taskInput.value.trim() : '';
    if (!task) return;

    startSpinner('Planning...');
    setStatus('in_progress');
    setPhase('Planning...');
    container.querySelector('#cc-steps').innerHTML =
      '<div style="color:#374151;font-size:12px;padding:6px 0;">Generating plan...</div>';

    const ch = mica.openChannel('run_session', {{ task, provider: '{provider or ""}' }});
    activeChannel = ch;

    ch.onData(handleMsg);
    ch.onClose(() => {{
      stopSpinner();
      activeChannel = null;
    }});
  }}

  function attachRunListener() {{
    const btn = container.querySelector('#run-btn');
    const inp = container.querySelector('#task-input');
    if (btn) btn.addEventListener('click', startSession);
    if (inp) inp.addEventListener('keydown', e => {{ if (e.key === 'Enter') startSession(); }});
  }}

  attachRunListener();
}})();
</script>
"""


# ─────────────────────────────────────────────
# Exports
# ─────────────────────────────────────────────

@mica.export
def select_provider(content, args):
    """User selected a provider from the picker."""
    provider = args.get("provider", "")
    providers = _load_providers()
    if provider not in providers:
        return {"error": f"Unknown provider: {provider}"}

    state = parse_state(content)
    state["provider"] = provider
    state["status"] = "idle"
    state["phase"] = "Ready"
    save_state(state)

    return {"provider": provider}
