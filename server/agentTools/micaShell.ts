// mica_shell — guarded shell execution for agents.
//
// Replaces the SDK's built-in `run_shell_command` (which we exclude in
// micaAgent.ts). The SDK built-in runs in yolo mode without consulting our
// canUseTool guard, so dangerous patterns (kill the backend's tsx PID,
// pkill tsx, etc.) execute unchecked. THIS tool runs server-side via the
// mica-builtins MCP server, so the guard fires before the shell spawns —
// works regardless of permission mode, in both parent and subagent
// contexts.
//
// Pattern matches the existing exec.ts + DANGEROUS_BASH_PATTERNS layer in
// micaAgent.ts. We import DANGEROUS_BASH_PATTERNS rather than duplicating
// so the canonical list stays single-source.

import { z } from "zod";
import { exec as execCb } from "child_process";
import { promisify } from "util";
import { WORKSPACE_DIR, getEffectiveWorkspaceDir } from "../files.js";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { DANGEROUS_BASH_PATTERNS, isBackgroundWithoutRedirect } from "../micaAgentGuards.js";

const execAsync = promisify(execCb);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 600_000;     // 10 min, same as Bash tool
const MAX_OUTPUT_BYTES = 1_048_576; // 1 MB

const inputSchema = {
  command: z.string().describe("The shell command to run. Executed via /bin/bash -c."),
  description: z
    .string()
    .optional()
    .describe("Short human-readable description of what this command does (for logging)."),
  is_background: z
    .boolean()
    .optional()
    .describe(
      "Set true for long-running services (dev servers, watchers). The command is detached and stdout/stderr are dropped; this tool returns immediately with the command line. Default false (synchronous, waits for completion).",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory. Absolute path or project-relative. Default: WORKSPACE_DIR (the projects directory).",
    ),
  timeout: z
    .number()
    .optional()
    .describe(`Timeout in milliseconds. Default ${DEFAULT_TIMEOUT_MS}, max ${MAX_TIMEOUT_MS}.`),
} as const;

export const micaShellTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_shell",
  description:
    "Run a shell command on the Mica server. Same purpose as the SDK's built-in `run_shell_command`, but with Mica's safety guards: refuses commands that would kill Mica's own backend (pkill tsx, kill <backend-pid>, scripts/stop.sh / restart.sh from inside the agent), refuses card-class file placements outside `.mica/card-classes/`, and warns on backgrounded commands without stdout/stderr redirect. Use this tool for ALL shell needs — `run_shell_command` is excluded from your tool surface because it bypasses these guards. Returns `{ stdout, stderr, exit_code, duration_ms }`. Stdout/stderr capped at 1 MB; commands that exceed the cap are killed and a `truncated: true` flag is set.",
  inputSchema,
  restPath: "/api/tools/mica-shell",
  handler: async (input): Promise<AgentToolResult> => {
    const command = input.command;
    if (!command || typeof command !== "string") {
      return { isError: true, text: "mica_shell: command is required" };
    }

    // 1. Dangerous-pattern guard.
    for (const { re, reason } of DANGEROUS_BASH_PATTERNS) {
      if (re.test(command)) {
        console.warn(`[mica_shell] BLOCKED: "${command.slice(0, 200)}" — ${reason}`);
        return {
          isError: true,
          text: `Refused: ${reason}\nCommand was: ${command.slice(0, 200)}`,
        };
      }
    }

    // 2. Background-without-redirect guard. Catches `cmd &` with no redirect —
    // the spawned process inherits the tool-call shell's stdio and dies when
    // the shell exits. Tell the agent how to fix it.
    if (!input.is_background && isBackgroundWithoutRedirect(command)) {
      return {
        isError: true,
        text:
          "Backgrounded command (ends in `&`) has no stdout/stderr redirect. The spawned process inherits this shell's stdio and will die when the shell exits (SIGHUP / broken pipe). Pick one:\n" +
          "  1. Redirect both streams to a file:    cmd > /tmp/x.log 2>&1 &\n" +
          "  2. Use nohup + redirect:               nohup cmd > /tmp/x.log 2>&1 &\n" +
          "  3. Best for long-running services: pass `is_background: true` to mica_shell and DROP the trailing `&` — Mica manages the process lifecycle, stdio, and cleanup.",
      };
    }

    // 3. Resolve cwd. Absolute paths used as-is; relative paths resolve
    // under WORKSPACE_DIR (the projects directory). Default: WORKSPACE_DIR.
    const cwd = input.cwd
      ? input.cwd.startsWith("/")
        ? input.cwd
        : `${getEffectiveWorkspaceDir()}/${input.cwd}`
      : getEffectiveWorkspaceDir();

    const timeoutMs = Math.max(1, Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));

    // 4. Background mode: detach via nohup + redirect to /dev/null, return
    // immediately. The agent gets a confirmation; the process keeps running.
    if (input.is_background) {
      const bg = `nohup bash -c ${JSON.stringify(command)} > /dev/null 2>&1 &`;
      try {
        await execAsync(bg, { cwd, shell: "/bin/bash" });
        return {
          text: `Started backgrounded: ${command.slice(0, 200)}\n(detached; stdout/stderr discarded — wrap in your own redirect if you need logs)`,
        };
      } catch (err) {
        return {
          isError: true,
          text: `Background spawn failed: ${(err as Error).message}`,
        };
      }
    }

    // 5. Foreground mode: run synchronously with output capture and timeout.
    const t0 = Date.now();
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        shell: "/bin/bash",
      });
      const duration_ms = Date.now() - t0;
      return {
        text: JSON.stringify(
          {
            exit_code: 0,
            stdout: String(stdout || ""),
            stderr: String(stderr || ""),
            duration_ms,
          },
          null,
          2,
        ),
      };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; killed?: boolean; signal?: string; message?: string };
      const duration_ms = Date.now() - t0;
      // execAsync rejects on non-zero exit OR maxBuffer overflow OR timeout.
      // Tell the agent which it was.
      if (e.killed && e.signal === "SIGTERM") {
        return {
          isError: true,
          text: JSON.stringify(
            {
              exit_code: -1,
              stdout: String(e.stdout || ""),
              stderr: String(e.stderr || ""),
              duration_ms,
              error: `command timed out after ${timeoutMs}ms`,
            },
            null,
            2,
          ),
        };
      }
      // Non-zero exit code. Not necessarily an error from the agent's
      // perspective — `grep` exits 1 when no match, etc. Return the exit
      // code; let the caller decide.
      const exit_code = typeof e.code === "number" ? e.code : -1;
      return {
        text: JSON.stringify(
          {
            exit_code,
            stdout: String(e.stdout || ""),
            stderr: String(e.stderr || ""),
            duration_ms,
          },
          null,
          2,
        ),
      };
    }
  },
};
