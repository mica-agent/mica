// exec plugin -- mica.exec.* server primitive.
// Runs one-shot shell commands scoped to PROJECT_DIR.

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { PROJECT_DIR } from "../files.js";

const execAsync = promisify(execCb);

const MAX_TIMEOUT = 60000; // 60s max
const MAX_OUTPUT = 1024 * 1024; // 1MB max output

export async function execHandler(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "run": {
      const { command, cwd, timeout } = params as {
        command: string;
        cwd?: string;
        timeout?: number;
      };
      if (!command) throw new Error("command required");

      const execTimeout = Math.min(timeout || 30000, MAX_TIMEOUT);
      const execCwd = cwd ? `${PROJECT_DIR}/${cwd}` : PROJECT_DIR;

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
