import { useState, useRef, useEffect } from "react";
import { chat, teamDiscussRequest } from "./client";
import type { LayerId, AgentResponse } from "./client";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  layer: LayerId;
  agentName?: string;
  isEscalation?: boolean;
}

interface Props {
  activeLayer: LayerId;
  layerColor: string;
  onFilesChanged?: () => void;
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

// ── Voice helpers ────────────────────────────────────────
const SpeechRecognition =
  (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

function speak(text: string) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = 1.05;
  utterance.pitch = 1;
  synth.speak(utterance);
}

export default function AIChatPanel({ activeLayer, layerColor, onFilesChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [mode, setMode] = useState<"layer" | "team">("layer");
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const checkedInLayers = useRef<Set<string>>(new Set());
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto check-in: when entering a layer for the first time, agent speaks first
  useEffect(() => {
    if (checkedInLayers.current.has(activeLayer)) return;

    let cancelled = false;
    setCheckingIn(true);
    setLoading(true);

    (async () => {
      try {
        const result = await chat(
          activeLayer,
          "Briefly assess the whiteboard against _goal.md and _todo.md. What's solid, what's the top priority to work on next? 2-3 sentences max."
        );
        if (!cancelled) {
          checkedInLayers.current.add(activeLayer);
          handleResponse(result.response);
        }
      } catch (err) {
        if (!cancelled) {
          checkedInLayers.current.add(activeLayer);
          addMessage({
            role: "assistant",
            content: `Couldn't connect to the ${AGENT_NAMES[activeLayer]}. Send a message to try again.`,
            layer: activeLayer,
            agentName: "System",
          });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setCheckingIn(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      setLoading(false);
      setCheckingIn(false);
    };
  }, [activeLayer]); // eslint-disable-line react-hooks/exhaustive-deps

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
      isEscalation,
    });
    if (voiceOut && response.message) {
      speak(response.message);
    }
    if (response.filesChanged) {
      onFilesChanged?.();
    }
  }

  // ── Voice input (speech-to-text) ─────────────────────
  function toggleListening() {
    if (!SpeechRecognition) return;

    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    let finalTranscript = input; // append to existing input

    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscript += (finalTranscript ? " " : "") + transcript;
        } else {
          interim = transcript;
        }
      }
      setInput(finalTranscript + (interim ? " " + interim : ""));
    };

    recognition.onerror = () => setListening(false);
    recognition.onend = () => setListening(false);

    recognition.start();
    recognitionRef.current = recognition;
    setListening(true);
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
        {layerMessages.length === 0 && !loading && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">{AGENT_ICONS[activeLayer]}</div>
            <p>
              {mode === "team"
                ? "Ask a question and all 4 agents will respond from their perspective."
                : `Ask the ${AGENT_NAMES[activeLayer]} anything, or wait for the initial review.`}
            </p>
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
            {checkingIn ? (
              <div className="ai-chat-msg-body" style={{ opacity: 0.5, fontSize: "0.78rem" }}>
                Reviewing the whiteboard...
              </div>
            ) : (
              <div className="ai-chat-typing">
                <span /><span /><span />
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="ai-chat-input-area">
        {SpeechRecognition && (
          <button
            className={`ai-chat-voice-btn ${listening ? "ai-chat-voice-btn--active" : ""}`}
            onClick={toggleListening}
            title={listening ? "Stop listening" : "Voice input"}
            disabled={loading}
          >
            {listening ? "●" : "🎤"}
          </button>
        )}
        <input
          ref={inputRef}
          type="text"
          placeholder={
            listening
              ? "Listening..."
              : mode === "team"
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
        <button
          className={`ai-chat-voice-btn ${voiceOut ? "ai-chat-voice-btn--active" : ""}`}
          onClick={() => { setVoiceOut(!voiceOut); if (voiceOut) window.speechSynthesis.cancel(); }}
          title={voiceOut ? "Mute voice output" : "Enable voice output"}
        >
          {voiceOut ? "🔊" : "🔇"}
        </button>
      </div>
    </div>
  );
}
