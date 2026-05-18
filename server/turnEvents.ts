// turnEvents.ts — per-turn structured event log for retrospective analysis.
//
// Sidecar to turnSnapshots.ts. Each chat turn appends every SDK event
// (tool_use, thinking, result) as one JSON line to
//   `.mica/chats/<chatId>/turn-<turnId>.events.jsonl`
//
// Purpose: keep a complete record of what the agent DID and THOUGHT for any
// turn — full tool_use inputs, full thinking-block contents, full result
// text. The existing backend.log truncates thinking to 120 chars and
// tool_use to ~200 chars; this file is the full-fidelity record.
//
// Strictly an OBSERVABILITY artifact. NOT fed back into the agent's
// context on future turns. The token-budget posture is unchanged — these
// files live on disk for humans (the user looking back, an investigator
// debugging exit-53 loops) and tooling (grep, jq, future replay UIs).
// Compare turnSnapshots.ts: same pattern, complementary content (snapshot
// = what the agent SAW; events = what the agent DID).
//
// Format: one JSON object per line. Fields always include `ts` (Unix-ms)
// and `type`; remaining fields per type:
//   { ts, type: "tool_use", name, input }
//   { ts, type: "thinking", text }
//   { ts, type: "result",   text?, is_error?, error?, usage? }
//
// Writes are append-only and fire-and-forget. Errors during writes are
// logged once-per-process at warn level (so a broken FS doesn't spam) and
// never thrown — turn behavior is preserved if the log can't write.

import { mkdir, appendFile, readFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { micaDir } from "./files.js";

function eventsDir(project: string | null, chatId: string): string {
  return join(micaDir(project ?? undefined), "chats", chatId);
}

function eventsPath(project: string | null, chatId: string, turnId: string): string {
  return join(eventsDir(project, chatId), `turn-${turnId}.events.jsonl`);
}

let warnedOnce = false;
function warn(msg: string): void {
  if (warnedOnce) return;
  warnedOnce = true;
  console.warn(`[turn-events] ${msg} (this message is logged once per process)`);
}

/** Append one event line to the per-turn jsonl. Fire-and-forget. Errors
 *  swallowed after first warn so they don't drown other logging. */
export async function appendTurnEvent(
  project: string | null,
  chatId: string,
  turnId: string,
  event: Record<string, unknown>,
): Promise<void> {
  if (!chatId || !turnId) return;
  try {
    const dir = eventsDir(project, chatId);
    if (!existsSync(dir)) await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ ts: Date.now(), ...event }) + "\n";
    await appendFile(eventsPath(project, chatId, turnId), line, "utf-8");
  } catch (err) {
    warn(`appendTurnEvent ${chatId}/${turnId} failed: ${(err as Error).message}`);
  }
}

/** Read all events for a turn. Returns parsed lines, or empty array if the
 *  file doesn't exist (turn predates this mechanism, or was archived).
 *  Bad lines are skipped silently. */
export async function readTurnEvents(
  project: string | null,
  chatId: string,
  turnId: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const raw = await readFile(eventsPath(project, chatId, turnId), "utf-8");
    return raw.split("\n").filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    });
  } catch {
    return [];
  }
}

/** Verdict the analyzer returns: was this turn making progress, or stuck? */
export type TurnVerdict = {
  /** "converging" → safe to auto-continue. "stuck" → user-visible error. */
  verdict: "converging" | "stuck";
  /** Human-readable single line — included in logs and (for "stuck") the
   *  user-facing error message. */
  summary: string;
  /** Raw counts the verdict was computed from. Surfaced in logs for tuning. */
  signals: {
    toolCount: number;
    uniqueToolArgs: number;
    maxRepeatedArgsCount: number;
    canvasWrites: number;
    trailingThinkingOnly: number;
    recurringErrors: number;
  };
};

/** Stable-stringify so equivalent argument objects hash identically. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Generic progress vs. stuck classifier for one turn's events. Used by the
 *  exit-53 recovery path in micaAgent.ts to decide whether to silently
 *  auto-continue (turn cap fired mid-legitimate-work) or surface a
 *  user-visible error (genuine loop).
 *
 *  Default verdict is "converging" — give the agent the benefit of the
 *  doubt unless clear stuck signals fire. The auto-continue caller is
 *  responsible for the "one retry per user message" cap. */
