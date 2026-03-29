/**
 * AgentChannel — Node-side manager for agent card sessions.
 *
 * Sessions are keyed by (project, canvas, filename), not by channel ID.
 * Multiple browser channels can attach to the same running agent session.
 *
 * Lifecycle (task-scoped):
 *   openChannel + task → session running? attach (replay status) : start new task
 *   closeChannel → detach. Task keeps running even with 0 channels.
 *   task completes → notify all attached channels, clean up session.
 *   openChannel after completion → starts a fresh task.
 */

import { runClaudeCodeSession } from "./agentProviders/claudeCode.js";

export type BroadcastFn = (msg: Record<string, unknown>) => void;

interface ChannelHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

interface AgentSession {
  channels: Map<string, ChannelHandle>;
  messageQueue: Array<unknown>;
  messageResolve: ((value: unknown | null) => void) | null;
  closed: boolean;
  running: boolean;
  lastStatus: unknown[];  // recent status messages for replay to new attachers
}

export class AgentChannelManager {
  // Sessions keyed by "project/canvas/filename"
  private sessions: Map<string, AgentSession> = new Map();
  // Reverse lookup: channelId → sessionKey
  private channelToSession: Map<string, string> = new Map();
  private broadcast: BroadcastFn | null = null;

  private sessionKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  /** Set the broadcast function for lifecycle events. */
  setBroadcast(fn: BroadcastFn): void {
    this.broadcast = fn;
  }

  /** Emit a lifecycle event for the orchestrator to consume. */
  private emitLifecycle(project: string, canvas: string, filename: string, event: string, extra: Record<string, unknown> = {}): void {
    this.broadcast?.({
      type: "agent-lifecycle",
      project, canvas, filename, event,
      ...extra,
    });
  }

  /**
   * Open or attach to an agent session.
   * If a task is running for this file, attach and replay status.
   * If no task running, start a new one.
   */
  open(
    channelId: string,
    project: string,
    canvas: string,
    filename: string,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): void {
    const key = this.sessionKey(project, canvas, filename);
    const existing = this.sessions.get(key);

    if (existing && existing.running) {
      // Attach to in-progress session
      existing.channels.set(channelId, { onData, onClose });
      this.channelToSession.set(channelId, key);

      // Replay recent status messages so the new channel sees current state
      for (const msg of existing.lastStatus) {
        onData(msg);
      }

      console.log(`[agent] Attached channel ${channelId} to running session ${key} (${existing.channels.size} channels)`);
      return;
    }

    // Start new task
    const task = args.task as string || "";
    const provider = args.provider as string || "claude-code";

    const session: AgentSession = {
      channels: new Map([[channelId, { onData, onClose }]]),
      messageQueue: [],
      messageResolve: null,
      closed: false,
      running: true,
      lastStatus: [],
    };
    this.sessions.set(key, session);
    this.channelToSession.set(channelId, key);

    // Create a receive function that blocks until a client sends data
    const receiveFromClient = (): Promise<unknown | null> => {
      if (session.closed) return Promise.resolve(null);

      if (session.messageQueue.length > 0) {
        return Promise.resolve(session.messageQueue.shift()!);
      }

      return new Promise((resolve) => {
        session.messageResolve = resolve;
      });
    };

    const sendToClient = (data: unknown) => {
      if (session.closed) return;

      // Cache status messages for replay to new attachers
      const msg = data as Record<string, unknown>;
      if (msg.type === "status" || msg.type === "phase" || msg.type === "plan" || msg.type === "action") {
        session.lastStatus.push(data);
        // Keep only last 20 status messages
        if (session.lastStatus.length > 20) {
          session.lastStatus = session.lastStatus.slice(-20);
        }
      }

      // Broadcast to all attached channels
      for (const ch of session.channels.values()) {
        ch.onData(data);
      }

      // Emit lifecycle broadcasts for key transitions
      switch (msg.type) {
        case "plan":
          this.emitLifecycle(project, canvas, filename, "started", { task, provider });
          break;
        case "step_update":
          if (msg.status === "done") {
            this.emitLifecycle(project, canvas, filename, "step_done", { step: msg.index });
          }
          break;
        case "blocked":
          this.emitLifecycle(project, canvas, filename, "blocked", { question: msg.question });
          break;
        case "done":
          this.emitLifecycle(project, canvas, filename, "done", { task });
          break;
        case "error":
          this.emitLifecycle(project, canvas, filename, "error", { message: msg.message });
          break;
      }
    };

    // Run the session asynchronously
    const run = async () => {
      try {
        switch (provider) {
          case "claude-code":
            await runClaudeCodeSession(
              project, canvas, filename, task,
              sendToClient, receiveFromClient,
            );
            break;
          default:
            sendToClient({ type: "error", message: `Unknown provider: ${provider}` });
        }
      } catch (err) {
        sendToClient({ type: "error", message: (err as Error).message });
      } finally {
        session.running = false;
        // Notify all remaining channels that the session is done
        for (const [chId, ch] of session.channels) {
          ch.onClose();
          this.channelToSession.delete(chId);
        }
        session.channels.clear();
        this.sessions.delete(key);
        console.log(`[agent] Session ${key} completed`);
      }
    };

    console.log(`[agent] Started session ${key} via channel ${channelId} (provider=${provider}, task="${task.slice(0, 50)}")`);
    run();
  }

  /**
   * Handle incoming data from the browser for an agent channel.
   * Routes to the session — any attached channel can send (e.g., blocker responses).
   */
  sendData(channelId: string, data: unknown): void {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;

    if (session.messageResolve) {
      const resolve = session.messageResolve;
      session.messageResolve = null;
      resolve(data);
    } else {
      session.messageQueue.push(data);
    }
  }

  /**
   * Detach a channel from its session.
   * The task keeps running even with 0 channels — it completes on its own.
   */
  close(channelId: string): void {
    const key = this.channelToSession.get(channelId);
    if (!key) return;
    this.channelToSession.delete(channelId);

    const session = this.sessions.get(key);
    if (!session) return;

    session.channels.delete(channelId);
    console.log(`[agent] Detached channel ${channelId} from session ${key} (${session.channels.size} channels remaining)`);
  }

  /**
   * Check if a channel ID belongs to an agent session.
   */
  has(channelId: string): boolean {
    return this.channelToSession.has(channelId);
  }

  /**
   * Close all agent sessions (for graceful shutdown).
   */
  closeAll(): void {
    for (const [key, session] of this.sessions) {
      session.closed = true;
      if (session.messageResolve) {
        session.messageResolve(null);
        session.messageResolve = null;
      }
      for (const [chId] of session.channels) {
        this.channelToSession.delete(chId);
      }
      console.log(`[agent] Shutdown: closed session ${key}`);
    }
    this.sessions.clear();
  }
}
