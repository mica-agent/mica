// opencodePlugin.mjs — Mica's opencode plugin. Loaded at opencode-serve
// startup via config.plugin = [path-to-this-file].
//
// Two jobs (both in `tool.execute.before`):
//
// 1. SESSION-ID STAMPING (for mica-builtins tools).
//    One opencode-serve daemon serves many .opencode sessions, sharing a
//    single MCP bridge (server/agentTools/opencodeBridge.mjs). When the
//    bridge POSTs to Mica's /api/tools/*, it has no way to know which
//    session originated the call — MCP tool calls don't carry session
//    context (opencode 1.15.5 leaves _meta undefined; upstream #15117).
//    This plugin closes the gap by stamping the calling session's ID onto
//    the args. The bridge reads it off the args, removes it before
//    forwarding, and sends it as the `x-mica-opencode-session-id` header.
//    Mica's REST handler maps that ID back to {project, chatFilename} via
//    server/agentTools/registry.ts (populated by server/opencodeAgent.ts
//    at session-attach time).
//
//    Why arg-mutation rather than _meta or env vars:
//      • opencode 1.15.5 doesn't propagate _meta from tools/call (verified
//        empirically — the bridge handler's `extra._meta` is undefined).
//      • Env vars need per-session MCP child spawning, which opencode-serve
//        does NOT do today (one bridge, all sessions).
//      • output.args is mutable in `tool.execute.before` per opencode docs
//        and verified by the diagnostic probe.
//
// 2. PATH-SANDBOX (Step B from the design plan).
//    opencode's built-in `read` / `write` / `edit` / `glob` / `grep` /
//    `list` tools accept absolute paths and walk anywhere on disk. We set
//    `external_directory: "allow"` in opencodeConfig.ts so they don't
//    stall on permission asks (the "ask" path's auto-approve was found to
//    stall the tool in opencode 1.15.10 — see Step A). But that left no
//    project isolation: a 2026-05-28 build with gemini-3.5-flash read
//    `/workspaces/testproj/canvas/sfo-traffic-spec.md` from a sibling
//    project. This plugin enforces the boundary in-band by throwing on
//    out-of-allowlist absolute paths BEFORE the tool runs. The error
//    surfaces to the agent as a tool failure with an educational message;
//    same shape as the library-prereq deny in toolPrerequisites.ts.
//
//    Allowlist is fetched per-session from Mica's REST
//    (/api/tools/opencode-session-scope) and cached in-process — sessions
//    are project-stable, so one fetch per session lifetime is enough.
//    Fail-open on lookup error (network/auth glitch shouldn't brick the
//    agent; the original "no isolation" state is what we revert to).
//
// Default-export-only on purpose: opencode iterates ALL async-function
// exports as plugin functions, so a named-plus-default export would
// register hooks twice and fire them twice per tool call.

const PREFIX = "mica-builtins_";
const STAMP_KEY = "_mica_session_id";

// Tools whose args carry path values to gate. Map: tool name → arg keys
// that contain a single path string. `bash` is intentionally OMITTED for
// v1 — gating bash requires parsing arbitrary shell commands (cat/grep/
// sed/etc.); the loophole is acknowledged. v2 candidate.
const PATH_ARG_KEYS = {
  read: ["filePath"],
  write: ["filePath"],
  edit: ["filePath"],
  list: ["path"],
  glob: ["path"],   // glob's `path` is the base dir; `pattern` is relative-or-absolute
  grep: ["path"],
};

const MICA_BASE = process.env.MICA_TOOLS_BASE_URL || "http://127.0.0.1:3002";
const AUTH = process.env.MICA_TOOLS_AUTH_SECRET || "";

// In-process cache: sessionID → string[] of absolute path prefixes.
// Sessions are project-stable, so this only needs to be fetched once per
// session. We refetch on cache miss only — no TTL needed for now.
const sessionScopeCache = new Map();

