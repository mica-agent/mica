/**
 * MicaSocket — WebSocket manager for widget ↔ server communication.
 *
 * Supports five patterns:
 *   1. call(fn, args) → Promise<result>         Request/response
 *   2. send(fn, args)                           Fire-and-forget to server
 *   3. on(event, callback)                      Server-pushed events
 *   4. openChannel(fn, args) → Channel          Bidirectional stream
 *   5. broadcast(event, data)                   Widget-to-widget events
 *
 * Channel lifecycle:
 *   Every openChannel() sends channel_open to the server. The server's
 *   ChannelManager attaches to an existing session (keyed by card filename)
 *   or creates a new one. ch.close() sends channel_close (soft detach).
 *   The server session stays alive — the card filename is the session identity.
 */

export type CanvasId = string;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ChannelHandle {
  onData: ((data: unknown) => void) | null;
  onClose: (() => void) | null;
  // Params needed to re-send `channel_open` after a WebSocket reconnect
  // (e.g., backend restart). Without this, sessions silently die on the
  // server but the card still holds a stale handle, so its `ch.send()`
  // goes into the void — visible bug: chat card UI shows "connected"
  // (green light) but voice / cross-card dispatch fails with
  // `ok=false` because `filenameToSessionId` has no entry. Voice avoids
  // this naturally via its presence-ping loop; chat / claude / opencode
  // don't, so we replay the open server-side using the SAME client-side
  // channel id — card classes' captured `ch` references stay valid.
  reopenSpec: {
    project: string;
    canvas: CanvasId;
    filename: string;
    fn: string;
    args: Record<string, unknown>;
    sessionId?: string;
  };
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const pendingCalls = new Map<string, PendingCall>();
const activeChannels = new Map<string, ChannelHandle>();
const eventListeners = new Map<string, Set<(data: unknown) => void>>();
let idCounter = 0;
let wsUrl = "";
let connected = false;
let wasEverConnected = false;
const connectionListeners = new Set<(connected: boolean) => void>();

/** Subscribe to WebSocket connection state changes. */
export function onConnectionChange(cb: (connected: boolean) => void): () => void {
  connectionListeners.add(cb);
  cb(connected); // immediate current state
  return () => { connectionListeners.delete(cb); };
}

function setConnected(value: boolean) {
  connected = value;
  for (const cb of connectionListeners) cb(value);
}

/** Unique ID for this browser window — used for event source attribution. */
export const windowId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Stable ID for this browser tab, persisted in sessionStorage.
 * Survives page refreshes within the same tab, but is isolated between tabs.
 * Used by the server to evict stale clients from the same tab on reconnect.
 */
function getTabId(): string {
  try {
    let id = sessionStorage.getItem("mica-tab-id");
    if (!id) {
      id = `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem("mica-tab-id", id);
    }
    return id;
  } catch {
    // sessionStorage unavailable — fall back to a per-session random ID
    return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
export const tabId = getTabId();

function nextId(): string {
  return `mc-${++idCounter}-${Date.now()}`;
}

// ── Global fetch override for /api/* — force cache:'no-store' ─
//
// Why: two projects often hit identical URLs (e.g. /api/files/docs/spec.md)
// with different `X-Mica-Project` headers. Browsers key the cache by URL
// alone unless the response carries `Vary: X-Mica-Project`. Even after we
// add that response header, OLD cache entries (from before the fix) ignore
// it and continue to be served on URL match — leading to "I just created a
// new project but spec.md shows another project's data" bugs.
//
// Forcing cache:'no-store' at fetch-time bypasses the disk cache entirely
// (read AND write). One-time installation here covers every fetch in the
// app, including those issued from card scripts (which call window.fetch
// after the CARD_SHIM's wrapper).
(function installFetchNoStore() {
  if (typeof window === "undefined") return;
  const orig = window.fetch.bind(window);
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
    if (url && (url.startsWith("/api/") || url.includes("/api/"))) {
      init = { ...(init || {}), cache: "no-store" };
    }
    return orig(input, init);
  };
})();

// ── Connection management ────────────────────────────────────

export function connect(url?: string): void {
  if (ws) {
    if (ws.readyState === WebSocket.OPEN) return;
    // Clean up stale socket (CONNECTING or CLOSING) to prevent orphaned handlers
    ws.onopen = null;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try { ws.close(); } catch {}
    ws = null;
  }

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  // For desktop dev (http://localhost:5173) we connect directly to the
  // backend's WS port so it survives Vite restarts. For any non-
  // localhost origin (Tailscale Serve, Caddy, cloud LB, etc.) only
  // the page's port is reachable — direct-port-3002 fails. Use the
  // same-origin path so Vite's /ws proxy (in dev) or the upstream
  // reverse proxy (in prod) routes to the backend.
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (url) {
    wsUrl = url;
  } else if (isLocal) {
    const apiPort = import.meta.env.VITE_MICA_WS_PORT || "3002";
    wsUrl = `${protocol}//${location.hostname}:${apiPort}/ws/cards`;
  } else {
    wsUrl = `${protocol}//${location.host}/ws/cards`;
  }
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    const isReconnect = wasEverConnected;
    console.log(`[mica-socket] Connected${isReconnect ? " (reconnect)" : ""}`);
    wasEverConnected = true;
    setConnected(true);
    // Re-subscribe after reconnect so the file watcher rejoins this tab's project.
    if (subscribedProject) {
      try { sendMsg({ type: "subscribe-project", project: subscribedProject }); } catch { /* ignored */ }
    }
    // Replay channel_open for every active channel so server-side
    // sessions get re-created after a backend restart. The id stays
    // the same so the card class's captured `ch.send(...)` references
    // continue to address the same server-side session. Without this,
    // sessions live on the client but not on the server, and
    // cross-card routing (e.g., voice → qwen.chat) fails with
    // `dispatchToFilename` ok=false until the user refreshes the tab.
    if (isReconnect && activeChannels.size > 0) {
      console.log(`[mica-socket] Replaying ${activeChannels.size} channel(s) after reconnect`);
      for (const [id, handle] of activeChannels) {
        const { project, canvas, filename, fn, args, sessionId } = handle.reopenSpec;
        try {
          sendMsg({ type: "channel_open", id, sessionId, project, canvas, filename, fn, args, tabId });
        } catch (err) {
          console.warn(`[mica-socket] Replay failed for channel ${id} (${filename}/${fn}): ${(err as Error).message}`);
        }
      }
    }
  };

  ws.onclose = () => {
    console.log("[mica-socket] Disconnected");
    setConnected(false);
    ws = null;
    // Reject all pending calls
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket disconnected"));
      pendingCalls.delete(id);
    }
    // Active channels are intentionally NOT cleared here — we keep them
    // so ws.onopen can replay `channel_open` for each, re-creating their
    // server-side sessions after a backend restart. `ch.send()` calls
    // made during the disconnect window queue inside `waitForConnection`
    // and fire after the onopen replays land. Channels are only removed
    // by an explicit `ch.destroy()` or by `destroyBridgeFor()` when the
    // file is deleted. See ChannelHandle.reopenSpec for the params used
    // to replay.
    // Two parallel recovery paths; whichever succeeds first wins.
    //   (1) Retry the WebSocket directly at its own port. The backend lives on
    //       :3002; WS connects there, NOT through Vite. So even if the Vite
    //       dev server is also restarting (and /api/* fetches are failing as
    //       a result), the WS can reach Mica as soon as the backend is ready.
    //       Successful reconnect → onopen → setConnected(true) → overlay gone.
    //   (2) HTTP probe via relative URL. Works once Vite is back up. On 200,
    //       force-reload so the page picks up any fresh frontend build.
    // Previously we only did (2) — which wedged when Vite was slow to recover.
    // Track whether we've actually seen the server go down. We only
    // force-reload on a CONFIRMED down→up transition, not on the first
    // successful poll. Without this guard, transient WS blips (common
    // over iOS Safari + Tailscale + power management) get misread as
    // "server restarted" and trigger a reload-on-every-blip loop.
    let confirmedDown = false;
    const poll = setInterval(async () => {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        try { connect(wsUrl); } catch { /* will retry next tick */ }
      }
      try {
        const r = await fetch("/api/project");
        if (r.ok) {
          if (confirmedDown) {
            clearInterval(poll);
            console.log("[mica-socket] Server is back — reloading page");
            window.location.replace(window.location.pathname + "?t=" + Date.now());
          }
          // If we've never seen it down, stay silent. Either WS reconnects
          // on its own (stopPollOnReconnect handler clears this poll) or a
          // future poll will catch a real outage.
        } else {
          confirmedDown = true;
        }
      } catch {
        // network error fetching /api/project → server is genuinely down.
        confirmedDown = true;
      }
    }, 2000);
    // If WS reconnects before HTTP does, we want to stop polling so we don't
    // force-reload a working session. Subscribe once; unsubscribe after firing.
    const stopPollOnReconnect = onConnectionChange((c) => {
      if (c) {
        clearInterval(poll);
        stopPollOnReconnect();
      }
    });
  };

  ws.onerror = (err) => {
    console.error("[mica-socket] Error:", err);
  };

  ws.onmessage = (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data as string);
    } catch {
      return;
    }
    handleMessage(msg);
  };
}

