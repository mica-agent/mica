/**
 * AgentChannel — Node-side manager for agent card sessions.
 *
 * Routes agent channels to the appropriate provider (Claude Code, etc.)
 * based on the provider field in the args. Manages the lifecycle of
 * agent sessions and provides a message queue for blocking receive.
 *
 * Follows the same pattern as TerminalChannelManager.
 */

import { runClaudeCodeSession } from "./agentProviders/claudeCode.js";

export type BroadcastFn = (msg: Record<string, unknown>) => void;

interface AgentSession {
  onData: (data: unknown) => void;
  onClose: () => void;
  messageQueue: Array<unknown>;
  messageResolve: ((value: unknown | null) => void) | null;
  closed: boolean;
}

export class AgentChannelManager {
  private sessions: Map<string, AgentSession> = new Map();
  private broadcast: BroadcastFn | null = null;

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
   * Open a new agent session for a channel.
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
    const task = args.task as string || "";
    const provider = args.provider as string || "claude-code";

    const session: AgentSession = {
      onData,
      onClose,
      messageQueue: [],
      messageResolve: null,
      closed: false,
    };
    this.sessions.set(channelId, session);

    // Create a receive function that blocks until the client sends data
    const receiveFromClient = (): Promise<unknown | null> => {
      if (session.closed) return Promise.resolve(null);

      // Check queue first
      if (session.messageQueue.length > 0) {
        return Promise.resolve(session.messageQueue.shift()!);
      }

      // Wait for next message
      return new Promise((resolve) => {
        session.messageResolve = resolve;
      });
    };

    const sendToClient = (data: unknown) => {
      if (session.closed) return;
      onData(data);

      // Emit lifecycle broadcasts for key transitions (orchestrator listens to these)
      const msg = data as Record<string, unknown>;
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
        this.sessions.delete(channelId);
        if (!session.closed) {
          onClose();
        }
      }
    };

    console.log(`[agent] Opened session ${channelId} (provider=${provider}, task="${task.slice(0, 50)}")`);
    run();
  }

  /**
   * Handle incoming data from the browser for an agent channel.
   */
  sendData(channelId: string, data: unknown): void {
    const session = this.sessions.get(channelId);
    if (!session) return;

    // If there's a pending receive, resolve it
    if (session.messageResolve) {
      const resolve = session.messageResolve;
      session.messageResolve = null;
      resolve(data);
    } else {
      // Queue it for later
      session.messageQueue.push(data);
    }
  }

  /**
   * Close an agent channel.
   */
  close(channelId: string): void {
    const session = this.sessions.get(channelId);
    if (!session) return;
    session.closed = true;

    // Unblock any pending receive
    if (session.messageResolve) {
      session.messageResolve(null);
      session.messageResolve = null;
    }

    this.sessions.delete(channelId);
    console.log(`[agent] Closed session ${channelId}`);
  }

  /**
   * Check if a channel ID belongs to an agent session.
   */
  has(channelId: string): boolean {
    return this.sessions.has(channelId);
  }

  /**
   * Close all agent sessions (for graceful shutdown).
   */
  closeAll(): void {
    for (const [id] of this.sessions) {
      this.close(id);
    }
  }
}
