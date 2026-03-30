/**
 * TerminalChannel — Node-side PTY manager for terminal cards.
 *
 * Sessions are keyed by (project, canvas, filename), not by channel ID.
 * Multiple browser channels can attach to the same PTY session — this
 * handles expand/collapse, layout switches, and multi-tab scenarios.
 *
 * Lifecycle:
 *   openChannel → session exists? attach (replay scrollback) : spawn PTY
 *   closeChannel → detach. 0 channels left? start idle timer.
 *   idle timer fires → kill PTY.
 *   openChannel during idle timer → cancel timer, attach.
 *
 * Data protocol (matches xterm.js frontend expectations):
 *   Server → Browser:  { output: string }
 *   Browser → Server:  { input: string } | { resize: true, cols: N, rows: N }
 */

import * as pty from "node-pty";

const SCROLLBACK_SIZE = 4000;  // chars to retain for replay
const IDLE_TIMEOUT_MS = 30000; // 30s before killing an idle PTY

interface ChannelHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

interface TerminalSession {
  pty: pty.IPty;
  channels: Map<string, ChannelHandle>;
  scrollback: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class TerminalChannelManager {
  // Sessions keyed by "project/canvas/filename"
  private sessions: Map<string, TerminalSession> = new Map();
  // Reverse lookup: channelId → sessionKey
  private channelToSession: Map<string, string> = new Map();

  private sessionKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  /**
   * Open or attach to a terminal session.
   * If a session already exists for this file, attach the new channel and replay scrollback.
   * Otherwise, spawn a new PTY.
   */
  open(
    channelId: string,
    project: string,
    canvas: string,
    filename: string,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void,
    spawnOverride?: { shell: string; args: string[]; cwd?: string },
  ): void {
    const key = this.sessionKey(project, canvas, filename);
    const existing = this.sessions.get(key);

    if (existing) {
      // Attach to existing session
      if (existing.idleTimer) {
        clearTimeout(existing.idleTimer);
        existing.idleTimer = null;
        console.log(`[terminal] Cancelled idle timer for ${key}`);
      }

      existing.channels.set(channelId, { onData, onClose });
      this.channelToSession.set(channelId, key);

      // Replay scrollback so the new channel sees recent output
      if (existing.scrollback.length > 0) {
        onData({ output: existing.scrollback });
      }

      console.log(`[terminal] Attached channel ${channelId} to existing session ${key} (${existing.channels.size} channels)`);
      return;
    }

    // Spawn new PTY
    const cols = (args.cols as number) || 80;
    const rows = (args.rows as number) || 24;

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      COLUMNS: String(cols),
      LINES: String(rows),
    };

    const shell = spawnOverride?.shell || process.env.SHELL || "/bin/bash";
    const shellArgs = spawnOverride?.args || ["--login"];
    const cwd = spawnOverride?.cwd || process.env.HOME || "/";

    const ptyProcess = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      env,
      cwd,
    });

    const session: TerminalSession = {
      pty: ptyProcess,
      channels: new Map([[channelId, { onData, onClose }]]),
      scrollback: "",
      idleTimer: null,
    };
    this.sessions.set(key, session);
    this.channelToSession.set(channelId, key);

    // PTY output → broadcast to all attached channels + accumulate scrollback
    ptyProcess.onData((data: string) => {
      // Append to scrollback, trim to size limit
      session.scrollback += data;
      if (session.scrollback.length > SCROLLBACK_SIZE) {
        session.scrollback = session.scrollback.slice(-SCROLLBACK_SIZE);
      }
      // Broadcast to all attached channels
      for (const ch of session.channels.values()) {
        ch.onData({ output: data });
      }
    });

    // PTY exit → close all channels, remove session
    ptyProcess.onExit(() => {
      console.log(`[terminal] PTY exited for session ${key}`);
      for (const [chId, ch] of session.channels) {
        ch.onClose();
        this.channelToSession.delete(chId);
      }
      session.channels.clear();
      if (session.idleTimer) clearTimeout(session.idleTimer);
      this.sessions.delete(key);
    });

    console.log(`[terminal] Opened PTY session ${key} via channel ${channelId} (${cols}x${rows}, shell=${shell} ${shellArgs.join(' ')})`);
  }

  /**
   * Handle incoming data from the browser for a terminal channel.
   */
  sendData(channelId: string, data: unknown): void {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    const session = this.sessions.get(key);
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
   * Detach a channel from its session.
   * If no channels remain, start an idle timer to kill the PTY.
   */
  close(channelId: string): void {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    this.channelToSession.delete(channelId);

    const session = this.sessions.get(key);
    if (!session) return;

    session.channels.delete(channelId);
    console.log(`[terminal] Detached channel ${channelId} from session ${key} (${session.channels.size} channels remaining)`);

    if (session.channels.size === 0) {
      // No channels attached — start idle timer
      console.log(`[terminal] Starting ${IDLE_TIMEOUT_MS / 1000}s idle timer for session ${key}`);
      session.idleTimer = setTimeout(() => {
        console.log(`[terminal] Idle timeout — killing PTY for session ${key}`);
        session.pty.kill();
        this.sessions.delete(key);
      }, IDLE_TIMEOUT_MS);
    }
  }

  /**
   * Check if a channel ID belongs to a terminal session.
   */
  has(channelId: string): boolean {
    return this.channelToSession.has(channelId);
  }

  /**
   * Close all terminal sessions (for graceful shutdown).
   */
  closeAll(): void {
    for (const [key, session] of this.sessions) {
      if (session.idleTimer) clearTimeout(session.idleTimer);
      session.pty.kill();
      for (const [chId] of session.channels) {
        this.channelToSession.delete(chId);
      }
      console.log(`[terminal] Shutdown: killed PTY for session ${key}`);
    }
    this.sessions.clear();
  }
}
