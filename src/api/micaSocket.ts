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

function nextId(): string {
  return `mc-${++idCounter}-${Date.now()}`;
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
    // No channel re-registration needed — card scripts re-execute on re-render
    // and each openChannel() sends a fresh channel_open to the server.
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
    // Notify all active channels of disconnect
    for (const [id, ch] of activeChannels) {
      ch.onClose?.();
      activeChannels.delete(id);
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
 * Every call sends channel_open to the server. The server's ChannelManager
 * attaches to an existing session (keyed by card filename) or creates a new one.
 * onAttach fires server-side, delivering state replay (scrollback, history).
 *
 * ch.close()   = Soft detach. Sends channel_close. Server detaches client,
 *                session stays alive. Next openChannel() reattaches.
 * ch.destroy() = Same as close() — session lifecycle is bound to the card file,
 *                not the channel.
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
    sendMsg({ type: "channel_open", id, project, canvas, filename, fn, args });
  }).catch((err) => {
    console.error("[mica-socket] channel open failed:", err);
    activeChannels.delete(id);
    handle.onClose?.();
  });

  const close = () => {
    activeChannels.delete(id);
    waitForConnection().then(() => {
      sendMsg({ type: "channel_close", id });
    }).catch(() => {});
  };

  return {
    id,
    send: (data: unknown) => {
      waitForConnection().then(() => {
        sendMsg({ type: "channel_data", id, data });
      }).catch((err) => console.error("[mica-socket] channel send failed:", err));
    },
    close,
    destroy: close,
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
    /** Register a cleanup callback for re-render/unmount. */
    onDestroy: (fn: () => void) => {
      destroyCallbacks.push(fn);
    },
    /** Run onDestroy callbacks. Channels close via ch.close() in the callbacks. */
    _runDestroy: () => {
      for (const cb of destroyCallbacks) {
        try { cb(); } catch (e) { console.error("[mica-bridge] onDestroy error:", e); }
      }
      destroyCallbacks.length = 0;
    },
  };
}

export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
}
