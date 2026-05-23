// Verifier #6 — parse-check Python scripts. Detects syntax errors before
// the file lands on disk. `python3 -c "import ast; ast.parse(content)"` is
// the cheapest possible Python lint — runs in ~100ms, catches the
// failure shape Galaxy's defined-but-uncalled-functions and orbit42's
// orchestration bugs have analogs of (in Python: incomplete `def foo(`
// statements, mismatched indentation, top-level await without proper
// async context, etc.).
//
// Spawned via child_process directly (not mica_shell — we want
// guaranteed isolation and no shell-quoting concerns). Content is
// passed via stdin so we don't need a temp file.

import { spawn } from "node:child_process";
import { registerVerifier, type FileVerifier, type VerifyResult } from "./index.js";

async function parseCheckPython(content: string): Promise<{ ok: true } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["-c", "import ast, sys; ast.parse(sys.stdin.read())"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => resolve({ ok: false, error: err.message }));
    proc.on("close", (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `python3 exited with code ${code}` });
    });
    proc.stdin.write(content);
    proc.stdin.end();
  });
}

// Pull a line number out of Python's traceback format if present.
// Example: `File "<unknown>", line 5\n    def foo(\n           ^\nSyntaxError: ...`
function extractLine(error: string): number | undefined {
  const m = error.match(/line (\d+)/);
  return m ? parseInt(m[1], 10) : undefined;
}

const verifier: FileVerifier = {
  name: "python-script-parse",
  mode: "gate",
  matches: (filepath) => /\.py$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    const result = await parseCheckPython(content);
    if (result.ok) return { ok: true };
    return {
      ok: false,
      verifier: "python-script-parse",
      problems: [{
        file: filepath,
        line: extractLine(result.error),
        problem: `Python parse failure: ${result.error.split("\n").pop() || result.error}`,
        fix_hint:
          "Re-read the file, fix the syntax error (likely incomplete statement, mismatched indentation, " +
          "or unbalanced parens / brackets), retry the write.",
      }],
    };
  },
};

registerVerifier(verifier);
