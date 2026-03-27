import { useState, useRef, useEffect } from "react";
import { chat, teamDiscussRequest } from "./client";
import type { CanvasId, AgentResponse } from "./client";
import { getCanvasColor } from "../data";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  canvas: CanvasId;
  agentName?: string;
  isEscalation?: boolean;
}

interface Props {
  projectId: string;
  activeCanvas: CanvasId;
  canvases: string[];
  canvasColor: string;
  onFilesChanged?: () => void;
}

function agentName(canvas: string): string {
  const known: Record<string, string> = {
    mission: "Mission Strategist",
    experience: "Experience Designer",
    architecture: "System Architect",
    implementation: "Implementation Engineer",
  };
  if (known[canvas]) return known[canvas];
  const label = canvas.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${label} Agent`;
}

function agentIcon(canvas: string): string {
  const known: Record<string, string> = {
    mission: "\u25c6",
    experience: "\u25c7",
    architecture: "\u2b21",
    implementation: "\u2b22",
  };
  return known[canvas] || "\u25cb";
}

function canvasColorForId(canvas: string, canvases: string[]): string {
  const idx = canvases.indexOf(canvas);
  if (idx < 0) return "#999";
  return getCanvasColor(idx).color;
}

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

export default function AIChatPanel({ projectId, activeCanvas, canvases, canvasColor, onFilesChanged }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [checkingIn, setCheckingIn] = useState(false);
  const [mode, setMode] = useState<"canvas" | "team">("canvas");
  const [listening, setListening] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const checkedInCanvases = useRef<Set<string>>(new Set());
  const recognitionRef = useRef<any>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Auto check-in: when entering a canvas for the first time, agent speaks first
  useEffect(() => {
    const key = `${projectId}/${activeCanvas}`;
    if (checkedInCanvases.current.has(key)) return;

    let cancelled = false;
    setCheckingIn(true);
    setLoading(true);

    (async () => {
      try {
        const result = await chat(
          projectId,
          activeCanvas,
          "Briefly assess the whiteboard against _goal.md and _todo.md. What's solid, what's the top priority to work on next? 2-3 sentences max."
        );
        if (!cancelled) {
          checkedInCanvases.current.add(key);
          handleResponse(result.response);
        }
      } catch (err) {
        if (!cancelled) {
          checkedInCanvases.current.add(key);
          addMessage({
            role: "assistant",
            content: `Couldn't connect to the ${agentName(activeCanvas)}. Send a message to try again.`,
            canvas: activeCanvas,
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
  }, [projectId, activeCanvas]); // eslint-disable-line react-hooks/exhaustive-deps

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
      canvas: response.canvas,
      agentName: agentName(response.canvas),
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
      canvas: activeCanvas,
    });

    try {
      if (mode === "team") {
        const responses = await teamDiscussRequest(projectId, userMsg);
        for (const canvas of canvases) {
          if (responses[canvas]) {
            handleResponse(responses[canvas]);
          }
        }
      } else {
        const result = await chat(projectId, activeCanvas, userMsg);
        handleResponse(result.response);
        if (result.escalationResponse) {
          handleResponse(result.escalationResponse, true);
        }
      }
    } catch (err) {
      addMessage({
        role: "assistant",
        content: `Error: ${(err as Error).message}`,
        canvas: activeCanvas,
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

  const canvasMessages = mode === "canvas"
    ? messages.filter((m) => m.role === "user" || m.canvas === activeCanvas || m.isEscalation)
    : messages;

  return (
    <div className="ai-chat-panel" style={{ "--panel-color": canvasColor } as React.CSSProperties}>
      {/* Panel header */}
      <div className="ai-chat-header">
        <div className="ai-chat-agent-info">
          <span className="ai-chat-agent-icon" style={{ color: canvasColor }}>
            {agentIcon(activeCanvas)}
          </span>
          <div>
            <div className="ai-chat-agent-name">{agentName(activeCanvas)}</div>
            <div className="ai-chat-agent-role">AI Team Member</div>
          </div>
        </div>
        <div className="ai-chat-controls">
          <button
            className={`ai-chat-mode ${mode === "canvas" ? "ai-chat-mode--active" : ""}`}
            onClick={() => setMode("canvas")}
            title="Chat with this canvas's agent"
          >
            Solo
          </button>
          <button
            className={`ai-chat-mode ${mode === "team" ? "ai-chat-mode--active" : ""}`}
            onClick={() => setMode("team")}
            title="All agents discuss together"
          >
            Team
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="ai-chat-messages">
        {canvasMessages.length === 0 && !loading && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-icon">{agentIcon(activeCanvas)}</div>
            <p>
              {mode === "team"
                ? "Ask a question and all agents will respond from their perspective."
                : `Ask the ${agentName(activeCanvas)} anything, or wait for the initial review.`}
            </p>
          </div>
        )}

        {canvasMessages.map((msg) => (
          <div
            key={msg.id}
            className={`ai-chat-msg ai-chat-msg--${msg.role} ${msg.isEscalation ? "ai-chat-msg--escalation" : ""}`}
          >
            {msg.role === "assistant" && (
              <div className="ai-chat-msg-header">
                <span className="ai-chat-msg-icon">
                  {msg.agentName === "System" ? "\u2699" : agentIcon(msg.canvas)}
                </span>
                <span className="ai-chat-msg-name" style={{ color: canvasColorForId(msg.canvas, canvases) }}>
                  {msg.agentName}
                </span>
                {msg.isEscalation && (
                  <span className="ai-chat-escalation-badge">&nearr; Escalation</span>
                )}
              </div>
            )}

            <div className="ai-chat-msg-body">{msg.content}</div>
          </div>
        ))}

        {loading && (
          <div className="ai-chat-msg ai-chat-msg--assistant ai-chat-msg--loading">
            <div className="ai-chat-msg-header">
              <span className="ai-chat-msg-icon">{mode === "team" ? "\u2b21" : agentIcon(activeCanvas)}</span>
              <span className="ai-chat-msg-name" style={{ color: canvasColor }}>
                {mode === "team" ? "AI Team" : agentName(activeCanvas)}
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
            {listening ? "\u25cf" : "\ud83c\udfa4"}
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
                : `Ask the ${agentName(activeCanvas)}...`
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          &uarr;
        </button>
        <button
          className={`ai-chat-voice-btn ${voiceOut ? "ai-chat-voice-btn--active" : ""}`}
          onClick={() => { setVoiceOut(!voiceOut); if (voiceOut) window.speechSynthesis.cancel(); }}
          title={voiceOut ? "Mute voice output" : "Enable voice output"}
        >
          {voiceOut ? "\ud83d\udd0a" : "\ud83d\udd07"}
        </button>
      </div>
    </div>
  );
}
