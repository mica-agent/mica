import { readMicaConfig } from "../projectConnection.js";

export async function resolveModel(project: string, canvas: string, fallback: string): Promise<string> {
  const config = await readMicaConfig(project);
  return config?.agents?.[canvas]?.model
    || config?.model
    || fallback;
}

export async function resolveAgentProvider(project: string): Promise<string> {
  const config = await readMicaConfig(project);
  return config?.agentProvider || "claude";
}
