/**
 * Qwen Code Agent card class — coding agent using @qwen-code/sdk.
 *
 * Browser: Chat UI with streaming output.
 * Server: Uses the Qwen Code SDK (same pattern as claude-chat uses Claude SDK).
 *         The SDK manages the qwen subprocess, session state, and tool execution.
 */

import fs from 'fs';
import path from 'path';

// Lazy import — SDK may not be installed until setup.sh runs
let _query = null;
async function getQuery() {
  if (!_query) {
    const mod = await import('/opt/mica/node_modules/@qwen-code/sdk/dist/index.mjs');
    _query = mod.query;
  }
  return _query;
}

export const metadata = {
  extension: ".qwen-code-agent",
  badge: "QWEN",
  primaryFile: "conversation.json",
  defaultTitle: "Qwen Code",
};

export const dependencies = {
  scripts: ['https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.7/marked.min.js'],
};

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";
const HISTORY_FILE = "conversation.json";
const MAX_HISTORY = 100;

// ── Network helpers ─────────────────────────────────────────

async function getHostIp() {
  try { await fs.promises.access("/.dockerenv"); } catch {
    try {
      const cgroup = await fs.promises.readFile("/proc/1/cgroup", "utf-8");
      if (!cgroup.includes("docker") && !cgroup.includes("containerd")) return "127.0.0.1";
    } catch { return "127.0.0.1"; }
  }
  try {
    const routeTable = await fs.promises.readFile("/proc/net/route", "utf-8");
    for (const line of routeTable.trim().split("\n").slice(1)) {
      const parts = line.split("\t");
      if (parts[1] === "00000000") {
        const gw = parts[2];
        return [parseInt(gw.slice(6,8),16), parseInt(gw.slice(4,6),16),
                parseInt(gw.slice(2,4),16), parseInt(gw.slice(0,2),16)].join(".");
      }
    }
  } catch {}
  return "host.docker.internal";
}

async function getLlamaBaseUrl() {
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL.replace(/\/v1$/, '') + '/v1';
  return `http://${await getHostIp()}:8012/v1`;
}

// ── Project context ─────────────────────────────────────────

async function readCardContent(cardName) {
  const dir = path.join(PROJECT_DIR, cardName);
  try {
    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      if (!entry.startsWith(".")) return await fs.promises.readFile(path.join(dir, entry), "utf-8");
    }
  } catch {}
  return null;
}

async function buildContext(mica) {
  const parts = [];

  // Reference docs and brief (bulk context — middle of prompt)
  try {
    let brief = await mica.read("brief.md");
    const fileRefs = brief.match(/^@(\S+)$/gm) || [];
    for (const ref of fileRefs) {
      const filename = ref.slice(1);
      try {
        let content;
        try { content = await fs.promises.readFile(`/opt/mica/card-classes/${filename}`, "utf-8"); }
        catch { content = await fs.promises.readFile(path.join(PROJECT_DIR, filename), "utf-8"); }
        brief = brief.replace(ref, content.trim());
      } catch { brief = brief.replace(ref, `(file not found: ${filename})`); }
    }
    if (brief.trim()) parts.push(brief.trim());
  } catch {}

  // Project context
  let todoContent = '';
  for (const { name, label } of [
    { name: "goal.goal", label: "Project Goals" },
    { name: "todo.todo", label: "Tasks" },
    { name: "brief.md", label: "Project Brief" },
  ]) {
    const content = await readCardContent(name);
    if (content?.trim()) {
      parts.push(`## ${label}\n${content.trim()}`);
      if (name === 'todo.todo') todoContent = content;
    }
  }

  // Check for pending user approvals — block building if user hasn't approved
  const pendingUserTasks = (todoContent.match(/- \[ \] @user/g) || []).length;
  if (pendingUserTasks > 0) {
    parts.push(`## BLOCKED — ${pendingUserTasks} pending @user task(s)\nDo NOT build or implement any card classes. There are unchecked @user tasks in the todo. Wait for the user to complete them first. Ask the user to review and approve.`);
  }

  try {
    const entries = await fs.promises.readdir(PROJECT_DIR);
    const cards = entries.filter(e => !e.startsWith(".") && e !== "workspace" && path.extname(e));
    if (cards.length > 0) parts.push(`## Canvas Cards\n${cards.map(c => `- ${c}`).join("\n")}`);
  } catch {}

  // Recent activity log — gives the agent context about what was done in previous sessions
  const logContent = await readCardContent('log.md');
  if (logContent?.trim()) {
    const recentLines = logContent.split('\n').slice(-15).join('\n');
    parts.push(`## Recent Activity\n${recentLines}`);
  }

  // Card errors — scan for .error files in card directories
  try {
    const entries = await fs.promises.readdir(PROJECT_DIR);
    const errorLines = [];
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      try {
        const errorPath = path.join(PROJECT_DIR, entry, ".error");
        const errorContent = await fs.promises.readFile(errorPath, "utf-8");
        const err = JSON.parse(errorContent);
        errorLines.push(`- **${entry}**: ${err.error} (${err.source}, ${err.cardClass || 'unknown class'})`);
      } catch {
        // No .error file — card is fine
      }
    }
    if (errorLines.length > 0) {
      parts.push(`## Card Errors (fix these)\n${errorLines.join("\n")}`);
    }
  } catch {}

  // CRITICAL RULES — placed last for recency (models attend most to start and end)
  parts.push(`## Critical Rules
- The server is always running — never tell the user to restart it.
- When building a new card type, use the \`create-card-class\` skill. It covers the full workflow.
- Card UI goes in card.html — a standard HTML file. CARD_DATA has the card's data. mica.call() persists data.
- Copy the template render.js — do NOT write your own.
- Always test before creating an instance.`);

  return parts.join("\n\n");
}

