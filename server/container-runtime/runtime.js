/**
 * Container Card Runtime — runs inside the per-project Docker container.
 *
 * Loads card class ES modules, executes render/export/stream handlers.
 * Communicates with the host Mica server via stdin/stdout JSON messages.
 *
 * Protocol:
 *   Host → Container: JSON message per line on stdin
 *   Container → Host: JSON message per line on stdout
 *   Stderr: debug logging only (not protocol)
 *
 * Message types (host → container):
 *   { id, type: "render", className, classPath, content, config }
 *   { id, type: "callExport", className, classPath, fn, content, args, cardName }
 *   { id, type: "onConnect", className, classPath, cardName, args }
 *   { id, type: "onMessage", className, classPath, cardName, msg, replyClientId }
 *   { id, type: "onDestroy", className, classPath, cardName }
 *   { id, type: "invalidateClass", className }
 *   { id, type: "invalidateAll" }
 *
 * Message types (container → host):
 *   { id, type: "result", value: ... }
 *   { id, type: "error", message: "..." }
 *   { type: "bridge", cardName, method: "send"|"reply"|"log", data: ... }
 */

import { pathToFileURL } from "url";
import fs from "fs";
import path from "path";
import { createInterface } from "readline";

// ── Redirect console.log to stderr ─────────────────────────
// stdout is reserved for the JSON protocol with the host.
// Card classes that call console.log() must not corrupt the protocol.
const origLog = console.log;
console.log = (...args) => {
  process.stderr.write(args.map(String).join(" ") + "\n");
};
console.info = console.log;
console.warn = (...args) => {
  process.stderr.write("[warn] " + args.map(String).join(" ") + "\n");
};
console.error = (...args) => {
  process.stderr.write("[error] " + args.map(String).join(" ") + "\n");
};

// ── Module cache ────────────────────────────────────────────

const moduleCache = new Map();

async function loadModule(className, classPath) {
  const cached = moduleCache.get(className);
  if (cached) return cached;

  const fileUrl = pathToFileURL(classPath).href;
  const mod = await import(`${fileUrl}?t=${Date.now()}`);

  const loaded = { exportNames: [] };

  if (typeof mod.default === "function") {
    loaded.render = mod.default;
  } else if (typeof mod.render === "function") {
    loaded.render = mod.render;
  }

  if (typeof mod.onConnect === "function") loaded.onConnect = mod.onConnect;
  if (typeof mod.onMessage === "function") loaded.onMessage = mod.onMessage;
  if (typeof mod.onDestroy === "function") loaded.onDestroy = mod.onDestroy;
  if (mod.dependencies) loaded.dependencies = mod.dependencies;

  for (const [name, value] of Object.entries(mod)) {
    if (name === "default" || name === "dependencies") continue;
    if (name === "onConnect" || name === "onMessage" || name === "onDestroy") continue;
    if (typeof value === "function") {
      loaded.exportNames.push(name);
      loaded[name] = value;
    }
  }

  moduleCache.set(className, loaded);
  return loaded;
}

// ── Per-card session state for stream handlers ──────────────

// Maps cardName → { mica bridge, active state }
// Stream handler calls (onConnect/onMessage/onDestroy) reference this
const cardSessions = new Map();

// ── MicaBridge factory ──────────────────────────────────────
// Creates a bridge for a card instance. File I/O is local (project dir mounted).
// send/reply/log cross the boundary to the host via stdout messages.

const PROJECT_DIR = process.env.PROJECT_DIR || "/project";
const CARD_CLASSES_DIR = process.env.CARD_CLASSES_DIR || "/opt/mica/card-classes";

/** Resolve the primary file for a card directory by looking up card class metadata. */
function resolvePrimaryFile(cardName) {
  const ext = path.extname(cardName);
  // Scan card classes to find the one with this extension
  try {
    const classes = fs.readdirSync(CARD_CLASSES_DIR);
    for (const cls of classes) {
      const renderJs = path.join(CARD_CLASSES_DIR, cls, "render.js");
      try {
        const src = fs.readFileSync(renderJs, "utf-8");
        const match = src.match(/export\s+const\s+metadata\s*=\s*(\{[^}]+\})/);
        if (match) {
          const meta = new Function(`return ${match[1]}`)();
          if (meta.extension === ext) return meta.primaryFile || "content";
        }
      } catch { /* skip */ }
    }
  } catch { /* card-classes not available */ }
  return "content"; // fallback
}

