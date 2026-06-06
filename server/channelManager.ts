/**
 * ChannelManager — transport-agnostic session manager.
 *
 * Sessions are keyed by per-file UUID (sessionId). The same file across
 * different projects (e.g. template-seeded `docs/qwen.qwen`) get distinct
 * UUIDs and thus distinct sessions, so state never leaks across projects.
 * Multiple clients can attach/detach from the same session. Handlers are
 * created by registered factory functions keyed by card class (derived from
 * file extension).
 *
 * States: registered -> active -> idle -> destroyed
 */

import { readProjectFile, writeProjectFile, WORKSPACE_DIR, getCardClassMeta, getOrCreateCardId } from "./files.js";
import { registerManifest, validateArgs, getManifest, getManifestNames, type HandlerManifest } from "./handlerManifest.js";
import { join } from "path";

// ── Types ──────────────────────────────────────────────────

type SessionState = "registered" | "active" | "idle" | "destroyed";

interface ClientHandle {
  onData: (data: unknown) => void;
  onClose: () => void;
  /** Optional resolver: what project is this client's WebSocket CURRENTLY
   *  subscribed to? Used by broadcast() to skip cross-project delivery —
   *  a voice session in project A should not emit TTS to a client whose
   *  tab has navigated away to project B (even though the WS is still
   *  alive). Returns null when the resolver isn't installed (legacy
   *  callers; treated as "deliver to all attached clients"). */
  getProject?: () => string | null;
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
  /** Owning tenant (multi-tenant fork), captured at session creation from the
   *  WS connection's tenant. Threaded explicitly (not read from ambient
   *  AsyncLocalStorage, which doesn't reliably propagate into handler creation)
   *  so a handler can bind it around its own long-lived async work. Undefined in
   *  single-tenant main. */
  tenant?: string;
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
  /** Owning tenant (multi-tenant fork), captured at creation. See SessionContext.tenant. */
  tenant?: string;
  state: SessionState;
  clients: Map<string, ClientHandle>;
  handler: ChannelHandler | null;
  ctx: SessionContext;
}