function handleMessage(msg: Record<string, unknown>): void {
  const type = msg.type as string;
  const id = msg.id as string | undefined;

  switch (type) {
    case "result": {
      const pending = id ? pendingCalls.get(id) : undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        pendingCalls.delete(id!);
        pending.resolve(msg.result);
      }
      break;
    }

    case "error": {
      const pending = id ? pendingCalls.get(id) : undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        pendingCalls.delete(id!);
        pending.reject(new Error(msg.error as string || "Unknown error"));
      }
      break;
    }

    case "stream": {
      const pending = id ? pendingCalls.get(id) : undefined;
      if (pending && (pending as unknown as { onStream?: (data: unknown) => void }).onStream) {
        (pending as unknown as { onStream: (data: unknown) => void }).onStream(msg.data);
      }
      break;
    }

    case "stream_end": {
      const pending = id ? pendingCalls.get(id) : undefined;
      if (pending) {
        clearTimeout(pending.timeout);
        pendingCalls.delete(id!);
        pending.resolve(msg.result ?? null);
      }
      break;
    }

    case "channel_data": {
      const ch = id ? activeChannels.get(id) : undefined;
      if (ch) ch.onData?.(msg.data);
      break;
    }

    case "channel_close": {
      const ch = id ? activeChannels.get(id) : undefined;
      if (ch) {
        activeChannels.delete(id!);
        ch.onClose?.();
      }
      break;
    }

    default: {
      const listeners = eventListeners.get(type);
      if (listeners) {
        for (const cb of listeners) cb(msg);
      }
      break;
    }
  }
}