// ── Session state ───────────────────────────────────────────

const sessions = new Map();
function sessionKey(mica) { return `${mica.project}/${mica.canvas}/${mica.filename}`; }

async function loadHistory(mica) {
  try { return JSON.parse(await mica.read(HISTORY_FILE)); } catch { return []; }
}

async function appendHistory(mica, msgs) {
  let messages = await loadHistory(mica);
  messages.push(...msgs);
  if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);
  await mica.write(HISTORY_FILE, JSON.stringify(messages, null, 2));
}

function describeToolUse(name, input) {
  if (!input) return name;
  switch (name) {
    case 'bash': case 'execute_command': {
      const cmd = String(input.command || input.cmd || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case 'read_file': case 'read': return `Read ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    case 'write_file': case 'write': case 'write_to_file': return `Write ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    case 'edit_file': case 'edit': return `Edit ${String(input.file_path || input.filePath || "").split("/").pop() || "file"}`;
    default: return name;
  }
}

// ── Channel handlers ────────────────────────────────────────

export async function onConnect(mica, args) {
  const key = sessionKey(mica);

  if (!sessions.has(key)) {
    sessions.set(key, { busy: false, queue: [], activeQuery: null });
  }

  // Card errors are now handled via .error files — buildContext() reads them
  // and includes them in the agent's context. No reactive listener needed.

  if (typeof mica.on === 'function') {
    // Reactive canvas: wake the agent when canvas cards are edited by the user.
    // The agent reads the change and responds (e.g., user edits architecture → agent adjusts).
    // Throttled: 30s cooldown, skip if busy, ignore own writes.
    mica.on('file-changed', async (event) => {
      const session = sessions.get(key);
      if (!session) return;

      const { filename, source } = event;

      // Ignore our own writes
      if (source === mica.filename) return;

      // Only react to design-relevant cards (not every file change)
      const designCards = ['.goal', '.todo', '.mmd', '-spec.md', '-ux.mmd'];
      if (!designCards.some(suffix => filename.endsWith(suffix))) return;

      // Skip if busy or cooling down
      if (session.busy) return;
      const now = Date.now();
      const lastReact = session.lastCanvasReact || 0;
      if (now - lastReact < 30000) return;
      session.lastCanvasReact = now;

      console.log(`[qwen-code-agent] Canvas change detected: ${filename} (source: ${source || 'user'})`);

      const reactMessage = `The canvas card "${filename}" was just updated by the user. Read its current content and respond appropriately — update related cards, answer questions, or acknowledge the change.`;
      processMessage(session, reactMessage, mica);
    });
  }

  const messages = await loadHistory(mica);
  mica.send({ type: 'history', messages });
}

export async function onMessage(msg, mica) {
  const key = sessionKey(mica);
  const session = sessions.get(key);
  if (!session) return;

  if (msg.type === 'attached') {
    const messages = await loadHistory(mica);
    mica.reply({ type: 'history', messages });
    return;
  }

  if (msg.type === 'get_context') {
    const context = await buildContext(mica);
    const baseUrl = await getLlamaBaseUrl();
    mica.reply({
      type: 'context_info',
      context,
      baseUrl,
      contextLength: context.length,
    });
    return;
  }

  if (msg.type === 'interrupt') {
    if (session.activeQuery) {
      try { await session.activeQuery.interrupt(); } catch {}
    }
    return;
  }

  const message = msg.message;
  if (!message) return;

  if (session.busy) { session.queue.push(message); return; }

  await processMessage(session, message, mica);
}

export function onDestroy(mica) {
  const key = sessionKey(mica);
  const session = sessions.get(key);
  if (session?.activeQuery) {
    try { session.activeQuery.close(); } catch {}
  }
  sessions.delete(key);
}

// ── Message processor ───────────────────────────────────────

async function processMessage(session, message, mica) {
  session.busy = true;

  mica.send({ type: 'user', content: message });
  await appendHistory(mica, [{ role: 'user', content: message }]);
  mica.send({ type: 'thinking' });

  try {
    const baseUrl = await getLlamaBaseUrl();
    const context = await buildContext(mica);

    console.log(`[qwen-code-agent] Context: ${context.length} chars, baseUrl: ${baseUrl}`);

    const options = {
      cwd: PROJECT_DIR,
      model: 'openai:local',
      authType: 'openai',
      permissionMode: 'yolo',
      systemPrompt: { type: 'preset', preset: 'qwen_code', append: context },
      env: {
        OPENAI_API_KEY: 'dummy',
        OPENAI_BASE_URL: baseUrl,
        MICA_API_URL: `http://${baseUrl.split('//')[1].split(':')[0]}:3002`,
      },
      // Fresh session every time — canvas cards provide context, not chat history.
      // This prevents context overflow (131K limit) on long conversations.
    };

    let resultText = "";
    let filesChanged = false;

    const queryFn = await getQuery();
    const q = queryFn({ prompt: message, options });
    session.activeQuery = q;

    for await (const evt of q) {
      if (evt.type === 'assistant' && evt.message?.content) {
        // Tool use progress
        for (const block of evt.message.content) {
          if (block.type === 'tool_use' && block.name) {
            mica.send({
              type: 'progress',
              tool: block.name,
              description: describeToolUse(block.name, block.input),
            });
            if (['write_file', 'write_to_file', 'edit_file', 'create_file'].includes(block.name)) {
              filesChanged = true;
            }
          }
        }
        // Extract text
        let turnText = "";
        for (const block of evt.message.content) {
          if (block.type === 'text' && block.text) turnText += block.text;
        }
        if (turnText) resultText = turnText;
      }

      if (evt.type === 'result') {
        if (evt.result?.text) resultText = evt.result.text;
      }
    }

    session.activeQuery = null;

    if (!resultText.trim()) {
      resultText = filesChanged ? "Done — I made changes." : "Done.";
    }

    mica.send({ type: 'assistant', content: resultText, agent: 'Qwen', filesChanged });
    await appendHistory(mica, [{ role: 'assistant', content: resultText, agent: 'Qwen' }]);

    // Log activity to canvas log.md so future sessions have context
    try {
      const msgSummary = message.slice(0, 200);
      const resSummary = resultText.slice(0, 500);
      await mica.log(msgSummary + ' → ' + resSummary);
    } catch {}


  } catch (err) {
    session.activeQuery = null;
    const errMsg = err.message || String(err);
    console.error(`[qwen-code-agent] Error:`, errMsg);
    if (errMsg.includes('context size') || errMsg.includes('exceeds')) {
      mica.send({ type: 'error', error: 'Context limit reached. Try a shorter message.' });
    } else {
      mica.send({ type: 'error', error: errMsg });
    }
  } finally {
    session.busy = false;

    if (session.queue.length > 0) {
      const next = session.queue.shift();
      setImmediate(() => processMessage(session, next, mica));
    }
  }
}

// ── Browser UI ──────────────────────────────────────────────

export default function render(content, config) {
  var color = '#7c3aed';

  return `
<div id="qwen-root" style="
  display:flex;flex-direction:column;height:100%;min-height:260px;
  background:#0d1117;border-radius:6px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
">
  <div style="
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;
  ">
    <span style="color:${color};font-size:14px;">Q</span>
    <span style="color:#e6edf3;font-size:13px;font-weight:600;">Qwen Code</span>
    <button id="qwen-ctx-btn" title="Show context" style="
      margin-left:auto;background:transparent;border:1px solid #30363d;border-radius:4px;
      color:#6e7681;font-size:11px;cursor:pointer;padding:2px 6px;font-family:monospace;
    ">ctx</button>
  </div>

  <div id="qwen-messages" style="
    flex:1;overflow-y:auto;padding:8px 12px;min-height:0;
    display:flex;flex-direction:column;gap:8px;
  ">
    <div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">
      Send a message to start the Qwen Code agent.
    </div>
  </div>

  <div id="qwen-statusbar" style="display:none;flex-shrink:0;">
    <div id="qwen-status-main" style="
      display:flex;align-items:center;gap:8px;padding:6px 12px;
      border-top:1px solid #30363d;cursor:pointer;font-size:12px;color:#8b949e;
    ">
      <span id="qwen-dot" style="width:8px;height:8px;border-radius:50%;flex-shrink:0;"></span>
      <span id="qwen-status-label" style="flex:1;"></span>
      <span id="qwen-status-meta" style="flex-shrink:0;font-size:11px;"></span>
    </div>
  </div>

  <div style="
    display:flex;gap:6px;padding:8px 12px;
    border-top:1px solid #30363d;flex-shrink:0;
  ">
    <input id="qwen-input" type="text" placeholder="Ask Qwen Code..."
      style="
        flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;
        padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;font-family:inherit;
      "
    />
    <button id="qwen-stop" style="
      background:#f87171;color:#fff;border:none;border-radius:6px;
      padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;
      display:none;
    ">Stop</button>
    <button id="qwen-send" style="
      background:${color};color:#fff;border:none;border-radius:6px;
      padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;
    ">Send</button>
  </div>
</div>

<style>
@keyframes qpulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
.qwen-md p { margin:0 0 8px; }
.qwen-md p:last-child { margin-bottom:0; }
.qwen-md code { background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;font-family:monospace; }
.qwen-md pre { background:rgba(0,0,0,0.3);padding:8px 10px;border-radius:6px;overflow-x:auto;margin:6px 0; }
.qwen-md pre code { background:none;padding:0;font-size:12px; }
.qwen-md ul, .qwen-md ol { margin:4px 0;padding-left:20px; }
.qwen-md li { margin:2px 0; }
.qwen-md h1,.qwen-md h2,.qwen-md h3 { margin:8px 0 4px;color:#e6edf3; }
.qwen-md h1 { font-size:16px; } .qwen-md h2 { font-size:14px; } .qwen-md h3 { font-size:13px; }
.qwen-md blockquote { border-left:3px solid #444;margin:6px 0;padding:2px 10px;color:#999; }
.qwen-md strong { color:#fff; }
.qwen-md a { color:#58a6ff; }
.qwen-md table { border-collapse:collapse;margin:6px 0;font-size:12px; }
.qwen-md th,.qwen-md td { border:1px solid #333;padding:4px 8px; }
.qwen-md th { background:rgba(255,255,255,0.05); }
</style>

<script>
(function() {
  var messagesEl = container.querySelector('#qwen-messages');
  var inputEl = container.querySelector('#qwen-input');
  var sendBtn = container.querySelector('#qwen-send');
  var stopBtn = container.querySelector('#qwen-stop');
  var statusBar = container.querySelector('#qwen-statusbar');
  var statusDot = container.querySelector('#qwen-dot');
  var statusLabel = container.querySelector('#qwen-status-label');
  var statusMeta = container.querySelector('#qwen-status-meta');
  var ctxBtn = container.querySelector('#qwen-ctx-btn');
  var ACCENT = '${color}';
  var busy = false;
  var elapsedSec = 0;
  var elapsedTimer = null;
  var stepCount = 0;

  var ch = mica.openChannel('chat_session');

  function scrollMessages() {
    requestAnimationFrame(function() { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    try {
      if (typeof window.marked !== 'undefined' && window.marked.parse) {
        return window.marked.parse(text, { breaks: true, gfm: true });
      }
      console.warn('[qwen-chat] marked not available, falling back to plain text');
    } catch(e) {
      console.error('[qwen-chat] marked.parse error:', e);
    }
    return escapeHtml(text);
  }

  function addMessage(role, content, agent) {
    if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
      messagesEl.innerHTML = '';
    }
    var msg = document.createElement('div');
    if (role === 'user') {
      msg.style.cssText = 'align-self:flex-end;background:rgba(124,58,237,0.18);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;';
      msg.innerHTML = '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + escapeHtml(content) + '</div>';
    } else {
      msg.style.cssText = 'align-self:flex-start;background:rgba(255,255,255,0.05);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:90%;';
      var header = agent ? '<div style="color:' + ACCENT + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(agent) + '</div>' : '';
      msg.innerHTML = header + '<div class="qwen-md" style="color:#e6edf3;font-size:13px;line-height:1.5;">' + renderMarkdown(content) + '</div>';
    }
    messagesEl.appendChild(msg);
    scrollMessages();
  }

  function setStatus(text, dot, pulsing) {
    statusBar.style.display = 'block';
    statusDot.style.background = dot;
    statusDot.style.animation = pulsing ? 'qpulse 1.2s ease-in-out infinite' : 'none';
    statusLabel.textContent = text;
  }

  function updateMeta() {
    var parts = [];
    if (elapsedSec > 0) parts.push(elapsedSec + 's');
    if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? ' step' : ' steps'));
    statusMeta.textContent = parts.join(' . ');
  }

  ch.onData(function(data) {
    switch (data.type) {
      case 'history':
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
          for (var i = 0; i < data.messages.length; i++) addMessage(data.messages[i].role, data.messages[i].content, data.messages[i].agent);
        } else {
          messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start the Qwen Code agent.</div>';
        }
        setStatus('Ready', '#3fb950', false);
        break;
      case 'user': addMessage('user', data.content); break;
      case 'thinking':
        busy = true; sendBtn.disabled = true; sendBtn.style.display = 'none'; stopBtn.style.display = '';
        stepCount = 0; elapsedSec = 0;
        setStatus('Thinking...', ACCENT, true);
        elapsedTimer = setInterval(function() { elapsedSec++; updateMeta(); }, 1000);
        break;
      case 'progress':
        if (data.description) { stepCount++; setStatus(data.description, ACCENT, true); updateMeta(); }
        break;
      case 'assistant':
        busy = false; sendBtn.disabled = false; sendBtn.style.display = ''; stopBtn.style.display = 'none';
        if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
        setStatus(data.filesChanged ? 'Canvas updated' : 'Done', '#3fb950', false);
        addMessage('assistant', data.content, data.agent || 'Qwen');
        break;
      case 'error':
        busy = false; sendBtn.disabled = false; sendBtn.style.display = ''; stopBtn.style.display = 'none';
        if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
        setStatus('Error', '#f87171', false);
        addMessage('assistant', 'Error: ' + (data.error || 'Unknown'), 'System');
        break;
      case 'context_info':
        var ctx = data.context || '';
        var sections = ctx.split(/^## /gm).filter(Boolean);
        var summary = 'Context: ' + data.contextLength + ' chars\\nBase URL: ' + data.baseUrl + '\\n\\nSections:\\n';
        for (var s = 0; s < sections.length; s++) {
          var title = sections[s].split(String.fromCharCode(10))[0].trim();
          var chars = sections[s].length;
          summary += '  - ' + title + ' (' + chars + ' chars)\\n';
        }
        addMessage('assistant', summary, 'Context');
        break;
    }
  });

  ch.onClose(function() {});

  function send() {
    var text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    ch.send({ message: text });
  }

  sendBtn.addEventListener('click', send);
  stopBtn.addEventListener('click', function() {
    ch.send({ type: 'interrupt' });
    busy = false; sendBtn.disabled = false; sendBtn.style.display = ''; stopBtn.style.display = 'none';
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
    setStatus('Stopped', '#fbbf24', false);
  });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  ctxBtn.addEventListener('click', function() {
    ch.send({ type: 'get_context' });
  });

  mica.onDestroy(function() { ch.close(); if (elapsedTimer) clearInterval(elapsedTimer); });
})();
</script>
`;
}
