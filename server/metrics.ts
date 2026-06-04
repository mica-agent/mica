// metrics.ts — JSONL metrics for agent turns + subagent invocations.
//
// Per-project records land under .mica/metrics/{turns,subagents}.jsonl.
// Writes are fire-and-forget fs.appendFile — no back-pressure on the turn
// hot path. Errors are logged but swallowed; metrics must never break a turn.
//
// Read offline with scripts/metrics-summary.mjs.

import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { micaDir } from "./files.js";
import { recordUsage } from "./auth/hooks.js";
import { getCurrentTenant } from "./tenantContext.js";

export interface TurnRecord {
  turn_id: string;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
  ttft_ms: number | null;
  chat_id: string;
  agent: "qwen" | "claude";
  model: string;
  input_tokens: number;
  output_tokens: number;
  baseline_tokens: number;
  context_window: number;
  capacity: number;
  subagent_count: number;
  tool_calls: Record<string, number>;
  /** Convenience surface for web-search activity this turn. Equal to the
   *  sum of `tool_calls["mcp__tavily__tavily_search"]` and
   *  `tool_calls["mcp__tavily__tavily_extract"]`. Exposed at the top level
   *  so `grep -c '"tavily_calls": 0'` on a turns.jsonl directly reveals
   *  build turns that skipped web search — the wtc4 / Crunch2 failure
   *  shape. */
  tavily_calls: number;
  /** Names of skills explicitly invoked via the SDK's `skill` tool this turn.
   *  Distinct from `tool_calls.skill` (which only counts invocations) — this
   *  preserves WHICH skills fired so the chat card's per-turn footer can
   *  show "decompose-task, doc-consistency" instead of just "2 skills". */
  skills_invoked: string[];
  files_changed: number;
  cursor_advanced: boolean;
  arc_complete: boolean;
}

export interface SubagentRecord {
  turn_id: string;
  tool_use_id: string;
  subagent_name: string;
  ts_start: number;
  ts_end: number;
  duration_ms: number;
}

/** Sum tavily MCP tool calls (search + extract) from a `tool_calls` map.
 *  Call sites pass the same map they record into `TurnRecord.tool_calls`.
 *  Centralized so every harness uses the same key set. */
export function countTavilyCalls(toolCalls: Record<string, number>): number {
  return (toolCalls["mcp__tavily__tavily_search"] || 0)
    + (toolCalls["mcp__tavily__tavily_extract"] || 0);
}

export async function recordTurn(project: string | null, rec: TurnRecord): Promise<void> {
  // Usage-metering hook — fires for every agent turn (this is the shared
  // chokepoint all agents call). No-op in main (no meter registered); a
  // multi-tenant fork's meter uses this for free-period budget enforcement.
  recordUsage({
    tenant: getCurrentTenant(),
    project: project ?? undefined,
    provider: rec.agent,
    model: rec.model,
    inputTokens: rec.input_tokens,
    outputTokens: rec.output_tokens,
  });
  if (!project) return;
  try {
    const path = join(micaDir(project), "metrics", "turns.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch (err) {
    console.warn("[metrics] recordTurn failed:", (err as Error).message);
  }
}

export async function recordSubagent(project: string | null, rec: SubagentRecord): Promise<void> {
  if (!project) return;
  try {
    const path = join(micaDir(project), "metrics", "subagents.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch (err) {
    console.warn("[metrics] recordSubagent failed:", (err as Error).message);
  }
}
