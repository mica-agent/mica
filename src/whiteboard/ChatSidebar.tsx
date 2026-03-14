// ChatSidebar — renders the _chat.md widget card in the sidebar.
// The input is rendered directly in React to avoid flex layout issues
// with innerHTML-injected content.
// Optimistic messages show the user's text immediately while the agent processes.

import { useState, useEffect, useCallback, useRef } from "react";
import type { LayerId, RenderedCard } from "../api/layerFiles";
import { fetchCards, callCardExport } from "../api/layerFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  projectId: string;
  activeLayer: LayerId;
  layerColor: string;
  onFilesChanged?: () => void;
  onAgentBusy?: (busy: boolean) => void;
}

interface PendingMessage {
  text: string;
  status: "sending" | "error";
  error?: string;
}

function agentName(layer: string): string {
  const known: Record<string, string> = {
    mission: "Mission Strategist",
    experience: "Experience Designer",
    architecture: "System Architect",
    implementation: "Implementation Engineer",
  };
  if (known[layer]) return known[layer];
  const label = layer.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${label} Agent`;
}

function agentIcon(layer: string): string {
  const known: Record<string, string> = {
    mission: "\u25c6",
    experience: "\u25c7",
    architecture: "\u2b21",
    implementation: "\u2b22",
  };
  return known[layer] || "\u25cb";
}

export default function ChatSidebar({ projectId, activeLayer, layerColor, onFilesChanged, onAgentBusy }: Props) {
  const [chatCard, setChatCard] = useState<RenderedCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [statusText, setStatusText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);

  // Progressive status updates while agent is working
  useEffect(() => {
    if (pending?.status !== "sending") {
      setStatusText("");
      return;
    }
    const start = Date.now();
    const tick = () => {
      const elapsed = (Date.now() - start) / 1000;
      if (elapsed < 10) setStatusText("");
      else if (elapsed < 30) setStatusText("Thinking...");
      else if (elapsed < 60) setStatusText("Still working...");
      else if (elapsed < 120) setStatusText("This is taking a while \u2014 hang tight...");
      else setStatusText("Almost there \u2014 complex responses take time...");
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [pending?.status]);

  const loadChat = useCallback(async () => {
    try {
      const cards = await fetchCards(projectId, activeLayer);
      const chat = cards.find((c) => c.filename === "_chat.md");
      setChatCard(chat || null);
    } catch {
      setChatCard(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, activeLayer]);

  useEffect(() => {
    setLoading(true);
    loadChat();
  }, [loadChat]);

  // Scroll pending messages into view
  useEffect(() => {
    if (pending) pendingRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pending]);

  const handleCallExport = useCallback(
    async (project: string, layer: LayerId, filename: string, fn: string, args?: Record<string, unknown>) => {
      onAgentBusy?.(true);
      try {
        const result = await callCardExport(project, layer, filename, fn, args || {});
        loadChat();
        onFilesChanged?.();
        return result;
      } finally {
        onAgentBusy?.(false);
      }
    },
    [loadChat, onFilesChanged, onAgentBusy]
  );

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending) return;

    setInputValue("");
    setSending(true);
    setPending({ text, status: "sending" });
    onAgentBusy?.(true);

    try {
      await callCardExport(projectId, activeLayer, "_chat.md", "send_message", { message: text });
      setPending(null);
      loadChat();
      onFilesChanged?.();
    } catch (err) {
      console.error("Chat send failed:", err);
      setPending({ text, status: "error", error: (err as Error).message });
    } finally {
      setSending(false);
      onAgentBusy?.(false);
      inputRef.current?.focus();
    }
  }, [inputValue, sending, projectId, activeLayer, loadChat, onFilesChanged, onAgentBusy]);

  return (
    <div
      className="chat-sidebar"
      style={{ "--panel-color": layerColor } as React.CSSProperties}
    >
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-icon" style={{ color: layerColor }}>
          {agentIcon(activeLayer)}
        </span>
        <div className="chat-sidebar-info">
          <div className="chat-sidebar-name">{agentName(activeLayer)}</div>
          <div className="chat-sidebar-role">AI Team Member</div>
        </div>
      </div>

      <div className="chat-sidebar-body">
        {loading && !chatCard && (
          <div className="chat-sidebar-loading">Loading chat...</div>
        )}
        {!loading && !chatCard && (
          <div className="chat-sidebar-empty">No chat card found for this layer.</div>
        )}
        {chatCard && (
          <WidgetRuntime
            html={chatCard.html}
            exports={chatCard.exports}
            project={projectId}
            layer={activeLayer}
            filename="_chat.md"
            callExport={handleCallExport}
          />
        )}

        {/* Optimistic pending messages — shown immediately while agent processes */}
        {pending && (
          <div className="chat-pending" ref={pendingRef}>
            <div className="chat-pending-user">{pending.text}</div>
            {pending.status === "sending" && (
              <div className="chat-pending-typing">
                <span /><span /><span />
                {statusText && <span className="chat-pending-status">{statusText}</span>}
              </div>
            )}
            {pending.status === "error" && (
              <div className="chat-pending-error">
                <span>Timed out — the agent took too long to respond.</span>
                <div className="chat-pending-error-actions">
                  <button onClick={() => { setPending(null); setInputValue(pending.text); }}>Edit</button>
                  <button onClick={() => { setPending(null); }}>Dismiss</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Input rendered in React — always visible at bottom */}
      <div className="chat-sidebar-input">
        <input
          ref={inputRef}
          type="text"
          placeholder={`Ask ${agentName(activeLayer)}...`}
          value={inputValue}
          disabled={sending}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
        />
        <button onClick={handleSend} disabled={sending || !inputValue.trim()}>
          &uarr;
        </button>
      </div>
    </div>
  );
}
