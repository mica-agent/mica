// exec plugin -- mica.exec.* server primitive.
// Runs one-shot shell commands. NOTE: currently unused from cards
// (mica.exec is not exposed in the client bridge). The exported
// setActiveProject is a backward-compat no-op shim kept so imports
// elsewhere don't break; project scoping must come from the `cwd`
// param in each call (an absolute path or relative to WORKSPACE_DIR).

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { WORKSPACE_DIR } from "../files.js";

const execAsync = promisify(execCb);

const MAX_TIMEOUT = 60000; // 60s max
const MAX_OUTPUT = 1024 * 1024; // 1MB max output

// Phase-1 shim, retained so server/index.ts's import doesn't break. No-op.
export function setActiveProject(_project: string | null) { void _project; }

export async function execHandler(method: string, params: unknown, _project: string | null = null): Promise<unknown> {
  void _project;
  switch (method) {
    case "run": {
      const { command, cwd, timeout } = params as {
        command: string;
        cwd?: string;
        timeout?: number;
      };
      if (!command) throw new Error("command required");

      const execTimeout = Math.min(timeout || 30000, MAX_TIMEOUT);
      const execCwd = cwd ? (cwd.startsWith("/") ? cwd : `${WORKSPACE_DIR}/${cwd}`) : WORKSPACE_DIR;

      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd: execCwd,
          timeout: execTimeout,
          maxBuffer: MAX_OUTPUT,
          shell: "/bin/bash",
        });
        return { stdout, stderr, exitCode: 0 };
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
        if (e.killed) {
          return { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: -1, error: "Timeout" };
        }
        return {
          stdout: e.stdout || "",
          stderr: e.stderr || "",
          exitCode: e.code || 1,
          error: e.message,
        };
      }
    }
    default:
      throw new Error(`Unknown method: mica.exec.${method}`);
  }
}
