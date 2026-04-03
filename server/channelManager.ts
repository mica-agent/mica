/**
 * ChannelManager — unified, transport-agnostic session manager.
 *
 * Sessions are keyed by (project, canvas, filename). Multiple clients can
 * attach/detach from the same session. Handlers are created by registered
 * factory functions keyed by card class (derived from file extension).
 *
 * States: registered -> active -> idle -> destroyed
 *
 * No WebSocket or HTTP imports — the transport layer calls into this class
 * via open/sendData/detach/destroySession.
 */

import { readCanvasFile, writeCanvasFile } from "./canvasFiles.js";

// ── Types ──────────────────────────────────────────────────

type SessionState = "registered" | "active" | "idle" | "destroyed";

interface ClientHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

export interface SessionContext {
  project: string;
  canvas: string;
  filename: string;
  broadcast(data: unknown): void;
  sendTo(clientId: string, data: unknown): void;
  clientCount(): number;
  readContent(): Promise<string>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string): Promise<void>;
  idle(): void;
  resume(): void;
  destroy(): void;
}

export interface ChannelHandler {
  onAttach?(clientId: string, args: Record<string, unknown>): void;
  onDetach?(clientId: string): void;
  onData?(clientId: string, data: unknown): void;
  onDestroy?(): void;
}

export type HandlerFactory = (
  content: string,
  args: Record<string, unknown>,
  ctx: SessionContext,
) => ChannelHandler | Promise<ChannelHandler>;

interface Session {
  project: string;
  canvas: string;
  filename: string;
  state: SessionState;
  clients: Map<string, ClientHandle>;
  handler: ChannelHandler | null;
  ctx: SessionContext;
}

// ── ChannelManager ─────────────────────────────────────────

export class ChannelManager {
  /** Sessions keyed by "project/canvas/filename" */
  private sessions = new Map<string, Session>();

  /** Reverse lookup: clientId -> sessionKey */
  private clientToSession = new Map<string, string>();

  /** Handler factories keyed by card class (file extension without dot) */
  private factories = new Map<string, HandlerFactory>();

  // ── Factory registration ───────────────────────────────

  /**
   * Register a handler factory for a card class.
   * Card class is derived from filename extension (e.g. "claude-chat", "terminal").
   */
  registerHandler(cardClass: string, factory: HandlerFactory): void {
    this.factories.set(cardClass, factory);
    console.log(`[channel-mgr] Registered handler for card class: ${cardClass}`);
  }

  // ── Session key helpers ────────────────────────────────

  private sessionKey(project: string, canvas: string, filename: string): string {
    return `${project}/${canvas}/${filename}`;
  }

  /**
   * Derive card class from filename by extracting the extension and
   * stripping the leading dot. E.g. "chat-foo.claude-chat" -> "claude-chat".
   */
  /** Check if a handler is registered for a card class. */
  hasHandler(cardClass: string): boolean {
    return this.factories.has(cardClass);
  }

  resolveCardClass(filename: string): string {
    const dotIdx = filename.indexOf(".");
    if (dotIdx === -1) return filename;
    return filename.slice(dotIdx + 1);
  }

  // ── Build SessionContext for a session ─────────────────

  private buildContext(session: Session): SessionContext {
    const self = this;
    const key = this.sessionKey(session.project, session.canvas, session.filename);

    return {
      project: session.project,
      canvas: session.canvas,
      filename: session.filename,

      broadcast(data: unknown): void {
        for (const [clientId, handle] of session.clients) {
          try {
            handle.onData(data);
          } catch (err) {
            console.warn(`[channel-mgr] Stale client ${clientId}, removing:`, (err as Error).message);
            session.clients.delete(clientId);
            self.clientToSession.delete(clientId);
          }
        }
      },

      sendTo(clientId: string, data: unknown): void {
        const handle = session.clients.get(clientId);
        if (handle) {
          try {
            handle.onData(data);
          } catch (err) {
            console.warn(`[channel-mgr] Stale client ${clientId}, removing:`, (err as Error).message);
            session.clients.delete(clientId);
            self.clientToSession.delete(clientId);
          }
        }
      },

      clientCount(): number {
        return session.clients.size;
      },

      async readContent(): Promise<string> {
        try {
          const file = await readCanvasFile(session.project, session.canvas, session.filename);
          return file.content;
        } catch {
          return "";
        }
      },

      async readFile(filename: string): Promise<string> {
        try {
          const file = await readCanvasFile(session.project, session.canvas, filename);
          return file.content;
        } catch {
          return "";
        }
      },

      async writeFile(filename: string, content: string): Promise<void> {
        await writeCanvasFile(session.project, session.canvas, filename, content);
      },

      idle(): void {
        if (session.state === "active") {
          session.state = "idle";
          console.log(`[channel-mgr] Session ${key} -> idle`);
        }
      },

      resume(): void {
        if (session.state === "idle") {
          session.state = "active";
          console.log(`[channel-mgr] Session ${key} -> active (resumed)`);
        }
      },

      destroy(): void {
        self.destroySessionByKey(key);
      },
    };
  }

