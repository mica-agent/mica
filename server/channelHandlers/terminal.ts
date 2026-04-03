/**
 * Terminal channel handler — PTY manager for terminal cards.
 *
 * Replaces TerminalChannelManager with the unified ChannelHandler interface.
 *
 * Lifecycle:
 *   onAttach (first) -> spawn PTY
 *   onAttach (subsequent) -> replay scrollback
 *   onDetach -> 0 clients left? start 30s idle timer
 *   idle timer fires -> kill PTY, ctx.destroy()
 *   onAttach during idle -> cancel timer, resume
 *   onDestroy -> kill PTY immediately
 *
 * Data protocol (matches xterm.js frontend):
 *   Server -> Browser:  { output: string }
 *   Browser -> Server:  { input: string } | { resize: true, cols: N, rows: N }
 */

import * as pty from "node-pty";
import type { ChannelHandler, SessionContext } from "../channelManager.js";

const SCROLLBACK_SIZE = 4000;  // chars to retain for replay
const IDLE_TIMEOUT_MS = 30_000; // 30s before killing an idle PTY

export function createTerminalHandler(
  _content: string,
  args: Record<string, unknown>,
  ctx: SessionContext,
): ChannelHandler {
  let ptyProcess: pty.IPty | null = null;
  let scrollback = "";
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  // Spawn override comes from open() args
  const spawnOverride = args.spawnOverride as
    | { shell: string; args: string[]; cwd?: string }
    | undefined;

  function spawnPty(cols: number, rows: number): void {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(cols),
      LINES: String(rows),
    };

    const shell = spawnOverride?.shell || process.env.SHELL || "/bin/bash";
    const shellArgs = spawnOverride?.args || ["--login"];
    // When spawning docker exec, cwd is the host-side working directory for the
    // docker process itself — use HOME, not the container-internal path.
    const cwd = (spawnOverride?.shell === "docker")
      ? (process.env.HOME || "/")
      : (spawnOverride?.cwd || process.env.HOME || "/");

    ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      env,
      cwd,
    });

    console.log(
      `[terminal-handler] Spawned PTY for ${ctx.project}/${ctx.canvas}/${ctx.filename} ` +
      `(${cols}x${rows}, shell=${shell} ${shellArgs.join(" ")})`,
    );

    // PTY output -> broadcast + accumulate scrollback
    ptyProcess.onData((data: string) => {
      scrollback += data;
      if (scrollback.length > SCROLLBACK_SIZE) {
        scrollback = scrollback.slice(-SCROLLBACK_SIZE);
      }
      ctx.broadcast({ output: data });
    });

    // PTY exit -> destroy session
    ptyProcess.onExit(() => {
      if (!destroyed) {
        console.log(`[terminal-handler] PTY exited for ${ctx.project}/${ctx.canvas}/${ctx.filename}`);
        ptyProcess = null;
        ctx.destroy();
      }
    });
  }

  function killPty(): void {
    if (ptyProcess) {
      try {
        ptyProcess.kill();
      } catch {
        // Already dead
      }
      ptyProcess = null;
    }
  }

  function cancelIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  return {
    onAttach(clientId: string, attachArgs: Record<string, unknown>): void {
      // Cancel any pending idle timer
      if (idleTimer) {
        cancelIdleTimer();
        ctx.resume();
        console.log(`[terminal-handler] Cancelled idle timer, client ${clientId} reattached`);
      }

      if (!ptyProcess) {
        // First attach or PTY was killed — spawn a new one
        const cols = (attachArgs.cols as number) || 80;
        const rows = (attachArgs.rows as number) || 24;
        spawnPty(cols, rows);
      } else {
        // Replay scrollback to the new client
        if (scrollback.length > 0) {
          ctx.sendTo(clientId, { output: scrollback });
        }
      }
    },

    onData(clientId: string, data: unknown): void {
      const msg = data as Record<string, unknown>;

      // Heartbeat — always respond even if PTY is dead
      if (msg.ping) {
        ctx.sendTo(clientId, { pong: true, ptyAlive: !!ptyProcess });
        return;
      }

      if (!ptyProcess) return;

      if (msg.input !== undefined) {
        ptyProcess.write(msg.input as string);
      } else if (msg.resize) {
        const cols = msg.cols as number;
        const rows = msg.rows as number;
        if (cols > 0 && rows > 0) {
          ptyProcess.resize(cols, rows);
        }
      }
    },

    onDetach(clientId: string): void {
      console.log(
        `[terminal-handler] Client ${clientId} detached ` +
        `(${ctx.clientCount()} remaining)`,
      );

      if (ctx.clientCount() === 0 && ptyProcess) {
        // No clients left — start idle timer
        console.log(
          `[terminal-handler] Starting ${IDLE_TIMEOUT_MS / 1000}s idle timer ` +
          `for ${ctx.project}/${ctx.canvas}/${ctx.filename}`,
        );
        ctx.idle();
        idleTimer = setTimeout(() => {
          console.log(
            `[terminal-handler] Idle timeout — killing PTY ` +
            `for ${ctx.project}/${ctx.canvas}/${ctx.filename}`,
          );
          killPty();
          ctx.destroy();
        }, IDLE_TIMEOUT_MS);
      }
    },

    onDestroy(): void {
      destroyed = true;
      cancelIdleTimer();
      killPty();
      scrollback = "";
    },
  };
}
