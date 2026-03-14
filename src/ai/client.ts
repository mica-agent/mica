// Mica AI Team Client — connects frontend to the agent server
// Auth is handled server-side via Claude Code subscription.

export type LayerId = string;

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
  projects: string[];
}> {
  const res = await fetch(`${API_BASE}/api/health`);
  return res.json();
}

export async function getAgentMeta(
  project: string,
  layer: LayerId
): Promise<AgentMeta> {
  const res = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(project)}/layers/${encodeURIComponent(layer)}/agent`
  );
  return res.json();
}

export async function chat(
  project: string,
  layer: LayerId,
  message: string
): Promise<ChatResult> {
  const t0 = performance.now();
  log("chat", `→ ${project}/${layer}`, message.length > 80 ? message.slice(0, 80) + "..." : message);

  const res = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(project)}/layers/${encodeURIComponent(layer)}/chat`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ message }),
    }
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("chat", `x ${project}/${layer} [${res.status}] ${elapsed}s`, text);
    let errMsg = "Request failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const data: ChatResult = await res.json();
  log("chat", `ok ${project}/${layer} [${res.status}] ${elapsed}s`, {
    msg: data.response.message.slice(0, 120),
    filesChanged: data.response.filesChanged,
    cost: data.response.cost,
    hasEscalation: !!data.escalationResponse,
  });
  return data;
}

export async function teamDiscussRequest(
  project: string,
  topic: string
): Promise<Record<LayerId, AgentResponse>> {
  const t0 = performance.now();
  log("team", "→", topic);

  const res = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(project)}/team/discuss`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ topic }),
    }
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("team", `x [${res.status}] ${elapsed}s`, text);
    let errMsg = "Request failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const { responses } = await res.json();
  log("team", `ok ${elapsed}s`, Object.keys(responses));
  return responses;
}

export async function escalate(
  project: string,
  fromLayer: LayerId,
  toLayer: LayerId,
  question: string,
  context: string
): Promise<AgentResponse> {
  const t0 = performance.now();
  log("escalate", `→ ${fromLayer} → ${toLayer}`, question);

  const res = await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(project)}/consult`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ fromLayer, toLayer, question, context }),
    }
  );

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);

  if (!res.ok) {
    const text = await res.text();
    logError("escalate", `x [${res.status}] ${elapsed}s`, text);
    let errMsg = "Escalation failed";
    try { errMsg = JSON.parse(text).error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const { response } = await res.json();
  log("escalate", `ok ${elapsed}s`, response.message.slice(0, 120));
  return response;
}

export async function reset(project: string, layer?: LayerId): Promise<void> {
  log("reset", layer || "all");
  await fetch(
    `${API_BASE}/api/projects/${encodeURIComponent(project)}/reset`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ layer }),
    }
  );
}
