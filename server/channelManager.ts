/**
 * ChannelManager — transport-agnostic session manager.
 *
 * Sessions are keyed by per-file UUID (sessionId). The same file across
 * different projects (e.g. template-seeded `docs/qwen.chat`) get distinct
 * UUIDs and thus distinct sessions, so state never leaks across projects.
 * Multiple clients can attach/detach from the same session. Handlers are
 * created by registered factory functions keyed by card class (derived from
 * file extension).
 *
 * States: registered -> active -> idle -> destroyed
 */

import { readProjectFile, writeProjectFile, WORKSPACE_DIR } from "./files.js";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────

type SessionState = "registered" | "active" | "idle" | "destroyed";

interface ClientHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
}

export interface SessionContext {
  /** Stable per-file UUID — the session identity. Use as the key for any
   *  per-session persistence (e.g. chat history file naming). */
  sessionId: string;
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
  sessionId: string;
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
  // Sessions are keyed by sessionId (per-file UUID). Two different projects
  // with the same template-seeded filename get distinct sessionIds → distinct
  // sessions → no cross-project state leak.
  private sessions = new Map<string, Session>();
  private clientToSession = new Map<string, string>();   // clientId → sessionId
  private factories = new Map<string, HandlerFactory>();
  private tabClients = new Map<string, Set<string>>();
  // Reverse lookup so file-deletion can find the session for a (project,
  // filename) without re-reading the sidecar from disk (which may already
  // have been removed by the file-deletion handler).
  private filenameToSessionId = new Map<string, string>();  // `${project}|${filename}` → sessionId
  // In-flight session creation single-flight (keyed by sessionId).
  private creating = new Map<string, Promise<Session>>();

  private filenameKey(project: string | null, filename: string): string {
    return `${project ?? "<workspace>"}|${filename}`;
  }

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
      sessionId: session.sessionId,
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
        self.destroySessionByKey(session.sessionId);
      },
    };
  }

  async open(
    clientId: string,
    sessionId: string,
    project: string | null,
    filename: string,
    fn: string | undefined,
    args: Record<string, unknown>,
    tabId: string | null,
    onData: (data: unknown) => void,
    onClose: () => void,
  ): Promise<void> {
    let session = this.sessions.get(sessionId);

    if (session && session.state === "destroyed") {
      this.sessions.delete(sessionId);
      session = undefined;
    }

    // If a creation is already in flight for this sessionId, await it so we
    // attach to the same Session instead of racing into a duplicate.
    if (!session) {
      let creation = this.creating.get(sessionId);
      if (!creation) {
        creation = this.createSession(sessionId, project, filename, args);
        this.creating.set(sessionId, creation);
        creation.finally(() => this.creating.delete(sessionId));
      }
      session = await creation;
    }

    // Attach this client to the (possibly just-created) session.
    // Evict stale clients from same tab attached to this same session.
    if (tabId) {
      const peers = this.tabClients.get(tabId);
      if (peers) {
        const staleIds = [...peers].filter((id) => this.clientToSession.get(id) === sessionId);
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
    this.clientToSession.set(clientId, sessionId);
    session.handler?.onAttach?.(clientId, args);
  }

  /** Create a session keyed by sessionId. Single-flight via `this.creating`. */
  private async createSession(
    sessionId: string,
    project: string | null,
    filename: string,
    args: Record<string, unknown>,
  ): Promise<Session> {
    const cardClass = this.resolveCardClass(filename);
    const factory = this.factories.get(cardClass);
    if (!factory) {
      throw new Error(`No handler registered for: ${cardClass}`);
    }

    let content = "";
    try {
      const file = await readProjectFile(filename, project || undefined);
      content = file.content;
    } catch { /* File may not exist yet */ }

    const session: Session = {
      sessionId,
      filename,
      project,
      state: "registered",
      clients: new Map(),
      handler: null,
      ctx: null as unknown as SessionContext,
    };
    const ctx = this.buildContext(session);
    session.ctx = ctx;

    this.sessions.set(sessionId, session);
    this.filenameToSessionId.set(this.filenameKey(project, filename), sessionId);

    const handler = await factory(content, args, ctx);
    session.handler = handler;
    session.state = "active";

    console.log(`[channel-mgr] Created session ${filename} (id=${sessionId.slice(0, 8)}, project: ${project ?? "<workspace>"})`);
    return session;
  }

  /** Look up a sessionId for (project, filename). Returns undefined if no
   *  active session exists for that file. Used by file-deletion handlers. */
  findSessionByFilename(project: string | null, filename: string): string | undefined {
    return this.filenameToSessionId.get(this.filenameKey(project, filename));
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

  /** Destroy a session by its UUID. */
  destroySession(sessionId: string): void {
    this.destroySessionByKey(sessionId);
  }

  destroyAll(): void {
    for (const key of [...this.sessions.keys()]) {
      this.destroySessionByKey(key);
    }
    console.log("[channel-mgr] All sessions destroyed");
  }

  /** Destroy every session bound to the given project. Called on rename/delete
   *  so sessions that captured the old project name (in their handler closure)
   *  don't keep writing to the now-stale path. */
  destroyAllForProject(project: string): void {
    let n = 0;
    for (const [key, session] of [...this.sessions]) {
      if (session.project !== project) continue;
      this.destroySessionByKey(key);
      n++;
    }
    if (n > 0) console.log(`[channel-mgr] Destroyed ${n} session(s) for project ${project}`);
  }

  has(clientId: string): boolean {
    return this.clientToSession.has(clientId);
  }

  private destroySessionByKey(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.state === "destroyed") return;
    session.state = "destroyed";
    try { session.handler?.onDestroy?.(); } catch { /* ignore */ }
    for (const [clientId, handle] of session.clients) {
      try { handle.onClose(); } catch { /* gone */ }
      this.clientToSession.delete(clientId);
    }
    session.clients.clear();
    this.sessions.delete(sessionId);
    this.filenameToSessionId.delete(this.filenameKey(session.project, session.filename));
    console.log(`[channel-mgr] Session ${session.filename} (id=${sessionId.slice(0, 8)}) destroyed`);
  }
}
