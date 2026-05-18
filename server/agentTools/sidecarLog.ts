// mica_sidecar_log — fetch a card class sidecar's recent stdout/stderr.
//
// Step 1 of the "Debugging a 500" recipe in card-class-handbook. The traceback
// emitted by the sidecar's exception handler (or by an uncaught exception in
// TS sidecars) appears in stdout — captured by cardSidecar.ts into a per-class
// ring buffer. This tool returns the last N lines of that buffer so the agent
// can read the actual stack trace BEFORE editing code.
//
// Observed failure mode without this tool: agent gets "Upload failed (HTTP
// 500)" from the user, reads server.py / card.js source, guesses at the bug,
// burns 3-15 turns debugging the wrong line. The traceback was in the backend
// log all along — but it required `mica_shell tail .../backend.log | grep ...`
// which the agent reliably forgets to compose. A dedicated single-call tool
// eliminates the friction.
//
// Survives sidecar process death — the ring buffer is per-class, not per-
// process, so a sidecar that crashed and got cleaned up still has its
// post-mortem traceback available here.

import { z } from "zod";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { getCardSidecarLog } from "../cardSidecar.js";

const inputSchema = {
  card_class: z
    .string()
    .describe(
      "The card class name (the directory name under `.mica/card-classes/`, e.g. 'rag-chat' or 'hello-py'). Project is inferred from the active session.",
    ),
  lines: z
    .number()
    .optional()
    .describe(
      "Number of recent log lines to return. Default 50 — usually enough to capture the most recent traceback. Max 500.",
    ),
} as const;

export const sidecarLogTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_sidecar_log",
  description:
    "Return the recent stdout/stderr lines from a card class's sidecar process. **Call this FIRST whenever a sidecar fetch returns HTTP 5xx** — the Python/TS exception handler in the sidecar emits the full traceback to stdout, which lands in this buffer. Read the traceback (look for `Traceback (most recent call last):` followed by the exception line) BEFORE you edit code. Pattern-matching the short error message from `mica.fetch` (e.g., 'Upload failed (HTTP 500)') consistently lands the agent on the wrong line; the traceback in this buffer tells you exactly which line raised and what the exception type was. The buffer survives sidecar exit/crash — even if the process died, the log lines that crashed it are still here. Returns the last `lines` (default 50, max 500) entries. Use this INSTEAD of `mica_shell tail backend.log | grep card-sidecar:<name>` — same data, one tool call, no path or pattern to remember.",
  inputSchema,
  restPath: "/api/tools/mica-sidecar-log",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "Active project required." };
    }
    const lines = typeof input.lines === "number" ? input.lines : 50;
    const buf = getCardSidecarLog(ctx.project, input.card_class, lines);
    if (buf.length === 0) {
      return {
        text:
          `No log entries for sidecar '${input.card_class}' in project '${ctx.project}'. ` +
          `Either the sidecar has never been spawned (no card.js has called mica.fetch yet), ` +
          `the card class doesn't declare a sidecar, or the class name is misspelled.`,
      };
    }
    const header = `--- last ${buf.length} log line(s) for sidecar '${input.card_class}' in project '${ctx.project}' ---`;
    return { text: `${header}\n${buf.join("\n")}` };
  },
};
