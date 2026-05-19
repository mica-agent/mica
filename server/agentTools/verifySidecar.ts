// mica_verify_sidecar — agent-time smoke test for a card-class sidecar.
//
// Closes the feedback gap that turned rag2–rag6 into 15–60 turn debug spirals:
// the agent currently writes server.py, hands off to the user, and only learns
// it's broken when the user clicks and hits an error. This tool gives the
// agent the same agent-time signal `render_capture` provides on the client
// side — verify after writing, before declaring done.
//
// The verb: force a respawn (so we're testing the CURRENT code, not stale
// bytecode from before the last edit), wait for /health, optionally fire one
// smoke request against an endpoint the agent names, return a structured
// verdict (OK / ERROR with phase + reason + log tail). The log tail includes
// the traceback emitted by the sidecar's @app.exception_handler if the bug
// is server-side.
//
// Composes existing primitives — restartCardSidecar + ensureCardSidecar +
// getCardSidecarLog — none of the spawn/health/log mechanics are new.

import { z } from "zod";
import { existsSync } from "fs";
import { join } from "path";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import {
  ensureCardSidecar,
  restartCardSidecar,
  getCardSidecarLog,
} from "../cardSidecar.js";
import { micaDir, findCardClassInLibraries } from "../files.js";

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

// Local copy of resolveCardClassDir (mirrors index.ts + micaFetch.ts).
// Project-scoped → library → built-in. Same shape used everywhere a card
// class needs to be resolved by name to a directory.
function resolveClassDir(className: string, project: string | null): string | null {
  if (project) {
    const projectScoped = join(micaDir(project), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html"))) return projectScoped;
  }
  const lib = findCardClassInLibraries(className);
  if (lib) return lib.dir;
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html"))) return builtIn;
  return null;
}

const smokeSchema = z
  .object({
    path: z
      .string()
      .describe(
        "HTTP path on the sidecar to exercise after /health succeeds (e.g. '/ask', '/encode'). Path only — do NOT include the host or port; Mica routes via 127.0.0.1:<sidecar-port>.",
      ),
    method: z
      .string()
      .optional()
      .describe("HTTP method. Default 'GET'."),
    body: z
      .string()
      .optional()
      .describe(
        "JSON-encoded request body (POST/PUT/PATCH). Mica sets Content-Type: application/json automatically. Keep small — this is a smoke test, not a load test.",
      ),
  })
  .describe(
    "Optional. After /health succeeds, fire ONE request against this endpoint to validate a real code path. Catches semantic bugs that /health alone misses (e.g. wrong numpy indexing inside the handler — /health returns 200 but /ask 500s).",
  );

const inputSchema = {
  card_class: z
    .string()
    .describe(
      "The card class name (the directory name under `.mica/card-classes/`, e.g. 'rag-chat' or 'hello-py'). Project is inferred from the active session.",
    ),
  smoke: smokeSchema.optional(),
  timeout_ms: z
    .number()
    .optional()
    .describe(
      "Timeout for the smoke request (if provided) in ms. Default 30000. Bump for endpoints that do heavy work (LLM call, model inference). The sidecar's own ready_timeout_ms governs the /health phase separately.",
    ),
} as const;

// Format a structured result as agent-readable text with a verdict tag
// on line 1 — same shape `render_capture` uses. The agent dispatches on
// the tag; the body fills in details for human inspection and for the
// agent to read the traceback.
function formatOk(
  cardClass: string,
  project: string,
  msToReady: number,
  port: number,
  smoke?: { status: number; bodyPreview: string },
): string {
  if (smoke) {
    return (
      `[verify_sidecar: OK] sidecar '${cardClass}' (project '${project}') ` +
      `reached /health in ${msToReady}ms and smoke ${smoke.status} on the requested endpoint. ` +
      `Sidecar is operational; you can hand off to the user.\n\n` +
      `Port: ${port}\n` +
      `Smoke response (first 500 chars):\n${smoke.bodyPreview}`
    );
  }
  return (
    `[verify_sidecar: OK] sidecar '${cardClass}' (project '${project}') ` +
    `reached /health in ${msToReady}ms. No smoke endpoint was requested — ` +
    `consider passing one (e.g. \`smoke: { path: "/ask", method: "POST", body: ... }\`) ` +
    `to validate a real code path. Sidecar is operational; you can hand off to the user.\n\n` +
    `Port: ${port}`
  );
}

function formatError(opts: {
  cardClass: string;
  project: string;
  phase: "lookup" | "spawn" | "ready" | "smoke";
  reason: string;
  msElapsed: number;
  port?: number;
  smoke?: { status?: number; bodyPreview?: string; transportError?: string };
  logTail: string[];
}): string {
  const { cardClass, project, phase, reason, msElapsed, port, smoke, logTail } = opts;
  const phaseHelp: Record<typeof opts.phase, string> = {
    lookup:
      "The card class directory wasn't found in this project, the library cache, or built-ins. Check spelling, or that the class has been created via mica_create_class.",
    spawn:
      "The sidecar process failed to start. The traceback in the log tail names the file/line. Typical causes: ImportError (a Python package isn't installed in this interpreter — verify with mica_inspect_python_package), syntax error in server.py, missing entry script.",
    ready:
      "The sidecar process spawned but /health never returned 200 within the timeout. Typical causes: server.py raises during module-scope code (model load, FAISS init), the @app.exception_handler wasn't reached because the failure was during import or app construction, OR /health endpoint missing from server.py.",
    smoke:
      "The sidecar reached /health but the smoke endpoint returned a non-2xx status (or transport error). The traceback in the log tail names the file/line in the handler.",
  };

  const lines: string[] = [
    `[verify_sidecar: ERROR — ${phase}] ${reason}`,
    "",
    phaseHelp[phase],
    "",
    `Card class: ${cardClass}`,
    `Project: ${project}`,
    `ms_elapsed: ${msElapsed}`,
  ];
  if (port !== undefined) lines.push(`Port: ${port}`);
  if (smoke) {
    if (smoke.status !== undefined) {
      lines.push(`Smoke status: ${smoke.status}`);
    }
    if (smoke.bodyPreview) {
      lines.push(`Smoke response body (first 500 chars):\n${smoke.bodyPreview}`);
    }
    if (smoke.transportError) {
      lines.push(`Smoke transport error: ${smoke.transportError}`);
    }
  }
  lines.push("");
  if (logTail.length === 0) {
    lines.push(
      "log_tail: (empty — no sidecar log entries captured for this class. The sidecar process may not have produced any output before failing.)",
    );
  } else {
    lines.push(`log_tail (last ${logTail.length} lines from [card-sidecar:${cardClass}]):`);
    lines.push(...logTail);
  }
  return lines.join("\n");
}

export const verifySidecarTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_verify_sidecar",
  description:
    "Smoke-test a card-class sidecar BEFORE handing off to the user. Mica: (1) restarts the tracked sidecar so the test runs against the CURRENT server.py / server.ts (not stale bytecode), (2) spawns and waits up to the metadata's ready_timeout_ms for /health to return 200, (3) optionally fires one request against a smoke endpoint you name (e.g. /ask, /encode) to exercise a real code path, (4) returns a verdict tag — `[verify_sidecar: OK]` or `[verify_sidecar: ERROR — <phase>]` — plus the recent log tail (which contains the @app.exception_handler traceback if the bug was server-side). Call this after EVERY mica_edit_class_file or mica_create_class change to a sidecar, BEFORE telling the user to click. This is the server-side analog of render_capture for cards: closes the agent-time feedback loop so you don't burn user round-trips on debugging. Input: `{ card_class, smoke?: { path, method?, body? }, timeout_ms? }`. The verdict tag is the first line — dispatch on it. ERROR results include phase (lookup|spawn|ready|smoke) and a help string explaining typical causes for each phase.",
  inputSchema,
  restPath: "/api/tools/mica-verify-sidecar",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "Active project required." };
    }
    const project = ctx.project;
    const cardClass = input.card_class;

    const classDir = resolveClassDir(cardClass, project);
    if (!classDir) {
      return {
        isError: true,
        text: formatError({
          cardClass,
          project,
          phase: "lookup",
          reason: `Card class '${cardClass}' not found in project '${project}'.`,
          msElapsed: 0,
          logTail: [],
        }),
      };
    }

    // Always restart first — the explicit contract of verify is "test the
    // CURRENT code, not what's already loaded into a running process."
    // Agents calling verify expect a clean spawn.
    await restartCardSidecar(project, cardClass);

    // Spawn fresh + wait for /health. ensureCardSidecar handles both the
    // process launch and the /health probe loop, throwing on either kind
    // of failure. Inspect the error message to classify the phase.
    const t0 = Date.now();
    let port: number;
    try {
      const r = await ensureCardSidecar(project, cardClass, classDir);
      port = r.port;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      const msElapsed = Date.now() - t0;
      const logTail = getCardSidecarLog(project, cardClass, 50);
      // Classify: "did not reach /health" or "died before ready" → ready
      // phase. Everything else (entry missing, interpreter missing,
      // metadata parse, port pool exhausted) → spawn phase.
      const phase: "spawn" | "ready" =
        msg.includes("did not reach") || msg.includes("died before ready") ? "ready" : "spawn";
      return {
        isError: true,
        text: formatError({
          cardClass,
          project,
          phase,
          reason: msg,
          msElapsed,
          logTail,
        }),
      };
    }
    const msToReady = Date.now() - t0;

    // No smoke requested — /health success is sufficient.
    if (!input.smoke) {
      return { text: formatOk(cardClass, project, msToReady, port) };
    }

    // Smoke phase — fire one request against the requested endpoint.
    const smokeMethod = (input.smoke.method || "GET").toUpperCase();
    const smokeUrl = `http://127.0.0.1:${port}${input.smoke.path}`;
    const timeoutMs = input.timeout_ms ?? 30_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (input.smoke.body) headers["Content-Type"] = "application/json";
      const resp = await fetch(smokeUrl, {
        method: smokeMethod,
        headers,
        body: input.smoke.body,
        signal: ctrl.signal,
      });
      const body = (await resp.text().catch(() => "")) || "";
      clearTimeout(timer);
      const bodyPreview = body.slice(0, 500);
      if (resp.ok) {
        return {
          text: formatOk(cardClass, project, msToReady, port, {
            status: resp.status,
            bodyPreview,
          }),
        };
      }
      // Non-2xx — pull log tail (likely contains the traceback from
      // @app.exception_handler) and return ERROR.
      const logTail = getCardSidecarLog(project, cardClass, 50);
      return {
        isError: true,
        text: formatError({
          cardClass,
          project,
          phase: "smoke",
          reason: `Smoke endpoint ${smokeMethod} ${input.smoke.path} returned HTTP ${resp.status}.`,
          msElapsed: Date.now() - t0,
          port,
          smoke: { status: resp.status, bodyPreview },
          logTail,
        }),
      };
    } catch (err) {
      clearTimeout(timer);
      const transportError = (err as Error).message || String(err);
      const logTail = getCardSidecarLog(project, cardClass, 50);
      return {
        isError: true,
        text: formatError({
          cardClass,
          project,
          phase: "smoke",
          reason: `Smoke endpoint ${smokeMethod} ${input.smoke.path} failed in transport: ${transportError}`,
          msElapsed: Date.now() - t0,
          port,
          smoke: { transportError },
          logTail,
        }),
      };
    }
  },
};