/** Wait for the WebSocket to be open (up to 5s). */
function waitForConnection(): Promise<void> {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket connection timeout")), 5000);
    const check = () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearTimeout(timeout);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

function sendMsg(msg: Record<string, unknown>): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error("WebSocket not connected");
  }
  ws.send(JSON.stringify(msg));
}

// ── Public API ──────────────────────────────────────────────

export async function call(
  project: string,
  canvas: CanvasId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {},
  timeoutMs = 300000
): Promise<unknown> {
  await waitForConnection();
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Call to ${fn} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timeout });
    sendMsg({ type: "call", id, project, canvas, filename, fn, args });
  });
}

export function send(
  project: string,
  canvas: CanvasId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {}
): void {
  waitForConnection().then(() => {
    sendMsg({ type: "send", project, canvas, filename, fn, args });
  }).catch((err) => console.error("[mica-socket] send failed:", err));
}

// Per-tab subscribed project. Persisted across reconnects so the WS
// auto-resubscribes on `onopen`. Server uses this to:
//   1. Add/release a watcher for this project (ref-counted)
//   2. Filter file-* broadcasts to subscribers only
let subscribedProject: string | null = null;

export function subscribeProject(project: string): void {
  if (subscribedProject === project) return;
  const prev = subscribedProject;
  subscribedProject = project;
  waitForConnection().then(() => {
    if (prev) sendMsg({ type: "unsubscribe-project", project: prev });
    sendMsg({ type: "subscribe-project", project });
  }).catch((err) => console.error("[mica-socket] subscribeProject failed:", err));
}

export function unsubscribeProject(): void {
  if (!subscribedProject) return;
  const prev = subscribedProject;
  subscribedProject = null;
  waitForConnection().then(() => {
    sendMsg({ type: "unsubscribe-project", project: prev });
  }).catch(() => { /* socket closed; server cleans up on disconnect */ });
}

export function on(event: string, callback: (data: unknown) => void): () => void {
  if (!eventListeners.has(event)) {
    eventListeners.set(event, new Set());
  }
  eventListeners.get(event)!.add(callback);
  return () => {
    eventListeners.get(event)?.delete(callback);
  };
}

/**
 * Pattern 4: Open a bidirectional channel.
 *
 * openChannel() always sends channel_open to the server. The server's
 * ChannelManager attaches to an existing session (keyed by card filename)
 * or creates a new one. onAttach fires server-side for state replay.
 *
 * ch.close()   = Soft detach. Nulls callbacks. Does not notify server.
 * ch.destroy() = Hard close. Notifies server to detach this client.
 */
export interface Channel {
  id: string;
  send: (data: unknown) => void;
  close: () => void;
  destroy: () => void;
  onData: (cb: (data: unknown) => void) => void;
  onClose: (cb: () => void) => void;
}

