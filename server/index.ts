// Mica Server — multi-project planning canvas.
// Serves a workspace with project subdirectories.
// Each project has its own files, layout, canvas, and AI context.

// Load .env BEFORE any other import that reads process.env. Two locations,
// in order of precedence:
//   1. <PROJECT_DIR>/.env — user's workspace (Docker bind-mount target);
//      what a container user edits to set their keys/models.
//   2. <repo-root>/.env   — dev checkout; handy for local debugging.
// Variables already set in process.env (e.g. from `docker run -e`) win —
// dotenv's default `override: false` preserves them.
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { join as joinPath } from "node:path";
const _workspaceEnv = joinPath(process.env.PROJECT_DIR || "/project", ".env");
if (existsSync(_workspaceEnv)) dotenv.config({ path: _workspaceEnv });
dotenv.config();  // fallback: repo-root .env (and ambient process.env wins)

import express from "express";
import cors from "cors";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import {
  WORKSPACE_DIR,
  micaDir,
  projectDir,
  getWorkspaceName,
  getProjectName,
  listProjects,
  createProject,
  renameProject,
  deleteProject,
  initProject,
  cloneProjectFromRepo,
  listFiles,
  listCanvasFiles,
  readCanvasConfig,
  updateCanvasConfig,
  listSkills,
  readSkill,
  writeSkill,
  deleteSkill,
  listTemplates,
  createProjectFromTemplate,
  readProjectFile,
  resolveFilePath,
  writeProjectFile,
  deleteProjectFile,
  getOrCreateCardId,
  lookupCardId,
  deleteCardId,
  evictCardIdsForProject,
  readCardSettings,
  writeCardSettings,
  canonicalizeCardPath,
  readOpenRouterKey,
  writeOpenRouterKey,
  archiveChat,
  listArchivedChats,
  readArchivedChat,
  readChatCursor,
  readChatHistoryLength,
  writeChatCursor,
  DEFAULT_CANVAS_ROOT,
  DEFAULT_CANVAS_CLASS,
  BINARY_EXTS,
  isLikelyBinary,
  CONTEXT_SOFT_CAP_CHARS,
  getCardClassMeta,
  micaDir,
  validateProjectName,
  markProjectOpened,
  type FileMeta,
  type CardSettings,
} from "./files.js";
import { readSnapshot } from "./turnSnapshots.js";
import { readFile, writeFile, mkdir, stat as fsStat } from "fs/promises";
import { createWriteStream } from "fs";
import mimeTypes from "mime-types";
import { join } from "path";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { FileWatcher } from "./fileWatcher.js";
import { ChannelManager } from "./channelManager.js";
import { ensureLlamaServer, stopLlamaServer, getLlamaServerStatus } from "./llamaServer.js";
import { ensureVoiceServers, stopVoiceServers, getVoiceServerStatus, getSttUrl, getTtsUrl } from "./voiceServers.js";
import { SentenceFanout } from "./voiceStreaming.js";
import { chatHandler, setActiveProject as setChatProject } from "./micaChat.js";
import { createAgentHandler, setActiveProject as setAgentProject, buildContext as buildMicaAgentContext } from "./micaAgent.js";
import { createVoiceAgentHandler } from "./voiceAgent.js";
import { createClaudeAgentHandler, setActiveProject as setClaudeAgentProject, buildContext as buildClaudeAgentContext } from "./claudeAgent.js";
import { createOpencodeAgentHandler, setActiveProject as setOpencodeAgentProject } from "./opencodeAgent.js";
import { stopOpencodeServer } from "./opencodeServer.js";
import { registerAgentToolRoutes } from "./agentTools/restRoutes.js";
import { execHandler, setActiveProject as setExecProject } from "./plugins/exec.js";
import { fetchHandler } from "./plugins/micaFetch.js";
import { createPtyHandler, setActiveProject as setPtyProject } from "./plugins/pty.js";
import { createProcessHandler, manifest as processManifest } from "./plugins/processChannel.js";
import { createLlmChatHandler, manifest as llmDirectManifest } from "./plugins/llmChat.js";
import { createLlmAgentHandler, manifest as llmAgentManifest } from "./plugins/llmAgent.js";
import { getManifests } from "./handlerManifest.js";
import { createSkillComposeHandler } from "./plugins/skillCompose.js";
import { createCanvasBackComposeHandler } from "./plugins/canvasBackCompose.js";
import { registerGitEndpoints } from "./plugins/git.js";
import { markWriteSource, consumeWriteSource } from "./writeSource.js";
import { enforceCardClassMetadata, enforceCardJsLint, enforceDecompositionConsistency, enforceDependenciesReachable } from "./cardValidators.js";
import { SERVICES, getService, getAllStatuses, writePasteKey, deletePasteKey, type PasteKeyService } from "./connections.js";
import { recordValidatorError, clearValidatorError, getPendingValidatorErrors, clearProjectValidatorErrors, hasValidatorError } from "./validatorErrorBuffer.js";
import { resolveCapture, failCapture, renderHandler, setBroadcast as setScreenshotBroadcast } from "./screenshot.js";
import {
  setActivityBroadcast,
  getProjectActivity,
  clearProjectActivity,
  broadcastProjectListChanged,
} from "./projectActivity.js";

const execAsync = promisify(execCb);
const PORT = parseInt(process.env.MICA_PORT || "3002");

