/**
 * MicaSocket — WebSocket manager for widget ↔ Python communication.
 *
 * Supports four patterns:
 *   1. call(fn, args) → Promise<result>         Request/response
 *   2. send(fn, args)                           Fire-and-forget to server
 *   3. on(event, callback)                      Server-pushed events
 *   4. openChannel(fn, args) → Channel          Bidirectional stream
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

  // Connect directly to the API server's WebSocket endpoint.
  // In dev, the API runs on port 3002 — connecting directly avoids the extra
  // hop through Vite's WS proxy, which is slow through VS Code port forwarding.
  const apiPort = import.meta.env.VITE_MICA_WS_PORT || "3002";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  wsUrl = url || `${protocol}//${location.hostname}:${apiPort}/ws/cards`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log("[mica-socket] Connected");
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
    // Close all channels
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
    // ── Request/response result ──
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

    // ── Server → widget stream ──
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

    // ── Bidirectional channel ──
    case "channel_data": {
      const ch = id ? activeChannels.get(id) : undefined;
      if (ch) ch.onData?.(msg.data);
      break;
    }

    case "channel_close": {
      const ch = id ? activeChannels.get(id) : undefined;
      if (ch) {
        ch.onClose?.();
        activeChannels.delete(id!);
      }
      break;
    }

    // ── Server-pushed events (broadcasts) ──
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

/**
 * Pattern 1: Request/response call to a Python @mica.export function.
 * Returns a Promise that resolves with the function's return value.
 */
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

/**
 * Pattern 2: Fire-and-forget send to server.
 * No response expected.
 */
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

/**
 * Pattern 3: Subscribe to server-pushed events.
 * Returns an unsubscribe function.
 */
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
 * Pattern 4: Open a bidirectional channel to a Python handler.
 * Returns a Channel object for sending data and receiving callbacks.
 */
export interface Channel {
  id: string;
  send: (data: unknown) => void;
  close: () => void;
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

  const handle: ChannelHandle = {
    onData: null,
    onClose: null,
  };

  activeChannels.set(id, handle);
  // Defer the open message until WebSocket is connected
  waitForConnection().then(() => {
    sendMsg({ type: "channel_open", id, project, canvas, filename, fn, args });
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
      activeChannels.delete(id);
      waitForConnection().then(() => {
        sendMsg({ type: "channel_close", id });
      }).catch(() => {});
      handle.onClose?.();
    },
    onData: (cb) => { handle.onData = cb; },
    onClose: (cb) => { handle.onClose = cb; },
  };
}

/**
 * Pattern 5: Broadcast an event to all connected widgets.
 * Other widgets receive this via mica.on(event, callback).
 */
export function broadcast(event: string, data: Record<string, unknown> = {}): void {
  waitForConnection().then(() => {
    sendMsg({ type: "broadcast", event, data });
  }).catch((err) => console.error("[mica-socket] broadcast failed:", err));
}

/**
 * Create a scoped mica bridge for a specific widget instance.
 * This is what WidgetRuntime injects into widget scripts.
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
    /** Register a cleanup callback. Called when the card is removed or before DOM replacement. */
    onDestroy: (fn: () => void) => {
      destroyCallbacks.push(fn);
    },
    /** Execute and clear all registered destroy callbacks. */
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
