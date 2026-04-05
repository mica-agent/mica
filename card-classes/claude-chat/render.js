/**
 * Claude Chat card class — interactive chat with Claude agent.
 *
 * Browser: Chat UI, opens channel for bidirectional streaming.
 * Server: onConnect/onMessage/onDisconnect wire directly to Claude Agent SDK.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from 'fs';
import path from 'path';

export const metadata = { extension: ".claude-chat", badge: "CLAUDE", primaryFile: "conversation.json", defaultTitle: "Claude Chat" };

// ── Server-side chat management ───────────────────────────

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";
const HISTORY_FILE = "conversation.json";

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

  // Read the agent's own brief and expand @file references
  try {
    let brief = await mica.read("brief.md");
    // Expand @filename references — inline the file content
    const fileRefs = brief.match(/^@(\S+)$/gm) || [];
    for (const ref of fileRefs) {
      const filename = ref.slice(1); // strip @
      try {
        // Try card-classes mount first, then project directory
        let content;
        try {
          content = await fs.promises.readFile(`/opt/mica/card-classes/${filename}`, "utf-8");
        } catch {
          content = await fs.promises.readFile(path.join(PROJECT_DIR, filename), "utf-8");
        }
        brief = brief.replace(ref, content.trim());
      } catch {
        brief = brief.replace(ref, `(file not found: ${filename})`);
      }
    }
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
const MAX_HISTORY = 100;
const MODEL = "claude-sonnet-4-6";

// Per-session state (module cached once, multiple chat cards possible)
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

function describeToolUse(name, input) {
  if (!input) return name;
  switch (name) {
    case "Bash": {
      const cmd = String(input.command || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case "Read": return `Read ${String(input.file_path || "").split("/").pop() || "file"}`;
    case "Write": return `Write ${String(input.file_path || "").split("/").pop() || "file"}`;
    case "Edit": return `Edit ${String(input.file_path || "").split("/").pop() || "file"}`;
    case "Glob": return `Search ${input.pattern || "files"}`;
    case "Grep": return `Grep ${String(input.pattern || "").slice(0, 40)}`;
    default: return name;
  }
}

export async function onConnect(mica, args) {
  const key = sessionKey(mica);
  sessions.set(key, {
    busy: false,
    queue: [],
    sessionId: undefined,
  });

  const messages = await loadHistory(mica);
  mica.send({ type: "history", messages });
}

export async function onMessage(msg, mica) {
  const key = sessionKey(mica);
  const session = sessions.get(key);
  if (!session) return;

  // Replay history — server delivers { type: "attached" } on every channel attach.
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
    let resultText = "";
    let sessionId;
    let cost = 0;

    const context = await buildContext(mica);
    const systemPrompt = `You are a collaborative AI assistant working on this project. You have full access to the project filesystem and can run commands.

${context}

Be concise and direct. Take action — don't just discuss. When asked to create files or make changes, do it.`;

    const options = {
      systemPrompt,
      tools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep"],
      model: MODEL,
      maxTurns: 10,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...(session.sessionId ? { resume: session.sessionId } : {}),
    };

    for await (const evt of query({ prompt: message, options })) {
      // Tool use progress
      if (evt.type === "assistant" && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === "tool_use" && block.name) {
            mica.send({
              type: "progress",
              tool: block.name,
              description: describeToolUse(block.name, block.input),
            });
          }
        }

        // Extract latest text
        let turnText = "";
        for (const block of evt.message.content) {
          if (block.type === "text" && block.text) {
            turnText += block.text;
          }
        }
        if (turnText) resultText = turnText;
      }

      // Final result
      if (evt.type === "result" && "result" in evt) {
        resultText = evt.result || resultText;
        cost = evt.total_cost_usd || 0;
        sessionId = evt.session_id;
      }
    }

    if (!resultText.trim()) {
      resultText = "I worked on it but ran out of steps. Say 'continue' to pick up where I left off.";
    }

    if (sessionId) {
      session.sessionId = sessionId;
    }

    mica.send({
      type: "assistant",
      content: resultText,
      agent: "Claude",
      filesChanged: false,
    });

    await appendHistory(mica, [
      { role: "assistant", content: resultText, agent: "Claude" },
    ]);
  } catch (err) {
    console.error(`[claude-chat] Error:`, err.message);
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
  return chatCardHtml("claude", "Claude", "#60a5fa", "◆");
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
    <span style="color:${color};font-size:14px;">${icon}</span>
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

  <!-- Status bar (hidden when idle) -->
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
      ? 'align-self:flex-end;background:rgba(96,165,250,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
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

  // ── Status bar ──

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

  function hideStatus() {
    statusBar.style.display = 'none';
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

  // Toggle log on click
  statusMain.addEventListener('click', () => {
    if (stepCount === 0) return;
    logExpanded = !logExpanded;
    progressLog.style.display = logExpanded ? 'block' : 'none';
  });

  // ── Channel data ──

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
