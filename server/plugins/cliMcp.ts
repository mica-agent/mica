// cli-mcp adapter — turn project's `<project>/.mica/tools.json` declarations
// into a project-scoped MCP server. The agent reads a tool's README, writes a
// manifest entry, and the tool becomes callable via `mcp__mica-tools__<server>_<op>`.
// No per-tool Mica code; the adapter just runs whatever bash commands the
// manifest declares and exposes the results as MCP tools.
//
// Lifecycle per tool call:
//   1. Read manifest fresh (so changes pick up across sessions; one-session
//      latency to add a NEW tool, but edits to existing tools land immediately).
//   2. Ensure install marker exists at <install_dir>/.mica-installed. If absent,
//      run install commands sequentially. Capture all output to .mica-install.log.
//      Failure surfaces as an MCP tool error with stage="install".
//   3. Spawn the run command per the tool's `io` pattern. Apply timeout (default
//      300s, configurable per-tool). Capture stdout as the result, stderr for
//      error context.
//
// See plan: cli-mcp adapter — third-party CLI tools as project-scoped MCP servers.

import { join } from "path";
import { spawn } from "child_process";
import { writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { z } from "zod";
import { WORKSPACE_DIR } from "../files.js";

// SDK helpers populated by bindSdk. Same lazy-binding pattern as
// server/plugins/cardClassTools.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tool: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createSdkMcpServer: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bindSdk(tool: any, createSdkMcpServer: any): void {
  _tool = tool;
  _createSdkMcpServer = createSdkMcpServer;
}

// ── Manifest types ────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description?: string;
  input?: Record<string, "string" | "number" | "boolean" | "array" | "object">;
  output?: "string" | "json" | "markdown";
  // io patterns:
  //   "args"                  — input fields baked into argv via argv_template
  //   "stdin-json/stdout-text" — JSON sent on stdin, raw text from stdout
  //   "stdin-json/stdout-json" — JSON in, JSON parsed from stdout
  io?: "args" | "stdin-json/stdout-text" | "stdin-json/stdout-json";
  argv_template?: string[];
  timeout_ms?: number;
}

interface ServerManifest {
  install?: string[];
  command: string;
  args?: string[];
  env?: Record<string, string>;
  install_dir?: string;
  tools: ToolDef[];
}

interface ToolsJson {
  [serverName: string]: ServerManifest;
}

// ── Manifest loading ──────────────────────────────────────────────

function manifestPath(project: string): string {
  return join(WORKSPACE_DIR, project, ".mica", "tools.json");
}

// Sync read so buildCliMcpServer can be called from the SDK options' IIFE.
// tools.json is tiny (a few KB at most); the sync cost is negligible.
function loadManifest(project: string): ToolsJson | null {
  const path = manifestPath(project);
  if (!existsSync(path)) return null;
  try {
    const content = readFileSync(path, "utf-8");
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      console.warn(`[cli-mcp] ${path}: top-level value must be an object`);
      return null;
    }
    return parsed as ToolsJson;
  } catch (e) {
    console.warn(`[cli-mcp] failed to parse ${path}: ${(e as Error).message}`);
    return null;
  }
}

// Resolve `${VAR}` references in env values against backend's process.env.
// Same shape as the qwen SDK's settings.json env interpolation.
function resolveEnv(env: Record<string, string> | undefined): Record<string, string> {
  if (!env) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    out[k] = String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
  }
  return out;
}

function getInstallDir(serverName: string, manifest: ServerManifest): string {
  return manifest.install_dir ?? join("/workspaces", ".cache", serverName);
}

// ── Install lifecycle ─────────────────────────────────────────────

interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

function runShell(cmd: string, env: Record<string, string>, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", cmd], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1, timedOut });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + `\n[spawn error] ${err.message}`, exitCode: -1, timedOut: false });
    });
  });
}

async function ensureInstalled(
  serverName: string,
  manifest: ServerManifest,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // No-install case: empty array OR no install field. Tool is assumed
  // already on PATH (system binaries, pre-existing tools).
  if (!manifest.install || manifest.install.length === 0) {
    return { ok: true };
  }

  const installDir = getInstallDir(serverName, manifest);
  const marker = join(installDir, ".mica-installed");
  const logPath = join(installDir, ".mica-install.log");

  if (existsSync(marker)) return { ok: true };

  await mkdir(installDir, { recursive: true });
  console.log(`[cli-mcp:${serverName}] install starting`);
  const start = Date.now();
  const env = resolveEnv(manifest.env);

  for (const cmd of manifest.install) {
    // 10-min hard cap per install step. Most installs (pipx, npm, apt) finish
    // in <60s; a 10-min cap catches stuck git clones or slow first-time pip
    // dependency resolution without being unreasonable.
    const result = await runShell(cmd, env, 600_000);
    const stamp = new Date().toISOString();
    await appendFile(
      logPath,
      `\n--- ${stamp} ${cmd}\nexit=${result.exitCode}${result.timedOut ? " [timeout]" : ""}\n${result.stdout}\n${result.stderr}\n`,
    );
    if (result.exitCode !== 0) {
      const tail = result.stderr.split("\n").filter(Boolean).slice(-50).join("\n");
      const reason = result.timedOut ? "timed out" : `exit=${result.exitCode}`;
      console.error(`[cli-mcp:${serverName}] install FAILED (${reason}) at "${cmd.slice(0, 80)}"`);
      return {
        ok: false,
        error: `install step failed (${reason}):\n  $ ${cmd}\nstderr (last 50 lines):\n${tail}\n\nFull log: ${logPath}`,
      };
    }
  }

  await writeFile(
    marker,
    JSON.stringify({ installed_at: new Date().toISOString() }, null, 2),
  );
  const dur = Math.round((Date.now() - start) / 1000);
  console.log(`[cli-mcp:${serverName}] install OK (${dur}s)`);
  return { ok: true };
}

