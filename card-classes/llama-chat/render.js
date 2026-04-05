/**
 * Llama Chat card class — interactive chat with local LLM (llama-server).
 *
 * Browser: Chat UI, opens channel with provider: "local".
 * Server: Calls llama-server's OpenAI-compatible API at /v1/chat/completions.
 *
 * Networking: llama-server runs on the host at port 8012. When this card class
 * runs inside a Docker container (bridge network), it reaches the host via the
 * default gateway IP. When running on the host directly, it uses 127.0.0.1.
 */

import fs from 'fs';
import path from 'path';

export const metadata = { extension: ".llama-chat", badge: "LLAMA", primaryFile: "conversation.json", defaultTitle: "Llama Chat" };

// ── Server-side chat management ───────────────────────────

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";
const HISTORY_FILE = "conversation.json";
const MAX_HISTORY = 100;
const MAX_TURNS = 5;

/**
 * Resolve the llama-server base URL.
 * Inside Docker (bridge network), 127.0.0.1 is the container itself.
 * We detect this by checking for /.dockerenv or the PROJECT_DIR convention,
 * then use the default gateway IP to reach the host.
 */
async function getLlamaBaseUrl() {
  // If explicitly set, use that
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL;

  // Check if we're inside a Docker container
  let inContainer = false;
  try {
    await fs.promises.access("/.dockerenv");
    inContainer = true;
  } catch {
    // Also check cgroup for container evidence
    try {
      const cgroup = await fs.promises.readFile("/proc/1/cgroup", "utf-8");
      if (cgroup.includes("docker") || cgroup.includes("containerd")) {
        inContainer = true;
      }
    } catch { /* not in container */ }
  }

  if (inContainer) {
    // Get the default gateway IP (host from container's perspective)
    try {
      const { execSync } = await import('child_process');
      const route = execSync("ip route | grep default | awk '{print $3}'", { encoding: "utf-8" }).trim();
      if (route) {
        return `http://${route}:8012`;
      }
    } catch { /* fallback */ }

    // Fallback: host.docker.internal (works on Docker Desktop for Mac/Windows)
    return "http://host.docker.internal:8012";
  }

  return "http://127.0.0.1:8012";
}

/** Read the first non-dot file from a card directory. */
async function readCardContent(cardName) {
  const dir = path.join(PROJECT_DIR, cardName);
  try {
    const entries = await fs.promises.readdir(dir);
    for (const entry of entries) {
      if (!entry.startsWith(".")) {
        return await fs.promises.readFile(path.join(dir, entry), "utf-8");
      }
    }
  } catch { /* card doesn't exist */ }
  return null;
}

/** Build project context for the system prompt. */
async function buildContext(mica) {
  const parts = [];

  // Read the agent's own brief
  try {
    const brief = await mica.read("brief.md");
    if (brief.trim()) parts.push(`## Agent Brief\n${brief.trim()}`);
  } catch { /* no brief */ }

  // Read canvas seed cards for project context
  const contextCards = [
    { name: "goal.goal", label: "Project Goals" },
    { name: "todo.todo", label: "Tasks" },
    { name: "brief.md", label: "Project Brief" },
    { name: "log.md", label: "Recent Activity" },
  ];

  for (const { name, label } of contextCards) {
    const content = await readCardContent(name);
    if (content?.trim()) {
      parts.push(`## ${label}\n${content.trim()}`);
    }
  }

  // List canvas cards
  try {
    const entries = await fs.promises.readdir(PROJECT_DIR);
    const cards = [];
    for (const entry of entries) {
      if (entry.startsWith(".") || entry === "workspace") continue;
      const ext = path.extname(entry);
      if (ext) {
        const stat = await fs.promises.stat(path.join(PROJECT_DIR, entry));
        cards.push(`- ${entry}${stat.isDirectory() ? "/" : ""}`);
      }
    }
    if (cards.length > 0) {
      parts.push(`## Canvas Cards\n${cards.join("\n")}`);
    }
  } catch { /* no cards */ }

  return parts.join("\n\n");
}