  // ── Public API ─────────────────────────────────────────

  /**
   * Open or attach a client to a session.
   * If the session doesn't exist yet, a handler is created via the factory.
   */
  async open(
    clientId: string,
    project: string,
    canvas: string,
    filename: string,
    fn: string | undefined,
    args: Record<string, unknown>,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): Promise<void> {
    const key = this.sessionKey(project, canvas, filename);
    let session = this.sessions.get(key);

    if (session && session.state === "destroyed") {
      // Session was destroyed, remove stale entry
      this.sessions.delete(key);
      session = undefined;
    }

    if (!session) {
      // Resolve card class from filename extension
      const cardClass = this.resolveCardClass(filename);
      const factory = this.factories.get(cardClass);
      if (!factory) {
        throw new Error(`No handler registered for card class: ${cardClass}`);
      }

      // Read initial content
      let content = "";
      try {
        const file = await readCanvasFile(project, canvas, filename);
        content = file.content;
      } catch {
        // File may not exist yet
      }

      // Create session shell (needed for buildContext)
      session = {
        project,
        canvas,
        filename,
        state: "registered",
        clients: new Map(),
        handler: null,
        ctx: null as unknown as SessionContext, // will be set below
      };
      const ctx = this.buildContext(session);
      session.ctx = ctx;

      // Attach client BEFORE creating handler so onConnect can broadcast to first client
      session.clients.set(clientId, { onData, onClose });
      this.clientToSession.set(clientId, key);

      // Create handler via factory
      const handler = await factory(content, args, ctx);
      session.handler = handler;
      session.state = "active";
      this.sessions.set(key, session);

      console.log(`[channel-mgr] Created session ${key} (cardClass=${cardClass})`);
      console.log(`[channel-mgr] Client ${clientId} attached to ${key} (${session.clients.size} clients)`);

      // Notify handler of first attach
      session.handler?.onAttach?.(clientId, args);
      return;
    } else if (session.state === "idle") {
      // Resume from idle
      session.state = "active";
      console.log(`[channel-mgr] Session ${key} resumed from idle`);
    }

    // Attach client (existing session)
    session.clients.set(clientId, { onData, onClose });
    this.clientToSession.set(clientId, key);

    console.log(`[channel-mgr] Client ${clientId} attached to ${key} (${session.clients.size} clients)`);

    // Notify handler
    session.handler?.onAttach?.(clientId, args);
  }

  /**
   * Forward data from a client to the session handler.
   */
  sendData(clientId: string, data: unknown): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session || session.state === "destroyed") return;

    session.handler?.onData?.(clientId, data);
  }

  /**
   * Soft close — detach client, session stays alive.
   */
  detach(clientId: string): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    this.clientToSession.delete(clientId);

    const session = this.sessions.get(key);
    if (!session) return;

    session.clients.delete(clientId);
    console.log(`[channel-mgr] Client ${clientId} detached from ${key} (${session.clients.size} remaining)`);

    // Notify handler
    session.handler?.onDetach?.(clientId);
  }

  /**
   * Hard close — destroy a specific session.
   */
  destroySession(project: string, canvas: string, filename: string): void {
    const key = this.sessionKey(project, canvas, filename);
    this.destroySessionByKey(key);
  }

  /**
   * Destroy all sessions (server shutdown).
   */
  destroyAll(): void {
    for (const key of [...this.sessions.keys()]) {
      this.destroySessionByKey(key);
    }
    console.log("[channel-mgr] All sessions destroyed");
  }

  /**
   * Check if a client ID is tracked by this manager.
   */
  has(clientId: string): boolean {
    return this.clientToSession.has(clientId);
  }

  /**
   * Broadcast data to all clients of a session (for container bridge mica.send()).
   */
  broadcastToSession(project: string, canvas: string, filename: string, data: unknown): void {
    const key = this.sessionKey(project, canvas, filename);
    const session = this.sessions.get(key);
    if (!session) return;
    session.ctx.broadcast(data);
  }

  /**
   * Send data to a specific client (for container bridge mica.reply()).
   */
  sendToClient(clientId: string, data: unknown): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session) return;
    session.ctx.sendTo(clientId, data);
  }

  /**
   * Get the number of active sessions.
   */
  get sessionCount(): number {
    return this.sessions.size;
  }

  // ── Internal ───────────────────────────────────────────

  private destroySessionByKey(key: string): void {
    const session = this.sessions.get(key);
    if (!session || session.state === "destroyed") return;

    session.state = "destroyed";

    // Notify handler
    try {
      session.handler?.onDestroy?.();
    } catch (err) {
      console.warn(`[channel-mgr] Error in onDestroy for ${key}:`, (err as Error).message);
    }

    // Close all clients
    for (const [clientId, handle] of session.clients) {
      try {
        handle.onClose();
      } catch {
        // Client may already be gone
      }
      this.clientToSession.delete(clientId);
    }
    session.clients.clear();

    this.sessions.delete(key);
    console.log(`[channel-mgr] Session ${key} destroyed`);
  }
}
