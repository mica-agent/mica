// WebSocket hook for real-time card updates from the server.
// Replaces 5-second polling with instant push updates.

import { useState, useEffect, useCallback, useRef } from "react";
import type { LayerId, RenderedCard, CardMeta } from "../api/layerFiles";
import { fetchCards, callCardExport as callCardExportRest } from "../api/layerFiles";

const API_BASE = import.meta.env.VITE_MICA_API || "";

function wsUrl(): string {
  if (API_BASE) {
    const url = new URL(API_BASE);
    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${protocol}//${url.host}/ws/cards`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/cards`;
}

interface ExportCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let callIdCounter = 0;

export interface UseLayerSocketResult {
  cards: RenderedCard[];
  loading: boolean;
  callExport: (layer: LayerId, filename: string, fn: string, args?: Record<string, unknown>) => Promise<unknown>;
  refetch: () => void;
}

export function useLayerSocket(layerId: LayerId): UseLayerSocketResult {
  const [cards, setCards] = useState<RenderedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingCalls = useRef<Map<string, ExportCall>>(new Map());

  // Initial fetch
  const loadCards = useCallback(async () => {
    try {
      console.log("[useLayerSocket] Fetching cards for", layerId);
      const loaded = await fetchCards(layerId);
      console.log("[useLayerSocket] Got", loaded.length, "cards for", layerId);
      setCards(loaded);
    } catch (err) {
      console.error("[useLayerSocket] Failed to fetch cards:", err);
    } finally {
      setLoading(false);
    }
  }, [layerId]);

  // WebSocket connection
  useEffect(() => {
    setLoading(true);
    loadCards();

    const url = wsUrl();
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let alive = true;

    function connect() {
      ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleMessage(msg);
        } catch {
          // ignore invalid messages
        }
      };

      ws.onclose = () => {
        if (alive) {
          reconnectTimer = setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    function handleMessage(msg: {
      type: string;
      layer?: string;
      filename?: string;
      html?: string;
      exports?: string[];
      meta?: CardMeta;
      id?: string;
      result?: unknown;
      error?: string;
    }) {
      // Only handle events for our layer
      if (msg.layer && msg.layer !== layerId) return;

      switch (msg.type) {
        case "file-changed":
        case "file-created":
          if (msg.html && msg.filename && msg.meta) {
            setCards((prev) => {
              const existing = prev.findIndex((c) => c.filename === msg.filename);
              const card: RenderedCard = {
                filename: msg.filename!,
                html: msg.html!,
                exports: msg.exports || [],
                meta: msg.meta!,
              };
              if (existing >= 0) {
                const next = [...prev];
                next[existing] = card;
                return next;
              }
              return [...prev, card];
            });
          }
          break;

        case "file-deleted":
          if (msg.filename) {
            setCards((prev) => prev.filter((c) => c.filename !== msg.filename));
          }
          break;

        case "export_result":
          if (msg.id) {
            const pending = pendingCalls.current.get(msg.id);
            if (pending) {
              pending.resolve(msg.result);
              pendingCalls.current.delete(msg.id);
            }
          }
          break;

        case "export_error":
          if (msg.id) {
            const pending = pendingCalls.current.get(msg.id);
            if (pending) {
              pending.reject(new Error(msg.error || "Export call failed"));
              pendingCalls.current.delete(msg.id);
            }
          }
          break;
      }
    }

    connect();

    return () => {
      alive = false;
      clearTimeout(reconnectTimer);
      ws?.close();
      wsRef.current = null;
    };
  }, [layerId, loadCards]);

  // Call an @export function via WebSocket, with REST fallback
  const callExport = useCallback(
    (layer: LayerId, filename: string, fn: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        // Fallback to REST
        console.log("[useLayerSocket] WebSocket not open, using REST fallback for", fn);
        return callCardExportRest(layer, filename, fn, args);
      }

      return new Promise((resolve, reject) => {
        const id = `call-${++callIdCounter}`;
        pendingCalls.current.set(id, { resolve, reject });

        ws.send(JSON.stringify({
          type: "export_call",
          id,
          layer,
          filename,
          fn,
          args,
        }));

        // Timeout after 120s
        setTimeout(() => {
          if (pendingCalls.current.has(id)) {
            pendingCalls.current.delete(id);
            reject(new Error("Export call timed out"));
          }
        }, 120000);
      });
    },
    []
  );

  return { cards, loading, callExport, refetch: loadCards };
}
