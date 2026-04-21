// Mica Server — multi-project planning canvas.
// Serves a workspace with project subdirectories.
// Each project has its own files, layout, canvas, and AI context.

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
  readOpenRouterKey,
  writeOpenRouterKey,
  BINARY_EXTS,
  isLikelyBinary,
  CONTEXT_SOFT_CAP_CHARS,
  type FileMeta,
  type CardSettings,
} from "./files.js";
import { readFile, writeFile, mkdir, stat as fsStat } from "fs/promises";
import { createReadStream, createWriteStream } from "fs";
import mimeTypes from "mime-types";
import { join } from "path";
import { existsSync } from "fs";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { FileWatcher } from "./fileWatcher.js";
import { ChannelManager } from "./channelManager.js";
import { ensureLlamaServer, stopLlamaServer, getLlamaServerStatus } from "./llamaServer.js";
import { chatHandler, setActiveProject as setChatProject } from "./micaChat.js";
import { createAgentHandler, setActiveProject as setAgentProject, buildContext as buildMicaAgentContext } from "./micaAgent.js";
import { createClaudeAgentHandler, setActiveProject as setClaudeAgentProject, buildContext as buildClaudeAgentContext } from "./claudeAgent.js";
import { execHandler, setActiveProject as setExecProject } from "./plugins/exec.js";
import { fetchHandler } from "./plugins/micaFetch.js";
import { createPtyHandler, setActiveProject as setPtyProject } from "./plugins/pty.js";
import { createLlmChatHandler } from "./plugins/llmChat.js";
import { createSkillComposeHandler } from "./plugins/skillCompose.js";
import { createCanvasBackComposeHandler } from "./plugins/canvasBackCompose.js";
import { markWriteSource, consumeWriteSource } from "./writeSource.js";

const execAsync = promisify(execCb);
const PORT = parseInt(process.env.MICA_PORT || "3002");

