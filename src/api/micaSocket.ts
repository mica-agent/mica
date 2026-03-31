/**
 * MicaSocket — WebSocket manager for widget ↔ server communication.
 *
 * Supports five patterns:
 *   1. call(fn, args) → Promise<result>         Request/response
 *   2. send(fn, args)                           Fire-and-forget to server
 *   3. on(event, callback)                      Server-pushed events
 *   4. openChannel(fn, args) → Channel          Bidirectional stream (persistent)
 *   5. broadcast(event, data)                   Widget-to-widget events
 *
 * Channel persistence:
 *   Channels are keyed by (project/canvas/filename/fn). Calling openChannel()
 *   for the same card and function returns the existing channel with swapped
 *   callbacks — no close/reopen cycle. Channels survive re-renders and WS
 *   reconnects. Only ch.destroy() (card file deleted) sends channel_close.
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

function nextId(): string {
  return `mc-${++idCounter}-${Date.now()}`;
}

// ── Persistent channel registry ─────────────────────────────
// Channels keyed by purpose (project/canvas/filename/fn), not by random ID.
// Survives re-renders and WS reconnects.

interface PersistentChannel {
  id: string;
  handle: ChannelHandle;
  openParams: { project: string; canvas: string; filename: string; fn: string; args: Record<string, unknown> };
}

const channelRegistry = new Map<string, PersistentChannel>();

function channelKey(project: string, canvas: string, filename: string, fn: string): string {
  return `${project}/${canvas}/${filename}/${fn}`;
}

// ── Connection management ────────────────────────────────────

export function connect(url?: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  const apiPort = import.meta.env.VITE_MICA_WS_PORT || "3002";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl = url || `${protocol}//${location.hostname}:${apiPort}/ws/cards`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[mica-socket] Connected");
    // Reattach all persistent channels — server sessions may still be alive
    for (const [, info] of channelRegistry) {
      const newId = nextId();
      activeChannels.delete(info.id);
      info.id = newId;
      activeChannels.set(newId, info.handle);
      try {
        sendMsg({ type: "channel_open", id: newId, ...info.openParams });
      } catch { /* WS may not be ready yet */ }
    }
  };

  ws.onclose = () => {
    console.log("[mica-socket] Disconnected, reconnecting in 2s...");
    ws = null;
    // Reject all pending calls
    for (const [id, pending] of pendingCalls) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("WebSocket disconnected"));
      pendingCalls.delete(id);
    }
    // Soft-close non-persistent channels only.
    // Persistent channels stay in registry and reattach on reconnect.
    for (const [id, ch] of activeChannels) {
      let isPersistent = false;
      for (const info of channelRegistry.values()) {
        if (info.id === id) { isPersistent = true; break; }
      }
      if (!isPersistent) {
        ch.onClose?.();
        activeChannels.delete(id);
      }
    }
    reconnectTimer = setTimeout(() => connect(wsUrl), 2000);
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
        // Server closed the channel (session destroyed, file deleted).
        // Remove from both maps.
        activeChannels.delete(id!);
        for (const [key, info] of channelRegistry) {
          if (info.id === id) {
            channelRegistry.delete(key);
            break;
          }
        }
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
 * Pattern 4: Open a persistent bidirectional channel.
 *
 * Channels are keyed by (project/canvas/filename/fn). If one already exists
 * for this key, the existing channel is returned with swapped callbacks.
 * No close/reopen message is sent to the server.
 *
 * ch.close()   = SOFT detach. Nulls callbacks. Channel stays in registry.
 *                Next openChannel() with same key reattaches instantly.
 * ch.destroy() = HARD close. Removes from registry. Sends channel_close to server.
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
  const key = channelKey(project, canvas, filename, fn);

  // Reattach to existing channel if one exists for this key
  const existing = channelRegistry.get(key);
  if (existing && activeChannels.has(existing.id)) {
    const handle = existing.handle;
    return {
      id: existing.id,
      send: (data: unknown) => {
        waitForConnection().then(() => {
          sendMsg({ type: "channel_data", id: existing.id, data });
        }).catch((err) => console.error("[mica-socket] channel send failed:", err));
      },
      close: () => {
        // Soft detach — no-op for persistent channels.
        // Callbacks stay active so data continues flowing even if the
        // card script doesn't re-run (same HTML, prevHtmlRef guard).
      },
      destroy: () => {
        // Hard close — remove from everything, notify server
        activeChannels.delete(existing.id);
        channelRegistry.delete(key);
        waitForConnection().then(() => {
          sendMsg({ type: "channel_close", id: existing.id });
        }).catch(() => {});
        handle.onClose?.();
      },
      onData: (cb) => { handle.onData = cb; },
      onClose: (cb) => { handle.onClose = cb; },
    };
  }

  // New channel
  const id = nextId();
  const handle: ChannelHandle = { onData: null, onClose: null };

  activeChannels.set(id, handle);
  channelRegistry.set(key, { id, handle, openParams: { project, canvas, filename, fn, args } });

  waitForConnection().then(() => {
    sendMsg({ type: "channel_open", id, project, canvas, filename, fn, args });
  }).catch((err) => {
    console.error("[mica-socket] channel open failed:", err);
    activeChannels.delete(id);
    channelRegistry.delete(key);
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
      // Soft detach — no-op for persistent channels.
      // Callbacks stay active so data continues flowing even if the
      // card script doesn't re-run (same HTML, prevHtmlRef guard).
    },
    destroy: () => {
      // Hard close — remove from everything, notify server
      activeChannels.delete(id);
      channelRegistry.delete(key);
      waitForConnection().then(() => {
        sendMsg({ type: "channel_close", id });
      }).catch(() => {});
      handle.onClose?.();
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
export function createBridge(project: string, canvas: CanvasId, filename: string) {
  const destroyCallbacks: Array<() => void> = [];

  return {
    call: (fn: string, args: Record<string, unknown> = {}) =>
      call(project, canvas, filename, fn, args),
    send: (fn: string, args: Record<string, unknown> = {}) =>
      send(project, canvas, filename, fn, args),
    on: (event: string, cb: (data: unknown) => void) =>
      on(event, cb),
    openChannel: (fn: string, args: Record<string, unknown> = {}) =>
      openChannel(project, canvas, filename, fn, args),
    broadcast: (event: string, data: Record<string, unknown> = {}) =>
      broadcast(event, data),
    /** Register a cleanup callback for soft destroy (re-render). */
    onDestroy: (fn: () => void) => {
      destroyCallbacks.push(fn);
    },
    /** Soft destroy — re-render lifecycle. Runs onDestroy callbacks (which call ch.close() = detach). */
    _runDestroy: () => {
      for (const cb of destroyCallbacks) {
        try { cb(); } catch (e) { console.error("[mica-bridge] onDestroy error:", e); }
      }
      destroyCallbacks.length = 0;
    },
    /** Hard destroy — component permanently removed. Destroys all channels for this card. */
    _hardDestroy: () => {
      // Run soft destroy first (onDestroy callbacks)
      for (const cb of destroyCallbacks) {
        try { cb(); } catch (e) { console.error("[mica-bridge] onDestroy error:", e); }
      }
      destroyCallbacks.length = 0;
      // Then destroy all persistent channels belonging to this card
      const prefix = `${project}/${canvas}/${filename}/`;
      for (const [key, info] of channelRegistry) {
        if (key.startsWith(prefix)) {
          activeChannels.delete(info.id);
          channelRegistry.delete(key);
          waitForConnection().then(() => {
            sendMsg({ type: "channel_close", id: info.id });
          }).catch(() => {});
        }
      }
    },
  };
}

export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
}