async function getSessionAllowlist(sessionID) {
  if (sessionScopeCache.has(sessionID)) return sessionScopeCache.get(sessionID);
  if (!AUTH) {
    // Plugin loaded without the auth secret — fail-open. (Setup bug or
    // standalone opencode usage outside Mica.)
    sessionScopeCache.set(sessionID, null);
    return null;
  }
  try {
    const res = await fetch(`${MICA_BASE}/api/tools/opencode-session-scope?sessionID=${encodeURIComponent(sessionID)}`, {
      headers: { "x-mica-agent-auth": AUTH },
    });
    if (!res.ok) {
      sessionScopeCache.set(sessionID, null);
      return null;
    }
    const body = await res.json();
    const list = Array.isArray(body?.allowlist) ? body.allowlist.filter((p) => typeof p === "string" && p.length > 0) : null;
    sessionScopeCache.set(sessionID, list);
    return list;
  } catch {
    sessionScopeCache.set(sessionID, null);
    return null;
  }
}

function isAbsolutePath(p) {
  return typeof p === "string" && p.startsWith("/");
}

function pathInAllowlist(absPath, allowlist) {
  for (const prefix of allowlist) {
    if (!prefix) continue;
    if (absPath === prefix) return true;
    if (absPath.startsWith(prefix.endsWith("/") ? prefix : prefix + "/")) return true;
  }
  return false;
}

export default async () => ({
  "tool.execute.before": async (input, output) => {
    const tool = typeof input?.tool === "string" ? input.tool : "";
    const sessionID = typeof input?.sessionID === "string" ? input.sessionID : "";

    // ── Job 0: refuse opencode's native `bash` tool ──────────────────
    // Native bash is ungated — it bypasses the path-sandbox below (which
    // only covers read/write/edit/list/glob/grep) and Mica's
    // DANGEROUS_BASH_PATTERNS guard. An agent used it to edit framework
    // source under /workspaces/mica and to run scripts/restart.sh
    // (2026-06-01). The qwen/Claude SDK path already excludes its native
    // shell (micaAgent.ts excludeTools) and routes all shell through the
    // guarded `mica_shell` (mica-builtins) tool; this brings opencode in
    // line. We enforce here in the hook rather than via opencode's
    // permission system, which is unreliable in this version (a non-"allow"
    // value stalls the tool instead of denying — see opencodeConfig.ts).
    // A thrown error aborts the tool deterministically and surfaces to the
    // model as a tool failure with the redirect.
    if (tool.toLowerCase() === "bash") {
      throw new Error(
        "The native `bash` tool is disabled in Mica. Use `mica_shell` " +
        "(the mica-builtins shell tool) for all shell commands — it runs the " +
        "same `/bin/bash -c` but with Mica's safety guards (won't kill the " +
        "backend, won't restart the stack, won't write to framework source). " +
        "Pass your command as `mica_shell({ command: \"...\" })`.",
      );
    }

    // ── Job 1: session-ID stamp for mica-builtins ────────────────────
    if (tool.startsWith(PREFIX) && sessionID && output && typeof output === "object") {
      if (!output.args || typeof output.args !== "object") output.args = {};
      output.args[STAMP_KEY] = sessionID;
    }

    // ── Job 2: path-sandbox for opencode built-in path-taking tools ──
    const argKeys = PATH_ARG_KEYS[tool];
    if (!argKeys || !sessionID) return;

    const args = output?.args ?? {};
    const allowlist = await getSessionAllowlist(sessionID);
    if (!allowlist) return; // fail-open on lookup failure (don't brick the agent)

    for (const key of argKeys) {
      const val = args[key];
      if (!isAbsolutePath(val)) continue; // relative paths are inside cwd by definition
      if (!pathInAllowlist(val, allowlist)) {
        const allowed = allowlist.join(", ");
        throw new Error(
          `Refused: ${tool} argument "${key}=${val}" is outside this project's directory. ` +
          `This .opencode session is scoped to:\n  - ${allowlist.join("\n  - ")}\n` +
          `Use a path inside one of those, or a relative path (resolved against your project root). ` +
          `If you genuinely need cross-project access, ask the user to add the location as a Mica library project ` +
          `(then it appears in the allowlist via ~/.mica/include-projects.json).`,
        );
      }
    }
  },
});