// ── Global error handlers ────────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION]", err.message);
  setTimeout(() => process.exit(1), 1000);
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
// JSON body parser — skip binary upload routes
const jsonParser = express.json({ limit: "5mb" });
app.use((req, res, next) => {
  if (req.path.endsWith("/upload") && req.method === "POST") return next();
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
      "connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*",
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
  const header = req.header("x-mica-project");
  if (header && typeof header === "string" && header.trim()) {
    return header.trim();
  }
  const q = req.query.project;
  if (typeof q === "string" && q.trim()) {
    return q.trim();
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
    res.json(projects);
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
      await createProject(name, docsDir || "docs");
    }
    res.json({ success: true, name, template: template || null });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Clone a git repo as a new project
app.post("/api/projects/clone", async (req, res) => {
  const { url, name, docsDir } = req.body as { url?: string; name?: string; docsDir?: string };
  if (!url) {
    res.status(400).json({ error: "url required" });
    return;
  }
  try {
    // Derive project name from URL if not provided
    const projectName = name || url.split("/").pop()?.replace(/\.git$/, "") || "project";
    const destDir = join(WORKSPACE_DIR, projectName);
    if (existsSync(destDir)) {
      res.status(400).json({ error: `Project already exists: ${projectName}` });
      return;
    }

    console.log(`[mica] Cloning ${url} -> ${destDir}`);
    await execAsync(`git clone ${JSON.stringify(url)} ${JSON.stringify(destDir)}`, {
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Initialize .mica directory
    await initProject(projectName, docsDir || "docs");

    res.json({ success: true, name: projectName });
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
    await renameProject(oldName, newName);
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
    await deleteProject(name);
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
      await initProject(name, docsDir || "docs");
    }
    const tAfterInit = Date.now();
    switchProject(name);
    const tAfterSwitch = Date.now();

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
    if (existsSync(join(projectScoped, "card.html")) || existsSync(join(projectScoped, "render.js"))) return projectScoped;
  }
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html")) || existsSync(join(builtIn, "render.js"))) return builtIn;
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
  const allowed = ["render.js", "card.html", "card.js", "card.css", "metadata.json", "spec.md"];
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
      const hasHtml = existsSync(join(dir, "card.html"));
      const hasRenderJs = existsSync(join(dir, "render.js"));
      if (hasHtml || hasRenderJs) {
        classes[name] = {
          builtIn: true,
          format: hasHtml ? "html" : "renderjs",
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
        const hasHtml = existsSync(join(dir, "card.html"));
        const hasRenderJs = existsSync(join(dir, "render.js"));
        if (hasHtml || hasRenderJs) {
          classes[name] = {
            builtIn: false,
            format: hasHtml ? "html" : "renderjs",
            hasCss: existsSync(join(dir, "card.css")),
            hasJs: existsSync(join(dir, "card.js")),
            hasMetadata: existsSync(join(dir, "metadata.json")),
          };
        }
      }
    } catch { /* no project card-classes */ }
  }

  res.json(classes);
});

// Render the canvas card (assembles card.html + card.css + card.js)
app.get("/api/canvas-card", async (req, res) => {
  const t0 = Date.now();
  try {
    const reqProject = getRequestProject(req);
    let canvasClass = "canvas";
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

app.get("/api/cards/settings", async (req, res) => {
  const path = (req.query.path as string | undefined)?.trim();
  if (!path) { res.status(400).json({ error: "missing ?path=<filename>" }); return; }
  const proj = getRequestProject(req) || undefined;
  const settings = await readCardSettings(proj, path);
  res.json(settings);
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
  await writeCardSettings(proj, path, settings);
  res.json({ ok: true, settings });
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
      broadcastToProject(proj, { type: "card-error", filename, error });
    }
  }
  res.json({ ok: true });
});

app.post("/api/cards/:filename/ok", (_req, res) => {
  res.json({ ok: true });
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
  const fileInfos = await Promise.all(files.map(async (f) => {
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
  return {
    files: fileInfos,
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

// List files for active project (metadata only — no content)
// ?canvas=true returns only canvas-visible files (direct children of canvasRoot + pinned)
app.get("/api/files", async (req, res) => {
  const t0 = Date.now();
  try {
    const proj = getRequestProject(req) || undefined;
    const isCanvas = req.query.canvas === "true";
    const files = isCanvas ? await listCanvasFiles(proj) : await listFiles(proj);
    const tAfterList = Date.now();
    const decorated = await decorateBadges(files, proj || null);
    const tAfterBadges = Date.now();
    console.log(`[timing] /files${isCanvas ? "?canvas=true" : ""} proj=${proj || "(none)"} files=${files.length} total=${tAfterBadges - t0}ms list=${tAfterList - t0}ms badges=${tAfterBadges - tAfterList}ms`);
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
    cfg.pinned = cfg.pinned.filter((f: string) => f !== filename);
    await updateCanvasConfig(proj, { pinned: cfg.pinned });
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
    await updateCanvasConfig(getRequestProject(req) || undefined, updates);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

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
    const contentType = mimeTypes.lookup(filename) || "application/octet-stream";
    res.setHeader("Content-Type", contentType as string);
    res.setHeader("Content-Length", fileStat.size);
    res.setHeader("Last-Modified", fileStat.mtime.toUTCString());
    createReadStream(filePath).pipe(res);
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

const channelManager = new ChannelManager();

wss.on("error", (err) => {
  console.error("[websocket-server] Error:", (err as Error).message);
});

wss.on("connection", (ws) => {
  wsClients.add(ws);

  const cleanupWsChannels = () => {
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
        console.log(`[ws] client subscribed to project: ${proj} (now watching: ${fileWatcher.watchedProjects().join(", ")})`);
        break;
      }

      case "unsubscribe-project": {
        const prev = wsProjects.get(ws);
        if (!prev) break;
        wsProjects.delete(ws);
        fileWatcher.releaseProject(prev);
        console.log(`[ws] client unsubscribed from project: ${prev}`);
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

          if (channelManager.hasHandler(cardClass)) {
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
          } else {
            throw new Error(`No channel handler for "${cardClass}"`);
          }
        } catch (err) {
          console.error(`[ws] channel_open error:`, (err as Error).message);
          ws.send(JSON.stringify({ type: "error", id, error: (err as Error).message }));
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

/** Send a message only to WS clients subscribed to the given project. */
function broadcastToProject(project: string, msg: Record<string, unknown>) {
  const data = JSON.stringify(msg);
  let count = 0;
  for (const [ws, proj] of wsProjects) {
    if (proj !== project) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    try { ws.send(data); count++; } catch { wsClients.delete(ws); wsProjects.delete(ws); }
  }
  console.log(`[broadcast:${project}] ${msg.type} → ${count} subscribers`);
}

// ── File Watcher Events ──────────────────────────────────────

fileWatcher.on("file-change", async (event: { type: string; filename: string; project: string }) => {
  console.log(`[file-watcher:${event.project}] ${event.type}: ${event.filename}`);

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
});

fileWatcher.on("card-class-change", (event: { type: string; filename: string; project: string }) => {
  console.log(`[file-watcher:${event.project}] card-class ${event.type}: ${event.filename}`);
  broadcastToProject(event.project, { type: "card-class-changed", filename: event.filename, change: event.type });
});

// ── Startup ──────────────────────────────────────────────────

(async () => {
  // Ensure workspace directory exists
  await mkdir(WORKSPACE_DIR, { recursive: true });

  // Register mica.* RPC plugins
  registerMicaHandler("chat", chatHandler);  // mica.chat.*
  registerMicaHandler("exec", execHandler);  // mica.exec.*
  registerMicaHandler("fetch", fetchHandler);  // mica.fetch.*

  // Register channel-based plugins
  channelManager.registerHandler("chat", createAgentHandler(fileWatcher));  // .chat files -> Qwen agent
  channelManager.registerHandler("claude", createClaudeAgentHandler(fileWatcher));  // .claude files -> Claude Code agent
  channelManager.registerHandler("terminal", createPtyHandler());  // .terminal files -> PTY
  channelManager.registerHandler("llm-chat", createLlmChatHandler());  // .llm-chat files -> direct LLM chat
  channelManager.registerHandler("skills", createSkillComposeHandler());  // .skills files -> collaborative SKILL.md authoring
  channelManager.registerHandler("canvas-back", createCanvasBackComposeHandler());  // .canvas-back files -> propose-then-apply canvas-back editor

  // Start llama-server for local AI
  ensureLlamaServer().catch((err) => {
    console.warn("[startup] llama-server failed to start:", (err as Error).message);
  });

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
    channelManager.destroyAll();
    fileWatcher.stopAll();
    await stopLlamaServer();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as NodeJS.Signals[]) {
    process.removeAllListeners(sig);
    process.on(sig, () => { void shutdown(sig); });
  }
})();
