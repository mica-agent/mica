// Mica AI Team Server
// Express server bridging the frontend to Claude Agent SDK-powered canvas agents.
// Auth: Uses Claude Code subscription (Pro/Max) — no API key needed.

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  chatWithAgent,
  consultCanvas,
  teamDiscuss,
  convertDrawingToMermaid,
  resetCanvas,
  resetAll,
  getAgentMeta,
  setAgentWriteHook,
  setAgentExecutor,
} from "./agents.js";
import type { CanvasId } from "./agents.js";
import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  listProjects,
  deleteProject,
  getProjectConfig,
  validateProjectCanvas,
} from "./canvasFiles.js";
import { connectProject, addCanvasToProject, migrateLegacyProjects, readMicaConfig, getProjectPath } from "./projectConnection.js";
import {
  getGitStatus,
  gitCommit,
  gitLog,
  gitDiff,
  gitBranch,
  gitCheckout,
} from "./projectGit.js";
import {
  startProjectContainer,
  stopProjectContainer,
  getContainerStatus,
  getContainerLogs,
  setContainerExecutor,
} from "./projectContainer.js";
import { initializeProjects, seedNewProject } from "./seedCanvases.js";
import { CardManager } from "./cardManager.js";
import type { MicaBridge } from "./moduleLoader.js";
import { FileWatcher } from "./fileWatcher.js";
import { SandboxManager } from "./projectSandbox.js";
import { ReactiveAgent } from "./reactiveAgent.js";
import { chatWithLocalAgent, setLocalAgentWriteHook, resetLocalCanvas, resetAllLocal } from "./localAgent.js";
import { stopLlamaServer } from "./llamaServer.js";
import { AgentChannelManager } from "./agentChannel.js";
import { setExecutor as setSubagentExecutor } from "./agentProviders/claudeCode.js";
import { ProjectExecutor } from "./projectExecutor.js";
import { ClaudeProvider } from "./agentProviders/claude.js";
import { LocalProvider } from "./agentProviders/local.js";
import { registerProvider, getProvider } from "./agentCore/registry.js";
import { resolveAgentProvider } from "./agentCore/config.js";
import { ChannelManager } from "./channelManager.js";
import { createModuleHandlerFactory } from "./channelHandlers/module.js";

const PORT = parseInt(process.env.MICA_PORT || "3002");

// ── Global error handlers — prevent process crashes ─────
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  // Give time to flush logs, then exit (restart via process manager)
  setTimeout(() => process.exit(1), 1000);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Content Security Policy ──────────────────────────────
// Block browser-side exfiltration: cards can only talk to the Mica server.
// External CDN resources are served via server-side proxy/cache (future).
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
      "img-src 'self' data: blob:",
      "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    ].join("; ")
  );
  next();
});

// ── Helper: validate project+canvas from route params ────
async function validateParams(
  res: express.Response,
  project: string,
  canvas: string
): Promise<boolean> {
  try {
    await validateProjectCanvas(project, canvas);
    return true;
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return false;
  }
}

// ── REST Endpoints ─────────────────────────────────────────

// Health check
app.get("/api/health", async (_req, res) => {
  const projects = await listProjects();
  res.json({
    status: "ok",
    auth: "claude-subscription",
    projects: projects.map((p) => p.id),
  });
});

// ── Project Management ────────────────────────────────────

// List all projects
app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects();
    res.json(projects);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get project details