export function analyzeTurnArtifacts(
  events: Array<Record<string, unknown>>,
): TurnVerdict {
  // Tally tool_use calls keyed by (name, args-hash). Repeated calls with
  // identical arguments are the canonical loop signature (the task_stop
  // fabrication loop, the "read_file the same path 6 times" pattern, etc).
  const argHashes = new Map<string, number>();
  let toolCount = 0;
  let canvasWrites = 0;
  // Track tool_use → next-result error matches so we can spot recurring
  // errors. We use a sliding key (tool name + short error fingerprint).
  const errorCounts = new Map<string, number>();
  let lastSeenToolName: string | null = null;
  // Trailing thinking-only count — events at end of the turn that were
  // thinking with no tool_use in between. Pure-reasoning loops show as
  // a long trailing run of thinking blocks.
  let trailingThinkingOnly = 0;
  let trailingActive = true;

  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    const t = evt.type as string;
    if (t === "thinking") {
      if (trailingActive) trailingThinkingOnly += 1;
    } else if (t === "tool_use") {
      trailingActive = false;
    } else if (t === "tool_result" || t === "result") {
      trailingActive = false;
    } else {
      trailingActive = false;
    }
  }

  for (const evt of events) {
    const t = evt.type as string;
    if (t === "tool_use") {
      toolCount += 1;
      const name = (evt.name as string) ?? "?";
      lastSeenToolName = name;
      const inp = (evt.input as Record<string, unknown>) ?? {};
      const hash = `${name}::${stableStringify(inp)}`;
      argHashes.set(hash, (argHashes.get(hash) ?? 0) + 1);
      // Canvas writes — both the mica-builtin tool name and raw write_file
      // pointing at the canvas-side paths count. Loose match on the path
      // since the agent uses absolute and relative paths interchangeably.
      const writeTools = new Set([
        "mcp__mica-builtins__mica_create_class",
        "mcp__mica-builtins__mica_create_card_instance",
        "mcp__mica-builtins__mica_edit_class_file",
        "write_file",
        "edit",
      ]);
      if (writeTools.has(name)) {
        const p = String(inp.file_path ?? inp.filename ?? inp.class ?? "");
        if (p.includes("canvas/") || p.includes(".mica/card-classes") || name.startsWith("mcp__mica-builtins__")) {
          canvasWrites += 1;
        }
      }
    } else if (t === "tool_result") {
      const content = evt.content;
      let txt = "";
      if (Array.isArray(content) && content.length > 0 && typeof content[0] === "object" && content[0]) {
        txt = String((content[0] as { text?: string }).text ?? "");
      } else if (typeof content === "string") {
        txt = content;
      }
      // Cheap error fingerprint: first 60 chars of any result containing
      // "error" or "fail" (case-insensitive), keyed by the tool that returned
      // it. Same fingerprint across calls = recurring error.
      if (/error|fail|cannot|invalid/i.test(txt.slice(0, 200))) {
        const fingerprint = `${lastSeenToolName ?? "?"}::${txt.slice(0, 60).replace(/\s+/g, " ").trim()}`;
        errorCounts.set(fingerprint, (errorCounts.get(fingerprint) ?? 0) + 1);
      }
    }
  }

  const repeats = [...argHashes.values()];
  const maxRepeatedArgsCount = repeats.length > 0 ? Math.max(...repeats) : 0;
  const recurringErrors = [...errorCounts.values()].reduce((a, b) => Math.max(a, b), 0);
  const uniqueToolArgs = argHashes.size;

  const signals = {
    toolCount,
    uniqueToolArgs,
    maxRepeatedArgsCount,
    canvasWrites,
    trailingThinkingOnly,
    recurringErrors,
  };

  // Stuck signals (any one → stuck). Thresholds tuned conservatively — we
  // want false negatives (auto-continue something that's actually stuck;
  // the second turn will catch it via source==="recovery" or the user
  // will redirect) rather than false positives (interrupt legit work).
  if (maxRepeatedArgsCount >= 4) {
    return {
      verdict: "stuck",
      summary: `same tool call repeated ${maxRepeatedArgsCount}× with identical arguments`,
      signals,
    };
  }
  if (recurringErrors >= 4) {
    return {
      verdict: "stuck",
      summary: `same error returned ${recurringErrors}× across tool calls`,
      signals,
    };
  }
  if (trailingThinkingOnly >= 6) {
    return {
      verdict: "stuck",
      summary: `${trailingThinkingOnly} trailing thinking events with no tool action`,
      signals,
    };
  }

  // Default: converging. Phrase the summary by which positive signal is
  // strongest so the log line is informative.
  let why: string;
  if (canvasWrites > 0) {
    why = `${canvasWrites} canvas write(s) this turn`;
  } else if (uniqueToolArgs >= 6) {
    why = `${uniqueToolArgs} distinct tool calls (broad research)`;
  } else if (toolCount > 0) {
    why = `${toolCount} tool calls, no loop signals`;
  } else {
    why = `no tool activity but no stuck signals`;
  }
  return { verdict: "converging", summary: why, signals };
}

/** Move all turn-*.events.jsonl files for a chat into the archive stamp dir.
 *  Mirrors archiveSnapshots in turnSnapshots.ts. Called from archiveChat. */
export async function archiveTurnEvents(
  project: string | null,
  chatId: string,
  archiveDirAbs: string,
): Promise<void> {
  const srcDir = eventsDir(project, chatId);
  if (!existsSync(srcDir)) return;
  try {
    const { readdir } = await import("fs/promises");
    const entries = await readdir(srcDir);
    const eventFiles = entries.filter((n) => /^turn-.*\.events\.jsonl$/.test(n));
    if (eventFiles.length === 0) return;
    const destDir = `${archiveDirAbs}-events`;
    await mkdir(destDir, { recursive: true });
    for (const f of eventFiles) {
      await rename(join(srcDir, f), join(destDir, f));
    }
  } catch (err) {
    warn(`archiveTurnEvents ${chatId} failed: ${(err as Error).message}`);
  }
}