// ── Singleton holder ────────────────────────────────────────
// Long-running modules that need to broadcast into channel sessions
// (the propose_changes agent tool, future cross-cutting hooks) need a
// way to reach the live ChannelManager without threading it through
// every API surface. server/index.ts registers the instance at boot.
let _activeChannelManager: ChannelManager | null = null;
export function setActiveChannelManager(m: ChannelManager): void {
  _activeChannelManager = m;
}
export function getActiveChannelManager(): ChannelManager | null {
  return _activeChannelManager;
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
  // Cross-session broadcast listeners. Used by voiceAgent's ambient
  // announcements: every time a chat card broadcasts (e.g. an `assistant`
  // turn-end event), voice gets notified and can queue a TTS notification.
  // Per CLAUDE.md tenet 3 (pipes, not policy), this hook is generic — the
  // listener decides what to filter on. Add via onAnyBroadcast(); the
  // returned function unsubscribes.
  private broadcastListeners = new Set<
    (project: string | null, filename: string, data: unknown) => void
  >();

  private filenameKey(project: string | null, filename: string): string {
    return `${project ?? "<workspace>"}|${filename}`;
  }

  registerHandler(cardClass: string, factory: HandlerFactory, manifest?: HandlerManifest): void {
    this.factories.set(cardClass, factory);
    if (manifest) {
      if (manifest.name !== cardClass) {
        console.warn(`[channel-mgr] manifest.name "${manifest.name}" does not match registration key "${cardClass}" — using ${cardClass} for routing.`);
      }
      registerManifest({ ...manifest, name: cardClass });
    }
    console.log(`[channel-mgr] Registered handler for: ${cardClass}${manifest ? " (with manifest)" : ""}`);
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
      tenant: session.tenant,

      broadcast(data: unknown): void {
        // One-line visibility for assistant_speech in particular, since
        // missing audio is the most reported voice issue and silence here
        // means "no clients attached" (so even a perfect TTS frame goes
        // nowhere).
        const t = (data as { type?: string } | null)?.type;
        if (t === "assistant_speech") {
          console.log(`[channel-mgr:broadcast] ${session.filename} type=assistant_speech clients=${session.clients.size}`);
        }
        let skippedCrossProject = 0;
        for (const [clientId, handle] of session.clients) {
          // Project-scoped delivery: a session in project A should not
          // deliver to clients whose WebSocket has navigated to project B.
          // This catches the cross-project voice-TTS leak when the React
          // unmount doesn't fully tear down a previous project's channel
          // before the same WS subscribes to a new project. Only filters
          // when BOTH session.project AND the client's current project
          // are non-null and differ (workspace-level sessions with null
          // project, or legacy clients without a getProject resolver,
          // deliver to all attached clients).
          if (session.project && handle.getProject) {
            const clientProject = handle.getProject();
            if (clientProject && clientProject !== session.project) {
              skippedCrossProject++;
              continue;
            }
          }
          try {
            handle.onData(data);
          } catch (err) {
            console.warn(`[channel-mgr] Stale client ${clientId}, removing`);
            session.clients.delete(clientId);
            self.clientToSession.delete(clientId);
          }
        }
        if (skippedCrossProject > 0 && t === "assistant_speech") {
          console.log(
            `[channel-mgr:broadcast] ${session.filename} skipped ${skippedCrossProject} cross-project client(s)`,
          );
        }
        // Notify cross-session listeners (used by voiceAgent for ambient
        // announcements). Wrapped in try/catch per listener so a buggy
        // subscriber can't poison broadcasts for the rest of the system.
        for (const listener of self.broadcastListeners) {
          try { listener(session.project, session.filename, data); }
          catch (err) {
            console.warn(`[channel-mgr] broadcast listener threw: ${(err as Error).message}`);
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
    getProject?: () => string | null,
    tenant?: string,
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
        creation = this.createSession(sessionId, project, filename, args, tenant);
        this.creating.set(sessionId, creation);
        // The real rejection surfaces via `await creation` below; this cleanup
        // chain must swallow it, else its floating promise becomes an UNHANDLED
        // REJECTION that crashes the process (hit in tier-1 when a card opens a
        // channel for a dropped handler, e.g. a .voice card with voice disabled).
        creation.finally(() => this.creating.delete(sessionId)).catch(() => { /* surfaced by the awaiter */ });
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

    session.clients.set(clientId, { onData, onClose, getProject });
    this.clientToSession.set(clientId, sessionId);
    session.handler?.onAttach?.(clientId, args);
  }

  /** Create a session keyed by sessionId. Single-flight via `this.creating`. */
  private async createSession(
    sessionId: string,
    project: string | null,
    filename: string,
    args: Record<string, unknown>,
    tenant?: string,
  ): Promise<Session> {
    // Routing: if the card class declares `metadata.handler`, route to that
    // built-in (or developer-registered custom plugin). Otherwise fall back
    // to today's extension-keyed lookup. This is what lets card classes
    // reach the parameterized llm-direct / llm-agent handlers without
    // anyone writing server-side code.
    const ext = this.resolveCardClass(filename);
    const meta = await getCardClassMeta(ext, project);
    const cardClass = meta.handler ?? ext;
    const factory = this.factories.get(cardClass);
    if (!factory) {
      // Two-state hint: distinguish "handler set but unknown" from "no
      // handler declared at all". The former is usually a typo (or the
      // card class name was put in by mistake); the latter is missing
      // metadata that needs to be added. Either way, lead with the
      // concrete fix-action so the agent (or human) doesn't have to
      // bounce to the handbook to figure it out.
      const available = getManifestNames();
      const choices = available.length > 0 ? available.join(", ") : "(none registered)";
      const hint = meta.handler
        ? `\nmetadata.json sets handler="${meta.handler}". Set it to one of the registered handlers: ${choices}.`
        : `\nDeclare a handler in metadata.json to route mica.openChannel() calls. Choose one of: ${choices}.\nExample: { "handler": "llm-agent", ... }`;
      throw new Error(`No handler registered for "${cardClass}" (card class: ${ext}).${hint}`);
    }

    // If the routed handler ships a manifest, validate args at the channel
    // boundary. Bad args fail fast with a structured error pointing at the
    // failing schema path — the card surfaces it instead of debugging a
    // downstream nullref.
    const manifest = getManifest(cardClass);
    if (manifest) {
      const result = validateArgs(manifest, args);
      if (!result.ok) {
        throw new Error(`Invalid args for handler "${cardClass}": ${result.error}`);
      }
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
      tenant,
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

  /** Reverse lookup: filename for an active sessionId. Returns undefined if
   *  the sessionId doesn't correspond to a live session. Used by lifecycle
   *  handlers (e.g. fresh-thread chat clear) that have the sessionId/chatId
   *  but need the chat-card filename to scope per-card buffers. */
  findFilenameBySession(sessionId: string): { project: string | null; filename: string } | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    return { project: session.project, filename: session.filename };
  }

  /** Push `data` to all clients attached to a (project, filename) session
   *  using the same path as `ctx.broadcast` inside the handler. Returns
   *  `true` if the session exists and was broadcast to, `false` if no
   *  session is registered (caller can decide whether to fall back to a
   *  REST/queue path). Used by agent tools (propose_changes) that need
   *  to push structured events to the originating chat card without
   *  routing through `dispatchToFilename` (which mimics a CLIENT message,
   *  not a server broadcast). */
  broadcastToFilename(project: string | null, filename: string, data: unknown): boolean {
    const sessionId = this.filenameToSessionId.get(this.filenameKey(project, filename));
    if (!sessionId) return false;
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "active") return false;
    session.ctx.broadcast(data);
    return true;
  }

  /** Subscribe to every broadcast across all sessions. Used by voiceAgent's
   *  ambient announcements (Phase 2): when a chat card emits an `assistant`
   *  turn-end event, voice gets notified and can queue a TTS announcement.
   *  Returns an unsubscribe function — sessions MUST call it from onDestroy. */
  onAnyBroadcast(
    listener: (project: string | null, filename: string, data: unknown) => void,
  ): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  /** Dispatch a payload into another card's channel handler as if it had been
   *  sent by an external client. Used by the .voice card's `send_to_card`
   *  tool to forward user requests into a chat card's queue without the user
   *  having to click into that card. The dispatched data flows through the
   *  target handler's `onData(clientId, data)` exactly like a normal client
   *  message; the target card's existing clients see broadcasts as usual.
   *
   *  Returns `{ ok, clientCount?, queueDepth? }`:
   *  - ok=false: no active session — the card hasn't been opened yet.
   *  - ok=true, clientCount>0: target session has UI clients attached;
   *    they'll see the new message bubble live.
   *  - ok=true, clientCount=0: the agent will process and persist, but no
   *    client is attached to render the new message — the user has to open
   *    the card to see it. Voice should warn about this.
   *  - queueDepth: 0 if the message dispatched immediately (current turn
   *    is idle), N if it landed in the busy-queue with N items ahead.
   *    Provided by the target handler synchronously via a `_voiceMeta`
   *    callback we inject into `data`. Undefined if the target handler
   *    doesn't honour the callback (older handlers / non-chat agents). */
  dispatchToFilename(
    project: string | null,
    filename: string,
    data: unknown,
  ): { ok: boolean; clientCount?: number; queueDepth?: number } {
    const sessionId = this.filenameToSessionId.get(this.filenameKey(project, filename));
    if (!sessionId) return { ok: false };
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== "active" || !session.handler?.onData) return { ok: false };
    // Synthetic clientId — the dispatched message doesn't have an attached
    // client; the target handler should not try to sendTo() this id, but
    // micaAgent (the main consumer here) only uses clientId for diagnostics
    // and queue routing, neither of which require a real client.
    const clientCount = session.clients.size;
    console.log(
      `[channel-mgr] dispatchToFilename(${filename}) → session=${sessionId.slice(0, 8)} clients=${clientCount}` +
        (clientCount === 0
          ? " (no UI attached — message will persist but no live update will render)"
          : ""),
    );
    // Inject a synchronous `onQueued` callback into the data so the
    // target handler can report back queue depth without us needing
    // async coordination. Honoured by handlers that read `_voiceMeta`
    // (currently micaAgent); ignored otherwise.
    let queueDepth: number | undefined;
    const wrappedData =
      data && typeof data === "object"
        ? {
            ...(data as object),
            _voiceMeta: {
              onQueued: (depth: number) => { queueDepth = depth; },
            },
          }
        : data;
    try {
      session.handler.onData("voice-dispatch", wrappedData);
      return { ok: true, clientCount, queueDepth };
    } catch (err) {
      console.warn(`[channel-mgr] dispatchToFilename(${filename}) handler.onData threw: ${(err as Error).message}`);
      return { ok: false };
    }
  }

  /** Like dispatchToFilename, but lazy-creates the session if it doesn't
   *  exist yet — using the file's stable card-UUID so a subsequent UI
   *  open reuses the same session. Right semantic for "send a message to
   *  the chat card whether or not the user has interacted with it yet"
   *  (per CLAUDE.md tenet 5: user intent, not transport).
   *
   *  The voice card's send_to_card tool routes through this so a user
   *  can ask voice to delegate work even when the qwen/claude/opencode
   *  chat card is in the layout but hasn't been "woken up" by a click.
   *  The agent processes the message with no UI clients attached;
   *  results persist to chat history and surface when the UI does
   *  attach (onAttach replays history).
   *
   *  Returns the same shape as dispatchToFilename. ok=false here only
   *  when the file's card class has no registered handler, or the
   *  session creation itself threw (rare). */
  async dispatchOrCreate(
    project: string | null,
    filename: string,
    data: unknown,
  ): Promise<{ ok: boolean; clientCount?: number; queueDepth?: number; created?: boolean }> {
    let sessionId = this.filenameToSessionId.get(this.filenameKey(project, filename));
    let created = false;
    if (!sessionId) {
      try {
        // Use the file's stable card UUID so a later UI open reuses
        // this session instead of forking a parallel one.
        sessionId = await getOrCreateCardId(project ?? undefined, filename);
      } catch (err) {
        console.warn(`[channel-mgr] dispatchOrCreate(${filename}) cardId lookup failed: ${(err as Error).message}`);
        return { ok: false };
      }
      // Single-flight: if a concurrent attachClient is mid-creation, await
      // its promise instead of racing a duplicate createSession.
      let creation = this.creating.get(sessionId);
      if (!creation && !this.sessions.has(sessionId)) {
        creation = this.createSession(sessionId, project, filename, {});
        this.creating.set(sessionId, creation);
        // Swallow on the cleanup chain so a rejected createSession doesn't
        // become an unhandled rejection (the awaiter below surfaces the error).
        creation.finally(() => this.creating.delete(sessionId!)).catch(() => { /* surfaced by the awaiter */ });
        created = true;
      }
      if (creation) {
        try { await creation; }
        catch (err) {
          console.warn(`[channel-mgr] dispatchOrCreate(${filename}) createSession failed: ${(err as Error).message}`);
          return { ok: false };
        }
      }
    }
    const result = this.dispatchToFilename(project, filename, data);
    if (created) (result as { created?: boolean }).created = true;
    return result;
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

  /** Re-fire onAttach for an already-attached client, re-delivering the
   *  handler's attach-time state (e.g. chat history). Used when a card REMOUNTS
   *  (navigate away + back, same WebSocket) and reuses its channel via the
   *  client-side bridge dedup — no fresh channel_open is sent, so onAttach never
   *  re-fires and the freshly-rendered (empty) DOM never receives the replay.
   *  onAttach is written to be idempotent (the chat card clears + re-renders),
   *  so re-running it is safe. No-op if the client isn't attached. */
  reattach(clientId: string, args: Record<string, unknown> = {}): void {
    const key = this.clientToSession.get(clientId);
    if (!key) return;
    const session = this.sessions.get(key);
    if (!session || session.state === "destroyed") return;
    if (!session.clients.has(clientId)) return;
    session.handler?.onAttach?.(clientId, args);
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
