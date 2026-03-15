/**
 * MicaSocket — WebSocket manager for widget ↔ Python communication.
 *
 * Supports four patterns:
 *   1. call(fn, args) → Promise<result>         Request/response
 *   2. send(fn, args)                           Fire-and-forget to server
 *   3. on(event, callback)                      Server-pushed events
 *   4. openChannel(fn, args) → Channel          Bidirectional stream
 */

export type LayerId = string;

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

  wsUrl = url || `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws/cards`;
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
export function call(
  project: string,
  layer: LayerId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {},
  timeoutMs = 300000
): Promise<unknown> {
  const id = nextId();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Call to ${fn} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingCalls.set(id, { resolve, reject, timeout });
    sendMsg({ type: "call", id, project, layer, filename, fn, args });
  });
}

/**
 * Pattern 2: Fire-and-forget send to server.
 * No response expected.
 */
export function send(
  project: string,
  layer: LayerId,
  filename: string,
  fn: string,
  args: Record<string, unknown> = {}
): void {
  sendMsg({ type: "send", project, layer, filename, fn, args });
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
  layer: LayerId,
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
  sendMsg({ type: "channel_open", id, project, layer, filename, fn, args });

  return {
    id,
    send: (data: unknown) => {
      sendMsg({ type: "channel_data", id, data });
    },
    close: () => {
      sendMsg({ type: "channel_close", id });
      activeChannels.delete(id);
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
  sendMsg({ type: "broadcast", event, data });
}

/**
 * Create a scoped mica bridge for a specific widget instance.
 * This is what WidgetRuntime injects into widget scripts.
 */
export function createBridge(project: string, layer: LayerId, filename: string) {
  return {
    call: (fn: string, args: Record<string, unknown> = {}) =>
      call(project, layer, filename, fn, args),
    send: (fn: string, args: Record<string, unknown> = {}) =>
      send(project, layer, filename, fn, args),
    on: (event: string, cb: (data: unknown) => void) =>
      on(event, cb),
    openChannel: (fn: string, args: Record<string, unknown> = {}) =>
      openChannel(project, layer, filename, fn, args),
    broadcast: (event: string, data: Record<string, unknown> = {}) =>
      broadcast(event, data),
  };
}

export function disconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  ws = null;
}
