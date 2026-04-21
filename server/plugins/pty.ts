// pty plugin -- mica.pty.* server primitive.
// Provides interactive PTY sessions via ChannelManager.
// Any card class can open a PTY with mica.openChannel("pty", { shell, cols, rows }).

import * as pty from "node-pty";
import { WORKSPACE_DIR } from "../files.js";
import { join } from "path";
import type { ChannelHandler, SessionContext } from "../channelManager.js";

const SCROLLBACK_SIZE = 4000;

// Backward-compat shim: server/index.ts still calls setActiveProject on
// project-switch to update phase-1 globals. Keep the no-op so the import
// doesn't break, but DON'T read it here — session's cwd is captured from
// ctx.project at channel-open time, not from whatever project was last
// switched to in some other tab.
export function setActiveProject(_project: string | null) { void _project; }

export function createPtyHandler() {
  return async function ptyHandlerFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {
    const cols = (args.cols as number) || 80;
    const rows = (args.rows as number) || 24;
    const shell = (args.shell as string) || process.env.SHELL || "/bin/bash";
    const shellArgs = (args.args as string[]) || ["--login"];

    // Per-session project — captured when this channel opened, stable for
    // the session's life. Multiple tabs with different active projects each
    // get their own correct cwd; subsequent project-switches in any tab
    // don't redirect this already-open terminal.
    const cwd = ctx.project ? join(WORKSPACE_DIR, ctx.project) : WORKSPACE_DIR;

    // Scrollback buffer for reconnecting clients
    let scrollback = "";

    // Spawn PTY
    const term = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      } as Record<string, string>,
    });

    console.log(`[pty] Spawned ${shell} (pid ${term.pid}) for ${ctx.filename}`);

    // Forward PTY output to all attached clients
    term.onData((data: string) => {
      // Maintain scrollback
      scrollback += data;
      if (scrollback.length > SCROLLBACK_SIZE) {
        scrollback = scrollback.slice(-SCROLLBACK_SIZE);
      }
      ctx.broadcast({ type: "output", data });
    });

    term.onExit(({ exitCode, signal }) => {
      console.log(`[pty] Exited (code=${exitCode}, signal=${signal}) for ${ctx.filename}`);
      ctx.broadcast({ type: "exit", exitCode, signal });
    });

    return {
      onAttach(clientId, _args) {
        // Send scrollback to reconnecting client
        if (scrollback) {
          ctx.sendTo(clientId, { type: "output", data: scrollback });
        }
      },

      onData(_clientId, data) {
        const msg = data as { type?: string; data?: string; cols?: number; rows?: number };

        if (msg.type === "input" && msg.data) {
          term.write(msg.data);
        } else if (msg.type === "resize" && msg.cols && msg.rows) {
          try { term.resize(msg.cols, msg.rows); } catch { /* ignore resize errors */ }
        } else if (typeof msg === "string") {
          // Raw string input (backward compat)
          term.write(msg as string);
        }
      },

      onDestroy() {
        console.log(`[pty] Destroying session for ${ctx.filename}`);
        try { term.kill(); } catch { /* already dead */ }
      },
    };
  };
}
