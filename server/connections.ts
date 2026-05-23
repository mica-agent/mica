// Connections — workspace-level credential store + validators for the
// services Mica talks to on the user's behalf. Surfaced in the UI by
// the Connections panel; consumed server-side by anything that needs an
// API key (chat agents, MCP servers, etc.).
//
// Storage: <workspace>/.mica/credentials.json. Plain JSON, plaintext.
// Same posture as ~/.claude/.credentials.json — file-system permissions
// are the boundary, not encryption-at-rest. If/when we add encryption
// it's a separate project.
//
// Two service patterns:
//   - Pattern A (paste-key): user pastes a bearer token. Mica validates
//     against the service's public auth endpoint, stores the token in
//     credentials.json, and reads it from there at runtime.
//   - Pattern B (delegated CLI): the service has a first-party CLI that
//     handles its own OAuth/device-flow. Mica doesn't store the token —
//     it just reports "connected" by checking the CLI's credential file.
//     Phase 2: spawn the CLI's login command and stream its prompts
//     through the UI. For Phase 1, "connected" status only.
//
// Resolution order for any credential read:
//   1. Per-project override (if applicable — currently OpenRouter only)
//   2. <workspace>/.mica/credentials.json (this file's home)
//   3. Legacy <workspace>/.mica/config.json (for OpenRouter, kept for
//      backwards-compatibility with pre-Connections setups)
//   4. Process environment (lowest priority — convenience for `.env`)

