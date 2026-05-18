// mica_inspect_python_package — server-side Python package introspection.
//
// Parallel to mica_inspect_url for CDN scripts: same shape (small structured
// return, ~200-500 bytes), same agent intent (verify-before-commit during
// dependency research). For Tier 4 sidecars, the analog of "is this UMD?"
// is "is this Python package installed in the interpreter I'll spawn the
// sidecar with, and what's the top-level API surface?".
//
// Use cases:
//   1. Sidecar dependency research: before committing `import sentence_transformers`
//      to server.py, confirm the package resolves in the chosen interpreter
//      AND get the top-level class/function names so the spec can name them
//      correctly. Catches version-sensitivity bugs and missing-dep bugs at
//      spec time, not at sidecar-spawn time.
//   2. Voice-venv vs system Python selection: the same name (e.g. "librosa")
//      may be present in voice-venv but not system. Inspect with both to
//      know which `python:` field to set in metadata.json.
//
// Stays inside the augmentation-layer boundary (Tenet 10) — bounded
// introspection of a fixed package, structured result. No code generation,
// no chat-history rewriting.
//
// Security: package name flows through argv (execFile), not shell. Python
// script does not exec() user input. Worst case is a name that imports a
// module with import-time side effects in the chosen interpreter — same
// risk as the sidecar itself, which already runs in this interpreter.

import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { z } from "zod";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

const execFileAsync = promisify(execFile);

// Same constants as cardSidecar.ts. Duplicated locally to avoid an import
// cycle (cardSidecar pulls in plugin runtime; this tool runs at request
// time and shouldn't drag that in).
const REPO_ROOT = process.env.MICA_REPO_ROOT || "/workspaces/mica";
const DEFAULT_PYTHON = "/usr/bin/python3";
const VOICE_VENV_PYTHON = join(REPO_ROOT, "scripts", "benchmarks", "voice", ".venv", "bin", "python");

function resolvePython(spec: string): string {
  if (spec === "system") return DEFAULT_PYTHON;
  if (spec === "voice-venv") return VOICE_VENV_PYTHON;
  return spec; // assume absolute path
}

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe(
      "Python package import name (e.g. 'sentence_transformers', 'fastapi', " +
        "'fitz'). Use the IMPORT name, not the PyPI distribution name when they " +
        "differ (e.g. pymupdf → import as 'fitz'). Names with dots resolve as " +
        "module paths (e.g. 'numpy.linalg' is valid).",
    ),
  python: z
    .string()
    .optional()
    .describe(
      "Optional interpreter selector. 'system' (default, /usr/bin/python3 — " +
        "the same interpreter sidecars get when metadata.python is unset or " +
        "'system'). 'voice-venv' — the Parakeet/Kokoro shared venv that has " +
        "sentence-transformers, librosa, soundfile, fastapi pre-installed. " +
        "An absolute path is also accepted for custom interpreters.",
    ),
} as const;

interface InspectResult {
  installed: boolean;
  name: string;
  python: string;
  version?: string;
  /** Top-level public class names (no leading underscore), capped at 20. */
  top_level_classes?: string[];
  /** Top-level public function/builtin names (no leading underscore), capped at 20. */
  top_level_functions?: string[];
  /** Path to the module's __file__ — useful to confirm WHICH installation
   *  resolved when a package is present in multiple paths. */
  module_file?: string | null;
  /** Error type + message when installed === false. */
  error?: string;
}

