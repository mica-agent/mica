// WebSocket hook for real-time card updates from the server.
// Uses the shared micaSocket connection for export calls;
// maintains its own listener for file-change broadcasts to update card state.

import { useState, useEffect, useCallback } from "react";
import type { CanvasId, RenderedCard, CardMeta } from "../api/canvasFiles";
import { fetchCards } from "../api/canvasFiles";
import { on } from "../api/micaSocket";

export interface UseCanvasSocketResult {
  cards: RenderedCard[];
  loading: boolean;
  refetch: () => void;
}

export function useCanvasSocket(projectId: string, canvasId: CanvasId): UseCanvasSocketResult {
  const [cards, setCards] = useState<RenderedCard[]>([]);
  const [loading, setLoading] = useState(true);

  // Initial fetch
  const loadCards = useCallback(async () => {
    try {
      const loaded = await fetchCards(projectId, canvasId);
      setCards(loaded);
    } catch (err) {
      console.error("[useCanvasSocket] Failed to fetch cards:", err);
    } finally {
      setLoading(false);
    }
  }, [projectId, canvasId]);

  useEffect(() => {
    setLoading(true);
    loadCards();
  }, [loadCards]);

  // Subscribe to file-change events via the shared micaSocket
  useEffect(() => {
    function handleFileEvent(msg: unknown) {
      const m = msg as {
        type: string;
        project?: string;
        canvas?: string;
        filename?: string;
        html?: string;
        exports?: string[];
        meta?: CardMeta;
      };
      if (m.project && m.project !== projectId) return;
      if (m.canvas && m.canvas !== canvasId) return;

      if ((m.type === "file-changed" || m.type === "file-created") && m.html && m.filename && m.meta) {
        setCards((prev) => {
          const existing = prev.findIndex((c) => c.filename === m.filename);
          const card: RenderedCard = {
            filename: m.filename!,
            html: m.html!,
            exports: m.exports || [],
            meta: m.meta!,
          };
          if (existing >= 0) {
            const next = [...prev];
            next[existing] = card;
            return next;
          }
          return [...prev, card];
        });
      } else if (m.type === "file-deleted" && m.filename) {
        setCards((prev) => prev.filter((c) => c.filename !== m.filename));
      }
    }

    const unsub1 = on("file-changed", handleFileEvent);
    const unsub2 = on("file-created", handleFileEvent);
    const unsub3 = on("file-deleted", handleFileEvent);

    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, [projectId, canvasId]);

  return { cards, loading, refetch: loadCards };
}
