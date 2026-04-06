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
/** Resolve the host IP from inside a container, or return 127.0.0.1. */
async function getHostIp() {
  // Check if we're inside a Docker container
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
        if (parts[1] === "00000000") { // default route
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

  // Read the card class spec (what this card type does)
  try {
    const spec = await fs.promises.readFile('/opt/mica/card-classes/llama-chat/spec.md', 'utf-8');
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
  const session = {
    busy: false,
    queue: [],
    conversation: [],
    fileChangeTimer: null,
    pendingChanges: [],
  };
  sessions.set(key, session);

  // Subscribe to sibling card changes — debounce and batch
  mica.on('file-changed', (event) => {
    // Ignore own writes
    if (event.source === mica.filename) return;
    // Ignore dot files
    if (event.filename.startsWith('.')) return;
    // Ignore log and other chat cards (conversation writes are noise)
    if (event.filename === 'log.md') return;
    if (event.filename.endsWith('.llama-chat') || event.filename.endsWith('.claude-chat')) return;
    // Ignore if agent is already busy (don't queue reactive work)
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
        message = `[Canvas update] todo.todo was updated. Use read_file to read todo.todo and look for tasks assigned to @agent. If you find any, do them now.`;
      } else {
        const summary = filenames.join(', ');
        message = `[Canvas update] ${summary} changed. Check if any action is needed.`;
      }

      // Process through normal message pipeline
      if (session.busy) {
        session.queue.push(message);
      } else {
        processMessage(session, message, mica);
      }
    }, 3000); // 3 second debounce
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
  sessions.delete(key);
}

// Tool definitions for OpenAI-compatible function calling
const TOOLS = [
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all cards/files on the canvas",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the content of a card/file on the canvas",
      parameters: { type: "object", properties: { filename: { type: "string", description: "Card directory name (e.g., 'notes.md', 'goal.goal')" } }, required: ["filename"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or update a card/file on the canvas. The file is the primary content file inside the card directory.",
      parameters: { type: "object", properties: { filename: { type: "string", description: "Card directory name (e.g., 'notes.md')" }, content: { type: "string", description: "File content" } }, required: ["filename", "content"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_card",
      description: "Create a new card on the canvas. Extension determines the card class (e.g., '.md' for markdown, '.todo' for todo list, '.terminal' for terminal).",
      parameters: { type: "object", properties: { name: { type: "string", description: "Card name with extension (e.g., 'design-notes.md', 'backend.todo')" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "exec",
      description: "Run a shell command in the project directory",
      parameters: { type: "object", properties: { command: { type: "string", description: "Shell command to run" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "read_reference",
      description: "Load a reference document into context. Use this when you need detailed API docs — e.g., before creating a new card class, call read_reference('AUTHORING_CARD_CLASSES.md').",
      parameters: { type: "object", properties: { name: { type: "string", description: "Reference doc name (e.g., 'AUTHORING_CARD_CLASSES.md', 'WORKING_WITH_CARDS.md')" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_to_path",
      description: "Write content to an absolute file path. Creates parent directories if needed. Use this to create card class files (render.js, spec.md) at /opt/mica/card-classes/{name}/.",
      parameters: { type: "object", properties: { path: { type: "string", description: "Absolute file path (e.g., '/opt/mica/card-classes/calculator/render.js')" }, content: { type: "string", description: "File content" } }, required: ["path", "content"] },
    },
  },
];

// Execute a tool call
/** Resolve the primary file for a card from its class metadata. */
function resolvePrimaryFile(cardName) {
  const ext = path.extname(cardName);
  // Scan card-classes for a class with this extension, read its metadata
  const classesDir = "/opt/mica/card-classes";
  try {
    const classes = fs.readdirSync(classesDir);
    for (const cls of classes) {
      const renderJs = path.join(classesDir, cls, "render.js");
      try {
        const source = fs.readFileSync(renderJs, "utf-8");
        const match = source.match(/export\s+const\s+metadata\s*=\s*(\{[^}]+\})/);
        if (match) {
          const meta = new Function(`return ${match[1]}`)();
          if (meta.extension === ext && meta.primaryFile) return meta.primaryFile;
        }
      } catch { /* skip */ }
    }
  } catch { /* card-classes not available */ }
  return "content"; // fallback
}

async function executeTool(name, args, mica) {
  switch (name) {
    case "list_files": {
      const entries = await fs.promises.readdir(PROJECT_DIR);
      const cards = entries.filter(e => !e.startsWith(".") && e !== "workspace" && path.extname(e));
      return cards.join("\n") || "(no cards)";
    }
    case "read_file": {
      const dir = path.join(PROJECT_DIR, args.filename);
      try {
        const primary = resolvePrimaryFile(args.filename);
        return await fs.promises.readFile(path.join(dir, primary), "utf-8");
      } catch {
        return `Error: card "${args.filename}" not found`;
      }
    }
    case "write_file": {
      const dir = path.join(PROJECT_DIR, args.filename);
      try {
        await fs.promises.mkdir(dir, { recursive: true });
        const primary = resolvePrimaryFile(args.filename);
        await fs.promises.writeFile(path.join(dir, primary), args.content, "utf-8");
        return `Written to ${args.filename}/${primary}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "create_card": {
      try {
        const host = await getHostIp();
        const res = await fetch(`http://${host}:3002/api/projects/${mica.project}/canvases/_root/cards`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: args.name }),
        });
        if (res.ok) return `Created card: ${args.name}`;
        return `Error: ${await res.text()}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    case "exec": {
      const result = await mica.exec(args.command);
      return result.stdout + (result.stderr ? "\nSTDERR: " + result.stderr : "") + `\n(exit ${result.exitCode})`;
    }
    case "read_reference": {
      const refName = args.name || "";
      try {
        return await fs.promises.readFile(`/opt/mica/card-classes/${refName}`, "utf-8");
      } catch {
        return `Error: reference "${refName}" not found`;
      }
    }
    case "write_to_path": {
      const filePath = args.path || "";
      const fileContent = args.content || "";
      if (!filePath) return "Error: path is required";
      try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, fileContent, "utf-8");
        return `Written: ${filePath}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

const MAX_TOOL_TURNS = 5;

async function processMessage(session, message, mica) {
  session.busy = true;

  mica.send({ type: "user", content: message });
  await appendHistory(mica, [{ role: "user", content: message }]);
  mica.send({ type: "thinking" });

  try {
    const baseUrl = await getLlamaBaseUrl();
    const context = await buildContext(mica);

    const systemPrompt = `You are a helpful local AI assistant (Llama) working on this project. You can read, write, and create cards on the canvas. You can also run shell commands.

${context}

When asked to create or modify cards, use the tools. Be concise and direct.`;

    const displayHistory = await loadHistory(mica);
    const openaiMessages = [{ role: "system", content: systemPrompt }];
    for (const m of displayHistory.slice(-20)) {
      if (m.role === "user") openaiMessages.push({ role: "user", content: m.content });
      else if (m.role === "assistant") openaiMessages.push({ role: "assistant", content: m.content });
    }

    let resultText = "";
    let filesChanged = false;

    // Tool loop
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
      mica.send({ type: "progress", description: turn === 0 ? "Thinking..." : `Tool turn ${turn + 1}...` });

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "local",
          messages: openaiMessages,
          tools: TOOLS,
          temperature: 0.7,
          max_tokens: 4096,
        }),
      });

      if (!res.ok) {
        throw new Error(`llama-server returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      const msg = choice?.message;

      if (!msg) break;

      // Add assistant message to conversation
      openaiMessages.push(msg);

      // Capture any text content (model may return text + tool calls together)
      if (msg.content) resultText = msg.content;

      // Check for tool calls
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          const fn = tc.function;
          let args = {};
          try { args = JSON.parse(fn.arguments || "{}"); } catch {}

          mica.send({ type: "progress", description: `${fn.name}(${Object.values(args).join(", ").slice(0, 50)})` });

          const result = await executeTool(fn.name, args, mica);
          if (fn.name === "write_file" || fn.name === "create_card") filesChanged = true;

          openaiMessages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result,
          });
        }
        continue; // Loop back for next turn
      }

      // No tool calls — this is the final text response
      resultText = msg.content || "";
      break;
    }

    if (!resultText.trim()) {
      resultText = filesChanged
        ? "Done — I made changes to the canvas."
        : "I wasn't able to generate a response. Please try again.";
    }

    mica.send({
      type: "assistant",
      content: resultText,
      agent: "Llama",
      filesChanged,
    });

    await appendHistory(mica, [
      { role: "assistant", content: resultText, agent: "Llama", filesChanged },
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
