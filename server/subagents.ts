// subagents.ts — file-based subagent definitions for the Qwen / Claude agents.
//
// Subagents are how the chat agent delegates a coherent sub-task (write a
// module, survey a tree, etc.) to a fresh context. Definitions live in
// markdown files with YAML-ish frontmatter:
//
//   .qwen/agents/<name>.md      (project override)
//   .claude/agents/<name>.md    (project override, claude variant)
//   server/builtin-agents/*.md  (defaults shipped by Mica)
//
// Frontmatter fields: name, description, tools (YAML list), level ("session"),
// color, model.temp, model.top_p. Body is the subagent's systemPrompt.
//
// Rationale lives in /home/vscode/.claude/plans/joyful-honking-hinton.md
// (server = mechanism; project files = policy). We don't hard-code any
// subagent systemPrompt in server source.

import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { WORKSPACE_DIR } from "./files.js";

// Mirror Qwen SDK's SubagentConfig shape. Intentionally typed structurally
// here rather than importing from @qwen-code/sdk because claudeAgent.ts has
// its own SDK with a parallel concept and we want a single in-house type.
export interface ParsedSubagent {
  name: string;
  description: string;
  tools?: string[];
  systemPrompt: string;
  level: "session";
  color?: string;
  modelConfig?: {
    model?: string;
    temp?: number;
    top_p?: number;
  };
  runConfig?: {
    max_time_minutes?: number;
    max_turns?: number;
  };
}

// Where the server's built-in agents live on disk. Relative to this module.
const BUILTIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "builtin-agents");

/** Project-level agents directory for a given SDK flavor. */
function projectAgentsDir(project: string, flavor: "qwen" | "claude"): string {
  const host = flavor === "qwen" ? ".qwen" : ".claude";
  return join(WORKSPACE_DIR, project, host, "agents");
}

/** Minimal YAML-subset frontmatter parser. Handles:
 *   key: value          (scalar)
 *   key: [a, b, c]      (inline array)
 *   key: true|false|123 (booleans, numbers)
 *   key:                (block children, one level deep)
 *     subkey: value
 * Comments (#...) ignored. Quotes trimmed. Good enough for our agent files;
 * if we ever need full YAML, swap for a dep. */
function parseFrontmatter(fm: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lines = fm.split("\n");
  let currentBlockKey: string | null = null;
  let currentBlock: Record<string, unknown> | null = null;
  const stripQuotes = (s: string) => s.replace(/^["'](.*)["']$/, "$1");
  const coerce = (raw: string): unknown => {
    const t = raw.trim();
    if (t === "") return "";
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t.startsWith("[") && t.endsWith("]")) {
      return t.slice(1, -1).split(",").map((x) => stripQuotes(x.trim())).filter((x) => x.length);
    }
    return stripQuotes(t);
  };
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
    const content = line.trim();
    if (leadingSpaces === 0) {
      currentBlockKey = null; currentBlock = null;
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      const val = rest.trim();
      if (val === "") { currentBlockKey = key; currentBlock = {}; out[key] = currentBlock; continue; }
      out[key] = coerce(val);
    } else if (currentBlock) {
      const m = content.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
      if (!m) continue;
      const [, key, rest] = m;
      currentBlock[key] = coerce(rest.trim());
    }
  }
  void currentBlockKey;
  return out;
}

/** Parse one agent markdown file into a ParsedSubagent. Returns null if the
 *  file is malformed (missing name or systemPrompt body). */
