/**
 * ChannelManager — transport-agnostic session manager.
 *
 * Sessions are keyed by filename. Multiple clients can attach/detach
 * from the same session. Handlers are created by registered factory
 * functions keyed by card class (derived from file extension).
 *
 * States: registered -> active -> idle -> destroyed
 */

import { readProjectFile, writeProjectFile, WORKSPACE_DIR } from "./files.js";
import { join } from "path";

// Active project tracking for file operations
let _activeProject: string | null = null;
export function setActiveProject(project: string | null) { _activeProject = project; }

// ── Types ──────────────────────────────────────────────────

type SessionState = "registered" | "active" | "idle" | "destroyed";

interface ClientHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

export interface SessionContext {
  filename: string;
  /** The project this session belongs to. Captured at session creation —
   *  does NOT change if the user later switches projects. Use this for all
   *  per-session file ops to avoid the "session writes to wrong project"
   *  bug from referencing a global activeProject. May be null only for
   *  workspace-level sessions (none today). */
  project: string | null;
  broadcast(data: unknown): void;
  sendTo(clientId: string, data: unknown): void;
  clientCount(): number;
  readContent(): Promise<string>;
  readFile(filename: string): Promise<string>;
  writeFile(filename: string, content: string): Promise<void>;
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
  filename: string;
  /** Captured project at session creation. Sessions stay tied to the project
   *  they were created in even if the user later switches the active project. */
  project: string | null;
  state: SessionState;
  clients: Map<string, ClientHandle>;
  handler: ChannelHandler | null;
  ctx: SessionContext;
}

// ── ChannelManager ─────────────────────────────────────────

export class ChannelManager {
  private sessions = new Map<string, Session>();
  private clientToSession = new Map<string, string>();
  private factories = new Map<string, HandlerFactory>();
  private tabClients = new Map<string, Set<string>>();

  registerHandler(cardClass: string, factory: HandlerFactory): void {
    this.factories.set(cardClass, factory);
    console.log(`[channel-mgr] Registered handler for: ${cardClass}`);
  }

  hasHandler(cardClass: string): boolean {
    return this.factories.has(cardClass);
  }

  resolveCardClass(filename: string): string {
    const dotIdx = filename.indexOf(".");
    if (dotIdx === -1) return filename;
    return filename.slice(dotIdx + 1);
  }

  private buildContext(session: Session): SessionContext {
    const self = this;
    return {
      filename: session.filename,
      project: session.project,

      broadcast(data: unknown): void {
        for (const [clientId, handle] of session.clients) {
          try {
            handle.onData(data);
          } catch (err) {
            console.warn(`[channel-mgr] Stale client ${clientId}, removing`);
            session.clients.delete(clientId);
            self.clientToSession.delete(clientId);
          }
        }
      },

      sendTo(clientId: string, data: unknown): void {
        const handle = session.clients.get(clientId);
        if (handle) {
          try { handle.onData(data); } catch {
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
          const file = await readProjectFile(session.filename, session.project || undefined);
          return file.content;
        } catch { return ""; }
      },

      async readFile(filename: string): Promise<string> {
        try {
          const file = await readProjectFile(filename, session.project || undefined);
          return file.content;
        } catch { return ""; }
      },

      async writeFile(filename: string, content: string): Promise<void> {
        await writeProjectFile(filename, content, session.project || undefined);
      },

      destroy(): void {
        self.destroySessionByKey(session.filename);
      },
    };
  }

  async open(
    clientId: string,
    filename: string,
    fn: string | undefined,
    args: Record<string, unknown>,
    tabId: string | null,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): Promise<void> {
    let session = this.sessions.get(filename);

    if (session && session.state === "destroyed") {
      this.sessions.delete(filename);
      session = undefined;
    }

    if (!session) {
      const cardClass = this.resolveCardClass(filename);
      const factory = this.factories.get(cardClass);
      if (!factory) {
        throw new Error(`No handler registered for: ${cardClass}`);
      }

      // Capture the project at session creation. From here on, this session
      // uses its captured project for ALL file ops — even if the user later
      // switches the active project.
      const sessionProject = _activeProject;

      let content = "";
      try {
        const file = await readProjectFile(filename, sessionProject || undefined);
        content = file.content;
      } catch { /* File may not exist yet */ }

      session = {
        filename,
        project: sessionProject,
        state: "registered",
        clients: new Map(),
        handler: null,
        ctx: null as unknown as SessionContext,
      };
      const ctx = this.buildContext(session);
      session.ctx = ctx;

      this.sessions.set(filename, session);

      session.clients.set(clientId, { onData, onClose });
      this.clientToSession.set(clientId, filename);

      const handler = await factory(content, args, ctx);
      session.handler = handler;
      session.state = "active";

      console.log(`[channel-mgr] Created session ${filename} (project: ${sessionProject ?? "<workspace>"})`);
      session.handler?.onAttach?.(clientId, args);
      return;
    }

    // Evict stale clients from same tab
    if (tabId) {
      const peers = this.tabClients.get(tabId);
      if (peers) {
        const staleIds = [...peers].filter((id) => this.clientToSession.get(id) === filename);
        for (const id of staleIds) {
          try { session.handler?.onDetach?.(id); } catch { /* ignore */ }
          try { session.clients.get(id)?.onClose(); } catch { /* gone */ }
          session.clients.delete(id);
          this.clientToSession.delete(id);
          peers.delete(id);
        }
      }
    }

    if (tabId) {
      if (!this.tabClients.has(tabId)) this.tabClients.set(tabId, new Set());
      this.tabClients.get(tabId)!.add(clientId);
    }

    session.clients.set(clientId, { onData, onClose });
    this.clientToSession.set(clientId, filename);
    session.handler?.onAttach?.(clientId, args);
  }

  sendData(clientId: string, data: unknown): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session || session.state === "destroyed") return;
    session.handler?.onData?.(clientId, data);
  }

  detach(clientId: string): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    this.clientToSession.delete(clientId);
    const session = this.sessions.get(key);
    if (!session) return;
    session.clients.delete(clientId);
    session.handler?.onDetach?.(clientId);
  }

  destroySession(filename: string): void {
    this.destroySessionByKey(filename);
  }

  destroyAll(): void {
    for (const key of [...this.sessions.keys()]) {
      this.destroySessionByKey(key);
    }
    console.log("[channel-mgr] All sessions destroyed");
  }

  has(clientId: string): boolean {
    return this.clientToSession.has(clientId);
  }

  private destroySessionByKey(key: string): void {
    const session = this.sessions.get(key);
    if (!session || session.state === "destroyed") return;
    session.state = "destroyed";
    try { session.handler?.onDestroy?.(); } catch { /* ignore */ }
    for (const [clientId, handle] of session.clients) {
      try { handle.onClose(); } catch { /* gone */ }
      this.clientToSession.delete(clientId);
    }
    session.clients.clear();
    this.sessions.delete(key);
    console.log(`[channel-mgr] Session ${key} destroyed`);
  }
}
