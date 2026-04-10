/**
 * Pi Chat card class — interactive chat with Pi coding agent + local LLM.
 *
 * Browser: Chat UI, opens channel for bidirectional streaming.
 * Server: onConnect/onMessage/onDestroy wire to Pi coding agent SDK,
 *         using llama-server as the OpenAI-compatible LLM backend.
 */

import { createAgentSession, SessionManager, DefaultResourceLoader, createCodingTools, ModelRegistry, AuthStorage, InMemoryAuthStorageBackend } from "@mariozechner/pi-coding-agent";
import fs from 'fs';
import path from 'path';

export const metadata = { extension: ".pi-chat", badge: "PI", primaryFile: "conversation.json", defaultTitle: "Pi Chat" };

// ── Server-side chat management ───────────────────────────

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";
const HISTORY_FILE = "conversation.json";
const MAX_HISTORY = 100;

/** Resolve the host IP from inside a container, or return 127.0.0.1. */
async function getHostIp() {
  let inContainer = false;
  try {
    await fs.promises.access("/.dockerenv");
    inContainer = true;
  } catch {
    try {
      const cgroup = await fs.promises.readFile("/proc/1/cgroup", "utf-8");
      if (cgroup.includes("docker") || cgroup.includes("containerd")) {
        inContainer = true;
      }
    } catch { /* not in container */ }
  }

  if (inContainer) {
    try {
      const routeTable = await fs.promises.readFile("/proc/net/route", "utf-8");
      const lines = routeTable.trim().split("\n");
      for (const line of lines.slice(1)) {
        const parts = line.split("\t");
        if (parts[1] === "00000000") {
          const gw = parts[2];
          return [
            parseInt(gw.slice(6, 8), 16),
            parseInt(gw.slice(4, 6), 16),
            parseInt(gw.slice(2, 4), 16),
            parseInt(gw.slice(0, 2), 16),
          ].join(".");
        }
      }
    } catch { /* fallback */ }
    return "host.docker.internal";
  }

  return "127.0.0.1";
}

