/**
 * TerminalChannel — Node-side PTY manager for terminal cards.
 *
 * Spawns PTY sessions via node-pty and manages their lifecycle.
 * Terminal channels bypass the Python worker pool entirely —
 * the browser talks directly to Node via WebSocket.
 *
 * Data protocol (matches xterm.js frontend expectations):
 *   Server → Browser:  { output: string }
 *   Browser → Server:  { input: string } | { resize: true, cols: N, rows: N }
 */

import * as pty from "node-pty";

interface TerminalSession {
  pty: pty.IPty;
  onData: (data: unknown) => void;
  onClose: () => void;
}

export class TerminalChannelManager {
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * Open a new PTY session for a channel.
   */
  open(
    channelId: string,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): void {
    const cols = (args.cols as number) || 80;
    const rows = (args.rows as number) || 24;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(cols),
      LINES: String(rows),
    };

    const shell = process.env.SHELL || "/bin/bash";

    const ptyProcess = pty.spawn(shell, ["--login"], {
      name: "xterm-256color",
      cols,
      rows,
      env,
      cwd: process.env.HOME || "/",
    });

    const session: TerminalSession = { pty: ptyProcess, onData, onClose };
    this.sessions.set(channelId, session);

    // PTY output → browser
    ptyProcess.onData((data: string) => {
      onData({ output: data });
    });

    // PTY exit → close channel
    ptyProcess.onExit(() => {
      this.sessions.delete(channelId);
      onClose();
    });

    console.log(`[terminal] Opened PTY session ${channelId} (${cols}x${rows}, shell=${shell})`);
  }

  /**
   * Handle incoming data from the browser for a terminal channel.
   */
  sendData(channelId: string, data: unknown): void {
    const session = this.sessions.get(channelId);
    if (!session) return;

    const msg = data as Record<string, unknown>;
    if (msg.input !== undefined) {
      session.pty.write(msg.input as string);
    } else if (msg.resize) {
      const cols = msg.cols as number;
      const rows = msg.rows as number;
      if (cols > 0 && rows > 0) {
        session.pty.resize(cols, rows);
      }
    }
  }

  /**
   * Close a terminal channel and kill the PTY.
   */
  close(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    this.sessions.delete(channelId);
    session.pty.kill();
    console.log(`[terminal] Closed PTY session ${channelId}`);
  }

  /**
   * Check if a channel ID belongs to a terminal session.
   */
  has(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  /**
   * Close all terminal sessions (for graceful shutdown).
   */
  closeAll(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }
}
