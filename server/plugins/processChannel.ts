// process channel handler — generic spawn-and-stream primitive for
// long-running third-party subprocesses. Mirrors the .terminal card's
// PTY pattern (server/plugins/pty.ts) but without the PTY emulation:
// just stdio streaming for non-interactive tools.
//
// Use cases — anything stateful and bounded by a process lifetime:
//   - autoresearch's training loop (uv run train.py running for hours)
//   - language servers (long-lived stdin/stdout JSON-RPC)
//   - polling daemons / webhook receivers
//   - SSH sessions, database REPLs (when you don't need a TTY)
//
// Card classes use this via mica.openChannel("process", { command, args, cwd, env }).
// Per-card config flows through openChannel args, same shape as llm-direct.
//
// Companion to cli-mcp (server/plugins/cliMcp.ts): cli-mcp is for stateless
// agent-callable tool invocations (MCP, request/response); process is for
// long-running stateful subprocesses (channel, bidirectional, streaming).
// Together they cover both shapes of "third-party code on canvas."

import { spawn, ChildProcess } from "child_process";
import { join } from "path";
import { WORKSPACE_DIR, getEffectiveWorkspaceDir } from "../files.js";
import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { HandlerManifest } from "../handlerManifest.js";

const SCROLLBACK_SIZE = 16_000;  // bytes; covers ~200 lines of typical log output

export function createProcessHandler() {
  return async function processHandlerFactory(
    _content: string,
    _initialArgs: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    // Lifecycle-driven: the subprocess is NOT spawned on channel-open.
    // The card sends { type: "start", command, args, cwd, env } when it's
    // ready (after loading config, after user clicks Start, etc.). This
    // lets the channel survive across multiple start/stop cycles without
    // recreating the session, and lets the card update config at runtime.
    //
    // State held by the closure: the current subprocess (or null), and a
    // scrollback buffer of recent output so late-joining clients catch up.
    let proc: ChildProcess | null = null;
    let lastConfig: { command: string; args: string[]; cwd: string } | null = null;
    let scrollback = "";

    function appendScrollback(data: string): void {
      scrollback = (scrollback + data).slice(-SCROLLBACK_SIZE);
    }

    function startProcess(args: Record<string, unknown>): void {
      // Refuse if already running. Card should send `signal` first, wait for
      // exit event, then start again.
      if (proc && proc.exitCode === null && !proc.killed) {
        ctx.broadcast({ type: "error", error: "subprocess already running; stop it first" });
        return;
      }

      const command = String(args.command || "");
      if (!command) {
        ctx.broadcast({ type: "error", error: "start requires 'command' field" });
        return;
      }
      const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
      const cwdArg = args.cwd ? String(args.cwd) : null;
      const envArg = (args.env && typeof args.env === "object")
        ? (args.env as Record<string, string>)
        : {};
      const cwd = cwdArg ?? (ctx.project ? join(getEffectiveWorkspaceDir(), ctx.project) : getEffectiveWorkspaceDir());

      const env: Record<string, string> = { ...(process.env as Record<string, string>) };
      for (const [k, v] of Object.entries(envArg)) {
        env[k] = String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
      }

      let spawned: ChildProcess;
      try {
        spawned = spawn(command, cmdArgs, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        const msg = (err as Error).message;
        console.error(`[process] ${ctx.filename}: spawn failed: ${msg}`);
        ctx.broadcast({ type: "error", error: `spawn failed: ${msg}` });
        return;
      }

      proc = spawned;
      lastConfig = { command, args: cmdArgs, cwd };
      // Reset scrollback on each fresh start. Old run's output is no longer
      // relevant once a new subprocess begins.
      scrollback = "";
      console.log(`[process] ${ctx.filename}: spawned ${command} ${cmdArgs.join(" ")} (pid=${spawned.pid}, cwd=${cwd})`);
      ctx.broadcast({ type: "started", pid: spawned.pid, command, args: cmdArgs, cwd });

      spawned.stdout?.on("data", (d: Buffer) => {
        const text = d.toString();
        appendScrollback(text);
        ctx.broadcast({ type: "stdout", data: text });
      });
      spawned.stderr?.on("data", (d: Buffer) => {
        const text = d.toString();
        appendScrollback(text);
        ctx.broadcast({ type: "stderr", data: text });
      });
      spawned.on("exit", (code, signal) => {
        console.log(`[process] ${ctx.filename}: exited (code=${code}, signal=${signal})`);
        ctx.broadcast({ type: "exit", code, signal });
        if (proc === spawned) proc = null;
      });
      spawned.on("error", (err) => {
        console.error(`[process] ${ctx.filename}: subprocess error: ${err.message}`);
        ctx.broadcast({ type: "error", error: err.message });
      });
    }

    return {
      onAttach(clientId, _attachArgs) {
        // Late joiner — give them the current state. If a subprocess is
        // running, replay scrollback + a started event. If not, just an
        // idle marker so the card UI can show "ready to start."
        if (proc && lastConfig) {
          if (scrollback) ctx.sendTo(clientId, { type: "stdout", data: scrollback });
          ctx.sendTo(clientId, { type: "started", pid: proc.pid, ...lastConfig });
        } else {
          ctx.sendTo(clientId, { type: "idle" });
        }
      },

      onData(_clientId, data) {
        const msg = data as {
          type?: string;
          data?: string;
          signal?: NodeJS.Signals;
          command?: string;
          args?: string[];
          cwd?: string;
          env?: Record<string, string>;
        };

        if (msg.type === "start") {
          // Fresh subprocess with the args from the message itself.
          startProcess(msg as Record<string, unknown>);
        } else if (msg.type === "input" && typeof msg.data === "string") {
          // Forward to subprocess stdin (REPLs, language servers, tools that
          // accept JSONL on stdin).
          try { proc?.stdin?.write(msg.data); } catch (err) {
            console.warn(`[process] ${ctx.filename}: stdin write failed: ${(err as Error).message}`);
          }
        } else if (msg.type === "signal") {
          // Card-side stop. Default SIGTERM; cards can override.
          if (proc) {
            const sig = msg.signal ?? "SIGTERM";
            try { proc.kill(sig); } catch { /* already gone */ }
          }
        } else if (msg.type === "close_stdin") {
          try { proc?.stdin?.end(); } catch { /* already closed */ }
        }
      },

      onDestroy() {
        // Card unmounted / channel torn down. Terminate any running subprocess
        // with the two-stage SIGTERM-then-SIGKILL pattern.
        if (!proc) return;
        const target = proc;
        console.log(`[process] ${ctx.filename}: destroying session (pid=${target.pid})`);
        try { target.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          if (target.exitCode === null && !target.killed) {
            console.warn(`[process] ${ctx.filename}: SIGKILL after grace`);
            try { target.kill("SIGKILL"); } catch { /* already gone */ }
          }
        }, 1500);
      },
    };
  };
}

