// Mica AI Team Client — connects frontend to the agent server
// Auth is handled server-side via Claude Code subscription.

export type LayerId =
  | "mission"
  | "experience"
  | "architecture"
  | "implementation";

export interface AgentMeta {
  name: string;
  role: string;
}

export interface Escalation {
  targetLayer: LayerId;
  question: string;
  context: string;
}

export interface AgentResponse {
  layer: LayerId;
  message: string;
  escalation?: Escalation | null;
  filesChanged?: boolean;
  cost?: number;
}

export interface ChatResult {
  response: AgentResponse;
  escalationResponse?: AgentResponse;
}

const API_BASE = import.meta.env.VITE_MICA_API || "";

const headers: Record<string, string> = { "Content-Type": "application/json" };

function log(tag: string, ...args: unknown[]) {
  console.log(`%c[mica:${tag}]`, "color:#4acaa0;font-weight:bold", ...args);
}

function logError(tag: string, ...args: unknown[]) {
  console.error(`%c[mica:${tag}]`, "color:#ff6b6b;font-weight:bold", ...args);
}

export async function healthCheck(): Promise<{
  status: string;
  auth: string;
  agents: string[];
}> {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}

export async function getAgents(): Promise<Record<LayerId, AgentMeta>> {
  const res = await fetch(`${API_BASE}/api/agents`);
  return res.json();
}

export async function chat(
  layer: LayerId,
  message: string
): Promise<ChatResult> {
  const t0 = performance.now();
  log("chat", `→ ${layer}`, message.length > 80 ? message.slice(0, 80) + "…" : message);

  const res = await fetch(`${API_BASE}/api/chat/${layer}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("chat", `✗ ${layer} [${res.status}] ${elapsed}s`, text);
    let errMsg = "Request failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const data: ChatResult = await res.json();
  log("chat", `✓ ${layer} [${res.status}] ${elapsed}s`, {
    msg: data.response.message.slice(0, 120),
    filesChanged: data.response.filesChanged,
    cost: data.response.cost,
    hasEscalation: !!data.escalationResponse,
  });
  return data;
}

export async function teamDiscussRequest(
  topic: string
): Promise<Record<LayerId, AgentResponse>> {
  const t0 = performance.now();
  log("team", "→", topic);

  const res = await fetch(`${API_BASE}/api/team/discuss`, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic }),
  });

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("team", `✗ [${res.status}] ${elapsed}s`, text);
    let errMsg = "Request failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const { responses } = await res.json();
  log("team", `✓ ${elapsed}s`, Object.keys(responses));
  return responses;
}

export async function escalate(
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const t0 = performance.now();
  log("escalate", `→ ${fromLayer} → ${toLayer}`, question);

  const res = await fetch(`${API_BASE}/api/escalate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fromLayer, toLayer, question, context }),
  });

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("escalate", `✗ [${res.status}] ${elapsed}s`, text);
    let errMsg = "Escalation failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const { response } = await res.json();
  log("escalate", `✓ ${elapsed}s`, response.message.slice(0, 120));
  return response;
}

export async function reset(layer?: LayerId): Promise<void> {
  log("reset", layer || "all");
  await fetch(`${API_BASE}/api/reset`, {
    method: "POST",
    headers,
    body: JSON.stringify({ layer }),
  });
}
