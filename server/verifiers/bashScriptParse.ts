// Verifier #7 — parse-check bash scripts via `bash -n` (no-execute). The
// cheapest possible shell lint — catches unbalanced quotes, missing
// `fi` / `done` / closing braces, malformed heredocs, etc. — without
// running a single command.
//
// Same shape as the Python verifier. Content piped via stdin so we
// don't need temp files. ~100ms.

import { spawn } from "node:child_process";
import { registerVerifier, type FileVerifier, type VerifyResult } from "./registry.js";

async function parseCheckBash(content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("bash", ["-n", "/dev/stdin"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => resolve({ ok: false, error: err.message }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `bash exited with code ${code}` });
    });
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

// bash -n errors look like: `/dev/stdin: line 5: syntax error near ...`
function extractLine(error: string): number | undefined {
  const m = error.match(/line (\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

const verifier: FileVerifier = {
  name: "bash-script-parse",
  mode: "gate",
  matches: (filepath) => /\.(sh|bash)$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    const result = await parseCheckBash(content);
    if (result.ok) return { ok: true };
    return {
      ok: false,
      verifier: "bash-script-parse",
      problems: [{
        file: filepath,
        line: extractLine(result.error),
        problem: `bash parse failure: ${result.error.replace(/\/dev\/stdin:\s*/, "")}`,
        fix_hint:
          "Re-read the script, fix the syntax (likely unbalanced quotes, missing `fi` / `done` / `}`, " +
          "malformed heredoc, or unterminated string), retry the write.",
      }],
    };
  },
};

registerVerifier(verifier);