export function openChannel(
  project: string,
  canvas: CanvasId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {},
  sessionId?: string,
): Channel {
  const id = nextId();
  const handle: ChannelHandle = {
    onData: null,
    onClose: null,
    reopenSpec: { project, canvas, filename, fn, args, sessionId },
  };

  activeChannels.set(id, handle);

  waitForConnection().then(() => {
    sendMsg({ type: "channel_open", id, sessionId, project, canvas, filename, fn, args, tabId });
  }).catch((err) => {
    console.error("[mica-socket] channel open failed:", err);
    activeChannels.delete(id);
    handle.onClose?.();
  });

  return {
    id,
    send: (data: unknown) => {
      waitForConnection().then(() => {
        sendMsg({ type: "channel_data", id, data });
      }).catch((err) => console.error("[mica-socket] channel send failed:", err));
    },
    close: () => {
      // Soft detach — null callbacks so stale data doesn't reach destroyed widgets.
      // Does NOT notify server. Session stays alive.
      handle.onData = null;
      handle.onClose = null;
    },
    destroy: () => {
      // Hard close — notifies server to detach this client.
      handle.onData = null;
      handle.onClose = null;
      activeChannels.delete(id);
      waitForConnection().then(() => {
        sendMsg({ type: "channel_close", id });
      }).catch(() => {});
    },
    onData: (cb) => { handle.onData = cb; },
    onClose: (cb) => { handle.onClose = cb; },
  };
}

export function broadcast(event: string, data: Record<string, unknown> = {}): void {
  waitForConnection().then(() => {
    sendMsg({ type: "broadcast", event, data });
  }).catch((err) => console.error("[mica-socket] broadcast failed:", err));
}

/**
 * Module-level bridge cache, keyed by (project, canvas, filename).
 *
 * Why module-level (and not React useRef): cards correspond to FILES, not to
 * React component instances. A bridge holds an open WebSocket channel and a
 * server-side session — those should outlive React's lifecycle quirks
 * (StrictMode double-mount, parent re-render forcing remount, key changes).
 *
 * Without the cache: StrictMode mount → fresh useRef → fresh bridge → fresh
 * openChannel → fresh server-side session. Two of those happen in dev,
 * splitting broadcasts between two sessions. With the cache: same bridge is
 * reused; the dedup inside the bridge returns the same channel.
 *
 * Bridge destroy is now driven by FILE LIFECYCLE (file-deleted handler in
 * CanvasCardRuntime calls destroyBridgeFor), not by React unmount.
 */
// Bridge cache keyed by sessionId (the file's stable UUID). One bridge per file
// across all React lifecycle quirks (StrictMode double-mount, parent re-renders,
// key changes). Different projects with the same template-seeded filename get
// distinct sessionIds → distinct bridges → no cross-project channel sharing.
const bridges = new Map<string, ReturnType<typeof createBridge>>();

/** Get or create the bridge for this card. Caller does NOT need to track its lifetime. */
export function getOrCreateBridge(sessionId: string, project: string, canvas: CanvasId, filename: string) {
  let bridge = bridges.get(sessionId);
  if (!bridge) {
    bridge = createBridge(sessionId, project, canvas, filename);
    bridges.set(sessionId, bridge);
  }
  return bridge;
}

/** Tear down the bridge for a file. Call when the file is deleted or the
 *  project is closed — NOT on every React unmount. */
export function destroyBridgeFor(sessionId: string): void {
  const bridge = bridges.get(sessionId);
  if (!bridge) return;
  bridge._runDestroy();
  bridges.delete(sessionId);
}

// Per-card capture hooks, keyed by filename. Cards register via
// `mica.onCapture(cb)` to provide their own screenshot path. The
// screenshot pipeline (src/whiteboard/screenshotClient.ts) checks this
// map BEFORE falling back to html2canvas. Used by WebGL/Three.js cards
// where html2canvas → toDataURL returns blank unless the renderer was
// constructed with `preserveDrawingBuffer: true`. Hook lets the card
// render-on-demand and produce a dataURL inside the same frame.
//
// Cleanup is automatic — the registration pushes a destroy callback
// onto the bridge that removes the entry when the card unmounts.
const captureHooks = new Map<string, () => string | Promise<string>>();

/** Look up a card's registered onCapture callback, if any. Used by the
 *  screenshot pipeline. Returns undefined if the card didn't register. */
export function getCaptureHook(filename: string): (() => string | Promise<string>) | undefined {
  return captureHooks.get(filename);
}

