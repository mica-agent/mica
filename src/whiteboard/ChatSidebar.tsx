// ChatSidebar — renders the _chat.md widget card in the sidebar.
// The input is rendered directly in React to avoid flex layout issues
// with innerHTML-injected content.

import { useState, useEffect, useCallback, useRef } from "react";
import type { LayerId, RenderedCard } from "../api/layerFiles";
import { fetchCards, callCardExport } from "../api/layerFiles";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  activeLayer: LayerId;
  layerColor: string;
  onFilesChanged?: () => void;
  onAgentBusy?: (busy: boolean) => void;
}

const AGENT_NAMES: Record<LayerId, string> = {
  mission: "Mission Strategist",
  experience: "Experience Designer",
  architecture: "System Architect",
  implementation: "Implementation Engineer",
};

const AGENT_ICONS: Record<LayerId, string> = {
  mission: "\u25c6",
  experience: "\u25c7",
  architecture: "\u2b21",
  implementation: "\u2b22",
};

export default function ChatSidebar({ activeLayer, layerColor, onFilesChanged, onAgentBusy }: Props) {
  const [chatCard, setChatCard] = useState<RenderedCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadChat = useCallback(async () => {
    try {
      const cards = await fetchCards(activeLayer);
      const chat = cards.find((c) => c.filename === "_chat.md");
      setChatCard(chat || null);
    } catch {
      setChatCard(null);
    } finally {
      setLoading(false);
    }
  }, [activeLayer]);

  useEffect(() => {
    setLoading(true);
    loadChat();
  }, [loadChat]);

  const handleCallExport = useCallback(
    async (layer: LayerId, filename: string, fn: string, args?: Record<string, unknown>) => {
      onAgentBusy?.(true);
      try {
        const result = await callCardExport(layer, filename, fn, args || {});
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
    onAgentBusy?.(true);

    try {
      await callCardExport(activeLayer, "_chat.md", "send_message", { message: text });
      loadChat();
      onFilesChanged?.();
    } catch (err) {
      console.error("Chat send failed:", err);
    } finally {
      setSending(false);
      onAgentBusy?.(false);
      inputRef.current?.focus();
    }
  }, [inputValue, sending, activeLayer, loadChat, onFilesChanged, onAgentBusy]);

  return (
    <div
      className="chat-sidebar"
      style={{ "--panel-color": layerColor } as React.CSSProperties}
    >
      <div className="chat-sidebar-header">
        <span className="chat-sidebar-icon" style={{ color: layerColor }}>
          {AGENT_ICONS[activeLayer]}
        </span>
        <div className="chat-sidebar-info">
          <div className="chat-sidebar-name">{AGENT_NAMES[activeLayer]}</div>
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
            layer={activeLayer}
            filename="_chat.md"
            callExport={handleCallExport}
          />
        )}
      </div>

      {/* Input rendered in React — always visible at bottom */}
      <div className="chat-sidebar-input">
        <input
          ref={inputRef}
          type="text"
          placeholder={`Ask ${AGENT_NAMES[activeLayer]}...`}
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