// ── Child-process reaper ─────────────────────────────────────
// On graceful shutdown OR after an uncaughtException, give spawned
// children (notably the qwen-code/sdk CLI subprocess per chat session)
// `graceMs` to exit on their own (their parents have already issued
// abort()); SIGKILL anyone still alive. Without this, children orphan
// to PID 1 and hold llama-server `-np` slots indefinitely.
async function reapChildProcesses(graceMs: number): Promise<void> {
  const { execSync } = await import("node:child_process");
  const pgrepChildren = (): number[] => {
    try {
      return execSync(`pgrep -P ${process.pid}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return []; // pgrep returns non-zero if no children — that's the success case
    }
  };

  const start = Date.now();
  while (Date.now() - start < graceMs) {
    if (pgrepChildren().length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }

  const survivors = pgrepChildren();
  for (const pid of survivors) {
    console.warn(`[shutdown] SIGKILLing surviving child pid=${pid}`);
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
}

/** Reap orphan opencode-serve processes left behind by previous Mica
 *  instances. Called at startup, before we spawn a fresh one. Without this,
 *  every dev-loop restart of Mica accumulates an opencode-serve hanging
 *  off PID 1 — they reach a stuck state on restart-time config changes
 *  (e.g. an earlier ConfigInvalidError) and the next user-loaded web UI
 *  may hit one of them by port. The pattern matches `opencode serve` in
 *  argv; safe because that string only appears in the headless server
 *  CLI, not in `opencode providers login` / `opencode tui`. */
async function reapOrphanOpencodeServers(): Promise<void> {
  const { execSync } = await import("node:child_process");
  let pids: number[] = [];
  try {
    pids = execSync(`pgrep -f "[.]opencode serve"`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  } catch { return; /* none alive */ }
  if (pids.length === 0) return;
  console.log(`[startup] reaping ${pids.length} orphan opencode-serve process(es) from prior runs: ${pids.join(", ")}`);
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
  }
  // Brief grace, then SIGKILL stragglers.
  await new Promise((r) => setTimeout(r, 800));
  for (const pid of pids) {
    try { process.kill(pid, 0); } catch { continue; /* already exited */ }
    try { process.kill(pid, "SIGKILL"); console.warn(`[startup] SIGKILL stale opencode-serve pid=${pid}`); } catch { /* gone */ }
  }
}

// ── Global error handlers ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  // Reap orphaned SDK CLI subprocesses before exiting. Without this,
  // qwen-code/sdk CLI children orphan to PID 1 and live forever, holding
  // llama-server slots and ~50-100MB RAM each. Async-bounded by the
  // 1.5s grace window inside reapChildProcesses; remaining 500ms before
  // exit covers any stragglers.
  setTimeout(async () => {
    await reapChildProcesses(1500);
    process.exit(1);
  }, 0);
});

// Install signal traps EARLY so a kill during llama-server boot still leaves
// a "received <SIG>" line in the log. The graceful shutdown that owns
// channelManager + llama-server cleanup runs later (in the startup IIFE) —
// these handlers are temporary log-only catchers replaced once the real
// shutdown is wired in. Order matters: kill -TERM during boot would otherwise
// die silently because the late handlers haven't been installed yet.
let _earlySignalLogger: NodeJS.SignalsListener | null = (sig) => {
  console.log(`[mica] received ${sig} during startup — exiting`);
  setTimeout(() => process.exit(0), 100);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as NodeJS.Signals[]) {
  process.on(sig, (s) => { if (_earlySignalLogger) _earlySignalLogger(s); });
}

const app = express();
app.use(cors());
// JSON body parser — skip binary upload + voice audio routes
const jsonParser = express.json({ limit: "5mb" });
app.use((req, res, next) => {
  if (req.method === "POST") {
    if (req.path.endsWith("/upload")) return next();
    // Voice routes that accept raw audio bodies; echo/transcribe both consume
    // a recorded blob from MediaRecorder, /synthesize takes JSON (handled by jsonParser).
    // Voice routes that accept raw audio bodies. /synthesize takes JSON
    // (handled by jsonParser); everything else here gets the raw stream.
    if (
      req.path === "/api/voice/echo" ||
      req.path === "/api/voice/converse" ||
      req.path === "/api/voice/transcribe"
    )
      return next();
  }
  jsonParser(req, res, next);
});

// ── CSP ──────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com",
      // wss: and https: schemes added so the page can open WebSockets +
      // fetches back to the same origin when served from any HTTPS host
      // (Tailscale Serve, Caddy, cloud LB, etc). 'self' alone is scheme-
      // sensitive in browsers — an HTTPS-served page would otherwise have
      // its WSS connection blocked.
      "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:* wss: https: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
      "img-src 'self' data: blob:",
      "font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    ].join("; ")
  );
  next();
});

// ── No-cache for API responses ───────────────────────────────
// Two projects can hit the same URL (e.g. /api/files/docs/spec.md) with
// different `X-Mica-Project` headers and get different bodies. Browsers
// cache by URL alone unless told otherwise — without this header the
// second project sees the first project's stale response.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "X-Mica-Project");
  next();
});

// ── Active project tracking ─────────────────────────────────
// Per-tab project comes from `X-Mica-Project` header (or `?project=` query)
// on every API call; channel sessions capture `ctx.project` at open time.
// No module-level fallback — stale globals caused test6-vs-bigtest1 mixups
// when multiple tabs/projects were open. getRequestProject() returns null
// if neither header nor query is set; callers handle the null explicitly.

const fileWatcher = new FileWatcher();

function getRequestProject(req: express.Request): string | null {
  // Validate at the request boundary so all downstream `join(WORKSPACE_DIR,
  // project, ...)` callsites are safe by construction. Without this gate, a
  // header like `X-Mica-Project: ../../etc` would let a request reach files
  // outside the workspace via path normalization (the file-watcher's
  // canvasRoot/.mica-internal layout, the OpenRouter key blob, etc.). Fail
  // closed: invalid name → null project (most endpoints already handle the
  // null case by returning the workspace-default scope, which is safer than
  // a 500 or a partial path).
  const tryName = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try { validateProjectName(trimmed); return trimmed; }
    catch { return null; }
  };
  const header = req.header("x-mica-project");
  if (typeof header === "string") {
    const v = tryName(header);
    if (v) return v;
  }
  const q = req.query.project;
  if (typeof q === "string") {
    const v = tryName(q);
    if (v) return v;
  }
  return null;
}

// `switchProject` is kept as a named-event emitter for logging and because the
// `/api/projects/:project/open` endpoint still calls it. The old setXxxProject
// shims are now no-ops in their respective modules (see micaAgent, claudeAgent,
// micaChat, exec, pty) — project scoping lives in ctx.project / request header.
function switchProject(projectName: string) {
  setChatProject(projectName);
  setAgentProject(projectName);
  setClaudeAgentProject(projectName);
  setOpencodeAgentProject(projectName);
  setExecProject(projectName);
  setPtyProject(projectName);
  console.log(`[mica] Active project: ${projectName}`);
}

// ── REST Endpoints ───────────────────────────────────────────

// Workspace info
app.get("/api/workspace", async (_req, res) => {
  const name = getWorkspaceName();
  res.json({ name, path: WORKSPACE_DIR });
});

// Backwards-compatible: /api/project returns active project info for this tab
app.get("/api/project", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) {
    res.json({ name: getWorkspaceName(), path: WORKSPACE_DIR });
    return;
  }
  const name = await getProjectName(proj);
  res.json({ name, path: projectDir(proj), project: proj });
});

// ── Projects ────────────────────────────────────────────────

// List all projects
app.get("/api/projects", async (_req, res) => {
  try {
    const projects = await listProjects();
    // Enrich with current activity state so the project-list page renders
    // the live "active" badge on initial load. Subsequent updates arrive
    // via project-activity-changed broadcasts.
    const enriched = projects.map((p) => ({
      ...p,
      ...getProjectActivity(p.name),
    }));
    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new project
app.post("/api/projects", async (req, res) => {
  const { name, docsDir, template } = req.body as { name?: string; docsDir?: string; template?: string };
  if (!name) {
    res.status(400).json({ error: "name required" });
    return;
  }
  try {
    if (template) {
      await createProjectFromTemplate(name, template);
    } else {
      await createProject(name, docsDir || DEFAULT_CANVAS_ROOT);
    }
    broadcastProjectListChanged();
    res.json({ success: true, name, template: template || null });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Clone a git repo as a new project. Optionally overlay a template on top
// (for skills, agents, canvas-back, seed cards) — the clone's own files are
// preserved; the template fills gaps around them.
app.post("/api/projects/clone", async (req, res) => {
  const { url, name, docsDir, template } = req.body as {
    url?: string; name?: string; docsDir?: string; template?: string;
  };
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    const projectName = name || url.split("/").pop()?.replace(/\.git$/, "") || "project";
    await cloneProjectFromRepo(projectName, url, {
      templateName: template || undefined,
      canvasRoot: docsDir || undefined,
    });
    broadcastProjectListChanged();
    res.json({ success: true, name: projectName, template: template || null });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Rename a project
app.put("/api/projects/:project/rename", async (req, res) => {
  const { newName } = req.body as { newName?: string };
  if (!newName) {
    res.status(400).json({ error: "newName required" });
    return;
  }
  try {
    const oldName = req.params.project;
    // Force-release the watcher for this project before mutating its directory.
    // (Subscribers still attached at the WS level will be cleaned up on disconnect.)
    while (fileWatcher.watchedProjects().includes(oldName)) {
      fileWatcher.releaseProject(oldName);
    }
    // Tear down channel sessions and cardId caches keyed to the old name.
    // Otherwise sessions captured the old project in their handler closure
    // and would keep reading/writing the now-stale path (chat history reads
    // come back empty, the card looks confused).
    channelManager.destroyAllForProject(oldName);
    evictCardIdsForProject(oldName);
    clearProjectValidatorErrors(oldName);
    await renameProject(oldName, newName);
    // Activity counters were keyed by the old name; clear them so they
    // don't appear under a stale identity if the old name is reused later.
    clearProjectActivity(oldName);
    broadcastProjectListChanged();
    res.json({ success: true, name: newName });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Delete a project
app.delete("/api/projects/:project", async (req, res) => {
  try {
    const name = req.params.project;
    while (fileWatcher.watchedProjects().includes(name)) {
      fileWatcher.releaseProject(name);
    }
    channelManager.destroyAllForProject(name);
    evictCardIdsForProject(name);
    clearProjectValidatorErrors(name);
    await deleteProject(name);
    clearProjectActivity(name);
    broadcastProjectListChanged();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Open/activate a project (switches file watcher, initializes .mica if needed)
app.post("/api/projects/:project/open", async (req, res) => {
  const name = req.params.project;
  const t0 = Date.now();
  try {
    const dir = projectDir(name);
    if (!existsSync(dir)) {
      res.status(404).json({ error: `Project not found: ${name}` });
      return;
    }
    // Initialize .mica if not present
    if (!existsSync(join(dir, ".mica"))) {
      const { docsDir } = req.body as { docsDir?: string };
      await initProject(name, docsDir || DEFAULT_CANVAS_ROOT);
    }
    const tAfterInit = Date.now();
    switchProject(name);
    const tAfterSwitch = Date.now();

    // Touch the last-opened marker so the project list can sort by recency.
    // Best-effort — failure is logged in the helper, doesn't fail the open.
    await markProjectOpened(name);

    const displayName = await getProjectName(name);
    const tAfterName = Date.now();
    console.log(`[timing] /projects/${name}/open total=${tAfterName - t0}ms init=${tAfterInit - t0}ms switch=${tAfterSwitch - tAfterInit}ms name=${tAfterName - tAfterSwitch}ms`);
    res.json({ success: true, name: displayName, project: name });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card Classes ─────────────────────────────────────────────

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

// Resolve card class directory: project .mica/card-classes/:name first, then built-in
function resolveCardClassDir(className: string, project: string | null): string | null {
  if (project) {
    const projectScoped = join(micaDir(project), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html"))) return projectScoped;
  }
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html"))) return builtIn;
  return null;
}

// Serve any file from a card class directory
const cardClassServeCount = { n: 0, bytes: 0, windowStart: Date.now() };
app.get("/api/card-classes/:className/:file", async (req, res) => {
  const dir = resolveCardClassDir(req.params.className, getRequestProject(req));
  if (!dir) {
    res.status(404).json({ error: `Card class not found: ${req.params.className}` });
    return;
  }
  cardClassServeCount.n++;
  if (Date.now() - cardClassServeCount.windowStart > 5000 || cardClassServeCount.n === 1) {
    // Roll-up log every 5s so we don't spam the console per-file.
    if (cardClassServeCount.n > 1) console.log(`[timing] card-class file serves: ${cardClassServeCount.n} in the last window (~${Math.round((Date.now() - cardClassServeCount.windowStart) / 100) / 10}s)`);
    cardClassServeCount.n = 0;
    cardClassServeCount.windowStart = Date.now();
  }
  const fileName = req.params.file;
  const allowed = ["card.html", "card.js", "card.css", "metadata.json", "spec.md"];
  if (!allowed.includes(fileName)) {
    res.status(403).json({ error: `Not allowed: ${fileName}` });
    return;
  }
  try {
    const content = await readFile(join(dir, fileName), "utf-8");
    const types: Record<string, string> = {
      ".js": "application/javascript", ".html": "text/html", ".css": "text/css",
      ".json": "application/json", ".md": "text/markdown",
    };
    const ext = fileName.substring(fileName.lastIndexOf("."));
    res.type(types[ext] || "text/plain").send(content);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// List available card classes
app.get("/api/card-classes", async (req, res) => {
  const { readdir: rd } = await import("fs/promises");
  const classes: Record<string, unknown> = {};

  // Built-in
  try {
    const entries = await rd(CARD_CLASSES_DIR);
    for (const name of entries) {
      const dir = join(CARD_CLASSES_DIR, name);
      if (existsSync(join(dir, "card.html"))) {
        classes[name] = {
          builtIn: true,
          format: "html",
          hasCss: existsSync(join(dir, "card.css")),
          hasJs: existsSync(join(dir, "card.js")),
          hasMetadata: existsSync(join(dir, "metadata.json")),
        };
      }
    }
  } catch { /* no card-classes dir */ }

  // Project-scoped (overrides built-in)
  const reqProject = getRequestProject(req);
  if (reqProject) {
    try {
      const projDir = join(micaDir(reqProject), "card-classes");
      const entries = await rd(projDir);
      for (const name of entries) {
        const dir = join(projDir, name);
        if (existsSync(join(dir, "card.html"))) {
          classes[name] = {
            builtIn: false,
            format: "html",
            hasCss: existsSync(join(dir, "card.css")),
            hasJs: existsSync(join(dir, "card.js")),
            hasMetadata: existsSync(join(dir, "metadata.json")),
          };
        }
      }
    } catch { /* no project card-classes */ }
  }

  // Decorate with the `meta` flag from each class's metadata.json so the
  // canvas toolbar can hide infrastructure cards (canvas-back, skills)
  // without hard-coding their names. Client-side filtering only — this
  // endpoint still returns the full list so CardRuntime / CardFrame can
  // find the class for already-placed meta cards.
  for (const name of Object.keys(classes)) {
    try {
      const m = await getCardClassMeta(`.${name}`, reqProject);
      (classes[name] as Record<string, unknown>).meta = m.meta;
    } catch { /* leave meta undefined */ }
  }

  res.json(classes);
});

// Channel-handler registry — each entry describes a built-in (or developer-
// registered) handler that card classes can opt into via metadata.handler.
// Authoring agents discover available handlers here instead of carrying
// per-handler documentation in their permanent system prompt. Adding a new
// plugin's manifest grows this endpoint, NOT the skill prose.
app.get("/api/handlers", (_req, res) => {
  res.json(getManifests());
});

// Render the canvas card (assembles card.html + card.css + card.js)
app.get("/api/canvas-card", async (req, res) => {
  const t0 = Date.now();
  try {
    const reqProject = getRequestProject(req);
    let canvasClass = DEFAULT_CANVAS_CLASS;
    if (reqProject) {
      try {
        const cfg = JSON.parse(await readFile(join(micaDir(reqProject), "config.json"), "utf-8"));
        if (cfg.canvasClass) canvasClass = cfg.canvasClass;
      } catch { /* use default */ }
    }
    const classDir = resolveCardClassDir(canvasClass, reqProject);
    if (!classDir) throw new Error(`Canvas card class not found: ${canvasClass}`);

    const cardHtml = await readFile(join(classDir, "card.html"), "utf-8");

    let cardCss = "";
    try { cardCss = await readFile(join(classDir, "card.css"), "utf-8"); } catch { /* no card.css */ }

    let cardJs = "";
    try { cardJs = await readFile(join(classDir, "card.js"), "utf-8"); } catch { /* no card.js */ }

    let meta: Record<string, unknown> = {};
    let deps: { scripts?: string[]; styles?: string[] } = {};
    try {
      const raw = await readFile(join(classDir, "metadata.json"), "utf-8");
      meta = JSON.parse(raw);
      deps = (meta.dependencies as { scripts?: string[]; styles?: string[] }) || {};
    } catch { /* no metadata.json */ }

    const html =
      cardHtml +
      (cardCss ? `<style>${cardCss}</style>` : "") +
      (cardJs ? `<script>${cardJs}</script>` : "");

    console.log(`[timing] /canvas-card proj=${reqProject || "(none)"} class=${canvasClass} total=${Date.now() - t0}ms htmlBytes=${html.length}`);
    res.json({ html, exports: [], dependencies: deps, meta });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Per-card settings + per-project secrets ─────────────────
//
// Settings live in the existing `.mica/cards/<sanitized>.id.json` sidecar
// alongside the UUID. The OpenRouter API key is project-wide (one key, many
// cards) and lives in `.mica/config.json`. The GET key endpoint never returns
// the key itself — only `{ hasKey }` — so the client can render a "Key set ✓"
// indicator without exposing the secret.

// Cards send their canvas-relative `mica.filename` (e.g. "qwen.chat" with no
// canvasRoot prefix) when reading/writing their settings. The agent reads
// settings later via the project-relative SessionContext filename
// (e.g. "canvas/qwen.chat"). Canonicalize incoming paths to project-relative
// here so save/load both land on the same sidecar regardless of which form
// the client sent.
async function canonicalizeSettingsPath(rawPath: string, project: string | undefined): Promise<string> {
  const cfg = await readCanvasConfig(project);
  return canonicalizeCardPath(rawPath, cfg.canvasRoot);
}

app.get("/api/cards/settings", async (req, res) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path) { res.status(400).json({ error: "missing ?path=<filename>" }); return; }
  const proj = getRequestProject(req) || undefined;
  try {
    const canonical = await canonicalizeSettingsPath(path, proj);
    const settings = await readCardSettings(proj, canonical);
    res.json(settings);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put("/api/cards/settings", async (req, res) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path) { res.status(400).json({ error: "missing ?path=<filename>" }); return; }
  const proj = getRequestProject(req) || undefined;
  const body = (req.body || {}) as CardSettings;
  const provider = body.provider === "openrouter" ? "openrouter" : "local";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const settings: CardSettings = { provider };
  if (model) settings.model = model;
  try {
    const canonical = await canonicalizeSettingsPath(path, proj);
    await writeCardSettings(proj, canonical, settings);
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/openrouter-key", async (req, res) => {
  const proj = getRequestProject(req) || undefined;
  const key = await readOpenRouterKey(proj);
  res.json({ hasKey: Boolean(key) });
});

app.put("/api/openrouter-key", async (req, res) => {
  const proj = getRequestProject(req) || undefined;
  const body = (req.body || {}) as { key?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  await writeOpenRouterKey(proj, key);
  res.json({ ok: true, hasKey: Boolean(key) });
});

// Validate an OpenRouter (key, model) pair against openrouter.ai before persisting.
// Returns { ok, errors: { key?, model? }, warning? } — `warning` is used when
// the network call failed and we fell back to "unverified".
//
// Key check: GET /api/v1/auth/key with Authorization: Bearer — 200 = valid, 401/403 = invalid.
// Model check: GET /api/v1/models (public) — the `model` string must appear as `id` in the list.
app.post("/api/openrouter/validate", async (req, res) => {
  const body = (req.body || {}) as { key?: string; model?: string };
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const errors: { key?: string; model?: string } = {};

  if (!key && !model) { res.json({ ok: true, errors }); return; }

  try {
    const calls: Promise<unknown>[] = [];
    if (key) {
      calls.push(fetch("https://openrouter.ai/api/v1/auth/key", {
        method: "GET",
        headers: { "Authorization": `Bearer ${key}` },
        signal: AbortSignal.timeout(8000),
      }).then(async (r) => {
        if (r.status === 401 || r.status === 403) { errors.key = "Invalid OpenRouter API key (rejected by openrouter.ai)"; }
        else if (!r.ok) { errors.key = `OpenRouter returned HTTP ${r.status} while validating the key`; }
      }));
    }
    if (model) {
      calls.push(fetch("https://openrouter.ai/api/v1/models", {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      }).then(async (r) => {
        if (!r.ok) { errors.model = `Could not list models (HTTP ${r.status})`; return; }
        const data = await r.json() as { data?: Array<{ id?: string }> };
        const ids = new Set((data.data || []).map((m) => m.id).filter((x): x is string => typeof x === "string"));
        if (!ids.has(model)) { errors.model = `Model "${model}" not found on OpenRouter`; }
      }));
    }
    await Promise.all(calls);
    res.json({ ok: Object.keys(errors).length === 0, errors });
  } catch (err) {
    // Network/DNS/timeout — treat as "unverified" rather than a hard failure.
    const msg = (err as Error).message || String(err);
    res.json({ ok: true, errors: {}, warning: `Could not verify: ${msg}` });
  }
});

// List available OpenRouter models. Proxies the public OpenRouter endpoint
// and caches in-memory for an hour — the catalog is stable on minute-to-hour
// timescales, the chat card hits this once per settings-panel-open, and a
// 1h TTL is invisible to users while sparing OpenRouter from a fan-out hit.
// No auth required (public catalog). Returns slim shape including pricing
// (per-million-tokens, since that's how model prices are universally quoted)
// and context length.
type ModelEntry = {
  id: string;
  name?: string;
  promptPerM?: number;       // USD per million prompt tokens
  completionPerM?: number;   // USD per million completion tokens
  contextLength?: number;    // tokens
};
let _modelsCache: { ts: number; data: ModelEntry[] } | null = null;
const MODELS_TTL_MS = 60 * 60 * 1000;

function parseUsdPerToken(v: unknown): number | undefined {
  // OpenRouter returns prices as strings in USD-per-token. Convert to USD per
  // million tokens for human-readable display ($5/M reads more cleanly than
  // 0.000005 per token). Empty string / missing / NaN → undefined.
  if (typeof v !== "string" || !v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n * 1_000_000;
}

app.get("/api/openrouter/models", async (_req, res) => {
  if (_modelsCache && Date.now() - _modelsCache.ts < MODELS_TTL_MS) {
    res.json({ ok: true, models: _modelsCache.data, cached: true });
    return;
  }
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8000) });
    if (!r.ok) {
      res.status(502).json({ ok: false, error: `OpenRouter returned ${r.status}` });
      return;
    }
    const json = await r.json() as {
      data?: Array<{
        id?: unknown;
        name?: unknown;
        pricing?: { prompt?: unknown; completion?: unknown };
        context_length?: unknown;
      }>;
    };
    const models: ModelEntry[] = (json.data || [])
      .filter((m) => typeof m.id === "string" && m.id)
      .map((m) => {
        const entry: ModelEntry = { id: m.id as string };
        if (typeof m.name === "string" && m.name) entry.name = m.name;
        const promptPerM = parseUsdPerToken(m.pricing?.prompt);
        const completionPerM = parseUsdPerToken(m.pricing?.completion);
        if (promptPerM !== undefined) entry.promptPerM = promptPerM;
        if (completionPerM !== undefined) entry.completionPerM = completionPerM;
        if (typeof m.context_length === "number" && m.context_length > 0) entry.contextLength = m.context_length;
        return entry;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    _modelsCache = { ts: Date.now(), data: models };
    res.json({ ok: true, models, cached: false });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
});

// ── Voice (STT + TTS sidecars) ──────────────────────────────
//
// Three endpoints:
//   GET  /api/voice/status      — sidecar readiness for the voice-hello card
//   POST /api/voice/echo        — audio in → STT → TTS same text → audio out (hello-world round-trip)
//   POST /api/voice/synthesize  — JSON {text} → audio out (used by future TTS-only flows)
//
// /api/voice/transcribe (audio → text only) is reserved but not wired in
// hello-world; /echo covers it. Add later if a card needs the split.

app.get("/api/voice/status", (_req, res) => {
  res.json(getVoiceServerStatus());
});

// /api/voice/echo — the hello-world round-trip. Accepts a recorded audio
// blob from the browser's MediaRecorder (any format librosa can decode:
// webm/opus, ogg, m4a, wav). Forwards to the STT sidecar, then forwards
// the transcribed text to the TTS sidecar, then streams the resulting
// WAV back. The transcript is returned in the X-Transcript header so the
// card can display "you said: ..." alongside playback.
app.post("/api/voice/echo", async (req, res) => {
  const status = getVoiceServerStatus();
  if (status.disabled) {
    res.status(503).json({ error: "Voice servers disabled (MICA_DISABLE_VOICE=1)" });
    return;
  }
  // Self-heal: if a sidecar died (or hasn't been started since boot),
  // ensureVoiceServers respawns it. Cheap when already running.
  if (!status.stt.ready || !status.tts.ready) {
    try {
      await ensureVoiceServers();
    } catch (err) {
      res.status(503).json({
        error: `Voice servers not ready: ${(err as Error).message}`,
        stt_ready: status.stt.ready,
        tts_ready: status.tts.ready,
      });
      return;
    }
  }

  // Buffer the audio body. Express won't have parsed it (we skip jsonParser
  // for /api/voice/echo above). Use Node streams directly.
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const MAX_BYTES = 50 * 1024 * 1024;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          reject(new Error("audio too large (50MB limit)"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const audioBuf = Buffer.concat(chunks);
  const audioContentType = req.headers["content-type"] || "application/octet-stream";

  // 1. POST to STT sidecar as multipart/form-data. FormData is built-in
  //    on modern Node; Blob too.
  let transcript = "";
  try {
    const sttForm = new FormData();
    sttForm.append(
      "audio",
      new Blob([audioBuf], { type: audioContentType }),
      "audio.webm",
    );
    const sttResp = await fetch(`${getSttUrl()}/transcribe`, {
      method: "POST",
      body: sttForm,
    });
    if (!sttResp.ok) {
      const errText = await sttResp.text();
      res.status(502).json({ error: `STT failed: ${sttResp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const sttJson = (await sttResp.json()) as { text?: string };
    transcript = (sttJson.text || "").trim();
  } catch (err) {
    res.status(502).json({ error: `STT request failed: ${(err as Error).message}` });
    return;
  }

  if (!transcript) {
    // Empty transcription — likely silence or unintelligible. Return a
    // friendly synthesized response so the card has SOMETHING to play.
    transcript = "(silence detected — try speaking louder)";
  }

  // 2. POST to TTS sidecar.
  let wavBytes: ArrayBuffer;
  try {
    const ttsResp = await fetch(`${getTtsUrl()}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: transcript }),
    });
    if (!ttsResp.ok) {
      const errText = await ttsResp.text();
      res.status(502).json({ error: `TTS failed: ${ttsResp.status} ${errText.slice(0, 300)}` });
      return;
    }
    wavBytes = await ttsResp.arrayBuffer();
  } catch (err) {
    res.status(502).json({ error: `TTS request failed: ${(err as Error).message}` });
    return;
  }

  // 3. Stream the WAV back. Transcript goes in a header so the card can
  //    display it alongside the audio. URI-encode for header safety.
  res.setHeader("content-type", "audio/wav");
  res.setHeader("x-transcript", encodeURIComponent(transcript));
  res.setHeader("cache-control", "no-store");
  res.send(Buffer.from(wavBytes));
});

// /api/voice/converse — streaming voice round-trip with the LLM in the
// loop. Audio in → STT → llama-server stream → per-sentence TTS → NDJSON
// frames out. The browser plays audio as each sentence's WAV arrives,
// so the user hears the response start before the LLM has finished
// generating the rest of it.
//
// Response framing: one JSON object per line ("\n"-terminated), Content-Type
// application/x-ndjson. Frames:
//   {"type":"transcript", "text": <STT result>}                        — emitted once
//   {"type":"sentence",   "idx": N, "text": <sentence>}                — per sentence
//   {"type":"audio",      "idx": N, "wav_b64": <base64 WAV>}           — per sentence
//   {"type":"done", "elapsed_ms": N, "first_audio_ms": N}              — terminal
//   {"type":"error", "message": <str>}                                 — on failure
//
// Sentence boundary: [.!?] followed by whitespace or end-of-stream. Splits
// abbreviations like "Dr." but acceptable for hello-world.
app.post("/api/voice/converse", async (req, res) => {
  const status = getVoiceServerStatus();
  if (status.disabled) {
    res.status(503).json({ error: "Voice servers disabled (MICA_DISABLE_VOICE=1)" });
    return;
  }
  if (!status.stt.ready || !status.tts.ready) {
    try {
      await ensureVoiceServers();
    } catch (err) {
      res.status(503).json({
        error: `Voice servers not ready: ${(err as Error).message}`,
      });
      return;
    }
  }

  // Buffer the audio body (same pattern as /echo).
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const MAX_BYTES = 50 * 1024 * 1024;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          reject(new Error("audio too large (50MB limit)"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const audioBuf = Buffer.concat(chunks);
  const audioContentType = req.headers["content-type"] || "application/octet-stream";

  // Switch into streaming mode early so the client can render "Listening…"
  // → "Thinking…" before the first audio arrives.
  res.setHeader("content-type", "application/x-ndjson");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-accel-buffering", "no");
  res.flushHeaders?.();
  const t0 = Date.now();
  let firstAudioAt: number | null = null;

  const writeFrame = (frame: object): boolean => {
    return res.write(JSON.stringify(frame) + "\n");
  };

  // 1. STT.
  let transcript = "";
  try {
    const sttForm = new FormData();
    sttForm.append("audio", new Blob([audioBuf], { type: audioContentType }), "audio.webm");
    const sttResp = await fetch(`${getSttUrl()}/transcribe`, { method: "POST", body: sttForm });
    if (!sttResp.ok) {
      writeFrame({ type: "error", message: `STT failed: ${sttResp.status} ${(await sttResp.text()).slice(0, 300)}` });
      res.end();
      return;
    }
    const sttJson = (await sttResp.json()) as { text?: string };
    transcript = (sttJson.text || "").trim();
  } catch (err) {
    writeFrame({ type: "error", message: `STT request failed: ${(err as Error).message}` });
    res.end();
    return;
  }
  writeFrame({ type: "transcript", text: transcript });

  if (!transcript) {
    writeFrame({ type: "sentence", idx: 0, text: "I didn't catch that." });
    // Synthesize a one-liner so the user hears something.
    try {
      const ttsResp = await fetch(`${getTtsUrl()}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "I didn't catch that." }),
      });
      if (ttsResp.ok) {
        const wavBuf = Buffer.from(await ttsResp.arrayBuffer());
        firstAudioAt = Date.now();
        writeFrame({ type: "audio", idx: 0, wav_b64: wavBuf.toString("base64") });
      }
    } catch {
      /* ignore — done frame still fires */
    }
    writeFrame({
      type: "done",
      elapsed_ms: Date.now() - t0,
      first_audio_ms: firstAudioAt ? firstAudioAt - t0 : null,
    });
    res.end();
    return;
  }

  // 2. LLM stream + sentence-buffered TTS via SentenceFanout helper. Each
  //    LLM delta is `feed()`d in; the helper cuts on sentence boundaries,
  //    fires TTS in parallel, and calls `onFrame` with sentence/audio frames
  //    in order.
  const fanout = new SentenceFanout({
    ttsUrl: getTtsUrl(),
    onFrame: (frame) => {
      if (frame.type === "sentence") {
        writeFrame({ type: "sentence", idx: frame.idx, text: frame.text });
      } else if (frame.type === "audio") {
        if (firstAudioAt === null) firstAudioAt = Date.now();
        writeFrame({ type: "audio", idx: frame.idx, wav_b64: frame.wavB64 });
      } else {
        writeFrame({ type: "error", message: frame.message });
      }
    },
  });

  try {
    const llmResp = await fetch(`http://127.0.0.1:8012/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "voice",
        messages: [
          {
            role: "system",
            content:
              "You are Mica's voice assistant. Reply in 1–2 short conversational sentences. " +
              "No markdown, no lists, no code. Plain spoken English only.",
          },
          { role: "user", content: transcript },
        ],
        max_tokens: 256,
        temperature: 0.6,
        stream: true,
        // Skip Qwen3.6's chain-of-thought — it'd waste TTFT and we're
        // generating short voice replies, not reasoning.
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    if (!llmResp.ok) {
      writeFrame({
        type: "error",
        message: `LLM error (${llmResp.status}): ${(await llmResp.text()).slice(0, 300)}`,
      });
      res.end();
      return;
    }

    // Parse SSE: lines starting with "data: ", terminated by "data: [DONE]".
    const reader = llmResp.body as unknown as AsyncIterable<Uint8Array>;
    const decoder = new TextDecoder();
    let sseBuf = "";
    for await (const chunk of reader) {
      sseBuf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = sseBuf.indexOf("\n")) !== -1) {
        const line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        try {
          const obj = JSON.parse(payload);
          const delta: string = obj?.choices?.[0]?.delta?.content || "";
          if (delta) fanout.feed(delta);
        } catch {
          /* malformed line — skip */
        }
      }
    }
  } catch (err) {
    writeFrame({ type: "error", message: `LLM stream failed: ${(err as Error).message}` });
    res.end();
    return;
  }

  // Flush any trailing remainder as a final sentence (no terminal punctuation),
  // then wait for all in-flight TTS to emit before sending `done`.
  fanout.end();
  await fanout.drain();
  writeFrame({
    type: "done",
    elapsed_ms: Date.now() - t0,
    first_audio_ms: firstAudioAt ? firstAudioAt - t0 : null,
  });
  res.end();
});

// /api/voice/synthesize — text in (JSON), audio/wav out. Lighter-weight
// than /echo for cards that only need TTS (e.g. an "agent speaks its
// reply" toggle on a normal chat card).
app.post("/api/voice/synthesize", async (req, res) => {
  const status = getVoiceServerStatus();
  if (status.disabled) {
    res.status(503).json({ error: "Voice servers disabled" });
    return;
  }
  if (!status.tts.ready) {
    res.status(503).json({ error: "TTS server not ready yet" });
    return;
  }
  const body = (req.body || {}) as { text?: string; voice?: string };
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  try {
    const ttsResp = await fetch(`${getTtsUrl()}/synthesize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: body.voice }),
    });
    if (!ttsResp.ok) {
      const errText = await ttsResp.text();
      res.status(502).json({ error: `TTS failed: ${ttsResp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const wavBytes = await ttsResp.arrayBuffer();
    res.setHeader("content-type", "audio/wav");
    res.setHeader("cache-control", "no-store");
    res.send(Buffer.from(wavBytes));
  } catch (err) {
    res.status(502).json({ error: `TTS request failed: ${(err as Error).message}` });
  }
});

// /api/voice/transcribe — STT-only convenience for cards (e.g. mica.listen()).
// Audio body in (any format librosa can decode), JSON `{ transcript, durationMs }` out.
// Distinct from /echo (which also does TTS) and /converse (which also runs the LLM).
app.post("/api/voice/transcribe", async (req, res) => {
  const status = getVoiceServerStatus();
  if (status.disabled) {
    res.status(503).json({ error: "Voice servers disabled (MICA_DISABLE_VOICE=1)" });
    return;
  }
  if (!status.stt.ready) {
    try {
      await ensureVoiceServers();
    } catch (err) {
      res.status(503).json({ error: `STT server not ready: ${(err as Error).message}` });
      return;
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const MAX_BYTES = 50 * 1024 * 1024;
  try {
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BYTES) {
          reject(new Error("audio too large (50MB limit)"));
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", reject);
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return;
  }
  const audioBuf = Buffer.concat(chunks);
  const audioContentType = req.headers["content-type"] || "application/octet-stream";

  const t0 = Date.now();
  try {
    const sttForm = new FormData();
    sttForm.append("audio", new Blob([audioBuf], { type: audioContentType }), "audio.webm");
    const sttResp = await fetch(`${getSttUrl()}/transcribe`, { method: "POST", body: sttForm });
    if (!sttResp.ok) {
      const errText = await sttResp.text();
      res.status(502).json({ error: `STT failed: ${sttResp.status} ${errText.slice(0, 300)}` });
      return;
    }
    const sttJson = (await sttResp.json()) as { text?: string; duration_s?: number };
    res.json({
      transcript: (sttJson.text || "").trim(),
      durationMs: Date.now() - t0,
      audioDurationS: typeof sttJson.duration_s === "number" ? sttJson.duration_s : null,
    });
  } catch (err) {
    res.status(502).json({ error: `STT request failed: ${(err as Error).message}` });
  }
});

// ── Connections (workspace-level credential store) ──────────
//
// Surfaced in the UI by src/Connections.tsx; populated by the user
// pasting API keys for paste-key services (OpenRouter, Anthropic,
// Tavily) or running CLI logins for delegated-cli services (Claude,
// GitHub — Phase 2 will spawn the CLI; Phase 1 only reports status).
//
// Storage: <workspace>/.mica/credentials.json (paste-key services)
// or the service's own credential file (delegated-cli — we just
// check presence). See server/connections.ts for the full contract.

// GET /api/connections — status of every known service.
app.get("/api/connections", async (_req, res) => {
  try {
    const statuses = await getAllStatuses();
    res.json({ ok: true, services: statuses });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message });
  }
});

// POST /api/connections/:service — set the API key for a paste-key
// service. Validates against the service's public auth endpoint; on
// success persists to credentials.json. Returns 400 for unknown
// service IDs or for delegated-cli services (Phase 1 doesn't connect
// them via this endpoint).
app.post("/api/connections/:service", async (req, res) => {
  const id = req.params.service;
  const svc = getService(id);
  if (!svc) {
    res.status(400).json({ ok: false, error: `Unknown service: ${id}` });
    return;
  }
  if (svc.pattern !== "paste-key") {
    res.status(400).json({
      ok: false,
      error: `${svc.displayName} is connected via its own CLI, not by pasting a key. ${
        "phase1Instruction" in svc ? svc.phase1Instruction : ""
      }`.trim(),
    });
    return;
  }
  const body = (req.body || {}) as { api_key?: string };
  const key = typeof body.api_key === "string" ? body.api_key.trim() : "";
  if (!key) {
    res.status(400).json({ ok: false, error: "api_key is required" });
    return;
  }
  const result = await svc.validate(key);
  if (!result.ok) {
    res.status(400).json({ ok: false, error: result.error || "Validation failed" });
    return;
  }
  await writePasteKey(svc.id as PasteKeyService, key);
  res.json({ ok: true, warning: result.warning });
});

// DELETE /api/connections/:service — remove a paste-key service's
// stored API key. Doesn't affect env vars or legacy config.json
// entries; user manages those out-of-band.
app.delete("/api/connections/:service", async (req, res) => {
  const id = req.params.service;
  const svc = getService(id);
  if (!svc) {
    res.status(400).json({ ok: false, error: `Unknown service: ${id}` });
    return;
  }
  if (svc.pattern !== "paste-key") {
    res.status(400).json({
      ok: false,
      error: `${svc.displayName} can't be disconnected via this endpoint — log out via its CLI directly.`,
    });
    return;
  }
  await deletePasteKey(svc.id as PasteKeyService);
  res.json({ ok: true });
});

// SERVICES is imported but only consumed by getAllStatuses internally.
// Keep the import live for any future consumer that needs the registry
// directly without re-fetching status.
void SERVICES;

// ── Card error/ok reporting ─────────────────────────────────

app.post("/api/cards/:filename/error", (req, res) => {
  const { filename } = req.params;
  const { error } = req.body as { error?: string };
  if (error) {
    console.log(`[card-error] ${filename}: ${error.slice(0, 200)}`);
    // Broadcast so the chat card (or any subscriber) can surface the error
    // with a "Send to agent" affordance. Project-scoped via existing helper.
    const proj = getRequestProject(req);
    if (proj) {
      broadcastToProject(proj, { type: "card-error", filename, error, surface: classifyErrorSurface(filename) });
      // ALSO record into the validator-error buffer so the runtime error
      // reaches the agent's prompt context on its next turn (same pipeline
      // as schema/path/lint validators). Without this, the agent has no
      // visibility into runtime errors a card.js throws — `mica.reportError`
      // hits the user's UI but the agent flies blind, debugging via
      // render_capture screenshots alone. Wiring runtime errors through
      // the same buffer means when card.js throws "L is not defined" or
      // similar, the agent sees the exact error message + filename on the
      // next turn and can fix without the user having to retype it.
      recordValidatorError(proj, filename, error);
      // ALSO broadcast as a `progress` event so the chat card's step list
      // shows the error inline with the agent's other actions. Without this,
      // mid-turn errors only surface as bubbles in the chat (the agent's
      // step list is silent), and the user has no live evidence the system
      // is registering the error. Description is prefixed with ⚠ so it's
      // visually distinct from agent tool calls. The buildContext-time
      // broadcast at micaAgent.ts handles errors that pre-exist a turn;
      // this one handles errors that fire during a turn.
      const errorPreview = error.slice(0, 120).replace(/\n/g, " ");
      broadcastToProject(proj, {
        type: "progress",
        tool: "card-error",
        description: `⚠ ${filename}: ${errorPreview}`,
      });
    }
  }
  res.json({ ok: true });
});

app.post("/api/cards/:filename/ok", (req, res) => {
  // Card rendered (or re-rendered) without throwing — clear any prior
  // runtime-error buffer entry for this file. Self-healing: the agent
  // stops seeing the error in its next-turn prompt as soon as the card
  // successfully renders, mirroring the validator-clear-on-rewrite
  // semantics. Browser-side: CardRuntime POSTs /ok after a successful
  // mount or re-render.
  const proj = getRequestProject(req);
  if (proj) clearValidatorError(proj, req.params.filename);
  res.json({ ok: true });
});

// ── Card screenshot upload ──────────────────────────────────
// Frontend (src/whiteboard/screenshotClient.ts) POSTs the html2canvas output
// here. Body is JSON { data: base64Png, width, height } — sized well within
// the 5 MB JSON limit for typical cards. On failure, client POSTs
// { error: "<reason>" } and we reject the pending capture promise.
app.post("/api/cards/:filename/screenshot/:captureId", async (req, res) => {
  const { captureId } = req.params;
  const { data, width, height, error } = req.body as {
    data?: string; width?: number; height?: number; error?: string;
  };
  try {
    if (error) {
      failCapture(captureId, error);
      res.json({ ok: true });
      return;
    }
    if (typeof data !== "string" || !data) {
      res.status(400).json({ error: "data (base64) required" });
      return;
    }
    // Strip optional data URL prefix.
    const b64 = data.replace(/^data:image\/[^;]+;base64,/, "");
    const buf = Buffer.from(b64, "base64");
    const result = await resolveCapture(
      captureId,
      buf,
      typeof width === "number" ? width : 0,
      typeof height === "number" ? height : 0,
    );
    res.json({ ok: true, path: result.relativePath, bytes: result.bytes });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Chat lifecycle (clear / archive browser) ────────────────
//
// `:chatId` is the file's UUID (the per-card sidecar id — same identifier
// the agent uses as ctx.sessionId and as the basename of
// `.mica/chats/<id>.json`). Clients obtain it from the file's `id` field
// in /api/files.

app.post("/api/chats/:chatId/clear", async (req, res) => {
  const { chatId } = req.params;
  if (!chatId || chatId.includes("/") || chatId.includes("..")) {
    res.status(400).json({ error: "invalid chatId" });
    return;
  }
  const proj = getRequestProject(req);
  try {
    const archived = await archiveChat(chatId, proj);
    // Broadcast the cleared state to every client attached to this session.
    // Each chat card listens for `chat-cleared` and resets its scroll.
    if (proj) {
      broadcastToProject(proj, { type: "chat-cleared", chatId });
    }
    res.json({ ok: true, archived });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Manually advance the context cursor to the current end of history. The
// user-facing trigger is the chat card's header "+" / horizon button —
// they're explicitly saying "treat this conversation as a fresh arc; the
// agent should ignore the prior turns on its next call." The auto-advance
// path (server-side, gated on arc-complete + capacity ≥ 80%) handles the
// common case; this endpoint handles the rest. Idempotent — calling it
// when cursor is already at the end is a no-op.
app.post("/api/chats/:chatId/advance-cursor", async (req, res) => {
  const { chatId } = req.params;
  if (!chatId || chatId.includes("/") || chatId.includes("..")) {
    res.status(400).json({ error: "invalid chatId" });
    return;
  }
  const proj = getRequestProject(req);
  try {
    const len = await readChatHistoryLength(chatId, proj);
    const prev = await readChatCursor(chatId, proj);
    if (len === 0) {
      res.json({ ok: true, cursor: 0, advanced: 0 });
      return;
    }
    if (prev >= len) {
      res.json({ ok: true, cursor: prev, advanced: 0 });
      return;
    }
    await writeChatCursor(chatId, proj, len, len);
    // Broadcast so peer windows on the same project re-render the horizon
    // and grey out the now-above-cursor messages without a full reload.
    if (proj) {
      broadcastToProject(proj, { type: "cursor-advanced", chatId, cursor: len });
    }
    res.json({ ok: true, cursor: len, advanced: len - prev });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/chats/:chatId/archived", async (req, res) => {
  const { chatId } = req.params;
  if (!chatId || chatId.includes("/") || chatId.includes("..")) {
    res.status(400).json({ error: "invalid chatId" });
    return;
  }
  const proj = getRequestProject(req);
  try {
    const entries = await listArchivedChats(chatId, proj);
    res.json({ entries });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/chats/:chatId/archived/:name", async (req, res) => {
  const { chatId, name } = req.params;
  if (!chatId || chatId.includes("/") || chatId.includes("..")) {
    res.status(400).json({ error: "invalid chatId" });
    return;
  }
  const proj = getRequestProject(req);
  try {
    const messages = await readArchivedChat(chatId, proj, name);
    res.json({ messages });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── Project-scoped File Endpoints ───────────────────────────

// Preview the system prompt that will be sent to the agent for a given chat
// file. Calls the SAME buildContext() the agent uses at turn time — so the
// ctx tooltip can't drift from what's actually sent. `since` is omitted so
// the preview skips the "since your last turn" section (that's a per-turn
// diff, computed when the turn starts).
// Single-source-of-truth preview for the chat card's ctx tooltip.
// Per file we report:
//   - chars (what actually ends up in the prompt: content.length for text,
//     0 for binary/unreadable)
//   - binary/unreadable flags so the tooltip can mark them
// Plus the total prompt size and the configured soft cap — the tooltip
// warns (doesn't error) when the prompt exceeds the cap. No truncation.
async function buildCtxPreview(
  builder: (filename: string, project: string | null, since?: number) => Promise<string>,
  proj: string | null,
  filename: string,
) {
  const prompt = await builder(filename, proj, undefined);
  const files = await listCanvasFiles(proj || undefined);
  // Filter meta cards (canvas-back, skills) — their on-disk file is a shell
  // and their real content is surfaced through the separate "canvas-back"
  // entry below. Dropping them here matches what buildContext emits.
  const filesForListing: typeof files = [];
  for (const f of files) {
    const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
    const meta = await getCardClassMeta(ext, proj);
    if (!meta.meta) filesForListing.push(f);
  }
  const fileInfos = await Promise.all(filesForListing.map(async (f) => {
    const ext = f.name.substring(f.name.lastIndexOf(".")).toLowerCase();
    if (BINARY_EXTS.has(ext)) return { name: f.name, chars: 0, binary: true, size: f.size };
    try {
      const fc = await readProjectFile(f.name, proj || undefined);
      if (isLikelyBinary(f.name, fc.content)) return { name: f.name, chars: 0, binary: true, size: f.size };
      return { name: f.name, chars: fc.content.length, binary: false, size: f.size };
    } catch {
      return { name: f.name, chars: 0, binary: false, unreadable: true, size: f.size };
    }
  }));

  // Project-level context that buildContext injects beyond the canvas-files
  // listing. Surfacing them as distinct entries makes the tooltip match what
  // the prompt actually carries — canvas-back.md is already in the prompt as
  // "## Project Context", it just wasn't visible in the tooltip.
  const extras: Array<{ name: string; chars: number; binary?: false; unreadable?: false; size: number; kind: string }> = [];
  try {
    const cb = await readProjectFile(".mica/canvas-back.md", proj || undefined);
    if (cb.content.length > 0) {
      extras.push({ name: ".mica/canvas-back.md", chars: cb.content.length, size: cb.content.length, kind: "project context" });
    }
  } catch { /* no canvas-back */ }

  return {
    files: fileInfos,
    extras,
    promptSizeChars: prompt.length,
    estimatedTokens: Math.round(prompt.length / 4),
    softCapChars: CONTEXT_SOFT_CAP_CHARS,
    oversized: prompt.length > CONTEXT_SOFT_CAP_CHARS,
  };
}

app.get("/api/agent/context-preview", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    const filename = String(req.query.filename || "");
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    res.json(await buildCtxPreview(buildMicaAgentContext, proj, filename));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/claude-agent/context-preview", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    const filename = String(req.query.filename || "");
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    res.json(await buildCtxPreview(buildClaudeAgentContext, proj, filename));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Per-turn detail for the chat card's expandable bubble footer.
// Returns the matching TurnRecord plus joined SubagentRecords, read from
// `.mica/metrics/{turns,subagents}.jsonl`. Defensive: chatId/turnId come
// from the user's bubble, but we only ever read JSONL — no shell, no fs
// writes, no traversal. 404 if the turn isn't found in either the live
// or archived JSONLs (graceful for old chats predating the schema).
app.get("/api/agent/turn-record/:chatId/:turnId", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) { res.status(400).json({ error: "project required" }); return; }
    const { chatId, turnId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(chatId) || !/^[a-zA-Z0-9_-]+$/.test(turnId)) {
      res.status(400).json({ error: "invalid id" }); return;
    }
    const metricsDir = join(micaDir(proj), "metrics");
    let turn: unknown = null;
    const subagents: unknown[] = [];
    const turnsPath = join(metricsDir, "turns.jsonl");
    if (existsSync(turnsPath)) {
      const raw = await readFile(turnsPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { turn_id?: string; chat_id?: string };
          if (rec.turn_id === turnId && rec.chat_id === chatId) { turn = rec; break; }
        } catch { /* skip unparseable */ }
      }
    }
    const subagentsPath = join(metricsDir, "subagents.jsonl");
    if (existsSync(subagentsPath)) {
      const raw = await readFile(subagentsPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { turn_id?: string };
          if (rec.turn_id === turnId) subagents.push(rec);
        } catch { /* skip */ }
      }
    }
    if (!turn) { res.status(404).json({ error: "turn not found" }); return; }
    res.json({ turn, subagents });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Captured rendered system prompt for one turn. Streams as text/plain so
// the browser renders inline in a new tab (the card's "view snapshot" link
// uses `target="_blank"`). 404 if the snapshot doesn't exist.
app.get("/api/agent/turn-snapshot/:chatId/:turnId", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) { res.status(400).send("project required"); return; }
    const { chatId, turnId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(chatId) || !/^[a-zA-Z0-9_-]+$/.test(turnId)) {
      res.status(400).send("invalid id"); return;
    }
    const content = await readSnapshot(proj, chatId, turnId);
    if (content === null) { res.status(404).send("snapshot not found"); return; }
    res.type("text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", "inline");
    res.send(content);
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
});

// Recent turn-history slice for the fuel gauge's headroom projection. The
// card hydrates its rolling buffer from this on mount so the gauge can
// project trajectory across recent turns even after a refresh. Returns a
// minimal shape (turn_id + tokens) — full TurnRecord is fetched per-bubble
// via /turn-record above.
app.get("/api/agent/turn-history/:chatId", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) { res.status(400).json({ error: "project required" }); return; }
    const { chatId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(chatId)) {
      res.status(400).json({ error: "invalid id" }); return;
    }
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const turnsPath = join(micaDir(proj), "metrics", "turns.jsonl");
    const out: Array<{ turn_id: string; baseline_tokens: number; context_window: number; ts_end: number }> = [];
    if (existsSync(turnsPath)) {
      const raw = await readFile(turnsPath, "utf-8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { turn_id?: string; chat_id?: string; baseline_tokens?: number; context_window?: number; ts_end?: number };
          if (rec.chat_id === chatId && typeof rec.turn_id === "string") {
            out.push({
              turn_id: rec.turn_id,
              baseline_tokens: rec.baseline_tokens ?? 0,
              context_window: rec.context_window ?? 0,
              ts_end: rec.ts_end ?? 0,
            });
          }
        } catch { /* skip */ }
      }
    }
    out.sort((a, b) => b.ts_end - a.ts_end);
    res.json(out.slice(0, limit));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// List files for active project (metadata only — no content)
// ?canvas=true returns only canvas-visible files (direct children of canvasRoot + pinned)
app.get("/api/files", async (req, res) => {
  const t0 = Date.now();
  try {
    const proj = getRequestProject(req) || undefined;
    const isCanvas = req.query.canvas === "true";
    // `?showHidden=true` reveals dot-prefixed entries (Mica/agent state at
    // .mica, .qwen, .claude). Build-noise dirs (.git, node_modules, etc.)
    // stay filtered regardless. Only meaningful for project-wide listing
    // (canvas list has its own canvas-scoped filter that ignores hidden by
    // design). Used by the filebrowser card's "show hidden" toggle.
    const showHidden = req.query.showHidden === "true";
    const files = isCanvas ? await listCanvasFiles(proj) : await listFiles(proj, { showHidden });
    const tAfterList = Date.now();
    const decorated = await decorateBadges(files, proj || null);
    const tAfterBadges = Date.now();
    console.log(`[timing] /files${isCanvas ? "?canvas=true" : ""}${showHidden ? "&showHidden=true" : ""} proj=${proj || "(none)"} files=${files.length} total=${tAfterBadges - t0}ms list=${tAfterList - t0}ms badges=${tAfterBadges - tAfterList}ms`);
    res.json(decorated);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Resolve each file's badge + meta flag from its card class metadata.json
// (project-scoped first, then built-in). Uses a per-request Map so each
// unique extension's metadata is read at most once.
interface ResolvedClassMeta { badge: string; meta: boolean }
async function decorateBadges(files: FileMeta[], project: string | null): Promise<FileMeta[]> {
  const cache = new Map<string, ResolvedClassMeta>();
  const resolveClassMeta = async (ext: string): Promise<ResolvedClassMeta> => {
    if (cache.has(ext)) return cache.get(ext)!;
    const dir = resolveCardClassDir(ext, project);
    if (!dir) { const empty = { badge: "", meta: false }; cache.set(ext, empty); return empty; }
    try {
      const raw = await readFile(join(dir, "metadata.json"), "utf-8");
      const m = JSON.parse(raw) as { badge?: string; meta?: boolean };
      const resolved: ResolvedClassMeta = {
        badge: typeof m.badge === "string" ? m.badge : "",
        meta: m.meta === true,
      };
      cache.set(ext, resolved);
      return resolved;
    } catch {
      const empty = { badge: "", meta: false };
      cache.set(ext, empty);
      return empty;
    }
  };
  return Promise.all(files.map(async (f) => {
    if (f.type === "directory") return f;
    const ext = f.name.split(".").pop()?.toLowerCase() || "";
    if (!ext) return f;
    const { badge, meta } = await resolveClassMeta(ext);
    const out: FileMeta = { ...f };
    if (badge) out.badge = badge;
    if (meta) out.meta = true;
    return out;
  }));
}

// Pin/unpin files to canvas
app.post("/api/canvas/pin", async (req, res) => {
  try {
    const { filename } = req.body as { filename?: string };
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    const proj = getRequestProject(req) || undefined;
    const cfg = await readCanvasConfig(proj);
    if (!cfg.pinned.includes(filename)) {
      cfg.pinned.push(filename);
      await updateCanvasConfig(proj, { pinned: cfg.pinned });
      // Sync the file watcher so subsequent edits to the newly pinned file
      // arrive as `file-changed` broadcasts. Without this, the watcher only
      // covers what was pinned at addProject time — pins added mid-session
      // would silently drop edits until a reconnect.
      if (proj) await fileWatcher.refreshPinned(proj, cfg.pinned);
      // Tell subscribers a new file just became canvas-visible. Reusing the
      // existing `file-created` event piggy-backs on CanvasCardRuntime's
      // existing handler (which calls fetchFiles to reconcile children).
      // Without this, the frontend has no signal that pinning happened and
      // the new card stays invisible until the user manually reloads.
      if (proj) broadcastToProject(proj, { type: "file-created", filename, source: "pin" });
    }
    res.json({ ok: true, pinned: cfg.pinned });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.delete("/api/canvas/pin", async (req, res) => {
  try {
    const { filename } = req.body as { filename?: string };
    if (!filename) { res.status(400).json({ error: "filename required" }); return; }
    const proj = getRequestProject(req) || undefined;
    const cfg = await readCanvasConfig(proj);
    const wasPinned = cfg.pinned.includes(filename);
    cfg.pinned = cfg.pinned.filter((f: string) => f !== filename);
    await updateCanvasConfig(proj, { pinned: cfg.pinned });
    // Tear down the parent-dir watcher (if this was the last pin in that
    // dir). Otherwise the watcher would keep the inotify slot alive for
    // the rest of the session and re-emit edits as ghost broadcasts.
    if (wasPinned && proj) await fileWatcher.refreshPinned(proj, cfg.pinned);
    // Mirror the pin-add broadcast: when a pinned root file is unpinned,
    // it disappears from the canvas-files list. The frontend listens for
    // `file-deleted` to filter the children array, which is the right
    // shape — the card should leave the canvas, not the file system.
    if (wasPinned && proj) broadcastToProject(proj, { type: "file-deleted", filename });
    res.json({ ok: true, pinned: cfg.pinned });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Get/update canvas config
app.get("/api/canvas/config", async (req, res) => {
  try {
    res.json(await readCanvasConfig(getRequestProject(req) || undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.put("/api/canvas/config", async (req, res) => {
  try {
    const updates = req.body as { canvasRoot?: string; pinned?: string[] };
    const proj = getRequestProject(req) || undefined;
    await updateCanvasConfig(proj, updates);
    // Same reasoning as the /api/canvas/pin handlers: keep the watcher's
    // pinned set in sync with the persisted config so mid-session edits
    // to the new pin list don't silently drop file-change broadcasts.
    if (proj && updates.pinned) await fileWatcher.refreshPinned(proj, updates.pinned);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Git endpoints (status / stage / unstage / commit / push / pull / init)
// consumed by the .gitrepo card class. Implementation in plugins/git.ts
// so this file stays focused on routing and session wiring.
registerGitEndpoints(app, { getRequestProject });

// LLM server status — for chat cards to show loading state
app.get("/api/llm/status", (_req, res) => {
  res.json(getLlamaServerStatus());
});

// ── Skills (project-scoped) ──────────────────────────────────

app.get("/api/skills", async (req, res) => {
  try {
    res.json(await listSkills(getRequestProject(req) || undefined));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.get("/api/skills/:name", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) {
      res.status(400).json({ error: "No active project" });
      return;
    }
    const content = await readSkill(req.params.name, proj);
    res.type("text/markdown").send(content);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.put("/api/skills/:name", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) {
      res.status(400).json({ error: "No active project" });
      return;
    }
    const { content } = req.body as { content?: string };
    if (typeof content !== "string") {
      res.status(400).json({ error: "content (string) required" });
      return;
    }
    await writeSkill(req.params.name, content, proj);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete("/api/skills/:name", async (req, res) => {
  try {
    const proj = getRequestProject(req);
    if (!proj) {
      res.status(400).json({ error: "No active project" });
      return;
    }
    await deleteSkill(req.params.name, proj);
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Templates ──────────────────────────────────────────────

app.get("/api/templates", async (_req, res) => {
  try {
    res.json(await listTemplates());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Read a file — returns raw bytes with content-type header
app.get("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  try {
    const filePath = resolveFilePath(filename, getRequestProject(req) || undefined);
    const fileStat = await fsStat(filePath);
    if (!fileStat.isFile()) {
      res.status(404).json({ error: "Not a file" });
      return;
    }
    // Use res.sendFile rather than manual createReadStream(filePath).pipe(res):
    // the manual approach declared Content-Length from a prior fsStat, so any
    // mid-pipe write to the file (debounced agent edits, peer-tab saves) made
    // the body bytes diverge from the declared length, producing a malformed
    // HTTP response that crashed vite's dev-server proxy ("Data after
    // `Connection: close`"; incident 2026-05-01). res.sendFile handles
    // stat + Content-Length + streaming + stream-error events as one atomic
    // unit, so headers always match the bytes actually emitted.
    const contentType = mimeTypes.lookup(filename) || "application/octet-stream";
    res.type(contentType as string);
    res.sendFile(filePath, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// Create or update a file
// Accepts JSON body: { content: string, source?: string, cardSource?: string }
//   source     — windowId (per-tab); existing cards filter on this
//   cardSource — per-card-instance UUID (the channel session id); new cards
//                use mica.isSelfEcho() which checks this for sibling-friendly
//                self-echo suppression.
app.put("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  const { content, source, cardSource } = req.body;
  if (typeof content !== "string") {
    res.status(400).json({ error: "content (string) required" });
    return;
  }
  try {
    if (source) markWriteSource(filename, source, typeof cardSource === "string" ? cardSource : undefined);
    const proj = getRequestProject(req) || undefined;
    await writeProjectFile(filename, content, proj);
    // Pre-warm the UUID sidecar BEFORE responding so any client that reacts
    // to the resulting file-created broadcast can immediately fetch /api/files
    // and find a stable id.
    await getOrCreateCardId(proj, filename);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Upload a binary file (streamed to disk — no size limit, constant memory).
// Pass ?source=<windowId> to suppress the self-echo on the resulting file-changed event,
// matching the PUT /api/files/:filename behavior.
app.post("/api/files/:filename/upload", async (req, res) => {
  const filename = req.params.filename;
  const source = typeof req.query.source === "string" ? req.query.source : undefined;
  const cardSource = typeof req.query.cardSource === "string" ? req.query.cardSource : undefined;
  const reqProject = getRequestProject(req);
  const root = reqProject ? join(WORKSPACE_DIR, reqProject) : WORKSPACE_DIR;
  const filePath = join(root, filename);
  if (!filePath.startsWith(root + "/")) {
    res.status(400).json({ error: "Invalid filename" });
    return;
  }
  try {
    await mkdir(join(filePath, ".."), { recursive: true });
  } catch { /* dir exists */ }

  if (source) markWriteSource(filename, source, cardSource);

  const ws = createWriteStream(filePath);
  let bytes = 0;
  req.on("data", (chunk: Buffer) => { bytes += chunk.length; });
  req.pipe(ws);
  ws.on("finish", async () => {
    // Pre-warm the UUID sidecar before responding (same reason as PUT handler).
    try { await getOrCreateCardId(reqProject || undefined, filename); } catch { /* best-effort */ }
    res.json({ success: true, size: bytes });
  });
  ws.on("error", (err) => {
    res.status(500).json({ error: err.message });
  });
  req.on("error", (err) => {
    ws.destroy();
    res.status(500).json({ error: err.message });
  });
});

// Delete a file
app.delete("/api/files/:filename", async (req, res) => {
  const filename = req.params.filename;
  try {
    await deleteProjectFile(filename, getRequestProject(req) || undefined);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

// ── Layout persistence (.mica/layout.json, keyed by device class) ────

app.get("/api/layout", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.json({}); return; }
  const device = (req.query.device as string) || "desktop";
  try {
    const data = await readFile(join(micaDir(proj), "layout.json"), "utf-8");
    const all = JSON.parse(data);
    if (all[device] && typeof all[device] === "object" && all[device].cards) {
      res.json(all[device]);
    } else if (all.cards) {
      res.json(all);
    } else {
      res.json({});
    }
  } catch {
    res.json({});
  }
});

app.put("/api/layout", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.status(400).json({ error: "No active project" }); return; }
  const device = (req.query.device as string) || "desktop";
  try {
    const dir = micaDir(proj);
    await mkdir(dir, { recursive: true });
    const source = req.body.source;
    // `silent: true` skips the layout-changed broadcast. Used for changes
    // that are intentionally local-feeling (e.g. z-order: each tab tracks
    // its own focus, but we still want it to survive reload).
    const silent = req.body.silent === true;
    const dataToStore = { ...req.body };
    delete dataToStore.source;
    delete dataToStore.silent;

    let all: Record<string, unknown> = {};
    try {
      const existing = await readFile(join(dir, "layout.json"), "utf-8");
      all = JSON.parse(existing);
      if (all.cards && !all.desktop) {
        all = { desktop: all };
      }
    } catch { /* fresh file */ }

    all[device] = dataToStore;
    await writeFile(join(dir, "layout.json"), JSON.stringify(all, null, 2), "utf-8");
    if (!silent) broadcast({ type: "layout-changed", source, device });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Canvas Back (project-level AI context) ───────────────────

app.get("/api/canvas-back", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.json({ content: "" }); return; }
  try {
    const content = await readFile(join(micaDir(proj), "canvas-back.md"), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/canvas-back", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.status(400).json({ error: "No active project" }); return; }
  try {
    const dir = micaDir(proj);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "canvas-back.md"), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// Returns the originating template's canvas-back.md content. Used by the
// canvas-back card's "Reset" button. Looks up `template:` from the project's
// .mica/config.json (recorded by createProjectFromTemplate); 404 if absent.
app.get("/api/canvas-back/template-default", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.status(400).json({ error: "No active project" }); return; }
  try {
    const cfg = JSON.parse(await readFile(join(micaDir(proj), "config.json"), "utf-8"));
    const template = cfg.template;
    if (!template || typeof template !== "string") {
      res.status(404).json({ error: "no template recorded for this project" });
      return;
    }
    const tplPath = join(process.cwd(), "templates", template, ".mica", "canvas-back.md");
    if (!existsSync(tplPath)) {
      res.status(404).json({ error: `template '${template}' has no canvas-back.md` });
      return;
    }
    const content = await readFile(tplPath, "utf-8");
    res.json({ content, template });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Card Backs (per-card AI context) ─────────────────────────

app.get("/api/card-back/:filename", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.json({ content: "" }); return; }
  const filename = req.params.filename;
  try {
    // Replace path separators with -- for flat storage
    const safeFilename = filename.replace(/\//g, "--") + ".context.md";
    const content = await readFile(join(micaDir(proj), "cards", safeFilename), "utf-8");
    res.json({ content });
  } catch {
    res.json({ content: "" });
  }
});

app.put("/api/card-back/:filename", async (req, res) => {
  const proj = getRequestProject(req);
  if (!proj) { res.status(400).json({ error: "No active project" }); return; }
  const filename = req.params.filename;
  try {
    const cardsDir = join(micaDir(proj), "cards");
    await mkdir(cardsDir, { recursive: true });
    const safeFilename = filename.replace(/\//g, "--") + ".context.md";
    await writeFile(join(cardsDir, safeFilename), req.body.content || "", "utf-8");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── mica.* API (server-side bridge for client library) ───────
//
// Handler signature carries the request's project so handlers can scope
// their work (per-project rate limits, per-project state). Older handlers
// that don't care accept the arg and ignore it.

type MicaHandler = (
  method: string,
  params: unknown,
  project: string | null,
) => Promise<unknown>;

const micaHandlers = new Map<string, MicaHandler>();

export function registerMicaHandler(namespace: string, handler: MicaHandler) {
  micaHandlers.set(namespace, handler);
  console.log(`[mica] Registered handler: mica.${namespace}.*`);
}

app.post("/api/mica/:namespace/:method", async (req, res) => {
  const { namespace, method } = req.params;
  const handler = micaHandlers.get(namespace);
  if (!handler) {
    res.status(404).json({ error: `No handler for mica.${namespace}` });
    return;
  }
  try {
    const project = getRequestProject(req);
    const result = await handler(method, req.body, project);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Server Setup ─────────────────────────────────────────────

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[express] Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = http.createServer(app);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`[server] Port ${PORT} is already in use.`);
  } else {
    console.error("[server] HTTP error:", err.message);
  }
  process.exit(1);
});

// ── WebSocket ────────────────────────────────────────────────

const wss = new WebSocketServer({ server, path: "/ws/cards" });
const wsClients = new Set<WebSocket>();
const wsChannels = new Map<WebSocket, Set<string>>();
const wsCardChannels = new Map<WebSocket, Map<string, string>>();
// Per-WS subscribed project (one project per tab). Used by broadcastToProject
// to fan out file events only to interested clients.
const wsProjects = new Map<WebSocket, string>();
// Per-WS short id for log readability — answers "is the same tab toggling
// projects, or are these different tabs?". Assigned on connection. See
// reportSubscriptionState() below.
const wsIds = new WeakMap<WebSocket, number>();
let nextWsId = 1;
function reportSubscriptionState(reason: string): void {
  const watched = fileWatcher.watchedProjects();
  const perTab = Array.from(wsProjects.entries())
    .map(([w, p]) => `ws#${wsIds.get(w) ?? "?"}=${p}`)
    .join(", ");
  console.log(
    `[ws-state ${reason}] ws_count=${wsProjects.size} watching=${watched.length} ` +
    `[${watched.join(", ")}] tabs=[${perTab}]`,
  );
}

const channelManager = new ChannelManager();

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);
  wsIds.set(ws, nextWsId++);

  // Keepalive heartbeat. Without this, idle WebSockets get dropped by
  // intermediate proxies (Tailscale Serve idles after ~60s, iOS Safari
  // is even more aggressive about closing inactive sockets to save
  // battery). A WS-level ping every 30s keeps the connection alive
  // through most proxies and lets us detect a half-open client when no
  // pong arrives within 30s of a ping.
  let isAlive = true;
  ws.on("pong", () => { isAlive = true; });
  const heartbeat = setInterval(() => {
    if (ws.readyState !== ws.OPEN) return;
    if (!isAlive) {
      // No pong response since last ping — connection is dead. Force-close
      // so the client's onClose fires and reconnect logic kicks in.
      console.log(`[websocket] no pong from ws#${wsIds.get(ws) ?? "?"} — terminating`);
      try { ws.terminate(); } catch { /* ignore */ }
      return;
    }
    isAlive = false;
    try { ws.ping(); } catch { /* ignore */ }
  }, 30_000);

  const cleanupWsChannels = () => {
    clearInterval(heartbeat);
    wsClients.delete(ws);
    // Drop file-watcher ref for this client's subscribed project
    const subscribed = wsProjects.get(ws);
    if (subscribed) {
      wsProjects.delete(ws);
      fileWatcher.releaseProject(subscribed);
    }
    const channels = wsChannels.get(ws);
    if (channels) {
      for (const channelId of channels) {
        if (channelManager.has(channelId)) {
          channelManager.detach(channelId);
        }
      }
      wsChannels.delete(ws);
    }
    wsCardChannels.delete(ws);
    reportSubscriptionState(`disconnect ws#${wsIds.get(ws) ?? "?"}`);
  };

  ws.on("close", cleanupWsChannels);
  ws.on("error", (err) => {
    console.error("[websocket] Connection error:", err.message);
    cleanupWsChannels();
  });

  ws.on("message", async (raw) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch { return; }

    const { type, id, filename, fn, args } = msg as {
      type: string; id?: string; filename?: string;
      fn?: string; args?: Record<string, unknown>;
    };

    switch (type) {
      case "broadcast": {
        const event = (msg as { event?: string }).event;
        const data = (msg as { data?: Record<string, unknown> }).data || {};
        if (event) broadcast({ type: event, ...data });
        break;
      }

      case "subscribe-project": {
        const proj = (msg as { project?: string }).project;
        if (!proj) break;
        const prev = wsProjects.get(ws);
        if (prev === proj) break;
        if (prev) fileWatcher.releaseProject(prev);
        wsProjects.set(ws, proj);
        try {
          const { canvasRoot, pinned } = await readCanvasConfig(proj);
          await fileWatcher.addProject(proj, projectDir(proj), canvasRoot, pinned);
        } catch (err) {
          console.error(`[ws] subscribe-project ${proj} failed:`, (err as Error).message);
        }
        reportSubscriptionState(`subscribe ws#${wsIds.get(ws) ?? "?"}→${proj}${prev ? ` (was ${prev})` : ""}`);
        break;
      }

      case "unsubscribe-project": {
        const prev = wsProjects.get(ws);
        if (!prev) break;
        wsProjects.delete(ws);
        fileWatcher.releaseProject(prev);
        reportSubscriptionState(`unsubscribe ws#${wsIds.get(ws) ?? "?"} from ${prev}`);
        break;
      }

      case "channel_open": {
        const cid = id as string;
        try {
          const fname = filename as string;
          const channelArgs = (args || {}) as Record<string, unknown>;
          const msgTabId = (msg.tabId as string | undefined) ?? null;
          const sessionId = (msg as { sessionId?: string }).sessionId;
          const wsProject = wsProjects.get(ws) ?? null;

          if (!sessionId) {
            throw new Error(`channel_open missing sessionId — client must include the file's UUID (file.id from /api/files)`);
          }
          if (!wsProject) {
            throw new Error(`channel_open arrived before subscribe-project — client must subscribe first`);
          }

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

          const cardClass = channelManager.resolveCardClass(fname);

          // Don't pre-check hasHandler — the actual routing considers
          // metadata.handler (e.g. "llm-agent"), which createSession
          // resolves. Let createSession throw the proper error if no
          // handler is found after metadata resolution.
          {
            const cardKey = `${sessionId}#${fn}`;
            if (!wsCardChannels.has(ws)) wsCardChannels.set(ws, new Map());
            const cardMap = wsCardChannels.get(ws)!;
            const oldCid = cardMap.get(cardKey);
            if (oldCid && channelManager.has(oldCid)) {
              channelManager.detach(oldCid);
              wsChannels.get(ws)?.delete(oldCid);
            }

            await channelManager.open(cid, sessionId, wsProject, fname, fn as string, channelArgs, msgTabId, onData, onClose);
            if (!wsChannels.has(ws)) wsChannels.set(ws, new Set());
            wsChannels.get(ws)!.add(cid);
            cardMap.set(cardKey, cid);
          }
        } catch (err) {
          const errMsg = (err as Error).message;
          console.error(`[ws] channel_open error:`, errMsg);
          ws.send(JSON.stringify({ type: "error", id, error: errMsg }));
          // Surface to the agent's feedback loop too: the client gets a WS
          // error event (which the card.js may or may not log), but without
          // also broadcasting card-error + recording validator-error the
          // CHAT AGENT can't see this. We hit a real cost from this on
          // 2026-05-03: a card was missing metadata.handler="process" and
          // the framework rejected channel_open 9 times across many turns
          // while the agent debugged CSS in the dark. The error message
          // even names the fix ("Available handlers: ..., process") — but
          // it never reached the agent's prompt.
          //
          // Now: same path as runtime errors via /api/cards/:filename/error.
          // card-error broadcast + validator buffer entry. Agent reads it
          // on its next turn's buildContext injection and can act.
          const proj = wsProjects.get(ws);
          const fname = filename;
          if (proj && fname) {
            broadcastToProject(proj, { type: "card-error", filename: fname, error: errMsg, surface: classifyErrorSurface(fname) });
            broadcastToProject(proj, {
              type: "progress",
              tool: "channel-open-error",
              description: `⚠ ${fname}: ${errMsg.slice(0, 120).replace(/\n/g, " ")}`,
            });
            recordValidatorError(proj, fname, errMsg);
          }
        }
        break;
      }

      case "channel_data": {
        const cid = id as string;
        if (channelManager.has(cid)) {
          channelManager.sendData(cid, (msg as { data?: unknown }).data);
        }
        break;
      }

      case "channel_close": {
        const cid = id as string;
        if (channelManager.has(cid)) channelManager.detach(cid);
        wsChannels.get(ws)?.delete(cid);
        const cardMap = wsCardChannels.get(ws);
        if (cardMap) {
          for (const [key, val] of cardMap) {
            if (val === cid) { cardMap.delete(key); break; }
          }
        }
        break;
      }
    }
  });
});

function broadcast(msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { wsClients.delete(ws); }
    }
  }
}

/** Classify an error's preferred chat surface.
 *
 *  "overlay" — the file has a CardRuntime mounted on it (canvas-root cards,
 *  including markdown / spec.md / decomposition.md AND custom card classes
 *  like .world-clock or .moon-orbit). The overlay listener in CardRuntime
 *  matches on exact filename and surfaces a red error box on the card
 *  itself; render_capture's vision caption then feeds the same error back
 *  to the agent through the visual channel. A chat bubble would be
 *  duplicative noise.
 *
 *  "bubble" — the file has no card runtime listening (`.mica/` internals:
 *  card-class definitions, layout, sidecars). No overlay surface, so the
 *  bubble in chat is the only chat-side affordance the user has. The agent
 *  also gets the error via the validator buffer injection regardless.
 *
 *  Heuristic: anything under `.mica/` is framework-internal; everything
 *  else is a project file with a card runtime. Sync, no config read —
 *  works correctly even mid-startup before canvasRoot is resolved. */
function classifyErrorSurface(filename: string): "overlay" | "bubble" {
  if (filename === ".mica" || filename.startsWith(".mica/")) return "bubble";
  return "overlay";
}

/** Send a message only to WS clients subscribed to the given project.
 *  Returns the number of clients the message was successfully queued to. */
function broadcastToProject(project: string, msg: Record<string, unknown>): number {
  const data = JSON.stringify(msg);
  let count = 0;
  for (const [ws, proj] of wsProjects) {
    if (proj !== project) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(data); count++; } catch { wsClients.delete(ws); wsProjects.delete(ws); }
  }
  console.log(`[broadcast:${project}] ${msg.type} → ${count} subscribers`);
  return count;
}

// ── File Watcher Events ──────────────────────────────────────

fileWatcher.on("file-change", async (event: { type: string; filename: string; project: string }) => {
  console.log(`[file-watcher:${event.project}] ${event.type}: ${event.filename}`);

  // Capture whether this file had a validator error BEFORE we clear it.
  // After validators re-run, if the buffer is still empty, the file went
  // from errored → clean and we broadcast `card-error-cleared` so the chat
  // card can remove the previously-rendered error bubble. Without this
  // snapshot we can't distinguish "file was always clean" (no broadcast
  // needed) from "file just got fixed" (broadcast desired).
  const hadErrorBefore = hasValidatorError(event.project, event.filename);

  // Clear any prior validator-error buffer entry for this file before
  // re-running validators. Validators that emit errors will re-fill via
  // recordValidatorError below; validators that pass leave the buffer
  // empty, so a fix automatically clears the agent-visible error on its
  // next turn (the buildContext injection reads from this buffer).
  clearValidatorError(event.project, event.filename);

  // (former enforceCardClassPath wired here — retired. Path enforcement is
  // now structural via the mica-card-class MCP tools in
  // server/plugins/cardClassTools.ts. Tools own paths/shape by construction;
  // the regex-based wrong-path detector kept enumerating new failure shapes
  // without catching the next one. See git log for the rationale.)

  // Decomposition consistency: catch "Decision: Inline" + @component-coder
  // dispatch items contradiction (tenet 12). Fires after any decomposition.md
  // or plan.todo write — if both files exist and contradict, broadcast.
  const validatorPromises: Promise<unknown>[] = [];
  if (event.type !== "deleted") {
    validatorPromises.push(
      enforceDecompositionConsistency(event.filename, projectDir(event.project), {
        onError: (reason) => {
          console.warn(`[decomposition-check:${event.project}] ${reason}`);
          broadcastToProject(event.project, {
            type: "card-error",
            filename: event.filename,
            error: reason,
            surface: classifyErrorSurface(event.filename),
          });
          recordValidatorError(event.project, event.filename, reason);
        },
      }).catch((err) => {
        console.error(`[decomposition-check:${event.project}] failed:`, err);
      }),
    );
  }

  if (event.type === "deleted") {
    broadcastToProject(event.project, { type: "file-deleted", filename: event.filename });
    // Tear down any channel session keyed to this file (chat/claude/terminal/etc.).
    // Look up the session by (project, filename) → sessionId via the in-memory
    // reverse map (sidecar may already be gone from disk). Then evict the
    // sidecar so a future file with the same name gets a fresh UUID.
    const sessionId = channelManager.findSessionByFilename(event.project, event.filename);
    if (sessionId) channelManager.destroySession(sessionId);
    deleteCardId(event.project, event.filename).catch(() => { /* best-effort */ });
    return;
  }

  if (event.type === "created") {
    const ws = consumeWriteSource(event.filename);
    broadcastToProject(event.project, {
      type: "file-created",
      filename: event.filename,
      source: ws.source,
      ...(ws.cardSource ? { cardSource: ws.cardSource } : {}),
    });
  }

  if (event.type === "changed") {
    const ws = consumeWriteSource(event.filename);
    broadcastToProject(event.project, {
      type: "file-changed",
      filename: event.filename,
      source: ws.source,
      ...(ws.cardSource ? { cardSource: ws.cardSource } : {}),
    });
  }

  // Auto-remove the chat-card error bubble when this file went from errored
  // → clean. Wait for the validator(s) to settle, re-check the buffer; if
  // empty, broadcast `card-error-cleared` so the chat card prunes matching
  // bubbles. Skipped when there was no prior error (no bubble to clear) and
  // for delete events (the bubble removal is implicit — the card is gone).
  if (hadErrorBefore && event.type !== "deleted" && validatorPromises.length > 0) {
    Promise.allSettled(validatorPromises).then(() => {
      if (!hasValidatorError(event.project, event.filename)) {
        broadcastToProject(event.project, {
          type: "card-error-cleared",
          filename: event.filename,
          surface: classifyErrorSurface(event.filename),
        });
      }
    });
  }
});

fileWatcher.on("card-class-change", (event: { type: string; filename: string; project: string }) => {
  console.log(`[file-watcher:${event.project}] card-class ${event.type}: ${event.filename}`);
  broadcastToProject(event.project, { type: "card-class-changed", filename: event.filename, change: event.type });

  // Capture had-error-before state so we can broadcast card-error-cleared
  // after validators settle (see file-change handler above for the rationale).
  const hadErrorBefore = hasValidatorError(event.project, event.filename);

  // Clear prior validator-error buffer entry before re-running validators.
  // Same pattern as the file-change handler above. The card-class watcher
  // emits separately from the canvas/wrong-loc watchers, so we clear here
  // independently — a successful re-validation leaves the file's buffer
  // entry empty (no stale error visible to the agent).
  clearValidatorError(event.project, event.filename);

  // Collect validator promises so we can await all of them before deciding
  // whether to broadcast card-error-cleared. Promise.allSettled prevents one
  // validator's error from masking another's clean verdict.
  const validatorPromises: Promise<unknown>[] = [];

  // Post-write integrity check: the agent's canUseTool gate is dead under
  // permissionMode: "yolo", so `checkCardClassMetadataConsistency` can't
  // stop a bad metadata.json at write time. Enforce it here instead, on
  // the observation side — works regardless of how the write happened.
  // Missing `extension` is auto-repaired (dir name is authoritative);
  // mismatches and malformed JSON surface as card-error broadcasts which
  // the chat card renders with a "Send to agent" button.
  if (event.type !== "deleted" && event.filename.endsWith("/metadata.json")) {
    const absPath = join(projectDir(event.project), event.filename);
    // Tier-1 URL reachability: fetch each dependencies.scripts/styles URL
    // and broadcast card-error if any 404 / fail. Runs in parallel with
    // the metadata-shape check below — different validation, both fire.
    validatorPromises.push(
      enforceDependenciesReachable(absPath, {
        onError: (reason) => {
          console.warn(`[deps-reachable:${event.project}] ${reason}`);
          broadcastToProject(event.project, {
            type: "card-error",
            filename: event.filename,
            error: reason,
            surface: classifyErrorSurface(event.filename),
          });
          recordValidatorError(event.project, event.filename, reason);
        },
      }).catch((err) => {
        console.error(`[deps-reachable:${event.project}] failed:`, err);
      }),
    );
    validatorPromises.push(
      enforceCardClassMetadata(absPath, {
        // Auto-fix succeeded: framework already wrote the correct file. Log
        // server-side for trace/audit, but DON'T broadcast card-error — the
        // chat card would surface it as a red ⚠ banner indistinguishable
        // from a genuine failure. The agent's next read sees the repaired
        // content; no UI noise needed.
        onAutoFix: (reason) => {
          console.log(`[card-class-enforce:${event.project}] auto-fixed: ${reason}`);
        },
        onError: (reason) => {
          console.warn(`[card-class-enforce:${event.project}] ${reason}`);
          broadcastToProject(event.project, {
            type: "card-error",
            filename: event.filename,
            error: reason,
            surface: classifyErrorSurface(event.filename),
          });
          recordValidatorError(event.project, event.filename, reason);
        },
      }).catch((err) => {
        console.error(`[card-class-enforce:${event.project}] failed:`, err);
      }),
    );
  }

  // Lint card.js for Mica-runtime violations the agent's generic syntax
  // check misses (top-level `export`/`import`, function-declared-but-never-
  // called wrappers, redeclared CARD_SHIM globals, invented APIs). The
  // chat agent sees the resulting card-error broadcast on its next turn
  // and self-corrects before the user sees a broken card.
  if (event.type !== "deleted" && event.filename.endsWith("/card.js")) {
    const absPath = join(projectDir(event.project), event.filename);
    validatorPromises.push(
      enforceCardJsLint(absPath, {
        onError: (reason) => {
          console.warn(`[card-js-lint:${event.project}] ${reason}`);
          broadcastToProject(event.project, {
            type: "card-error",
            filename: event.filename,
            error: reason,
            surface: classifyErrorSurface(event.filename),
          });
          recordValidatorError(event.project, event.filename, reason);
        },
      }).catch((err) => {
        console.error(`[card-js-lint:${event.project}] failed:`, err);
      }),
    );
  }

  // Auto-remove the chat-card error bubble when this file went errored →
  // clean. Same pattern as file-change handler.
  if (hadErrorBefore && event.type !== "deleted" && validatorPromises.length > 0) {
    Promise.allSettled(validatorPromises).then(() => {
      if (!hasValidatorError(event.project, event.filename)) {
        broadcastToProject(event.project, {
          type: "card-error-cleared",
          filename: event.filename,
          surface: classifyErrorSurface(event.filename),
        });
      }
    });
  }
});

// ── Startup ──────────────────────────────────────────────────

(async () => {
  // Ensure workspace directory exists
  await mkdir(WORKSPACE_DIR, { recursive: true });

  // Reap any opencode-serve orphans from a previous Mica run. Each restart
  // would otherwise leak one (children of the dead Mica re-parent to PID 1).
  await reapOrphanOpencodeServers();

  // Register mica.* RPC plugins
  registerMicaHandler("chat", chatHandler);  // mica.chat.*
  registerMicaHandler("exec", execHandler);  // mica.exec.*
  registerMicaHandler("fetch", fetchHandler);  // mica.fetch.*
  setScreenshotBroadcast(broadcastToProject);
  // Wire workspace-level broadcasts for project activity + list changes.
  // Uses `broadcast` (all clients) rather than `broadcastToProject` because
  // the project-list page isn't subscribed to any specific project.
  setActivityBroadcast(broadcast);
  registerMicaHandler("render", renderHandler);  // mica.render.capture

  // Register agent-tools REST routes (POST /api/tools/<tool>). These are
  // the unified surface for tools available to ALL agents (qwen, Claude,
  // opencode). See server/agentTools/registry.ts.
  registerAgentToolRoutes(app);

  // Register channel-based plugins
  channelManager.registerHandler("chat", createAgentHandler(fileWatcher));  // .chat files -> Qwen agent
  channelManager.registerHandler("voice", createVoiceAgentHandler(channelManager));  // .voice files -> canvas-aware voice assistant
  channelManager.registerHandler("claude", createClaudeAgentHandler(fileWatcher));  // .claude files -> Claude Code agent
  channelManager.registerHandler("opencode", createOpencodeAgentHandler(fileWatcher));  // .opencode files -> OpenCode agent (lazy-spawned opencode serve)
  channelManager.registerHandler("terminal", createPtyHandler());  // .terminal files -> PTY
  channelManager.registerHandler("llm-chat", createLlmChatHandler());  // .llm-chat files -> direct LLM chat (legacy binding)
  channelManager.registerHandler("skills", createSkillComposeHandler());  // .skills files -> collaborative SKILL.md authoring
  channelManager.registerHandler("canvas-back", createCanvasBackComposeHandler());  // .canvas-back files -> propose-then-apply canvas-back editor
  // Reusable LLM handlers reachable via metadata.handler — card classes opt
  // in by setting "handler": "llm-direct" or "llm-agent" in metadata.json.
  // Manifests describe args + message shapes for authoring agents that
  // discover handlers via GET /api/handlers.
  channelManager.registerHandler("llm-direct", createLlmChatHandler(), llmDirectManifest);
  channelManager.registerHandler("llm-agent", createLlmAgentHandler(), llmAgentManifest);
  // process: generic spawn-and-stream primitive for long-running third-party
  // subprocesses. Card classes use it via mica.openChannel("process", { command,
  // args, cwd, env }). Companion to cli-mcp (which is for stateless agent-
  // callable tools); this is for stateful, persistent subprocesses (autoresearch
  // training loops, language servers, daemons). See server/plugins/processChannel.ts.
  channelManager.registerHandler("process", createProcessHandler(), processManifest);

  // Start llama-server for local AI — unless disabled via env. The
  // MICA_DISABLE_LLAMA=1 escape hatch lets OpenRouter-only users skip
  // the GPU model download + load (primary use case: the DGX-Spark
  // Docker image running with `--no-llama`-equivalent flag).
  if (process.env.MICA_DISABLE_LLAMA !== "1") {
    ensureLlamaServer().catch((err) => {
      console.warn("[startup] llama-server failed to start:", (err as Error).message);
    });
  } else {
    console.log("[startup] MICA_DISABLE_LLAMA=1 — skipping local llama-server.");
  }

  // Voice sidecars (Parakeet STT + Kokoro TTS) — lazy on startup, same
  // posture as llama-server. Failure here is non-fatal: chat/agents work
  // without voice; only the .voice-hello card surfaces the error.
  if (process.env.MICA_DISABLE_VOICE !== "1") {
    ensureVoiceServers().catch((err) => {
      console.warn("[startup] voice servers failed to start:", (err as Error).message);
    });
  } else {
    console.log("[startup] MICA_DISABLE_VOICE=1 — skipping voice sidecars.");
  }

  const workspaceName = getWorkspaceName();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`
======================================================
                     Mica
======================================================
  Workspace:  ${workspaceName}
  Path:       ${WORKSPACE_DIR}
  Canvas:     http://localhost:${PORT}
======================================================
`);
  });

  // Replace the early log-only signal trap with the full graceful shutdown.
  // Logs which signal arrived so when the process dies unexpectedly we know
  // who killed it (SIGHUP = terminal disconnect, SIGTERM = normal kill,
  // SIGINT = Ctrl-C, SIGQUIT = quit). The shutdown handler is set as the
  // single source of truth — the early one becomes a no-op.
  _earlySignalLogger = null;
  const shutdown = async (sig: NodeJS.Signals | "manual") => {
    console.log(`\n[shutdown] received ${sig} — stopping...`);
    channelManager.destroyAll();   // sends activeAbort.abort() per session
    fileWatcher.stopAll();
    // Wait for SDK CLI subprocesses to exit gracefully (the SDK turns
    // abort() into SIGTERM internally), then SIGKILL any stragglers.
    // Without this, process.exit(0) below races the async kill chain
    // and any in-flight subprocesses orphan to PID 1, accumulating leaks
    // across restart cycles. See incident: zombies from Apr 23 found alive
    // 9+ days later, holding llama-server -np slots + ~50-100MB RAM each.
    stopOpencodeServer();  // gracefully close the opencode HTTP server (no-op if never spawned)
    await reapChildProcesses(3000);
    await stopLlamaServer();
    await stopVoiceServers();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as NodeJS.Signals[]) {
    process.removeAllListeners(sig);
    process.on(sig, () => { void shutdown(sig); });
  }
})();