async function parseAgentFile(filePath: string): Promise<ParsedSubagent | null> {
  let raw: string;
  try { raw = await readFile(filePath, "utf-8"); }
  catch { return null; }

  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!fmMatch) {
    console.warn(`[subagents] ${filePath}: missing frontmatter, skipping`);
    return null;
  }
  const fm = parseFrontmatter(fmMatch[1]);
  const body = raw.slice(fmMatch[0].length).trim();

  const name = typeof fm.name === "string" ? fm.name : "";
  if (!name) {
    console.warn(`[subagents] ${filePath}: missing 'name' field, skipping`);
    return null;
  }
  if (!body) {
    console.warn(`[subagents] ${filePath}: empty body (systemPrompt), skipping`);
    return null;
  }

  const tools = Array.isArray(fm.tools) ? (fm.tools as string[]) : undefined;
  const description = typeof fm.description === "string" ? fm.description : "";
  const level = fm.level === "session" ? "session" : "session";
  const color = typeof fm.color === "string" ? fm.color : undefined;

  const modelFm = (fm.model ?? fm.modelConfig) as Record<string, unknown> | undefined;
  const modelConfig = modelFm && typeof modelFm === "object" ? {
    model: typeof modelFm.model === "string" ? modelFm.model : undefined,
    temp: typeof modelFm.temp === "number" ? modelFm.temp : undefined,
    top_p: typeof modelFm.top_p === "number" ? modelFm.top_p : undefined,
  } : undefined;

  const runFm = fm.run as Record<string, unknown> | undefined;
  const runConfig = runFm && typeof runFm === "object" ? {
    max_time_minutes: typeof runFm.max_time_minutes === "number" ? runFm.max_time_minutes : undefined,
    max_turns: typeof runFm.max_turns === "number" ? runFm.max_turns : undefined,
  } : undefined;

  return { name, description, tools, systemPrompt: body, level, color, modelConfig, runConfig };
}

/** List agents from a directory. Silent no-op if the dir doesn't exist. */
async function readAgentsDir(dir: string): Promise<ParsedSubagent[]> {
  if (!existsSync(dir)) return [];
  const out: ParsedSubagent[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".md") || e.name.startsWith(".")) continue;
      const parsed = await parseAgentFile(join(dir, e.name));
      if (parsed) out.push(parsed);
    }
  } catch (err) {
    console.warn(`[subagents] failed to read ${dir}:`, (err as Error).message);
  }
  return out;
}

/** Load subagent configs for a project. Project files override same-named
 *  built-ins. If the project has no agents dir, built-ins are used alone.
 *
 *  `flavor` picks between .qwen/agents (Qwen SDK) and .claude/agents
 *  (Claude SDK). Built-ins are shared across both for now. */
export async function loadProjectSubagents(
  project: string | null,
  flavor: "qwen" | "claude",
): Promise<ParsedSubagent[]> {
  const builtins = await readAgentsDir(BUILTIN_DIR);
  const projectAgents = project ? await readAgentsDir(projectAgentsDir(project, flavor)) : [];

  const byName = new Map<string, ParsedSubagent>();
  for (const a of builtins) byName.set(a.name, a);
  for (const a of projectAgents) byName.set(a.name, a); // project wins
  return Array.from(byName.values());
}

// ── Concurrency semaphore ─────────────────────────────────────────
//
// Per-project counter of in-flight subagent tasks. Enforced in canUseTool
// when the SDK's "task" tool fires. Denial returns a structured hint so the
// parent agent learns to wait rather than retry-loop.

const PROVIDER_DEFAULT_CAP: Record<string, number> = {
  local: 3,       // match LLAMA_N_PARALLEL default; slots share GPU compute
  openrouter: 4,  // no local slot constraint; bounded to avoid fan-out runaway
};

interface ConcurrencyState {
  active: number;
  cap: number;
}
const concurrencyByProject = new Map<string, ConcurrencyState>();

export function configureConcurrency(project: string, provider: "local" | "openrouter", userCap?: number): void {
  const cap = typeof userCap === "number" && userCap > 0 ? userCap : PROVIDER_DEFAULT_CAP[provider] ?? 1;
  const existing = concurrencyByProject.get(project);
  if (existing) { existing.cap = cap; return; }
  concurrencyByProject.set(project, { active: 0, cap });
}

/** Returns true if a new subagent task can start; false otherwise. Does NOT
 *  increment — caller handles begin/end to keep incorrect accounting obvious
 *  under errors rather than hiding a leak. */
export function canStartSubagentTask(project: string): boolean {
  const s = concurrencyByProject.get(project);
  if (!s) return true; // no configuration yet = allow (fail-open for unknown state)
  return s.active < s.cap;
}

export function beginSubagentTask(project: string): void {
  const s = concurrencyByProject.get(project);
  if (!s) return;
  s.active++;
}

export function endSubagentTask(project: string): void {
  const s = concurrencyByProject.get(project);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
}

export function getConcurrencyStatus(project: string): { active: number; cap: number } | null {
  const s = concurrencyByProject.get(project);
  if (!s) return null;
  return { active: s.active, cap: s.cap };
}
