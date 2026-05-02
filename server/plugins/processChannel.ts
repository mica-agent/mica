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
import { WORKSPACE_DIR } from "../files.js";
import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { HandlerManifest } from "../handlerManifest.js";

const SCROLLBACK_SIZE = 16_000;  // bytes; covers ~200 lines of typical log output

export function createProcessHandler() {
  return async function processHandlerFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const command = String(args.command || "");
    const cmdArgs = Array.isArray(args.args) ? (args.args as string[]).map(String) : [];
    const cwdArg = args.cwd ? String(args.cwd) : null;
    const envArg = (args.env && typeof args.env === "object")
      ? (args.env as Record<string, string>)
      : {};

    if (!command) {
      console.error(`[process] ${ctx.filename}: missing 'command' arg`);
      ctx.broadcast({ type: "error", error: "process channel requires 'command' arg" });
      return {
        onData() { /* no-op; channel is dead */ },
        onDestroy() { /* no-op */ },
      };
    }

    // Default cwd is the project root, matching the .terminal pattern.
    // Cards that need a different cwd (e.g., autoresearch installed in
    // /workspaces/.cache/autoresearch) override via the cwd arg.
    const cwd = cwdArg ?? (ctx.project ? join(WORKSPACE_DIR, ctx.project) : WORKSPACE_DIR);

    // Resolve ${VAR} env interpolation against backend's process.env.
    // Same shape as the cli-mcp adapter and the qwen SDK's settings.json.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(envArg)) {
      env[k] = String(v).replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => process.env[name] ?? "");
    }

    let proc: ChildProcess;
    try {
      proc = spawn(command, cmdArgs, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[process] ${ctx.filename}: spawn failed: ${msg}`);
      ctx.broadcast({ type: "error", error: `spawn failed: ${msg}` });
      return {
        onData() {},
        onDestroy() {},
      };
    }

    console.log(`[process] ${ctx.filename}: spawned ${command} ${cmdArgs.join(" ")} (pid=${proc.pid}, cwd=${cwd})`);
    ctx.broadcast({ type: "started", pid: proc.pid, command, args: cmdArgs, cwd });

    // Scrollback buffer for late-joining clients (browser tab reload, second
    // tab opens the same card). Stdout + stderr are interleaved in the buffer
    // — same as the user would see if they were watching the process directly.
    let scrollback = "";
    function appendScrollback(data: string): void {
      scrollback = (scrollback + data).slice(-SCROLLBACK_SIZE);
    }

    proc.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      appendScrollback(text);
      ctx.broadcast({ type: "stdout", data: text });
    });
    proc.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      appendScrollback(text);
      ctx.broadcast({ type: "stderr", data: text });
    });
    proc.on("exit", (code, signal) => {
      console.log(`[process] ${ctx.filename}: exited (code=${code}, signal=${signal})`);
      ctx.broadcast({ type: "exit", code, signal });
    });
    proc.on("error", (err) => {
      console.error(`[process] ${ctx.filename}: subprocess error: ${err.message}`);
      ctx.broadcast({ type: "error", error: err.message });
    });

    return {
      onAttach(clientId, _args) {
        // Late joiner — replay the recent buffer so they have context. The
        // type is "stdout" (not a separate "scrollback" type) so the card
        // doesn't need special-case handling — just append to the log pane
        // like any other output.
        if (scrollback) {
          ctx.sendTo(clientId, { type: "stdout", data: scrollback });
        }
        ctx.sendTo(clientId, { type: "started", pid: proc.pid, command, args: cmdArgs, cwd });
      },

      onData(_clientId, data) {
        const msg = data as { type?: string; data?: string; signal?: NodeJS.Signals };

        if (msg.type === "input" && typeof msg.data === "string") {
          // Forward stdin to the subprocess. Useful for tools that read
          // commands line-by-line from stdin (REPLs, language servers).
          try { proc.stdin?.write(msg.data); } catch (err) {
            console.warn(`[process] ${ctx.filename}: stdin write failed: ${(err as Error).message}`);
          }
        } else if (msg.type === "signal") {
          // Card-side abort / interrupt. signal defaults to SIGTERM; cards
          // can pass SIGINT / SIGKILL / etc. for tool-specific shutdowns.
          const sig = msg.signal ?? "SIGTERM";
          try { proc.kill(sig); } catch { /* already gone */ }
        } else if (msg.type === "close_stdin") {
          // For tools that need EOF on stdin to start processing.
          try { proc.stdin?.end(); } catch { /* already closed */ }
        }
      },

      onDestroy() {
        // Card unmounted / channel torn down — terminate the subprocess.
        // Two-stage shutdown: SIGTERM first to let the tool clean up
        // (write final logs, flush buffers), then SIGKILL after a short
        // grace if it's still alive. Mirrors the SDK lifecycle teardown
        // shipped earlier today (server/micaAgent.ts q.close() pattern).
        console.log(`[process] ${ctx.filename}: destroying session (pid=${proc.pid})`);
        try { proc.kill("SIGTERM"); } catch { /* already gone */ }
        setTimeout(() => {
          if (proc.exitCode === null && !proc.killed) {
            console.warn(`[process] ${ctx.filename}: SIGKILL after grace`);
            try { proc.kill("SIGKILL"); } catch { /* already gone */ }
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
    properties: {
      command: { type: "string", description: "Path or PATH-resolvable name of the binary to spawn (e.g., 'python', '/usr/bin/uv', 'node')." },
      args: { type: "array", items: { type: "string" }, description: "Argv to pass to the command. Default: []." },
      cwd: { type: "string", description: "Working directory for the spawned process. Default: project root. Override for tools installed outside the project (e.g., /workspaces/.cache/autoresearch)." },
      env: { type: "object", description: "Extra environment variables for the process. Backend's process.env is the base; these override. ${VAR} interpolation against backend env is supported." },
    },
    required: ["command"],
  },
  sendShapes: {
    type: "object",
    description:
      "What the card may send via channel.send(): " +
      "{ type: 'input', data: string } to write to the subprocess's stdin; " +
      "{ type: 'signal', signal?: 'SIGTERM'|'SIGKILL'|'SIGINT'|... } to terminate (default SIGTERM); " +
      "{ type: 'close_stdin' } to send EOF to the subprocess's stdin (some tools need this to start processing).",
  },
  recvShapes: {
    type: "object",
    description:
      "What the card receives via channel.onData(). Event types: " +
      "{ type: 'started', pid, command, args, cwd } when the subprocess spawns; " +
      "{ type: 'stdout', data: string } per-chunk stdout (also replayed as scrollback on attach); " +
      "{ type: 'stderr', data: string } per-chunk stderr; " +
      "{ type: 'exit', code, signal } when the subprocess exits; " +
      "{ type: 'error', error: string } on spawn or runtime errors.",
  },
};