export const manifest: HandlerManifest = {
  name: "process",
  version: "1.0.0",
  description:
    "Spawn a long-running subprocess and stream its stdout/stderr to the card. " +
    "Bidirectional: card can write to subprocess stdin via { type: 'input', data: string }. " +
    "Companion to cli-mcp's MCP-shaped tool calls — process is for stateful, persistent " +
    "tools (autoresearch's training loop, language servers, daemons). The .terminal card " +
    "uses a similar PTY-based pattern; this is the non-PTY equivalent for non-interactive " +
    "long-running tools.",
  whenToUse:
    "Pick this when your card class needs to run a long-lived process and stream its output. " +
    "Good fit: training agents, polling daemons, language servers, REPLs, SSH-shaped sessions. " +
    "NOT for stateless tool calls (use cli-mcp via tools.json instead). NOT for interactive " +
    "shell input (use .terminal which provides PTY emulation). NOT for HTTP services (use " +
    "mica.fetch from card.js).",
  argsSchema: {
    type: "object",
    description: "openChannel takes no required args. The subprocess is spawned only after the card sends a { type: 'start', command, args, cwd, env } message — see sendShapes. This lets the card load per-instance config (e.g. from its instance file) and then start, and lets the same channel survive multiple start/stop cycles without reopening.",
    properties: {},
  },
  sendShapes: {
    type: "object",
    description:
      "What the card may send via channel.send(): " +
      "{ type: 'start', command: string, args?: string[], cwd?: string, env?: object } to spawn the subprocess (only one running at a time per session); " +
      "{ type: 'input', data: string } to write to the subprocess's stdin; " +
      "{ type: 'signal', signal?: 'SIGTERM'|'SIGKILL'|'SIGINT'|... } to terminate the running subprocess (default SIGTERM); " +
      "{ type: 'close_stdin' } to send EOF to the subprocess's stdin.",
  },
  recvShapes: {
    type: "object",
    description:
      "What the card receives via channel.onData(). Event types: " +
      "{ type: 'idle' } on attach when no subprocess is running yet (card-side prompt: 'click Start'); " +
      "{ type: 'started', pid, command, args, cwd } when a subprocess spawns (and on attach if one is currently running); " +
      "{ type: 'stdout', data: string } per-chunk stdout (also replayed as scrollback on attach); " +
      "{ type: 'stderr', data: string } per-chunk stderr; " +
      "{ type: 'exit', code, signal } when the subprocess exits (channel survives — card can send another 'start' to spawn fresh); " +
      "{ type: 'error', error: string } on spawn or runtime errors.",
  },
};
