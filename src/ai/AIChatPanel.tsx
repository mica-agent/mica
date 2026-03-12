import { useState, useRef, useEffect } from "react";
import { chat, teamDiscussRequest } from "./client";
import type { LayerId, AgentResponse, ArtifactSuggestion } from "./client";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  layer: LayerId;
  agentName?: string;
  artifacts?: ArtifactSuggestion[];
  isEscalation?: boolean;
}

interface Props {
  activeLayer: LayerId;
  layerColor: string;
}

const AGENT_NAMES: Record<LayerId, string> = {
  mission: "Mission Strategist",
  experience: "Experience Designer",
  architecture: "System Architect",
  implementation: "Implementation Engineer",
};

const AGENT_ICONS: Record<LayerId, string> = {
  mission: "◆",
  experience: "◇",
  architecture: "⬡",
  implementation: "⬢",
};

const LAYER_COLORS: Record<LayerId, string> = {
  mission: "#4a8aff",
  experience: "#ff8a6a",
  architecture: "#4acaa0",
  implementation: "#9a7aff",
};

export default function AIChatPanel({ activeLayer, layerColor }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"layer" | "team">("layer");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function addMessage(msg: Omit<ChatMessage, "id">) {
    setMessages((prev) => [
      ...prev,
      { ...msg, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` },
    ]);
  }

  function handleResponse(response: AgentResponse, isEscalation = false) {
    addMessage({
      role: "assistant",
      content: response.message,
      layer: response.layer,
      agentName: AGENT_NAMES[response.layer],
      artifacts: response.artifacts,
      isEscalation,
    });
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMsg = input.trim();
    setInput("");
    setLoading(true);

    addMessage({
      role: "user",
      content: userMsg,
      layer: activeLayer,
    });

    try {
      if (mode === "team") {
        const responses = await teamDiscussRequest(userMsg);
        for (const layer of ["mission", "experience", "architecture", "implementation"] as LayerId[]) {
          handleResponse(responses[layer]);
        }
      } else {
        const result = await chat(activeLayer, userMsg);
        handleResponse(result.response);
        if (result.escalationResponse) {
          handleResponse(result.escalationResponse, true);
        }
      }
    } catch (err) {
      addMessage({
        role: "assistant",
        content: `Error: ${(err as Error).message}`,
        layer: activeLayer,
        agentName: "System",
      });
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  const layerMessages = mode === "layer"
    ? messages.filter((m) => m.role === "user" || m.layer === activeLayer || m.isEscalation)
    : messages;

  return (
    <div className="ai-chat-panel" style={{ "--panel-color": layerColor } as React.CSSProperties}>
      {/* Panel header */}
      <div className="ai-chat-header">
        <div className="ai-chat-agent-info">
          <span className="ai-chat-agent-icon" style={{ color: layerColor }}>
            {AGENT_ICONS[activeLayer]}
          </span>
          <div>
            <div className="ai-chat-agent-name">{AGENT_NAMES[activeLayer]}</div>
            <div className="ai-chat-agent-role">AI Team Member</div>
          </div>
        </div>
        <div className="ai-chat-controls">
          <button
            className={`ai-chat-mode ${mode === "layer" ? "ai-chat-mode--active" : ""}`}
            onClick={() => setMode("layer")}
            title="Chat with this layer's agent"
          >
            Solo
          </button>
          <button
            className={`ai-chat-mode ${mode === "team" ? "ai-chat-mode--active" : ""}`}
            onClick={() => setMode("team")}
            title="All 4 agents discuss together"
          >
            Team
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="ai-chat-messages">
        {layerMessages.length === 0 && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">{AGENT_ICONS[activeLayer]}</div>
            <p>
              {mode === "team"
                ? "Ask a question and all 4 agents will respond from their perspective."
                : `Chat with the ${AGENT_NAMES[activeLayer]} about the ${activeLayer} layer.`}
            </p>
            <div className="ai-chat-suggestions">
              {activeLayer === "mission" && (
                <>
                  <button onClick={() => setInput("What gaps do you see in our product brief?")}>
                    Review product brief
                  </button>
                  <button onClick={() => setInput("Help me sharpen the success criteria.")}>
                    Sharpen success criteria
                  </button>
                </>
              )}
              {activeLayer === "experience" && (
                <>
                  <button onClick={() => setInput("What's missing from our core user flow?")}>
                    Review user flow
                  </button>
                  <button onClick={() => setInput("Design the error states for query results.")}>
                    Design error states
                  </button>
                </>
              )}
              {activeLayer === "architecture" && (
                <>
                  <button onClick={() => setInput("What are the biggest technical risks?")}>
                    Identify risks
                  </button>
                  <button onClick={() => setInput("Review the data model for completeness.")}>
                    Review data model
                  </button>
                </>
              )}
              {activeLayer === "implementation" && (
                <>
                  <button onClick={() => setInput("What should we tackle in the next sprint?")}>
                    Plan next sprint
                  </button>
                  <button onClick={() => setInput("How can we get extraction accuracy from 82% to 90%?")}>
                    Fix accuracy gap
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {layerMessages.map((msg) => (
          <div
            key={msg.id}
            className={`ai-chat-msg ai-chat-msg--${msg.role} ${msg.isEscalation ? "ai-chat-msg--escalation" : ""}`}
          >
            {msg.role === "assistant" && (
              <div className="ai-chat-msg-header">
                <span className="ai-chat-msg-icon">
                  {msg.agentName === "System" ? "⚙" : AGENT_ICONS[msg.layer]}
                </span>
                <span className="ai-chat-msg-name" style={{ color: LAYER_COLORS[msg.layer] }}>
                  {msg.agentName}
                </span>
                {msg.isEscalation && (
                  <span className="ai-chat-escalation-badge">↗ Escalation</span>
                )}
              </div>
            )}

            <div className="ai-chat-msg-body">{msg.content}</div>

            {msg.artifacts && msg.artifacts.length > 0 && (
              <div className="ai-chat-artifacts">
                <div className="ai-chat-artifacts-label">Proposed Artifacts:</div>
                {msg.artifacts.map((a, i) => (
                  <div key={i} className="ai-chat-artifact-card">
                    <span className="ai-chat-artifact-type">{a.type}</span>
                    <strong>{a.title}</strong>
                    <p>{a.summary}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {loading && (
          <div className="ai-chat-msg ai-chat-msg--assistant ai-chat-msg--loading">
            <div className="ai-chat-msg-header">
              <span className="ai-chat-msg-icon">{mode === "team" ? "⬡" : AGENT_ICONS[activeLayer]}</span>
              <span className="ai-chat-msg-name" style={{ color: layerColor }}>
                {mode === "team" ? "AI Team" : AGENT_NAMES[activeLayer]}
              </span>
            </div>
            <div className="ai-chat-typing">
              <span /><span /><span />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="ai-chat-input-area">
        <input
          ref={inputRef}
          type="text"
          placeholder={
            mode === "team"
              ? "Ask the full team..."
              : `Ask the ${AGENT_NAMES[activeLayer]}...`
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}
