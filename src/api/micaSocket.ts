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

  const apiPort = import.meta.env.VITE_MICA_WS_PORT || "3002";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl = url || `${protocol}//${location.hostname}:${apiPort}/ws/cards`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[mica-socket] Connected");
    wasEverConnected = true;
    setConnected(true);
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
    // Notify all active channels of disconnect
    for (const [id, ch] of activeChannels) {
      ch.onClose?.();
      activeChannels.delete(id);
    }
    // Poll the server with HTTP until it's back, then reload the page
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`${location.protocol}//${location.hostname}:${import.meta.env.VITE_MICA_WS_PORT || "3002"}/api/card-classes`);
        if (r.ok) {
          clearInterval(poll);
          console.log("[mica-socket] Server is back — reloading page");
          location.reload();
        }
      } catch {
        // server still down, try again
      }
    }, 2000);
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
  args: Record<string, unknown> = {}
): Channel {
  const id = nextId();
  const handle: ChannelHandle = { onData: null, onClose: null };

  activeChannels.set(id, handle);

  waitForConnection().then(() => {
    sendMsg({ type: "channel_open", id, project, canvas, filename, fn, args, tabId });
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
 * Create a scoped mica bridge for a specific widget instance.
 */
/**
 * Create a scoped mica bridge for a specific widget instance.
 *
 * The bridge deduplicates openChannel() calls for the same (filename, fn) key.
 * This handles React lifecycle: scripts re-execute on re-render, StrictMode
 * double-mounts — the same channel handle is returned with swapped callbacks
 * instead of opening a new server connection.
 *
 * On page refresh, the bridge is recreated (fresh JS context), so openChannel
 * sends a fresh channel_open and the server attaches to the existing session.
 */
export function createBridge(project: string, canvas: CanvasId, filename: string) {
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
      // New channel — send channel_open to server
      const ch = openChannel(project, canvas, filename, fn, args);
      bridgeChannels.set(fn, ch);
      return ch;
    },
    broadcast: (event: string, data: Record<string, unknown> = {}) =>
      broadcast(event, data),
    /** Register a cleanup callback for re-render/unmount. */
    onDestroy: (fn: () => void) => {
      destroyCallbacks.push(fn);
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
