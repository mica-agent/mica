// Frontend API client for per-project container operations

const API_BASE = import.meta.env.VITE_MICA_API || "";

function containerUrl(projectId: string, path: string): string {
  return `${API_BASE}/api/projects/${encodeURIComponent(projectId)}/container/${path}`;
}

export interface ContainerInfo {
  containerId: string;
  containerName: string;
  projectId: string;
  ports: Array<{ container: number; host: number }>;
  status: "running" | "starting" | "stopped";
}

export interface ContainerStatus {
  running: boolean;
  status: string;
  uptime?: string;
  ports: Array<{ container: number; host: number }>;
  memoryUsage?: string;
}

export async function startContainer(projectId: string): Promise<ContainerInfo> {
  const res = await fetch(containerUrl(projectId, "start"), { method: "POST" });
  if (!res.ok) throw new Error(`Failed to start container: ${res.statusText}`);
  return res.json();
}

export async function stopContainer(projectId: string): Promise<void> {
  const res = await fetch(containerUrl(projectId, "stop"), { method: "POST" });
  if (!res.ok) throw new Error(`Failed to stop container: ${res.statusText}`);
}

export async function fetchContainerStatus(
  projectId: string
): Promise<ContainerStatus> {
  const res = await fetch(containerUrl(projectId, "status"));
  if (!res.ok) throw new Error(`Failed to fetch container status: ${res.statusText}`);
  return res.json();
}

export async function fetchContainerLogs(
  projectId: string,
  tail: number = 100
): Promise<string> {
  const res = await fetch(containerUrl(projectId, `logs?tail=${tail}`));
  if (!res.ok) throw new Error(`Failed to fetch container logs: ${res.statusText}`);
  const data = await res.json();
  return data.logs;
}