/**
 * Create a scoped mica bridge for a specific widget instance.
 *
 * The bridge deduplicates openChannel() calls for the same (filename, fn) key.
 * Caller should prefer `getOrCreateBridge` so the bridge is shared across
 * React remounts; calling `createBridge` directly creates a fresh, unmanaged
 * bridge that won't dedup against existing channels for the same file.
 */
export function createBridge(sessionId: string, project: string, canvas: CanvasId, filename: string) {
  const destroyCallbacks: Array<() => void> = [];
  let refreshFn: (() => Promise<void>) | null = null;

  // Per-bridge channel dedup: keyed by fn (channel function name).
  // Prevents duplicate channel_open for the same card during React lifecycle.
  const bridgeChannels = new Map<string, Channel>();

  const reportError = (msg: string) => {
    console.error(`[card-runtime] Script error in ${filename}:`, msg);
    fetch(`/api/projects/${project}/canvases/${canvas}/cards/${encodeURIComponent(filename)}/error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: msg }),
    }).catch(() => {});
  };

  return {
    /** Set the refresh implementation (provided by CardRuntime) */
    _setRefreshFn: (fn: () => Promise<void>) => { refreshFn = fn; },
    /** Re-fetch and re-render this card's HTML. Card classes call this to opt-in to updates. */
    refresh: async () => { try { if (refreshFn) await refreshFn(); } catch {} },
    call: (fn: string, args: Record<string, unknown> = {}) =>
      call(project, canvas, filename, fn, args),
    send: (fn: string, args: Record<string, unknown> = {}) =>
      send(project, canvas, filename, fn, args),
    // Server-only methods — provide helpful stubs that report the error
    read: (..._args: unknown[]) => { reportError("mica.read() is server-side only — use mica.call() to invoke an export function instead"); return Promise.resolve(""); },
    write: (..._args: unknown[]) => { reportError("mica.write() is server-side only — use mica.call() to invoke an export function instead"); return Promise.resolve(); },
    exec: (..._args: unknown[]) => { reportError("mica.exec() is server-side only — use mica.call() to invoke an export function instead"); return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 }); },
    on: (event: string, cb: (data: unknown) => void) =>
      on(event, cb),
    openChannel: (fn: string, args: Record<string, unknown> = {}) => {
      // If this bridge already has a channel for this fn, return it.
      // The card script will set new callbacks via ch.onData()/ch.onClose().
      const existing = bridgeChannels.get(fn);
      if (existing && activeChannels.has(existing.id)) {
        return existing;
      }
      // New channel — send channel_open to server with the file's sessionId
      // so the server keys the session correctly.
      const ch = openChannel(project, canvas, filename, fn, args, sessionId);
      bridgeChannels.set(fn, ch);
      return ch;
    },
    broadcast: (event: string, data: Record<string, unknown> = {}) =>
      broadcast(event, data),
    /** Register a cleanup callback for re-render/unmount. */
    onDestroy: (fn: () => void) => {
      destroyCallbacks.push(fn);
    },
    /** Register a snapshot callback for `render_capture`. The callback
     *  returns a PNG dataURL (or a Promise resolving to one). The screenshot
     *  pipeline calls this BEFORE falling back to html2canvas — required for
     *  WebGL cards (Three.js, regl, PixiJS in WebGL mode, Babylon, etc.)
     *  because html2canvas → `canvas.toDataURL()` returns blank unless the
     *  WebGL context was created with `preserveDrawingBuffer: true`.
     *
     *  Inside the callback, the card class controls when to render. Typical
     *  Three.js usage:
     *    `mica.onCapture(() => { renderer.render(scene, camera); return canvasEl.toDataURL("image/png"); });`
     *
     *  Last writer wins per filename; cleanup is automatic on card unmount.
     *  The pipeline applies a 5s timeout and falls back to html2canvas if
     *  the callback throws or times out.
     */
    onCapture: (cb: () => string | Promise<string>) => {
      captureHooks.set(filename, cb);
      destroyCallbacks.push(() => {
        if (captureHooks.get(filename) === cb) captureHooks.delete(filename);
      });
    },
    /** Run onDestroy callbacks and hard-close all channels. */
    _runDestroy: () => {
      for (const cb of destroyCallbacks) {
        try { cb(); } catch (e) { console.error("[mica-bridge] onDestroy error:", e); }
      }
      destroyCallbacks.length = 0;
      // Hard-close all channels so server cleans up sessions
      for (const ch of bridgeChannels.values()) {
        ch.destroy();
      }
      bridgeChannels.clear();
    },
  };
}

export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
}
