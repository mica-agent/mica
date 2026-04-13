// ChatCard — AI chat card that uses mica.chat.* API.
// This is what the AI would generate, but we ship a default version.

import { useState, useEffect, useRef, useCallback } from "react";
import mica from "../api/mica";

interface Props {
  chatId: string;
  onClose: () => void;
}

interface Message {
  role: string;
  content: string;
}

export default function ChatCard({ chatId, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Load history on mount
  useEffect(() => {
    mica.chat.history(chatId).then(({ history }) => {
      setMessages(history);
    }).catch(() => {});
  }, [chatId]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput("");
    setError("");
    setLoading(true);

    // Optimistic: show user message immediately
    setMessages((prev) => [...prev, { role: "user", content: msg }]);

    try {
      const { reply } = await mica.chat.send(chatId, msg);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }, [input, loading, chatId]);

  const handleClear = useCallback(async () => {
    await mica.chat.clear(chatId);
    setMessages([]);
  }, [chatId]);

  return (
    <div style={{
      display: "flex", flexDirection: "column", flex: 1, minHeight: 0,
      background: "#1a1a2e", overflow: "hidden",
    }}>
      {/* Messages */}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
        {messages.length === 0 && !loading && (
          <div style={{ color: "#555", fontSize: 13, textAlign: "center", marginTop: 40 }}>
            Ask the AI about your project. It can see all your files.
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              marginBottom: 12,
              padding: "8px 12px",
              borderRadius: 8,
              background: msg.role === "user" ? "#2a2a5a" : "#252540",
              color: msg.role === "user" ? "#ccc" : "#bbb",
              fontSize: 14,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            <div style={{ fontSize: 10, color: "#666", marginBottom: 4 }}>
              {msg.role === "user" ? "You" : "AI"}
            </div>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div style={{ color: "#666", fontSize: 13, padding: "8px 12px" }}>
            Thinking...
          </div>
        )}
        {error && (
          <div style={{ color: "#f66", fontSize: 13, padding: "8px 12px" }}>
            Error: {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: 8, borderTop: "1px solid #333",
        display: "flex", gap: 8, flexShrink: 0,
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask about your project..."
          rows={2}
          style={{
            flex: 1, background: "#252540", color: "#ccc", border: "1px solid #444",
            borderRadius: 6, padding: "8px 10px", fontSize: 14, fontFamily: "inherit",
            resize: "none", outline: "none",
          }}
        />
        <button
          onClick={handleClear}
          style={{
            background: "#333", color: "#888", border: "none", borderRadius: 6,
            padding: "8px 10px", cursor: "pointer", fontSize: 12, alignSelf: "flex-end",
          }}
          title="Clear chat"
        >
          &#8634;
        </button>
        <button
          onClick={handleSend}
          disabled={!input.trim() || loading}
          style={{
            background: "#4a4a8a", color: "#ccc", border: "none", borderRadius: 6,
            padding: "8px 16px", cursor: "pointer", fontSize: 14, alignSelf: "flex-end",
            opacity: (!input.trim() || loading) ? 0.5 : 1,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}