// Per-session state
const sessions = new Map();

function sessionKey(mica) {
  return `${mica.project}/${mica.canvas}/${mica.filename}`;
}

async function loadHistory(mica) {
  try {
    const raw = await mica.read(HISTORY_FILE);
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function appendHistory(mica, newMessages) {
  let messages = await loadHistory(mica);
  messages.push(...newMessages);
  if (messages.length > MAX_HISTORY) {
    messages = messages.slice(-MAX_HISTORY);
  }
  await mica.write(HISTORY_FILE, JSON.stringify(messages, null, 2));
}

export async function onConnect(mica, args) {
  const key = sessionKey(mica);
  sessions.set(key, {
    busy: false,
    queue: [],
    // OpenAI-format conversation history (system + user/assistant messages)
    conversation: [],
  });

  const messages = await loadHistory(mica);
  mica.send({ type: "history", messages });
}

export async function onMessage(msg, mica) {
  const key = sessionKey(mica);
  const session = sessions.get(key);
  if (!session) return;

  // Replay history on re-attach
  if (msg.type === "attached") {
    const messages = await loadHistory(mica);
    mica.reply({ type: "history", messages });
    return;
  }

  const message = msg.message;
  if (!message) return;

  if (session.busy) {
    session.queue.push(message);
    return;
  }

  await processMessage(session, message, mica);
}

export function onDisconnect(mica) {
  const key = sessionKey(mica);
  sessions.delete(key);
}

async function processMessage(session, message, mica) {
  session.busy = true;

  // Broadcast user message
  mica.send({ type: "user", content: message });
  await appendHistory(mica, [{ role: "user", content: message }]);

  // Signal thinking
  mica.send({ type: "thinking" });

  try {
    const baseUrl = await getLlamaBaseUrl();
    const context = await buildContext(mica);

    const systemPrompt = `You are a helpful local AI assistant (Llama) working on this project. Be concise and direct. When asked to create content or make changes, do it.

${context}`;

    // Build OpenAI-format messages from display history
    // (rebuild each time to keep it fresh; conversation state is display history)
    const displayHistory = await loadHistory(mica);
    const openaiMessages = [
      { role: "system", content: systemPrompt },
    ];

    // Convert display history to OpenAI format (last N messages for context window)
    const recentHistory = displayHistory.slice(-20);
    for (const m of recentHistory) {
      if (m.role === "user") {
        openaiMessages.push({ role: "user", content: m.content });
      } else if (m.role === "assistant") {
        openaiMessages.push({ role: "assistant", content: m.content });
      }
    }

    // Add the current user message (it's already in display history from appendHistory above,
    // but we built openaiMessages from the saved history which includes it)

    mica.send({ type: "progress", description: "Calling local LLM..." });

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "local",
        messages: openaiMessages,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`llama-server returned ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    let resultText = choice?.message?.content || "";

    if (!resultText.trim()) {
      resultText = "I wasn't able to generate a response. Please try again.";
    }

    mica.send({
      type: "assistant",
      content: resultText,
      agent: "Llama",
      filesChanged: false,
    });

    await appendHistory(mica, [
      { role: "assistant", content: resultText, agent: "Llama" },
    ]);
  } catch (err) {
    console.error(`[llama-chat] Error:`, err.message);
    mica.send({ type: "error", error: err.message });
  } finally {
    session.busy = false;

    if (session.queue.length > 0) {
      const lastMessage = session.queue[session.queue.length - 1];
      session.queue.length = 0;
      setImmediate(() => processMessage(session, lastMessage, mica));
    }
  }
}

// ── Browser-side chat UI ──────────────────────────────────

export default function render(content, config) {
  return chatCardHtml("local", "Llama", "#4ade80", "🦙");
}

function chatCardHtml(provider, label, color, icon) {
  return `
<div id="chat-root" style="
  display:flex;flex-direction:column;height:100%;min-height:260px;
  background:#0d1117;border-radius:6px;overflow:hidden;
  font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
">
  <!-- Header -->
  <div style="
    display:flex;align-items:center;gap:8px;padding:8px 12px;
    background:#161b22;border-bottom:1px solid #30363d;flex-shrink:0;
  ">
    <span style="font-size:14px;">${icon}</span>
    <span style="color:#e6edf3;font-size:13px;font-weight:600;">${label} Chat</span>
  </div>

  <!-- Messages -->
  <div id="chat-messages" style="
    flex:1;overflow-y:auto;padding:8px 12px;min-height:0;
    display:flex;flex-direction:column;gap:8px;
  ">
    <div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">
      Send a message to start collaborating.
    </div>
  </div>

  <!-- Status bar -->
  <div id="chat-statusbar" style="display:none;flex-shrink:0;">
    <div id="chat-status-main" style="
      display:flex;align-items:center;gap:8px;padding:6px 12px;
      border-top:1px solid #30363d;cursor:pointer;
      font-size:12px;color:#8b949e;
    ">
      <span id="chat-dot" style="
        width:8px;height:8px;border-radius:50%;flex-shrink:0;
      "></span>
      <span id="chat-status-label" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
      <span id="chat-status-meta" style="flex-shrink:0;font-size:11px;"></span>
    </div>
    <div id="chat-progress-log" style="
      display:none;padding:4px 12px 6px 28px;
      font-size:11px;color:#6e7681;line-height:1.6;
      max-height:80px;overflow-y:auto;
    "></div>
  </div>

  <!-- Input -->
  <div style="
    display:flex;gap:6px;padding:8px 12px;
    border-top:1px solid #30363d;flex-shrink:0;
  ">
    <input id="chat-input" type="text" placeholder="Type a message..."
      tabindex="0"
      style="
        flex:1;background:#161b22;border:1px solid #30363d;border-radius:6px;
        padding:6px 10px;color:#e6edf3;font-size:13px;outline:none;
        font-family:inherit;
      "
    />
    <button id="chat-send" style="
      background:${color};color:#0d1117;border:none;border-radius:6px;
      padding:6px 12px;font-size:13px;font-weight:600;cursor:pointer;
      font-family:inherit;
    ">Send</button>
  </div>
</div>

<script>
(() => {
  const root = container.querySelector('#chat-root');
  const messagesEl = container.querySelector('#chat-messages');
  const inputEl = container.querySelector('#chat-input');
  const sendBtn = container.querySelector('#chat-send');
  const statusBar = container.querySelector('#chat-statusbar');
  const statusMain = container.querySelector('#chat-status-main');
  const statusDot = container.querySelector('#chat-dot');
  const statusLabel = container.querySelector('#chat-status-label');
  const statusMeta = container.querySelector('#chat-status-meta');
  const progressLog = container.querySelector('#chat-progress-log');
  const provider = '${provider}';
  const color = '${color}';

  let busy = false;
  let stepCount = 0;
  let elapsedSec = 0;
  let elapsedTimer = null;
  let logExpanded = false;

  const ch = mica.openChannel('chat_session', { provider });

  function scrollToBottom() {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMarkdown(text) {
    if (!text) return '';
    return text
      .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
      .replace(/\`([^\`]+)\`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>')
      .replace(/\\n/g, '<br>');
  }

  function addMessage(role, content, agent) {
    if (messagesEl.children.length === 1 && messagesEl.children[0].style.textAlign === 'center') {
      messagesEl.innerHTML = '';
    }
    const msg = document.createElement('div');
    msg.style.cssText = role === 'user'
      ? 'align-self:flex-end;background:rgba(74,222,128,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
      : 'align-self:flex-start;background:rgba(255,255,255,0.06);border-radius:12px 12px 12px 4px;padding:8px 12px;max-width:85%;';
    if (role === 'user') {
      msg.innerHTML = '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + escapeHtml(content) + '</div>';
    } else {
      const header = agent ? '<div style="color:' + color + ';font-size:11px;font-weight:600;margin-bottom:4px;">' + escapeHtml(agent) + '</div>' : '';
      msg.innerHTML = header + '<div style="color:#e6edf3;font-size:13px;line-height:1.5;">' + renderMarkdown(content) + '</div>';
    }
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function showWorking(text) {
    statusBar.style.display = 'block';
    statusDot.style.background = '${color}';
    statusDot.style.animation = 'none';
    statusDot.offsetHeight;
    statusDot.style.animation = 'pulse 1.5s ease-in-out infinite';
    statusLabel.textContent = text || 'Agent is working...';
    updateMeta();
  }

  function showDone(filesChanged) {
    statusBar.style.display = 'block';
    statusDot.style.background = '#3fb950';
    statusDot.style.animation = 'none';
    statusLabel.textContent = filesChanged ? 'Whiteboard updated — your turn' : 'Done — your turn';
    statusMeta.textContent = '';
  }

  function showIdle() {
    statusBar.style.display = 'block';
    statusDot.style.background = '#3fb950';
    statusDot.style.animation = 'none';
    statusLabel.textContent = 'Your turn';
    statusMeta.textContent = '';
    progressLog.style.display = 'none';
  }

  function updateMeta() {
    const parts = [];
    if (elapsedSec > 0) parts.push(elapsedSec + 's');
    if (stepCount > 0) parts.push(stepCount + (stepCount === 1 ? ' step' : ' steps'));
    statusMeta.textContent = parts.join(' · ');
  }

  function addLogEntry(text) {
    stepCount++;
    const entry = document.createElement('div');
    entry.style.cssText = 'display:flex;align-items:baseline;gap:6px;';
    entry.innerHTML = '<span style="color:${color};font-size:8px;">●</span>' + escapeHtml(text);
    progressLog.appendChild(entry);
    if (logExpanded) progressLog.scrollTop = progressLog.scrollHeight;
    updateMeta();
  }

  function startElapsed() {
    elapsedSec = 0;
    elapsedTimer = setInterval(() => { elapsedSec++; updateMeta(); }, 1000);
  }

  function stopElapsed() {
    if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  }

  statusMain.addEventListener('click', () => {
    if (stepCount === 0) return;
    logExpanded = !logExpanded;
    progressLog.style.display = logExpanded ? 'block' : 'none';
  });

  ch.onData((data) => {
    switch (data.type) {
      case 'history':
        messagesEl.innerHTML = '';
        if (data.messages && data.messages.length > 0) {
          for (const m of data.messages) addMessage(m.role, m.content, m.agent);
        } else {
          messagesEl.innerHTML = '<div style="color:#8b949e;font-size:12px;text-align:center;padding:16px 0;">Send a message to start collaborating.</div>';
        }
        showIdle();
        break;

      case 'user':
        addMessage('user', data.content);
        break;

      case 'thinking':
        busy = true;
        sendBtn.disabled = true;
        stepCount = 0;
        progressLog.innerHTML = '';
        logExpanded = false;
        progressLog.style.display = 'none';
        showWorking('Thinking...');
        startElapsed();
        break;

      case 'progress':
        if (data.description) {
          showWorking(data.description);
          addLogEntry(data.description);
        }
        break;

      case 'assistant':
        busy = false;
        sendBtn.disabled = false;
        stopElapsed();
        showDone(data.filesChanged);
        addMessage('assistant', data.content, data.agent);
        break;

      case 'error':
        busy = false;
        sendBtn.disabled = false;
        stopElapsed();
        statusBar.style.display = 'block';
        statusDot.style.background = '#f87171';
        statusDot.style.animation = 'none';
        statusLabel.textContent = 'Error';
        statusMeta.textContent = '';
        addMessage('assistant', 'Error: ' + (data.error || 'Unknown error'), 'System');
        break;
    }
  });

  ch.onClose(() => {});

  function send() {
    const text = inputEl.value.trim();
    if (!text || busy) return;
    inputEl.value = '';
    ch.send({ message: text });
  }

  sendBtn.addEventListener('click', send);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  root.addEventListener('click', (e) => {
    if (e.target === root || e.target === messagesEl) inputEl.focus();
  });

  mica.onDestroy(() => { ch.close(); });
})();
</script>

<style>
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
</style>
  `;
}