/** Resolve a file path inside a card directory, handling card-as-directory. */
async function resolveCardPath(basePath) {
  try {
    const stats = await fs.promises.stat(basePath);
    if (stats.isDirectory()) {
      const cardName = path.basename(basePath);
      const primaryFile = resolvePrimaryFile(cardName);
      return path.join(basePath, primaryFile);
    }
    return basePath;
  } catch {
    return basePath; // doesn't exist yet — treat as flat file
  }
}

function createBridge(cardName, replyClientId) {
  const cardDir = path.join(PROJECT_DIR, cardName);

  return {
    project: process.env.MICA_PROJECT || "",
    canvas: process.env.MICA_CANVAS || "_root",
    filename: cardName,

    send(data) {
      sendToHost({ type: "bridge", cardName, method: "send", data });
    },

    reply(data) {
      sendToHost({ type: "bridge", cardName, method: "reply", data, replyClientId });
    },

    async read(filename) {
      const filepath = await resolveCardPath(path.join(cardDir, filename));
      return fs.promises.readFile(filepath, "utf-8");
    },

    async write(filename, content) {
      // Notify host of write source before writing — so file watcher can tag the source
      sendToHost({ type: "bridge", cardName, method: "writeNotify", data: { filename } });
      await fs.promises.mkdir(cardDir, { recursive: true });
      const filepath = await resolveCardPath(path.join(cardDir, filename));
      await fs.promises.mkdir(path.dirname(filepath), { recursive: true });
      await fs.promises.writeFile(filepath, content, "utf-8");
    },

    async exec(command, opts) {
      const { execFile } = await import("child_process");
      const { promisify } = await import("util");
      const execFileAsync = promisify(execFile);
      const cwd = opts?.cwd || PROJECT_DIR;
      const timeout = opts?.timeout || 30000;
      try {
        const { stdout, stderr } = await execFileAsync(
          "/bin/bash", ["-c", command],
          { cwd, timeout, maxBuffer: 10 * 1024 * 1024 }
        );
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        return {
          stdout: err.stdout || "",
          stderr: err.stderr || err.message,
          exitCode: err.code || 1,
        };
      }
    },

    async log(message) {
      sendToHost({ type: "bridge", cardName, method: "log", data: { message } });
    },

    async createCard(name) {
      sendToHost({ type: "bridge", cardName, method: "createCard", data: { name } });
    },

    on(event, cb) {
      // Register event listener — stored per card session
      const session = cardSessions.get(cardName);
      if (session) {
        if (!session.listeners) session.listeners = {};
        if (!session.listeners[event]) session.listeners[event] = [];
        session.listeners[event].push(cb);
      }
      return () => {
        const s = cardSessions.get(cardName);
        if (s?.listeners?.[event]) {
          s.listeners[event] = s.listeners[event].filter(fn => fn !== cb);
        }
      };
    },
  };
}

// ── Protocol: send message to host ──────────────────────────

function sendToHost(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, value) {
  sendToHost({ id, type: "result", value });
}

function sendError(id, message) {
  sendToHost({ id, type: "error", message });
}

// ── Message handlers ────────────────────────────────────────

