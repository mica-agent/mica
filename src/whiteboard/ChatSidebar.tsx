// ChatSidebar — owns the chat sidebar shell (header, input, pending states).
// The _chat.md widget (render.py) is a pure message renderer hosted via WidgetRuntime.
// Optimistic messages show the user's text immediately while the agent processes.
// Real-time progress events stream from the server via WebSocket.

import { useState, useEffect, useCallback, useRef } from "react";
import type { CanvasId, RenderedCard, CanvasFile } from "../api/canvasFiles";
import { fetchCards, fetchFiles } from "../api/canvasFiles";
import { call as micaCall, on } from "../api/micaSocket";
import WidgetRuntime from "./WidgetRuntime";

interface Props {
  projectId: string;
  activeCanvas: CanvasId;
  canvasColor: string;
  onFilesChanged?: () => void;
  onAgentBusy?: (busy: boolean) => void;
}

interface PendingMessage {
  text: string;
  status: "sending" | "error";
  error?: string;
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

// Human-friendly tool names
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
  // MCP tool names come as "server:tool_name"
  if (tool.startsWith("mica-tools")) return "Using whiteboard tools";
  return labels[tool] || `Using ${tool}`;
}

type TurnState = "your-turn" | "agent-working" | "agent-done" | "agent-done-files";