async function getLlamaBaseUrl() {
  if (process.env.LLAMA_URL) return process.env.LLAMA_URL;
  const host = await getHostIp();
  return `http://${host}:8012`;
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

  // Read the card class spec
  try {
    const spec = await fs.promises.readFile('/opt/mica/card-classes/pi-chat/spec.md', 'utf-8');
    if (spec.trim()) parts.push(`## Card Class Spec\n${spec.trim()}`);
  } catch { /* no spec */ }

  // Read the agent's own brief and expand @file references
  try {
    let brief = await mica.read("brief.md");
    const fileRefs = brief.match(/^@(\S+)$/gm) || [];
    for (const ref of fileRefs) {
      const filename = ref.slice(1);
      try {
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

  // CRITICAL RULES — placed last for recency (models attend most to start and end)
  parts.push(`## Critical Rules (MUST follow)
- The server is ALWAYS running. NEVER tell the user to restart it.
- NEVER redeclare \`container\` — it is pre-defined as your card's root element.
- NEVER use \`document.getElementById()\` or \`document.querySelector()\` — use \`container.querySelector()\`.
- NEVER use ES module \`import\` in browser scripts — load CDN libs via \`dependencies.scripts\`.
- Before using a CDN URL, verify it works: \`curl -sI <url> | head -1\` should return 200.
- After writing render.js, test it: \`curl -s -X POST $MICA_API_URL/api/card-classes/{name}/test -H 'Content-Type: application/json' -d '{"content":"{}"}'\`
- All functions in render.js must be defined in the same file — no implicit imports.`);

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

function describeToolUse(name, args) {
  if (!args) return name;
  switch (name) {
    case "bash": {
      const cmd = String(args.command || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case "read": return `Read ${String(args.filePath || args.file_path || "").split("/").pop() || "file"}`;
    case "write": return `Write ${String(args.filePath || args.file_path || "").split("/").pop() || "file"}`;
    case "edit": return `Edit ${String(args.filePath || args.file_path || "").split("/").pop() || "file"}`;
    case "grep": return `Grep ${String(args.pattern || "").slice(0, 40)}`;
    case "find": return `Find ${args.pattern || "files"}`;
    case "ls": return `List ${args.path || "."}`;
    default: return name;
  }
}

/** Create the Pi agent session for a chat card. */
async function createPiSession(projectContext) {
  const baseUrl = await getLlamaBaseUrl();

  // Pi requires auth even for local providers — provide a dummy key
  const authBackend = new InMemoryAuthStorageBackend();
  const authStorage = new AuthStorage(authBackend);
  authStorage.setRuntimeApiKey("llama-server", "no-key-needed");

  const modelRegistry = ModelRegistry.create(authStorage);
  modelRegistry.registerProvider("llama-server", {
    baseUrl: `${baseUrl}/v1`,
    api: "openai-completions",
    apiKey: "no-key-needed",
    models: [{
      id: "local-llama",
      name: "Local LLM",
      api: "openai-completions",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 16384,
      compat: { maxTokensField: "max_tokens" },
    }],
  });

  const model = modelRegistry.find("llama-server", "local-llama");

  // Append Mica project context to Pi's built-in system prompt.
  // We keep Pi's base prompt (tool descriptions + coding guidelines) intact —
  // replacing it caused the model to lose tool-use confidence and stop executing commands.
  const resourceLoader = new DefaultResourceLoader({
    cwd: PROJECT_DIR,
    appendSystemPromptOverride: (base) => [...base, projectContext],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd: PROJECT_DIR,
    model,
    modelRegistry,
    authStorage,
    tools: createCodingTools(PROJECT_DIR),
    resourceLoader,
    sessionManager: SessionManager.inMemory(),
  });

  return session;
}

export async function onConnect(mica, args) {
  const key = sessionKey(mica);
  const session = {
    busy: false,
    queue: [],
    piSession: null,
    fileChangeTimer: null,
    pendingChanges: [],
  };
  sessions.set(key, session);

  // Card render errors are logged but not auto-responded to — avoids endless fix loops.
  // The user can paste the error into chat to trigger a fix manually.
  mica.on('card-error', (event) => {
    console.log(`[pi-chat] Card error: ${event.filename} — ${event.error}`);
  });

  // Subscribe to sibling card changes — debounce and batch
  mica.on('file-changed', (event) => {
    if (event.source === mica.filename) return;
    if (event.filename.startsWith('.')) return;
    if (event.filename === 'log.md') return;
    if (event.filename.endsWith('.llama-chat') || event.filename.endsWith('.claude-chat') || event.filename.endsWith('.pi-chat')) return;
    if (session.busy) return;

    session.pendingChanges.push(event);
    if (session.fileChangeTimer) clearTimeout(session.fileChangeTimer);
    session.fileChangeTimer = setTimeout(() => {
      const changes = [...session.pendingChanges];
      session.pendingChanges = [];
      if (changes.length === 0) return;

      const filenames = changes.map(c => c.filename);
      const hasTodo = filenames.includes('todo.todo');

      let message;
      if (hasTodo) {
        message = `[Canvas update] todo.todo was updated. Read it and check for tasks assigned to @agent. If you find any, do them now.`;
      } else {
        const summary = filenames.join(', ');
        message = `[Canvas update] ${summary} changed. Check if any action is needed.`;
      }

      if (session.busy) {
        session.queue.push(message);
      } else {
        processMessage(session, message, mica);
      }
    }, 3000);
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

export function onDestroy(mica) {
  const key = sessionKey(mica);
  const session = sessions.get(key);
  if (session) {
    if (session.piSession) {
      try { session.piSession.abort(); } catch { /* ignore */ }
    }
  }
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
    const context = await buildContext(mica);
    const projectContext = `## Mica Project Context

You are a collaborative AI assistant working on this project. You have full access to the project filesystem and can run commands. Be concise and direct. Take action — don't just discuss. When asked to create files or make changes, do it.

${context}`;

    console.log(`[pi-chat] Project context length: ${projectContext.length} chars`);

    // Create pi session if we don't have one
    if (!session.piSession) {
      session.piSession = await createPiSession(projectContext);
      console.log(`[pi-chat] System prompt length: ${session.piSession.systemPrompt?.length} chars`);
    }

    // Track the response text and tool progress
    let resultText = "";
    let filesChanged = false;

    // Subscribe to events for progress reporting
    const unsub = session.piSession.subscribe((event) => {
      switch (event.type) {
        case "tool_execution_start":
          console.log(`[pi-chat] Tool: ${event.toolName} ${JSON.stringify(event.args || {}).slice(0, 100)}`);
          mica.send({
            type: "progress",
            tool: event.toolName,
            description: describeToolUse(event.toolName, event.args),
          });
          if (event.toolName === "write" || event.toolName === "edit") {
            filesChanged = true;
          }
          break;

        case "message_update":
          // Extract text deltas to accumulate the response
          if (event.assistantMessageEvent?.type === "text_delta") {
            // We'll grab the full text from agent_end instead
          }
          break;

        case "agent_end":
          console.log(`[pi-chat] agent_end: ${event.messages?.length || 0} messages`);
          // Extract the final assistant text from the last message
          if (event.messages && event.messages.length > 0) {
            for (let i = event.messages.length - 1; i >= 0; i--) {
              const msg = event.messages[i];
              if (msg.role === "assistant" && msg.content) {
                // Content can be string or array of content blocks
                if (typeof msg.content === "string") {
                  resultText = msg.content;
                } else if (Array.isArray(msg.content)) {
                  const textParts = msg.content
                    .filter(c => c.type === "text")
                    .map(c => c.text);
                  if (textParts.length > 0) {
                    resultText = textParts.join("");
                  }
                }
                break;
              }
            }
          }
          break;
      }
    });

    // Run the agent
    await session.piSession.prompt(message);
    unsub();

    if (!resultText.trim()) {
      resultText = "I worked on it but ran out of steps. Say 'continue' to pick up where I left off.";
    }

    mica.send({
      type: "assistant",
      content: resultText,
      agent: "Pi",
      filesChanged,
    });

    await appendHistory(mica, [
      { role: "assistant", content: resultText, agent: "Pi" },
    ]);
  } catch (err) {
    console.error(`[pi-chat] Error:`, err.message || err);
    mica.send({ type: "error", error: err.message || String(err) });
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
  return chatCardHtml("pi", "Pi", "#c084fc", "\u03C0");
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
      ? 'align-self:flex-end;background:rgba(192,132,252,0.15);border-radius:12px 12px 4px 12px;padding:8px 12px;max-width:85%;'
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