app.get("/api/projects/:project", async (req, res) => {
  try {
    const config = await getProjectConfig(req.params.project);
    if (!config) {
      res.status(404).json({ error: `Project not found: ${req.params.project}` });
      return;
    }
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new project (seeds a fresh directory)
app.post("/api/projects", async (req, res) => {
  const { id, name, agentProvider } = req.body;
  if (!id || !name) {
    res.status(400).json({ error: "id and name required" });
    return;
  }
  try {
    const config = await seedNewProject(id, name, agentProvider);

    // Add watchers for the new project
    await fileWatcher.addProject(id, config.canvases);

    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Connect an existing directory/repo to Mica
app.post("/api/projects/connect", async (req, res) => {
  const { path: projectPath, name } = req.body;
  if (!projectPath) {
    res.status(400).json({ error: "path required" });
    return;
  }
  try {
    const config = await connectProject(projectPath, name);

    // Add watchers for the connected project
    await fileWatcher.addProject(config.id, config.canvases);

    res.json(config);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Disconnect a project (leaves .mica/ intact)
app.post("/api/projects/:project/disconnect", async (req, res) => {
  try {
    await deleteProject(req.params.project);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a project (backward compat — same as disconnect)
app.delete("/api/projects/:project", async (req, res) => {
  try {
    await deleteProject(req.params.project);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Canvas management ──────────────────────────────────────

app.post("/api/projects/:project/canvases", async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    await addCanvasToProject(req.params.project, name);
    res.json({ success: true, canvas: name });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Migration ─────────────────────────────────────────────

app.post("/api/migrate", async (req, res) => {
  try {
    const { targetDir } = req.body || {};
    const migrated = await migrateLegacyProjects(targetDir);
    res.json({ migrated: migrated.length, projects: migrated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Git endpoints (project-scoped) ────────────────────────

app.get("/api/projects/:project/git/status", async (req, res) => {
  try {
    const status = await getGitStatus(req.params.project);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/projects/:project/git/commit", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: "message required" });
    return;
  }
  try {
    const result = await gitCommit(req.params.project, message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:project/git/log", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const log = await gitLog(req.params.project, limit);
    res.json(log);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:project/git/diff", async (req, res) => {
  try {
    const ref = req.query.ref as string | undefined;
    const diff = await gitDiff(req.params.project, ref);
    res.json({ diff });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:project/git/branches", async (req, res) => {
  try {
    const info = await gitBranch(req.params.project);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/projects/:project/git/checkout", async (req, res) => {
  const { branch, create } = req.body;
  if (!branch) {
    res.status(400).json({ error: "branch required" });
    return;
  }
  try {
    await gitCheckout(req.params.project, branch, create);
    res.json({ success: true, branch });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Container endpoints (project-scoped) ──────────────────

app.post("/api/projects/:project/container/start", async (req, res) => {
  try {
    const info = await startProjectContainer(req.params.project);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/projects/:project/container/stop", async (req, res) => {
  try {
    await stopProjectContainer(req.params.project);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:project/container/status", async (req, res) => {
  try {
    const status = await getContainerStatus(req.params.project);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/projects/:project/container/logs", async (req, res) => {
  try {
    const tail = parseInt(req.query.tail as string) || 100;
    const logs = await getContainerLogs(req.params.project, tail);
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Agent endpoints (project-scoped) ──────────────────────

// Agent metadata for a canvas
app.get("/api/projects/:project/canvases/:canvas/agent", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  res.json(getAgentMeta(canvas));
});

// Chat with a specific canvas agent
app.post("/api/projects/:project/canvases/:canvas/chat", async (req, res) => {
  req.setTimeout(120000);
  res.setTimeout(120000);
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;

  const { message } = req.body;
  if (!message) {
    res.status(400).json({ error: "Message required" });
    return;
  }

  reactiveAgent.markBusy(project, canvas);
  try {
    const response = await routedChat(project, canvas, message);

    // If there's a pending consultation, forward it (Claude only)
    if (response.consultation) {
      const consultationResponse = await consultCanvas(
        project,
        canvas,
        response.consultation.targetCanvas,
        response.consultation.question,
        response.consultation.context
      );
      res.json({ response, consultationResponse });
      return;
    }

    res.json({ response });
  } catch (err: unknown) {
    const error = err as Error;
    console.error(`[${project}/${canvas}] Error:`, error.message);
    res.status(500).json({ error: error.message });
  } finally {
    reactiveAgent.clearBusy(project, canvas);
  }
});

// Team discussion — all agents in a project respond to a topic
app.post("/api/projects/:project/team/discuss", async (req, res) => {
  const { project } = req.params;
  const { topic } = req.body;
  if (!topic) {
    res.status(400).json({ error: "Topic required" });
    return;
  }

  try {
    const config = await getProjectConfig(project);
    if (!config) {
      res.status(404).json({ error: `Project not found: ${project}` });
      return;
    }
    const responses = await teamDiscuss(project, config.canvases);
    res.json({ responses });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[team] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Cross-canvas consultation
app.post("/api/projects/:project/consult", async (req, res) => {
  const { project } = req.params;
  const { fromCanvas, toCanvas, question, context } = req.body;

  try {
    const response = await consultCanvas(
      project,
      fromCanvas,
      toCanvas,
      question,
      context
    );
    res.json({ response });
  } catch (err: unknown) {
    const error = err as Error;
    console.error("[consult] Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// Reset conversations
app.post("/api/projects/:project/reset", (req, res) => {
  const { project } = req.params;
  const { canvas } = req.body;
  if (canvas) {
    resetCanvas(project, canvas);
    resetLocalCanvas(project, canvas);
  } else {
    resetAll();
    resetAllLocal();
  }
  res.json({ success: true });
});

// ── Project Card (top-level canvas card) ─────────────────────

// Get rendered project card (the layout shell)
app.get("/api/projects/:project/card", async (req, res) => {
  const { project } = req.params;
  try {
    const config = await getProjectConfig(project);
    if (!config) {
      res.status(404).json({ error: `Project not found: ${project}` });
      return;
    }

    // Read _project.project from .mica/ root (canvas = "_root")
    let projectContent = "";
    try {
      const f = await readCanvasFile(project, "_root", "_project.project");
      projectContent = f.content;
    } catch {
      // No _project.project yet — that's OK
    }

    // Get child card metadata (not rendered HTML)
    const files = await listFiles(project, "_root");
    const childMetas = [];
    for (const file of files) {
      if (file.name === "_project.project") continue; // Skip the project card itself
      if (file.name === ".chat-history.json") continue;
      if (file.name === ".config.json") continue;
      const meta = cardManager.resolveCardMeta(file.name, file.content);
      childMetas.push({
        filename: file.name,
        cardClass: meta.cardClass,
        title: meta.title,
        badge: meta.badge,
        isSystem: meta.isSystem,
      });
    }

    // Render the project card with children metadata in config
    const rendered = await cardManager.renderCard(
      project, "_root", "_project.project", projectContent,
      { projectName: config.name, children: childMetas }
    );
    res.json(rendered);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get rendered child cards for a project (individually rendered)
app.get("/api/projects/:project/children", async (req, res) => {
  const { project } = req.params;
  try {
    const files = await listFiles(project, "_root");
    const results = [];
    for (const file of files) {
      if (file.name === "_project.project") continue;
      if (file.name === ".chat-history.json") continue;
      if (file.name === ".config.json") continue;
      const rendered = await cardManager.renderCard(project, "_root", file.name, file.content);
      results.push({ filename: file.name, ...rendered });
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Canvas File Endpoints (project-scoped) ─────────────────

// List all files in a canvas
app.get("/api/projects/:project/canvases/:canvas/files", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const files = await listFiles(project, canvas);
    res.json(files);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a single file
app.get("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const file = await readCanvasFile(project, canvas, filename);
    res.json(file);
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Create or update a file
app.put("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  const { content } = req.body;
  if (!(await validateParams(res, project, canvas))) return;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    await writeCanvasFile(project, canvas, filename, content);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a file
app.delete("/api/projects/:project/canvases/:canvas/files/:filename", async (req, res) => {
  const { project, canvas, filename } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    await deleteCanvasFile(project, canvas, filename);
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (UI metadata, not a card) ────────────
app.get("/api/projects/:project/canvases/:canvas/layout", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const file = await readCanvasFile(project, canvas, ".layout.json");
    res.json(JSON.parse(file.content));
  } catch {
    res.json({});
  }
});

app.put("/api/projects/:project/canvases/:canvas/layout", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    await writeCanvasFile(project, canvas, ".layout.json", JSON.stringify(req.body, null, 2));
    res.json({ success: true });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Convert a drawing to mermaid via Claude Vision
app.post("/api/projects/:project/canvases/:canvas/convert-drawing", async (req, res) => {
  const { project, canvas } = req.params;
  const { imageBase64 } = req.body;
  if (!(await validateParams(res, project, canvas))) return;
  if (!imageBase64) {
    res.status(400).json({ error: "imageBase64 required" });
    return;
  }
  try {
    const result = await convertDrawingToMermaid(project, canvas, imageBase64);
    res.json(result);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Widget Card System ──────────────────────────────────────

const sandboxManager = new SandboxManager();
const executor = new ProjectExecutor(sandboxManager);
setAgentExecutor(executor);
setContainerExecutor(executor);
setSubagentExecutor(executor);
const cardManager = new CardManager();
const fileWatcher = new FileWatcher();

// ── Agent provider registry ──────────────────────────────────
const claudeProvider = new ClaudeProvider(executor);
const localProvider = new LocalProvider();
registerProvider(claudeProvider);
registerProvider(localProvider);

// Routed chat function — picks provider based on project config
const routedChat: typeof chatWithAgent = async (project, canvas, message, image?, onProgress?, resumeSessionId?) => {
  const providerName = await resolveAgentProvider(project);
  const provider = getProvider(providerName);
  if (provider) {
    return provider.chat(project, canvas, message, image, onProgress, resumeSessionId);
  }
  // Fallback to Claude if provider not found
  return chatWithAgent(project, canvas, message, image, onProgress, resumeSessionId);
};

const reactiveAgent = new ReactiveAgent(routedChat, broadcast);

// Wire agent write suppression — prevents reactive loops when agent writes files
const writeHook = (project: string, canvas: string, filename: string) => {
  reactiveAgent.markAgentWrite(project, canvas, filename);
};
setAgentWriteHook(writeHook);
setLocalAgentWriteHook(writeHook);
claudeProvider.setWriteHook(writeHook);
localProvider.setWriteHook(writeHook);

// RPC handler: Python card classes can call mica.write(), mica.agent.chat(), etc.
const rpcHandler = async (method: string, args: Record<string, unknown>, context: { project: string; canvas: string; filename: string }) => {
  const project = context.project as string;
  const canvas = context.canvas as string;

  switch (method) {
    case "write": {
      await writeCanvasFile(project, canvas, context.filename, args.content as string);
      return { success: true };
    }
    case "write_file": {
      await writeCanvasFile(project, canvas, args.filename as string, args.content as string);
      return { success: true };
    }
    case "read_file": {
      try {
        const file = await readCanvasFile(project, canvas, args.filename as string);
        return file.content;
      } catch {
        return null;
      }
    }
    case "log": {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${args.message}\n`;
      try {
        const existing = await readCanvasFile(project, canvas, "_log.log");
        await writeCanvasFile(project, canvas, "_log.log", existing.content + line);
      } catch {
        await writeCanvasFile(project, canvas, "_log.log", `# Activity Log\n\n${line}`);
      }
      return { success: true };
    }
    case "agent.chat": {
      reactiveAgent.markBusy(project, canvas);
      try {
        const response = await routedChat(project, canvas, args.message as string, undefined, (evt) => {
          broadcast({
            type: "agent-progress",
            project,
            canvas,
            event: evt.type,
            tool: evt.tool,
            elapsed: evt.elapsed,
            description: evt.description,
          });
        });
        return {
          message: response.message,
          agentName: getAgentMeta(canvas).name,
          filesChanged: response.filesChanged,
        };
      } finally {
        reactiveAgent.clearBusy(project, canvas);
      }
    }
    case "emit": {
      broadcast({ type: args.event as string, ...(args.data as Record<string, unknown> || {}) });
      return { success: true };
    }
    case "fetch": {
      // Network-gated: only cards with `network: true` in manifest can fetch.
      // Resolve card class from filename to check permission.
      const url = args.url as string;
      if (!url) throw new Error("mica.fetch(): url is required");

      let fileContent = "";
      try {
        const f = await readCanvasFile(project, canvas, context.filename);
        fileContent = f.content;
      } catch { /* empty */ }
      const { cardClass } = cardManager.resolveCardClass(context.filename, fileContent);
      if (!cardManager.hasNetworkPermission(cardClass)) {
        throw new Error(
          `mica.fetch() denied: card class "${cardClass}" does not have network permission. ` +
          `Add "network": true to the manifest entry to enable.`
        );
      }

      // Proxy the fetch through the server
      const fetchOpts = args.options as Record<string, unknown> || {};
      const response = await fetch(url, {
        method: (fetchOpts.method as string) || "GET",
        headers: (fetchOpts.headers as Record<string, string>) || {},
        body: fetchOpts.body ? String(fetchOpts.body) : undefined,
      });
      const body = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body,
      };
    }
    case "exec": {
      const command = args.command as string;
      if (!command) throw new Error("mica.exec(): command is required");
      return executor.exec(project, command, {
        cwd: args.cwd ? String(args.cwd) : undefined,
        timeout: (args.timeout as number) || undefined,
      });
    }
    default:
      throw new Error(`Unknown RPC method: ${method}`);
  }
};
sandboxManager.setRpcHandler(rpcHandler);

// MicaBridge factory — creates a bridge instance for a specific card context.
// Used when calling card class exports that need server-side mica operations.
function createMicaBridge(project: string, canvas: string, filename: string): MicaBridge {
  return {
    project,
    canvas,
    filename,
    send(data: unknown) {
      broadcast({ type: "card-data", project, canvas, filename, data });
    },
    reply(data: unknown) {
      broadcast({ type: "card-data", project, canvas, filename, data });
    },
    async readSelf() {
      const file = await readCanvasFile(project, canvas, filename);
      return file.content;
    },
    async writeSelf(content: string) {
      await writeCanvasFile(project, canvas, filename, content);
    },
    async read(fname: string) {
      const file = await readCanvasFile(project, canvas, fname);
      return file.content;
    },
    async write(filenameOrContent: string, content?: string) {
      if (content === undefined) {
        // write(content) — write to self
        await writeCanvasFile(project, canvas, filename, filenameOrContent);
      } else {
        // write(filename, content) — write to another file
        await writeCanvasFile(project, canvas, filenameOrContent, content);
      }
    },
    async exec(command: string, opts?: { cwd?: string; timeout?: number }) {
      return executor.exec(project, command, opts);
    },
    async log(message: string) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${message}\n`;
      try {
        const existing = await readCanvasFile(project, canvas, "_log.log");
        await writeCanvasFile(project, canvas, "_log.log", existing.content + line);
      } catch {
        await writeCanvasFile(project, canvas, "_log.log", `# Activity Log\n\n${line}`);
      }
    },
  };
}

// Get all rendered cards for a canvas
app.get("/api/projects/:project/canvases/:canvas/cards", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const cards = await cardManager.renderAllCards(project, canvas);
    res.json(cards);
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Call an export function on a card
app.post("/api/projects/:project/canvases/:canvas/cards/:filename/call/:fn", async (req, res) => {
  req.setTimeout(300000);
  res.setTimeout(300000);
  const { project, canvas, filename, fn } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const mica = createMicaBridge(project, canvas, filename);
    const result = await cardManager.callExport(project, canvas, filename, fn, req.body || {}, mica);
    res.json({ result });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Context stats — estimate token usage for agent calls
app.get("/api/projects/:project/canvases/:canvas/context-stats", async (req, res) => {
  const { project, canvas } = req.params;
  if (!(await validateParams(res, project, canvas))) return;
  try {
    const files = await listFiles(project, canvas);
    let totalChars = 0;
    const fileStats: { name: string; chars: number }[] = [];
    for (const f of files) {
      const chars = f.content.length;
      totalChars += chars;
      fileStats.push({ name: f.name, chars });
    }

    // Chat history size
    let chatHistoryChars = 0;
    const chatFile = files.find((f) => f.name === ".chat-history.json");
    if (chatFile) chatHistoryChars = chatFile.content.length;

    // Fixed system prompt ~2100 chars
    const systemPromptChars = 2100;
    const totalContextChars = totalChars + systemPromptChars;

    // Rough token estimate: ~4 chars per token for English text
    const estimatedTokens = Math.round(totalContextChars / 4);

    res.json({
      project,
      canvas,
      files: fileStats.length,
      fileContentChars: totalChars,
      systemPromptChars,
      chatHistoryChars,
      totalContextChars,
      estimatedTokens,
    });
  } catch (err: unknown) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Start ──────────────────────────────────────────────────

// Initialize projects (seed or migrate) on startup
initializeProjects().catch((err) =>
  console.error("Failed to initialize projects:", err.message)
);

// Express global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[express] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} is already in use. Kill the other process and retry.`);
  } else {
    console.error("[server] HTTP error:", err.message);
  }
  process.exit(1);
});

// WebSocket server for real-time card updates
const wss = new WebSocketServer({ server, path: "/ws/cards" });
const wsClients = new Set<WebSocket>();
const wsChannels = new Map<WebSocket, Set<string>>(); // ws → set of channel IDs
const agentManager = new AgentChannelManager(); // Agent card sessions (complex task protocol, kept separate)

// Unified channel manager — handles chat, terminal, and future card types.
// Transport-agnostic: index.ts is the WebSocket adapter.
const channelManager = new ChannelManager();

// Module-based channel handler — bridges card class stream exports (onConnect/onMessage/onDisconnect)
// to the ChannelHandler interface. Registered dynamically per card class when stream support is detected.
const moduleHandlerFactory = createModuleHandlerFactory({
  moduleLoader: cardManager.getModuleLoader(),
  getClassPath: (className, projectPath) => cardManager.getClassPath(className, projectPath),
  resolveCardClass: (filename, content) => cardManager.resolveCardClass(filename, content),
  getProjectPath,
  createExecFn: (project) => (command, opts) => executor.exec(project, command, opts),
});

/** Ensure a module-based handler is registered for a card class with stream exports. */
function ensureModuleHandler(cardClass: string): void {
  if (!channelManager.hasHandler(cardClass)) {
    channelManager.registerHandler(cardClass, moduleHandlerFactory);
  }
}

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);

  // Clean up channels when WebSocket disconnects.
  // channelManager.detach() is a soft close — sessions stay alive for reconnect.
  // Agent channels get hard-closed (they don't use the unified manager yet).
  const cleanupWsChannels = () => {
    wsClients.delete(ws);
    const channels = wsChannels.get(ws);
    if (channels) {
      for (const channelId of channels) {
        if (channelManager.has(channelId)) {
          channelManager.detach(channelId); // soft — session stays alive
        } else if (agentManager.has(channelId)) {
          agentManager.close(channelId);
        }
      }
      wsChannels.delete(ws);
    }
  };

  ws.on("close", cleanupWsChannels);
  ws.on("error", (err) => {
    console.error("[websocket] Connection error:", err.message);
    cleanupWsChannels();
  });

  // ── Full WebSocket message router ──
  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // Ignore invalid JSON
    }

    const { type, id, project, canvas, filename, fn, args } = msg as {
      type: string; id?: string; project?: string; canvas?: string;
      filename?: string; fn?: string; args?: Record<string, unknown>;
      event?: string; data?: unknown;
    };

    switch (type) {
      // Pattern 1: Request/Response (call + legacy export_call)
      case "call":
      case "export_call": {
        try {
          const mica = createMicaBridge(project as string, canvas as string, filename as string);
          const result = await cardManager.callExport(
            project as string, canvas as string, filename as string,
            fn as string, (args || {}) as Record<string, unknown>,
            mica
          );
          ws.send(JSON.stringify({ type: "result", id, result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      // Pattern 2: Fire-and-forget
      case "send": {
        const mica = createMicaBridge(project as string, canvas as string, filename as string);
        cardManager.callExport(
          project as string, canvas as string, filename as string,
          fn as string, (args || {}) as Record<string, unknown>,
          mica
        ).catch((err) => console.error(`[ws] send error:`, (err as Error).message));
        break;
      }

      // Pattern 4: Widget-to-widget broadcast
      case "broadcast": {
        const event = (msg as { event?: string }).event;
        const data = (msg as { data?: Record<string, unknown> }).data || {};
        if (event) {
          broadcast({ type: event, ...data });
        }
        break;
      }

      // Pattern 5: Bidirectional channel — open
      case "channel_open": {
        try {
          const fname = filename as string;
          const channelArgs = (args || {}) as Record<string, unknown>;
          const cid = id as string;
          const proj = project as string;
          const canv = canvas as string;

          const onData = (data: unknown) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "channel_data", id, data }));
            }
          };
          const onClose = () => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "channel_close", id }));
            }
            wsChannels.get(ws)?.delete(cid);
          };

          // Agent cards have a complex task protocol — keep separate for now
          if (fname.endsWith(".agent")) {
            agentManager.open(cid, proj, canv, fname, channelArgs, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
            break;
          }

          // Terminal cards need shell override from project container
          if (fname.endsWith(".terminal") || (fn as string) === "shell") {
            const shellOverride = await executor.getContainerShell(proj);
            channelArgs.spawnOverride = shellOverride;
          }

          // Try the unified channel manager (chat, terminal, module-based handlers)
          const cardClass = channelManager.resolveCardClass(fname);

          // If no handler registered yet, check if the card class has stream exports
          if (!channelManager.hasHandler(cardClass)) {
            const { cardClass: resolvedClass } = cardManager.resolveCardClass(fname);
            let projectPath: string | undefined;
            try { projectPath = await getProjectPath(proj); } catch { /* fallback */ }
            const classPath = cardManager.getClassPath(resolvedClass, projectPath);
            if (classPath) {
              const streamHandlers = await cardManager.getModuleLoader().getStreamHandlers(resolvedClass, classPath);
              if (streamHandlers) {
                ensureModuleHandler(cardClass);
              }
            }
          }

          if (channelManager.hasHandler(cardClass)) {
            await channelManager.open(cid, proj, canv, fname, fn as string, channelArgs, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
          } else {
            throw new Error(`No channel handler for card class "${cardClass}" (file: ${fname})`);
          }
        } catch (err) {
          console.error(`[ws] channel_open error for ${project}/${canvas}/${filename}#${fn}:`, (err as Error).message);
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
        }
        break;
      }

      // Pattern 5: Bidirectional channel — data
      case "channel_data": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.sendData(cid, (msg as { data?: unknown }).data);
        } else if (agentManager.has(cid)) {
          agentManager.sendData(cid, (msg as { data?: unknown }).data);
        }
        break;
      }

      // Pattern 5: Bidirectional channel — close (hard destroy from browser)
      case "channel_close": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.detach(cid);
        } else if (agentManager.has(cid)) {
          agentManager.close(cid);
        }
        wsChannels.get(ws)?.delete(cid);
        break;
      }
    }
  });
});

function broadcast(msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(data);
      } catch {
        wsClients.delete(ws);
      }
    }
  }
}

// Wire broadcast for agent lifecycle events
agentManager.setBroadcast(broadcast);

// File watcher → re-render + broadcast
fileWatcher.on("file-change", async (event: { type: string; project: string; canvas: string; filename: string }) => {
  // Dot-prefixed files are internal data — never reach here (filtered by fileWatcher)
  // but guard just in case
  if (event.filename.startsWith(".")) return;

  console.log(`[file-watcher] ${event.type}: ${event.project}/${event.canvas}/${event.filename}`);

  if (event.type === "deleted") {
    cardManager.invalidateCard(event.project, event.canvas, event.filename);
    // Destroy any channel session for this card file (tenet #4: lifecycle bound to user intent)
    channelManager.destroySession(event.project, event.canvas, event.filename);
    broadcast({ type: "file-deleted", project: event.project, canvas: event.canvas, filename: event.filename });
    return;
  }

  // Notify clients that a re-render is starting
  broadcast({ type: "file-rendering", project: event.project, canvas: event.canvas, filename: event.filename });

  // Re-render the changed card
  cardManager.invalidateCard(event.project, event.canvas, event.filename);
  try {
    const file = await readCanvasFile(event.project, event.canvas, event.filename);
    console.log(`[file-watcher] Rendering ${event.project}/${event.canvas}/${event.filename}...`);
    const rendered = await cardManager.renderCard(
      event.project,
      event.canvas,
      event.filename,
      file.content
    );
    // Auto-register module channel handler if card has stream exports
    if (rendered.hasStream && rendered.meta?.cardClass) {
      ensureModuleHandler(rendered.meta.cardClass);
    }

    console.log(`[file-watcher] Broadcasting ${event.type} for ${event.project}/${event.canvas}/${event.filename}`);
    broadcast({
      type: event.type === "created" ? "file-created" : "file-changed",
      project: event.project,
      canvas: event.canvas,
      filename: event.filename,
      html: rendered.html,
      exports: rendered.exports,
      dependencies: rendered.dependencies,
      hasStream: rendered.hasStream,
      meta: rendered.meta,
    });
  } catch (err) {
    console.error(`[file-watcher] Re-render failed for ${event.project}/${event.canvas}/${event.filename}:`, (err as Error).message);
  }

  // Notify reactive agent of the change (runs asynchronously)
  reactiveAgent.onFileChange(event);
});

// Card class changes → invalidate + re-render all instances
fileWatcher.on("class-change", async (event: { className: string }) => {
  console.log(`[file-watcher] Card class changed: ${event.className}`);
  cardManager.invalidateClass(event.className);

  // Re-render all cards that use this class across all projects/canvases
  try {
    const projects = await listProjects();
    for (const project of projects) {
      const config = await getProjectConfig(project.id);
      const canvases = config?.canvases || ["_root"];
      for (const canvas of canvases) {
        const files = await listFiles(project.id, canvas);
        for (const file of files) {
          if (file.name.startsWith(".")) continue;
          const { cardClass } = cardManager.resolveCardClass(file.name, file.content);
          if (cardClass === event.className) {
            try {
              const rendered = await cardManager.renderCard(project.id, canvas, file.name, file.content);
              console.log(`[file-watcher] Re-rendered ${project.id}/${canvas}/${file.name} (class: ${event.className})`);
              broadcast({
                type: "file-changed",
                project: project.id,
                canvas,
                filename: file.name,
                html: rendered.html,
                exports: rendered.exports,
                dependencies: rendered.dependencies,
                meta: rendered.meta,
              });
            } catch (err) {
              console.error(`[file-watcher] Re-render failed for ${file.name}:`, (err as Error).message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[file-watcher] Class re-render sweep failed:`, (err as Error).message);
  }
});

// Start everything
(async () => {
  try {
    await fileWatcher.start();
  } catch (err) {
    console.error("[startup] File watcher failed:", (err as Error).message);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║                   Mica AI Team Server                    ║
╠══════════════════════════════════════════════════════════╣
║  REST API:  http://localhost:${PORT}/api                     ║
║  WebSocket: ws://localhost:${PORT}/ws/cards                  ║
╠══════════════════════════════════════════════════════════╣
║  Card System:                                            ║
║    Module Loader: ES module card classes                  ║
║    Per-Project Sandboxes: Docker isolation               ║
║    Card Classes: card-classes/                           ║
║    File Watcher: active                                  ║
╠══════════════════════════════════════════════════════════╣
║  Security: CSP + env filtering + container isolation     ║
║  Auth: Claude Code subscription (Pro/Max)                ║
╚══════════════════════════════════════════════════════════╝
`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[shutdown] Stopping agents, terminals, sandboxes, and llama-server...");
    agentManager.closeAll();
    channelManager.destroyAll();
    await stopLlamaServer();
    await sandboxManager.stopAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
})();