export default function ChatSidebar({ projectId, activeCanvas, canvasColor, onFilesChanged, onAgentBusy }: Props) {
  const [chatCard, setChatCard] = useState<RenderedCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputValue, setInputValue] = useState("");
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<PendingMessage | null>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [turn, setTurn] = useState<TurnState>("your-turn");
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<ProgressEntry[]>([]);
  const [logExpanded, setLogExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [contextFiles, setContextFiles] = useState<CanvasFile[]>([]);
  const [showContext, setShowContext] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const checkedInCanvases = useRef<Set<string>>(new Set());
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
    if (!chatCard) return;
    // Wait for WidgetRuntime to inject HTML and browser to lay out
    requestAnimationFrame(() => {
      const runtime = bodyRef.current?.querySelector(".widget-runtime");
      if (runtime) runtime.scrollTop = runtime.scrollHeight;
    });
  }, [chatCard]);

  // Fetch context files for the tooltip
  useEffect(() => {
    fetchFiles(projectId, activeCanvas)
      .then((files) => setContextFiles(files))
      .catch(() => setContextFiles([]));
  }, [projectId, activeCanvas]);

  // Refresh context files when agent finishes (it may have created files)
  useEffect(() => {
    if (turn === "agent-done" || turn === "agent-done-files") {
      fetchFiles(projectId, activeCanvas)
        .then((files) => setContextFiles(files))
        .catch(() => {});
    }
  }, [turn, projectId, activeCanvas]);

  // Scroll progress log when new entries arrive
  useEffect(() => {
    if (logExpanded) logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [progressLog, logExpanded]);

  // Listen for agent progress events from the server
  useEffect(() => {
    const unsub = on("agent-progress", (msg) => {
      const m = msg as { project?: string; canvas?: string; event?: string; tool?: string; description?: string };
      if (m.project !== projectId || m.canvas !== activeCanvas) return;

      if (m.event === "thinking") {
        setCurrentTool("Thinking...");
      } else if (m.event === "tool_start" && m.tool) {
        const summary = toolLabel(m.tool);
        const detail = m.description || summary;
        setCurrentTool(summary);
        setProgressLog((prev) => [
          ...prev,
          { id: ++progressIdRef.current, text: detail, ts: Date.now() },
        ]);
      }
    });
    return unsub;
  }, [projectId, activeCanvas]);

  const loadChat = useCallback(async () => {
    try {
      const cards = await fetchCards(projectId, activeCanvas);
      const chat = cards.find((c) => c.filename === "_chat.md");
      setChatCard(chat || null);
    } catch {
      setChatCard(null);
    } finally {
      setLoading(false);
    }
  }, [projectId, activeCanvas]);

  useEffect(() => {
    setLoading(true);
    loadChat();
  }, [loadChat]);

  // Listen for file changes to refresh chat card
  useEffect(() => {
    const unsub = on("file-changed", (msg) => {
      const m = msg as { project?: string; canvas?: string; filename?: string };
      if (m.project === projectId && m.canvas === activeCanvas && m.filename === "_chat.md") {
        loadChat();
      }
    });
    return unsub;
  }, [projectId, activeCanvas, loadChat]);

  const showDoneStatus = useCallback((filesChanged: boolean) => {
    setTurn(filesChanged ? "agent-done-files" : "agent-done");
    setCurrentTool(null);
    // Auto-focus the input so the user knows it's their turn
    setTimeout(() => inputRef.current?.focus(), 100);
  }, []);

  // Auto check-in: when entering a canvas for the first time with no messages
  useEffect(() => {
    if (!chatCard || loading) return;
    const key = `${projectId}/${activeCanvas}`;
    if (checkedInCanvases.current.has(key)) return;

    // Check if the widget rendered any messages (data attribute from render.py)
    const parser = new DOMParser();
    const doc = parser.parseFromString(chatCard.html, "text/html");
    const msgs = doc.querySelector(".chat-messages");
    if (msgs?.getAttribute("data-has-messages") === "true") {
      checkedInCanvases.current.add(key);
      return;
    }

    let cancelled = false;
    checkedInCanvases.current.add(key);
    setCheckingIn(true);
    setTurn("agent-working");
    setProgressLog([]);
    onAgentBusy?.(true);

    (async () => {
      try {
        await micaCall(projectId, activeCanvas, "_chat.md", "check_in", {});
        if (!cancelled) {
          loadChat();
          showDoneStatus(false);
          onFilesChanged?.();
        }
      } catch {
        if (!cancelled) setTurn("your-turn");
      } finally {
        if (!cancelled) {
          setCheckingIn(false);
          onAgentBusy?.(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [chatCard, loading, projectId, activeCanvas, loadChat, onFilesChanged, onAgentBusy, showDoneStatus]);

  // Scroll pending messages into view
  useEffect(() => {
    if (pending) pendingRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [pending]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || sending) return;

    setInputValue("");
    setSending(true);
    setPending({ text, status: "sending" });
    setTurn("agent-working");
    setProgressLog([]);
    setLogExpanded(false);
    setCurrentTool(null);
    onAgentBusy?.(true);

    try {
      const result = await micaCall(projectId, activeCanvas, "_chat.md", "send_message", { message: text }) as { filesChanged?: boolean } | undefined;
      setPending(null);
      loadChat();
      showDoneStatus(!!result?.filesChanged);
      onFilesChanged?.();
    } catch (err) {
      console.error("Chat send failed:", err);
      setPending({ text, status: "error", error: (err as Error).message });
      setTurn("your-turn");
      setProgressLog([]);
    } finally {
      setSending(false);
      onAgentBusy?.(false);
      inputRef.current?.focus();
    }
  }, [inputValue, sending, projectId, activeCanvas, loadChat, onFilesChanged, onAgentBusy, showDoneStatus]);

  const isAgentTurn = turn === "agent-working";
  const isYourTurn = turn === "your-turn" || turn === "agent-done" || turn === "agent-done-files";
  const stepCount = progressLog.length;

  // Clear "done" badge when user starts typing
  const handleInput = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
    if (turn === "agent-done" || turn === "agent-done-files") {
      setTurn("your-turn");
      setProgressLog([]);
      setLogExpanded(false);
    }
  }, [turn]);

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
        {loading && !chatCard && (
          <div className="chat-sidebar-loading">Loading chat...</div>
        )}
        {!loading && !chatCard && (
          <div className="chat-sidebar-empty">No chat card found for this canvas.</div>
        )}
        {chatCard && (
          <WidgetRuntime
            html={chatCard.html}
            exports={chatCard.exports}
            project={projectId}
            canvas={activeCanvas}
            filename="_chat.md"
          />
        )}

        {/* Typing indicator during auto check-in */}
        {checkingIn && (
          <div className="chat-pending">
            <div className="chat-pending-typing">
              <span /><span /><span />
              <span className="chat-pending-status">Reviewing whiteboard...</span>
            </div>
          </div>
        )}

        {/* Optimistic pending messages — shown immediately while agent processes */}
        {pending && (
          <div className="chat-pending" ref={pendingRef}>
            <div className="chat-pending-user">{pending.text}</div>
            {pending.status === "sending" && (
              <div className="chat-pending-typing">
                <span /><span /><span />
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

      {/* Turn indicator — always visible, shows whose turn it is */}
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

        {/* Expandable activity log */}
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

      {/* Input — visually activates on your turn */}
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