import { readFile, writeFile, mkdir, stat as fsStat } from "fs/promises";
import { existsSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { WORKSPACE_DIR, micaDir } from "./files.js";

// ── Service registry ────────────────────────────────────────────────

/** Pattern A — services where Mica stores an API key the user pastes. */
export type PasteKeyService = "openrouter" | "anthropic" | "tavily" | "exa";

/** Pattern B — services where Mica only checks whether an external CLI
 *  has logged in. Mica never sees the token. */
export type DelegatedCliService = "claude" | "github";

export type ConnectionService = PasteKeyService | DelegatedCliService;

interface PasteKeyDef {
  id: PasteKeyService;
  pattern: "paste-key";
  displayName: string;
  description: string;
  /** Hint shown next to the input field. Helps users find the right key. */
  inputHint: string;
  /** Where to get the key. Surfaced as a "Get an API key" link in the UI. */
  signupUrl: string;
  /** Hits a public endpoint with the supplied key. Returns { ok, error?,
   *  warning? }. Network failure → warning + ok:true (we don't block on
   *  flaky validation; the key still saves). */
  validate: (key: string) => Promise<{ ok: boolean; error?: string; warning?: string }>;
}

interface DelegatedCliDef {
  id: DelegatedCliService;
  pattern: "delegated-cli";
  displayName: string;
  description: string;
  /** Phase-1 instruction: what the user runs in a terminal card to log in.
   *  Phase 2 will replace this with an interactive flow that Mica spawns. */
  phase1Instruction: string;
  /** Returns true if the service's first-party credential file is present. */
  isConnected: () => boolean;
}

export type ServiceDef = PasteKeyDef | DelegatedCliDef;

// ── Validators (Pattern A) ──────────────────────────────────────────

async function validateOpenRouter(key: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
      headers: { "Authorization": `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "OpenRouter rejected the key. Double-check that you copied it correctly and that it hasn't been revoked." };
    }
    return { ok: false, error: `OpenRouter returned ${res.status}. Try again.` };
  } catch {
    return { ok: true, warning: "Couldn't reach openrouter.ai to verify — saved unverified. Mica will use it on next API call." };
  }
}

async function validateAnthropic(key: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  try {
    // GET /v1/models is auth-gated, free, and returns 200 for valid keys.
    // Avoids spending tokens on a /v1/messages probe.
    const res = await fetch("https://api.anthropic.com/v1/models", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Anthropic rejected the key. Double-check that you copied it correctly and that it hasn't been revoked." };
    }
    return { ok: false, error: `Anthropic returned ${res.status}. Try again.` };
  } catch {
    return { ok: true, warning: "Couldn't reach api.anthropic.com to verify — saved unverified. Mica will use it on next API call." };
  }
}

async function validateTavily(key: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  try {
    // Trivial search — Tavily returns 200 with a body for valid keys, 401
    // for invalid. Counts against the free tier (1k/month) but a single
    // validation call is negligible.
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query: "test", max_results: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Tavily rejected the key. Double-check that you copied it correctly." };
    }
    return { ok: false, error: `Tavily returned ${res.status}. Try again.` };
  } catch {
    return { ok: true, warning: "Couldn't reach api.tavily.com to verify — saved unverified. Mica will use it on next search call." };
  }
}

async function validateExa(key: string): Promise<{ ok: boolean; error?: string; warning?: string }> {
  try {
    // Trivial search via /search — auth-gated, returns 200 for valid keys,
    // 401 for invalid. Cheaper than /answer (which costs ~$0.005); /search
    // results count against the plan's monthly cap but a single
    // validation call is negligible.
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test", numResults: 1 }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Exa rejected the key. Double-check that you copied it correctly." };
    }
    return { ok: false, error: `Exa returned ${res.status}. Try again.` };
  } catch {
    return { ok: true, warning: "Couldn't reach api.exa.ai to verify — saved unverified. Mica will use it on next search call." };
  }
}

// ── Pattern B status checks ─────────────────────────────────────────

function claudeConnected(): boolean {
  // The Claude Code CLI writes credentials to ~/.claude/.credentials.json
  // after `claude /login` succeeds. Presence-check is sufficient for
  // status; Mica doesn't read or validate the contents.
  return existsSync(join(homedir(), ".claude", ".credentials.json"));
}

/** Detect how GitHub auth is configured. Returns the source label, or
 *  null if nothing is set up. Multiple paths are valid because a Mica
 *  user may run inside a devcontainer that inherits credentials from
 *  the host in any of several ways:
 *
 *    - `gh auth login` writes ~/.config/gh/hosts.yml. Most explicit.
 *    - GH_TOKEN / GITHUB_TOKEN env var. Honored by gh and direct API
 *      callers; common in CI and devcontainer setups.
 *    - Git credential helper. Inherited from the host by VS Code's
 *      remote-container forwarding; gives `git push` to github.com
 *      without any gh-side config. We can't verify the helper actually
 *      holds a github.com credential without a network probe, so we
 *      trust its presence — that's the same posture gh's own
 *      detection takes.
 */
function githubAuthSource(): "gh-cli" | "env-token" | "git-credential" | null {
  if (existsSync(join(homedir(), ".config", "gh", "hosts.yml"))) return "gh-cli";
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return "env-token";
  try {
    const helper = execSync("git config --global credential.helper", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
      encoding: "utf-8",
    }).trim();
    if (helper) return "git-credential";
  } catch { /* git missing, or no helper configured */ }
  return null;
}

function githubConnected(): boolean {
  return githubAuthSource() !== null;
}

// ── Registry ────────────────────────────────────────────────────────

export const SERVICES: ServiceDef[] = [
  {
    id: "openrouter",
    pattern: "paste-key",
    displayName: "OpenRouter",
    description: "Cloud LLM provider — used by chat cards configured for cloud models (Claude, GPT, Gemini, etc.).",
    inputHint: "Starts with sk-or-v1-",
    signupUrl: "https://openrouter.ai/keys",
    validate: validateOpenRouter,
  },
  {
    id: "anthropic",
    pattern: "paste-key",
    displayName: "Anthropic API",
    description: "Direct Anthropic API access for SDK calls outside the Claude Code CLI.",
    inputHint: "Starts with sk-ant-",
    signupUrl: "https://console.anthropic.com/settings/keys",
    validate: validateAnthropic,
  },
  {
    id: "tavily",
    pattern: "paste-key",
    displayName: "Tavily",
    description: "Web search for agents — surfaced as the tavily-search MCP tool when connected.",
    inputHint: "Starts with tvly-",
    signupUrl: "https://app.tavily.com",
    validate: validateTavily,
  },
  {
    id: "exa",
    pattern: "paste-key",
    displayName: "Exa",
    description: "Semantic search + synthesized `answer` endpoint — surfaced as exa-mcp tools. Preferred over Tavily for specific URL lookups and asset discovery (see discover-dependency skill).",
    inputHint: "UUID-shaped key",
    signupUrl: "https://dashboard.exa.ai",
    validate: validateExa,
  },
  {
    id: "claude",
    pattern: "delegated-cli",
    displayName: "Claude Code",
    description: "First-party Claude CLI used by .claude chat cards. Auth is OAuth via the CLI itself.",
    phase1Instruction: "Open a .terminal card and run: claude /login",
    isConnected: claudeConnected,
  },
  {
    id: "github",
    pattern: "delegated-cli",
    displayName: "GitHub",
    description: "GitHub access for git push, PR creation, and gh-based tooling. Authenticates via gh CLI, GH_TOKEN env var, or an inherited git credential helper (devcontainer).",
    phase1Instruction: "Open a .terminal card and run: gh auth login (pick \"Login with a web browser\" — gives a device code). Or set GH_TOKEN in your environment.",
    isConnected: githubConnected,
  },
];

export function getService(id: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.id === id);
}

// ── Credentials.json read/write (Pattern A) ─────────────────────────

interface CredentialEntry {
  api_key: string;
  saved_at: number;
}

interface CredentialsFile {
  [serviceId: string]: CredentialEntry | undefined;
}

function credentialsPath(): string {
  return join(micaDir(), "credentials.json");
}

async function readCredentialsFile(): Promise<CredentialsFile> {
  try {
    const raw = await readFile(credentialsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed as CredentialsFile : {};
  } catch {
    return {};
  }
}

async function writeCredentialsFile(file: CredentialsFile): Promise<void> {
  await mkdir(micaDir(), { recursive: true });
  await writeFile(credentialsPath(), JSON.stringify(file, null, 2) + "\n", "utf-8");
}

/** Read a paste-key service's stored API key. Resolution order:
 *  workspace credentials.json → legacy workspace config.json (OpenRouter
 *  only) → environment variable. Caller-provided per-project override
 *  is checked separately by the caller (e.g. readOpenRouterKey). */
export async function readPasteKey(service: PasteKeyService): Promise<{ key: string; source: "credentials" | "legacy" | "env" } | null> {
  const file = await readCredentialsFile();
  const entry = file[service];
  if (entry && typeof entry.api_key === "string" && entry.api_key.length > 0) {
    return { key: entry.api_key, source: "credentials" };
  }
  // Legacy: OpenRouter used to live in <workspace>/.mica/config.json:openrouterApiKey
  // before the Connections panel. Kept as a fallback so existing setups
  // don't break. Other services don't have legacy entries — this branch
  // is OpenRouter-only.
  if (service === "openrouter") {
    try {
      const cfgRaw = await readFile(join(micaDir(), "config.json"), "utf-8");
      const cfg = JSON.parse(cfgRaw);
      if (cfg && typeof cfg.openrouterApiKey === "string" && cfg.openrouterApiKey.length > 0) {
        return { key: cfg.openrouterApiKey, source: "legacy" };
      }
    } catch { /* no legacy config */ }
  }
  const envName = ENV_VAR_FOR[service];
  const envVal = envName ? process.env[envName] : undefined;
  if (typeof envVal === "string" && envVal.length > 0) {
    return { key: envVal, source: "env" };
  }
  return null;
}

const ENV_VAR_FOR: Record<PasteKeyService, string> = {
  openrouter: "OPENROUTER_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
};

/** Write a paste-key service's API key to credentials.json. */
export async function writePasteKey(service: PasteKeyService, key: string): Promise<void> {
  const file = await readCredentialsFile();
  file[service] = { api_key: key, saved_at: Date.now() };
  await writeCredentialsFile(file);
}

/** Remove a paste-key service's API key from credentials.json. Doesn't
 *  touch env vars or legacy config.json — those are user-managed. */
export async function deletePasteKey(service: PasteKeyService): Promise<void> {
  const file = await readCredentialsFile();
  delete file[service];
  await writeCredentialsFile(file);
}

// ── Status reporting ────────────────────────────────────────────────

export interface ConnectionStatus {
  id: ConnectionService;
  pattern: "paste-key" | "delegated-cli";
  displayName: string;
  description: string;
  /** True if the service is set up and ready to use. */
  connected: boolean;
  /** Where the credential came from. Lets the UI explain "this key came
   *  from .env so manage it via Connections going forward" or "GitHub
   *  auth is via the inherited git credential helper". Paste-key uses
   *  credentials | legacy | env; delegated-cli (github only today) uses
   *  gh-cli | env-token | git-credential. */
  source?: "credentials" | "legacy" | "env" | "gh-cli" | "env-token" | "git-credential";
  /** When the user saved the key via Connections. Undefined for env/legacy
   *  sources and for delegated-cli. */
  savedAt?: number;
  /** UI hints — passed through verbatim from the registry. */
  inputHint?: string;
  signupUrl?: string;
  phase1Instruction?: string;
}

export async function getAllStatuses(): Promise<ConnectionStatus[]> {
  const out: ConnectionStatus[] = [];
  for (const svc of SERVICES) {
    if (svc.pattern === "paste-key") {
      const got = await readPasteKey(svc.id);
      out.push({
        id: svc.id,
        pattern: "paste-key",
        displayName: svc.displayName,
        description: svc.description,
        connected: got !== null,
        source: got?.source,
        savedAt: got?.source === "credentials"
          ? (await readCredentialsFile())[svc.id]?.saved_at
          : undefined,
        inputHint: svc.inputHint,
        signupUrl: svc.signupUrl,
      });
    } else {
      // Surface the auth source for delegated-cli when we can identify
      // one. Today this is github-only — claude's CLI uses a single
      // credentials path so the source line would just restate "claude
      // CLI" without informing.
      const source = svc.id === "github" ? (githubAuthSource() ?? undefined) : undefined;
      out.push({
        id: svc.id,
        pattern: "delegated-cli",
        displayName: svc.displayName,
        description: svc.description,
        connected: svc.isConnected(),
        source,
        phase1Instruction: svc.phase1Instruction,
      });
    }
  }
  return out;
}

// fsStat is imported but only re-exported in case future status checks
// want it (e.g. saved_at from a credential file's mtime). Suppress
// unused-import warning while keeping the import handy.
void fsStat;
void WORKSPACE_DIR;