// ── Per-call invocation ───────────────────────────────────────────

function interpolateArgv(template: string[], args: Record<string, unknown>): string[] {
  return template.map((s) =>
    s.replace(/\{\{([a-z_][a-z0-9_]*)\}\}/gi, (_m, key) => {
      const v = args[key];
      return v === undefined || v === null ? "" : String(v);
    }),
  );
}

async function runTool(
  serverName: string,
  manifest: ServerManifest,
  toolDef: ToolDef,
  args: Record<string, unknown>,
): Promise<{ ok: true; output: string } | { ok: false; error: string }> {
  const installResult = await ensureInstalled(serverName, manifest);
  if (!installResult.ok) {
    return { ok: false, error: `[stage: install] ${installResult.error}` };
  }

  const timeoutMs = toolDef.timeout_ms ?? 300_000;
  const env = resolveEnv(manifest.env);
  const io = toolDef.io ?? "args";

  const baseArgs = manifest.args ?? [];
  const templated = toolDef.argv_template ? interpolateArgv(toolDef.argv_template, args) : [];
  const argv = [...baseArgs, ...templated];

  const inputBytes = JSON.stringify(args).length;
  console.log(`[cli-mcp:${serverName}] ${toolDef.name} called (input bytes=${inputBytes}, timeout=${timeoutMs}ms)`);
  const start = Date.now();

  return await new Promise((resolve) => {
    const proc = spawn(manifest.command, argv, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });

    if (io.startsWith("stdin-json")) {
      try { proc.stdin.write(JSON.stringify(args) + "\n"); } catch { /* pipe already closed */ }
    }
    try { proc.stdin.end(); } catch { /* ignore */ }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const dur = Math.round(Date.now() - start);
      const outputBytes = stdout.length;
      if (timedOut) {
        console.warn(`[cli-mcp:${serverName}] ${toolDef.name} timed out at ${timeoutMs}ms`);
        resolve({ ok: false, error: `[stage: run] timed out after ${timeoutMs}ms\nstderr (last 500 chars): ${stderr.slice(-500)}` });
        return;
      }
      console.log(`[cli-mcp:${serverName}] ${toolDef.name} returned in ${dur}ms (output bytes=${outputBytes}, exit=${code ?? "?"})`);
      if (code !== 0) {
        resolve({ ok: false, error: `[stage: run] exit=${code}\nstderr (last 500 chars): ${stderr.slice(-500)}` });
      } else {
        resolve({ ok: true, output: stdout });
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `[stage: run] spawn error: ${err.message}` });
    });
  });
}

// ── Schema generation ─────────────────────────────────────────────

function buildInputSchema(toolDef: ToolDef): Record<string, z.ZodTypeAny> {
  if (!toolDef.input) return {};
  const schema: Record<string, z.ZodTypeAny> = {};
  for (const [key, type] of Object.entries(toolDef.input)) {
    switch (type) {
      case "string":  schema[key] = z.string(); break;
      case "number":  schema[key] = z.number(); break;
      case "boolean": schema[key] = z.boolean(); break;
      case "array":   schema[key] = z.array(z.unknown()); break;
      case "object":  schema[key] = z.record(z.unknown()); break;
      default:        schema[key] = z.unknown(); break;
    }
  }
  return schema;
}

// ── MCP server builder ────────────────────────────────────────────

export function buildCliMcpServer(sessionProject: string | null): unknown | null {
  if (!sessionProject || !_tool || !_createSdkMcpServer) return null;
  const manifest = loadManifest(sessionProject);
  if (!manifest) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools: any[] = [];
  for (const [serverName, serverManifest] of Object.entries(manifest)) {
    if (!serverManifest || typeof serverManifest !== "object") continue;
    if (!Array.isArray(serverManifest.tools)) continue;
    for (const toolDef of serverManifest.tools) {
      if (!toolDef || typeof toolDef.name !== "string") continue;
      const fullName = `${serverName}_${toolDef.name}`;
      const description = toolDef.description ?? `Invoke ${serverName}.${toolDef.name}`;
      const inputSchema = buildInputSchema(toolDef);
      tools.push(
        _tool(
          fullName,
          description,
          inputSchema,
          async (args: Record<string, unknown>) => {
            const result = await runTool(serverName, serverManifest, toolDef, args);
            if (!result.ok) {
              return {
                content: [{ type: "text" as const, text: result.error }],
                isError: true,
              };
            }
            return {
              content: [{ type: "text" as const, text: result.output }],
            };
          },
        ),
      );
    }
  }

  if (tools.length === 0) {
    console.log(`[cli-mcp] ${sessionProject}: tools.json present but no tools declared`);
    return null;
  }

  console.log(`[cli-mcp] ${sessionProject}: registered ${tools.length} tool(s) from tools.json`);
  return _createSdkMcpServer({
    name: "mica-tools",
    version: "1.0.0",
    tools,
  });
}
