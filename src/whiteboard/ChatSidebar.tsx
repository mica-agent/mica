// ChatSidebar — owns the chat sidebar shell (header, input, pending states).
// Uses a persistent channel to the ChatChannelManager for agent communication.
// No V8 isolate involvement — agent calls happen directly in Node.

import { useState, useEffect, useCallback, useRef } from "react";
import type { CanvasId, CanvasFile } from "../api/canvasFiles";
import { fetchFiles } from "../api/canvasFiles";
import { openChannel, on, type Channel } from "../api/micaSocket";

interface Props {
  projectId: string;
  activeCanvas: CanvasId;
  canvasColor: string;
  onFilesChanged?: () => void;
  onAgentBusy?: (busy: boolean) => void;
}

interface ChatMessage {
  role: string;
  content: string;
  agent?: string;
  filesChanged?: boolean;
  reactive?: boolean;
  trigger?: string;
}

interface ProgressEntry {
  id: number;
  text: string;
  ts: number;
}

function agentName(canvas: string): string {
  if (canvas === "_root") return "Project Agent";
  const label = canvas.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return `${label} Agent`;
}

function agentIcon(canvas: string): string {
  if (canvas === "_root") return "\u25c6";
  return "\u25cb";
}

function toolLabel(tool: string): string {
  const labels: Record<string, string> = {
    Bash: "Running command",
    Read: "Reading file",
    Write: "Writing file",
    Edit: "Editing file",
    Glob: "Searching files",
    Grep: "Searching code",
    "mica-tools": "Using whiteboard tools",
  };
  if (tool.startsWith("mica-tools")) return "Using whiteboard tools";
  return labels[tool] || `Using ${tool}`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

type TurnState = "your-turn" | "agent-working" | "agent-done" | "agent-done-files";

export default function ChatSidebar({ projectId, activeCanvas, canvasColor, onFilesChanged, onAgentBusy }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [turn, setTurn] = useState<TurnState>("your-turn");
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<ProgressEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [contextFiles, setContextFiles] = useState<CanvasFile[]>([]);
  const [showContext, setShowContext] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const channelRef = useRef<Channel | null>(null);
  const progressIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Elapsed time counter while agent is working
  useEffect(() => {
    if (turn !== "agent-working") {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [turn]);

  // Scroll chat to bottom when messages change
  useEffect(() => {
    requestAnimationFrame(() => {
      if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    });
  }, [messages]);

  // Fetch context files for the tooltip
  useEffect(() => {
    fetchFiles(projectId, activeCanvas)
      .then((files) => setContextFiles(files))
      .catch(() => setContextFiles([]));
  }, [projectId, activeCanvas]);

  // Refresh context files when agent finishes
  useEffect(() => {
    if (turn === "agent-done" || turn === "agent-done-files") {
      fetchFiles(projectId, activeCanvas)
        .then((files) => setContextFiles(files))
        .catch(() => {});
    }
  }, [turn, projectId, activeCanvas]);

  // Scroll progress log
  useEffect(() => {
    if (logExpanded) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLog, logExpanded]);

  // Listen for reactive agent events
  useEffect(() => {
    const unsubReactive = on("reactive-started", (msg) => {
      const m = msg as { project?: string; canvas?: string; filename?: string };
      if (m.project !== projectId || m.canvas !== activeCanvas) return;
      setTurn("agent-working");
      setCurrentTool(`Analyzing changes to ${m.filename || "file"}...`);
      setProgressLog([]);
      onAgentBusy?.(true);
    });
    return unsubReactive;
  }, [projectId, activeCanvas, onAgentBusy]);

  // Open channel to ChatChannelManager
  useEffect(() => {
    const ch = openChannel(projectId, activeCanvas, "_chat.chat", "chat_session", {});
    channelRef.current = ch;

    ch.onData((data) => {
      const msg = data as Record<string, unknown>;

      switch (msg.type) {
        case "history":
          setMessages(msg.messages as ChatMessage[]);
          setLoading(false);
          break;

        case "user":
          setMessages((prev) => [...prev, { role: "user", content: msg.content as string }]);
          break;

        case "thinking":
          setTurn("agent-working");
          setCurrentTool("Thinking...");
          setProgressLog([]);
          setLogExpanded(false);
          onAgentBusy?.(true);
          break;

        case "progress": {
          const tool = msg.tool as string;
          const description = msg.description as string;
          if (tool) {
            const summary = toolLabel(tool);
            setCurrentTool(summary);
            setProgressLog((prev) => [
              ...prev,
              { id: ++progressIdRef.current, text: description || summary, ts: Date.now() },
            ]);
          }
          break;
        }

        case "assistant": {
          const content = msg.content as string;
          const agent = msg.agent as string || "AI Agent";
          const filesChanged = msg.filesChanged as boolean || false;
          setMessages((prev) => [...prev, { role: "assistant", content, agent, filesChanged }]);
          setSending(false);
          setTurn(filesChanged ? "agent-done-files" : "agent-done");
          setCurrentTool(null);
          onAgentBusy?.(false);
          if (filesChanged) onFilesChanged?.();
          setTimeout(() => inputRef.current?.focus(), 100);
          break;
        }

        case "error":
          setError(msg.error as string);
          setSending(false);
          setTurn("your-turn");
          setCurrentTool(null);
          onAgentBusy?.(false);
          break;
      }
    });

    ch.onClose(() => {
      channelRef.current = null;
    });

    return () => {
      ch.close();
      channelRef.current = null;
    };
  }, [projectId, activeCanvas, onFilesChanged, onAgentBusy]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text || sending || !channelRef.current) return;

    setInputValue("");
    setSending(true);
    setError(null);
    setTurn("agent-working");
    setProgressLog([]);
    setLogExpanded(false);
    setCurrentTool(null);
    onAgentBusy?.(true);

    channelRef.current.send({ message: text });
  }, [inputValue, sending, onAgentBusy]);

  const isAgentTurn = turn === "agent-working";
  const isYourTurn = turn === "your-turn" || turn === "agent-done" || turn === "agent-done-files";
  const stepCount = progressLog.length;

  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    if (turn === "agent-done" || turn === "agent-done-files") {
      setTurn("your-turn");
      setProgressLog([]);
      setLogExpanded(false);
    }
  }, [turn]);

  // Render messages as HTML
  const messagesHtml = messages.map((msg, i) => {
    if (msg.role === "user") {
      return `<div class="chat-msg chat-msg--user" key="${i}"><div class="chat-msg-body">${escapeHtml(msg.content)}</div></div>`;
    }
    // Simple markdown-like rendering for assistant messages
    const body = msg.content
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br>");
    const agent = escapeHtml(msg.agent || "");
    const badge = msg.filesChanged ? '<span class="chat-action-badge">whiteboard updated</span>' : '';
    const reactiveClass = msg.reactive ? ' chat-msg--reactive' : '';
    let triggerBadge = '';
    if (msg.reactive && msg.trigger) {
      triggerBadge = `<span class="chat-action-badge chat-action-badge--reactive">noticed change in ${escapeHtml(msg.trigger)}</span>`;
    }
    return `<div class="chat-msg chat-msg--assistant${reactiveClass}"><div class="chat-msg-header">${agent}${triggerBadge}${badge}</div><div class="chat-msg-body">${body}</div></div>`;
  }).join("");

  return (
    <div
      className="chat-sidebar"
      style={{ "--panel-color": canvasColor } as React.CSSProperties}
    >
      <div
        className="chat-sidebar-header"
        onMouseEnter={() => setShowContext(true)}
        onMouseLeave={() => setShowContext(false)}
      >
        <span className="chat-sidebar-icon" style={{ color: canvasColor }}>
          {agentIcon(activeCanvas)}
        </span>
        <div className="chat-sidebar-info">
          <div className="chat-sidebar-name">{agentName(activeCanvas)}</div>
          <div className="chat-sidebar-role">
            {contextFiles.length} file{contextFiles.length !== 1 ? "s" : ""} in context
          </div>
        </div>
        {showContext && contextFiles.length > 0 && (
          <div className="chat-context-tooltip">
            <div className="chat-context-tooltip-title">Files in agent context</div>
            {contextFiles.map((f) => (
              <div key={f.name} className="chat-context-tooltip-file">
                <span className="chat-context-tooltip-icon">
                  {f.name.endsWith(".md") ? "\u2630" : f.name.endsWith(".json") ? "{ }" : "\u2022"}
                </span>
                {f.name}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="chat-sidebar-body" ref={bodyRef}>
        {loading && (
          <div className="chat-sidebar-loading">Loading chat...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="chat-sidebar-empty">Send a message to start collaborating.</div>
        )}
        {!loading && messages.length > 0 && (
          <div className="chat-messages" dangerouslySetInnerHTML={{ __html: messagesHtml }} />
        )}

        {error && (
          <div className="chat-pending">
            <div className="chat-pending-error">
              <span>{error}</span>
              <div className="chat-pending-error-actions">
                <button onClick={() => setError(null)}>Dismiss</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Turn indicator */}
      <div className={`chat-turn chat-turn--${turn}`}>
        {turn === "agent-working" && (
          <button
            className="chat-turn-bar"
            onClick={() => stepCount > 0 && setLogExpanded(!logExpanded)}
            disabled={stepCount === 0}
          >
            <span className="chat-turn-dot chat-turn-dot--working" />
            <span className="chat-turn-label">
              {currentTool || "Agent is working..."}
            </span>
            <span className="chat-turn-meta">
              {elapsed > 0 && <span className="chat-turn-elapsed">{elapsed}s</span>}
              {stepCount > 0 && (
                <>
                  {stepCount} {stepCount === 1 ? "step" : "steps"}
                  <span className="chat-turn-chevron">{logExpanded ? "\u25b4" : "\u25be"}</span>
                </>
              )}
            </span>
          </button>
        )}
        {turn === "agent-done" && (
          <div className="chat-turn-bar">
            <span className="chat-turn-dot chat-turn-dot--done" />
            <span className="chat-turn-label">Done — your turn</span>
          </div>
        )}
        {turn === "agent-done-files" && (
          <div className="chat-turn-bar">
            <span className="chat-turn-dot chat-turn-dot--done" />
            <span className="chat-turn-label">Whiteboard updated — your turn</span>
          </div>
        )}
        {turn === "your-turn" && (
          <div className="chat-turn-bar">
            <span className="chat-turn-dot chat-turn-dot--you" />
            <span className="chat-turn-label">Your turn</span>
          </div>
        )}

        {logExpanded && progressLog.length > 0 && (
          <div className="chat-progress-log">
            {progressLog.map((entry) => (
              <div key={entry.id} className="chat-progress-entry">
                <span className="chat-progress-entry-dot" />
                {entry.text}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        )}
      </div>

      {/* Input */}
      <div className={`chat-sidebar-input ${isYourTurn ? "chat-sidebar-input--active" : ""}`}>
        <input
          ref={inputRef}
          type="text"
          placeholder={isAgentTurn ? `${agentName(activeCanvas)} is working...` : "Give direction or ask a question..."}
          value={inputValue}
          disabled={sending}
          onChange={handleInput}
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
