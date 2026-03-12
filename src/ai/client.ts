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

export interface ArtifactSuggestion {
  title: string;
  type: string;
  summary: string;
  detail?: string;
}

export interface Escalation {
  targetLayer: LayerId;
  question: string;
  context: string;
}

export interface AgentResponse {
  layer: LayerId;
  message: string;
  artifacts?: ArtifactSuggestion[];
  escalation?: Escalation | null;
  cost?: number;
}

export interface ChatResult {
  response: AgentResponse;
  escalationResponse?: AgentResponse;
}

const API_BASE = import.meta.env.VITE_MICA_API || "";

const headers: Record<string, string> = { "Content-Type": "application/json" };

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
  const res = await fetch(`${API_BASE}/api/chat/${layer}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message }),
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Request failed");
  }

  return res.json();
}

export async function teamDiscussRequest(
  topic: string
): Promise<Record<LayerId, AgentResponse>> {
  const res = await fetch(`${API_BASE}/api/team/discuss`, {
    method: "POST",
    headers,
    body: JSON.stringify({ topic }),
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Request failed");
  }

  const { responses } = await res.json();
  return responses;
}

export async function escalate(
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const res = await fetch(`${API_BASE}/api/escalate`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fromLayer, toLayer, question, context }),
  });

  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || "Escalation failed");
  }

  const { response } = await res.json();
  return response;
}

export async function reset(layer?: LayerId): Promise<void> {
  await fetch(`${API_BASE}/api/reset`, {
    method: "POST",
    headers,
    body: JSON.stringify({ layer }),
  });
}