async function handleMessage(msg) {
  const { id, type } = msg;

  try {
    switch (type) {
      case "render": {
        const mod = await loadModule(msg.className, msg.classPath);
        if (!mod.render) {
          sendResult(id, {
            html: `<div style="color:#f87171;">Card class "${msg.className}" has no render function.</div>`,
            exports: mod.exportNames,
            dependencies: mod.dependencies,
            hasStream: !!mod.onMessage,
          });
          return;
        }
        const html = await mod.render(msg.content, msg.config);
        sendResult(id, {
          html: typeof html === "string" ? html : String(html),
          exports: mod.exportNames,
          dependencies: mod.dependencies,
          hasStream: !!mod.onMessage,
        });
        return;
      }

      case "callExport": {
        const mod = await loadModule(msg.className, msg.classPath);
        const handler = mod[msg.fn];
        if (typeof handler !== "function") {
          throw new Error(`Card class "${msg.className}" has no export "${msg.fn}"`);
        }
        const mica = createBridge(msg.cardName);
        const result = await handler(msg.content, msg.args, mica);
        sendResult(id, result);
        return;
      }

      case "onConnect": {
        const mod = await loadModule(msg.className, msg.classPath);
        if (!mod.onConnect) {
          sendResult(id, null);
          return;
        }
        const mica = createBridge(msg.cardName);
        cardSessions.set(msg.cardName, { mica, className: msg.className, classPath: msg.classPath });
        await mod.onConnect(mica, msg.args);
        sendResult(id, null);
        return;
      }

      case "onMessage": {
        const mod = await loadModule(msg.className, msg.classPath);
        if (!mod.onMessage) {
          sendResult(id, null);
          return;
        }
        const session = cardSessions.get(msg.cardName);
        const mica = session?.mica || createBridge(msg.cardName);
        // Set reply target for this specific message
        if (msg.replyClientId) {
          mica.reply = (data) => {
            sendToHost({ type: "bridge", cardName: msg.cardName, method: "reply", data, replyClientId: msg.replyClientId });
          };
        }
        // Send result immediately — onMessage runs in background (agent tool loops can take minutes).
        // The agent streams results to the browser via mica.send(), not via the return value.
        sendResult(id, null);
        mod.onMessage(msg.msg, mica).catch((err) => {
          process.stderr.write(`[runtime] onMessage error for ${msg.cardName}: ${err.message}\n`);
        });
        return;
      }

      case "onDestroy": {
        const mod = await loadModule(msg.className, msg.classPath);
        const session = cardSessions.get(msg.cardName);
        const mica = session?.mica || createBridge(msg.cardName);
        if (mod.onDestroy) {
          await mod.onDestroy(mica);
        }
        cardSessions.delete(msg.cardName);
        sendResult(id, null);
        return;
      }

      case "invalidateClass": {
        moduleCache.delete(msg.className);
        process.stderr.write(`[runtime] Invalidated class "${msg.className}"\n`);
        sendResult(id, null);
        return;
      }

      case "invalidateAll": {
        moduleCache.clear();
        process.stderr.write(`[runtime] Invalidated all classes\n`);
        sendResult(id, null);
        return;
      }

      case "fileChanged": {
        // Deliver file-changed event to card session listeners
        const session = cardSessions.get(msg.cardName);
        if (session?.listeners?.["file-changed"]) {
          for (const cb of session.listeners["file-changed"]) {
            try { cb(msg.event); } catch (e) {
              process.stderr.write(`[runtime] file-changed listener error for ${msg.cardName}: ${e.message}\n`);
            }
          }
        }
        // No result needed — fire-and-forget
        return;
      }

      case "event": {
        // Deliver generic event to card session listeners (e.g., card-error)
        const session = cardSessions.get(msg.cardName);
        if (session?.listeners?.[msg.eventType]) {
          for (const cb of session.listeners[msg.eventType]) {
            try { cb(msg.data); } catch (e) {
              process.stderr.write(`[runtime] ${msg.eventType} listener error for ${msg.cardName}: ${e.message}\n`);
            }
          }
        }
        return;
      }

      default:
        sendError(id, `Unknown message type: ${type}`);
    }
  } catch (err) {
    sendError(id, err.message || String(err));
  }
}

// ── Main: read stdin line by line ───────────────────────────

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    handleMessage(msg).catch((err) => {
      process.stderr.write(`[runtime] Unhandled error: ${err.message}\n`);
      if (msg.id) sendError(msg.id, err.message);
    });
  } catch (err) {
    process.stderr.write(`[runtime] Invalid JSON: ${line}\n`);
  }
});

rl.on("close", () => {
  process.stderr.write("[runtime] stdin closed, exiting\n");
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  process.stderr.write(`[runtime] Uncaught exception: ${err.message}\n${err.stack}\n`);
});

process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[runtime] Unhandled rejection: ${reason}\n`);
});

process.stderr.write("[runtime] Card runtime started\n");
sendToHost({ type: "ready" });
