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

export async function recordTurn(project: string | null, rec: TurnRecord): Promise<void> {
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