// Python introspection script. Receives the package name as argv[1].
// Prints exactly one JSON line on stdout, then exits 0 (always — errors
// land in the JSON's `error` field). Keeps the protocol simple for the
// TS side: read stdout, JSON.parse, done.
const PY_INTROSPECT = `
import sys, json, importlib, inspect, traceback
name = sys.argv[1] if len(sys.argv) > 1 else ""
out = {"installed": False, "name": name}
if not name:
    out["error"] = "empty package name"
    print(json.dumps(out))
    sys.exit(0)
try:
    m = importlib.import_module(name)
    version = None
    for attr in ("__version__", "version", "VERSION"):
        v = getattr(m, attr, None)
        if v and not callable(v):
            version = str(v)
            break
    members = inspect.getmembers(m)
    classes = sorted(
        [n for n, v in members if inspect.isclass(v) and not n.startswith("_")]
    )[:20]
    funcs = sorted(
        [n for n, v in members
         if (inspect.isfunction(v) or inspect.isbuiltin(v)) and not n.startswith("_")]
    )[:20]
    out.update({
        "installed": True,
        "version": version or "(no __version__)",
        "top_level_classes": classes,
        "top_level_functions": funcs,
        "module_file": getattr(m, "__file__", None),
    })
except ImportError as e:
    out["error"] = f"ImportError: {e}"
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"
print(json.dumps(out))
`;

export const inspectPythonPackageTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_inspect_python_package",
  description:
    "Inspect a Python package in the sidecar's target interpreter. Same shape " +
    "as mica_inspect_url but for Python imports. Use during sidecar dependency " +
    "research — BEFORE committing `import X` to server.py — to confirm the " +
    "package resolves AND to learn its top-level class/function names. Input: " +
    "{ name, python? } where name is the import name (e.g. 'fastapi', " +
    "'sentence_transformers', 'fitz') and python is optional interpreter " +
    "selector ('system' default | 'voice-venv' | absolute path). Output: " +
    "{ installed, name, python, version?, top_level_classes?, " +
    "top_level_functions?, module_file?, error? }. When installed is false, " +
    "`error` names the ImportError — the spec must pick a different package OR " +
    "the sidecar must declare the interpreter that has it (e.g. voice-venv has " +
    "sentence-transformers + librosa; system has fastapi + httpx + numpy). The " +
    "top-level class/function names are the antidote to method hallucination at " +
    "code-write time — when writing server.py, reference these instead of " +
    "guessing API shapes. Cheap to call; safe (package name flows through " +
    "argv, not shell). Use BEFORE writing the sidecar's spec to verify each " +
    "intended import; if any returns installed: false, change the dep or the " +
    "interpreter selection BEFORE the sidecar is authored.",
  inputSchema,
  restPath: "/api/tools/inspect-python-package",
  handler: async (input): Promise<AgentToolResult> => {
    const name = input.name.trim();
    const pythonSpec = (input.python || "system").trim();
    const pythonPath = resolvePython(pythonSpec);
    try {
      const { stdout } = await execFileAsync(
        pythonPath,
        ["-c", PY_INTROSPECT, name],
        { timeout: 10_000, maxBuffer: 256 * 1024 },
      );
      // The script prints exactly one JSON line. Take the last non-empty
      // line in case the interpreter emits something on stderr (it shouldn't
      // — script catches everything) or a noisy import warning slipped in.
      const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "{}";
      try {
        const parsed = JSON.parse(line);
        const result: InspectResult = {
          installed: Boolean(parsed.installed),
          name: parsed.name ?? name,
          python: pythonSpec,
          ...(parsed.version ? { version: parsed.version } : {}),
          ...(parsed.top_level_classes ? { top_level_classes: parsed.top_level_classes } : {}),
          ...(parsed.top_level_functions ? { top_level_functions: parsed.top_level_functions } : {}),
          ...(parsed.module_file !== undefined ? { module_file: parsed.module_file } : {}),
          ...(parsed.error ? { error: parsed.error } : {}),
        };
        return { text: JSON.stringify(result) };
      } catch {
        return {
          isError: true,
          text: JSON.stringify({
            installed: false,
            name,
            python: pythonSpec,
            error: `Could not parse introspection output: ${line.slice(0, 200)}`,
          } satisfies InspectResult),
        };
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const msg =
        e.code === "ENOENT"
          ? `Interpreter not found at ${pythonPath}. Check the 'python' arg.`
          : (e.stderr?.toString().trim() || e.message || String(err));
      return {
        isError: true,
        text: JSON.stringify({
          installed: false,
          name,
          python: pythonSpec,
          error: msg.slice(0, 400),
        } satisfies InspectResult),
      };
    }
  },
};
