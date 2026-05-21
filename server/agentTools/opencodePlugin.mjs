// opencodePlugin.mjs — Mica's opencode plugin. Loaded at opencode-serve
// startup via config.plugin = [path-to-this-file].
//
// Why this file exists: one opencode-serve daemon serves many .opencode
// sessions, and they share a single MCP bridge (server/agentTools/
// opencodeBridge.mjs). When the bridge POSTs to Mica's /api/tools/*, it
// has no way to know which opencode session originated the call — MCP
// tool calls don't carry session context (opencode 1.15.5 leaves _meta
// undefined; see upstream issue #15117).
//
// This plugin closes the gap by intercepting `tool.execute.before` for
// mica-builtins tools and stamping the calling session's ID onto the
// args. The bridge reads it off the args, removes it before forwarding,
// and sends it as the `x-mica-opencode-session-id` header. Mica's REST
// handler maps that ID back to a project via a per-session map kept in
// server/agentTools/registry.ts (populated by server/opencodeAgent.ts
// at session-attach time).
//
// Why arg-mutation rather than _meta or env vars:
//   • opencode 1.15.5 doesn't propagate _meta from tools/call (verified
//     empirically — the bridge handler's `extra._meta` is undefined).
//   • Env vars need per-session MCP child spawning, which opencode-serve
//     does NOT do today (one bridge, all sessions).
//   • output.args is mutable in `tool.execute.before` per opencode docs
//     and verified by the diagnostic probe: a hook returning
//     `output.args.x = y` shows up in the args the bridge receives.
//
// Default-export-only on purpose: opencode iterates ALL async-function
// exports as plugin functions, so a named-plus-default export would
// register hooks twice and fire them twice per tool call.

const PREFIX = "mica-builtins_";
const STAMP_KEY = "_mica_session_id";

export default async () => ({
  "tool.execute.before": async (input, output) => {
    if (typeof input?.tool !== "string" || !input.tool.startsWith(PREFIX)) return;
    if (typeof input.sessionID !== "string" || !input.sessionID) return;
    // output.args === the args object the bridge will receive. Mutating
    // in place is safe and idempotent — if some upstream change ever
    // calls us twice for the same tool call, stamping the same value is
    // a no-op.
    if (output && typeof output === "object") {
      if (!output.args || typeof output.args !== "object") output.args = {};
      output.args[STAMP_KEY] = input.sessionID;
    }
  },
});
