// Verifier — flag method/class names that don't exist on imported Python
// packages. The recurring failure shape it catches: agent imports a real
// package (`import faiss`) and then calls a made-up sub-API on it
// (`faiss.IndexIDList`, `IndexFlatL2.add_with_ids` misuse, etc.). Sidecar
// imports cleanly, route is registered, request reaches the handler, then
// crashes at runtime with `AttributeError: module 'faiss' has no attribute
// 'IndexIDList'` — surfaced to the card as a bare 500.
//
// The check leverages the same probe the `mica_inspect_python_package`
// tool uses: `importlib.import_module(name)` + `inspect.getmembers`,
// trimmed to top-level classes + functions. For each `<module>.<attr>(`
// call site in the would-be content, look up `<attr>` against the probed
// module's surface. Miss → emit a warning with the closest-name match
// (handles typos like `IndexIDList` → `IndexIDMap`).
//
// Conservative by design:
//   - Only matches `^\s*import <bare-name>` and `^\s*import <bare-name>
//     as <alias>` styles. `from X import Y` is bare-name at the call site
//     and not in scope here. The 90% case the agent writes is covered.
//   - Only emits when the probe SUCCEEDS for the module AND the attribute
//     is genuinely absent. If the probe fails (package not installed,
//     interpreter mismatch, runtime error), the verifier stays quiet
//     rather than fire a misleading note.
//   - Skips the stdlib and a few obvious dynamic modules (typing, os,
//     sys) whose runtime surface routinely includes attributes the
//     introspection skips.
//   - Mode is `warning` — write succeeds, the note is appended to the
//     tool result. Zero false-positive cost because nothing blocks.
//
// Probe results are cached per-(python, module) for 60s — repeated edits
// in a turn don't re-fork python for every write.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerVerifier, type FileVerifier, type VerifyProblem, type VerifyResult } from "./registry.js";

const execFileAsync = promisify(execFile);

const DEFAULT_PYTHON = "/usr/bin/python3";

// Modules whose runtime surface is large + dynamic; checking attrs against
// the static introspect would produce noise. The agent rarely writes
// `os.foo()` calls that aren't real anyway.
const SKIP_MODULES = new Set([
  "os", "sys", "json", "re", "typing", "pathlib", "io", "math",
  "time", "datetime", "collections", "itertools", "functools", "asyncio",
  "logging", "traceback", "warnings", "inspect", "subprocess",
]);

// Cache: `${python}|${module}` → ProbeResult (60s TTL).
interface ProbeResult {
  ok: boolean;
  attrs: Set<string>;  // union of top-level classes + functions
}
const probeCache = new Map<string, { result: ProbeResult; at: number }>();
const PROBE_TTL_MS = 60_000;

// Same shape as mica_inspect_python_package's PY_INTROSPECT. Trimmed: we
// don't need version / module_file, just the top-level surface.
const PY_INTROSPECT = `
import sys, json, importlib, inspect
name = sys.argv[1] if len(sys.argv) > 1 else ""
out = {"ok": False, "name": name}
try:
    m = importlib.import_module(name)
    members = inspect.getmembers(m)
    classes = [n for n, v in members if inspect.isclass(v) and not n.startswith("_")]
    funcs = [n for n, v in members if (inspect.isfunction(v) or inspect.isbuiltin(v)) and not n.startswith("_")]
    # Also include attribute names that are modules / re-exports — covers
    # the common "package re-exports its submodule's classes" pattern.
    other = [n for n, v in members if not n.startswith("_") and n not in classes and n not in funcs]
    out["ok"] = True
    out["attrs"] = classes + funcs + other
except Exception:
    pass
print(json.dumps(out))
`;

async function probeModule(modName: string, python: string = DEFAULT_PYTHON): Promise<ProbeResult> {
  const key = `${python}|${modName}`;
  const cached = probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.result;
  try {
    const { stdout } = await execFileAsync(python, ["-c", PY_INTROSPECT, modName], {
      timeout: 5_000,
      maxBuffer: 512 * 1024,
    });
    const line = stdout.split("\n").map((l) => l.trim()).filter(Boolean).pop() || "{}";
    const parsed = JSON.parse(line) as { ok?: boolean; attrs?: string[] };
    const result: ProbeResult = {
      ok: Boolean(parsed.ok),
      attrs: new Set(Array.isArray(parsed.attrs) ? parsed.attrs : []),
    };
    probeCache.set(key, { result, at: Date.now() });
    return result;
  } catch {
    const result: ProbeResult = { ok: false, attrs: new Set() };
    probeCache.set(key, { result, at: Date.now() });
    return result;
  }
}

// Levenshtein-ish: return the closest match by simple edit-distance scan.
// Threshold of ratio-2/3 keeps "IndexIDList" → "IndexIDMap" but doesn't
// suggest unrelated names. ~50 attrs per module; cheap loop.
function closestMatch(target: string, candidates: Set<string>): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = editDistance(target, c);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  if (!best) return undefined;
  // Only suggest when at least half the characters match. Avoids "x" → "fastapi".
  const threshold = Math.max(1, Math.floor(Math.min(target.length, best.length) / 2));
  return bestDist <= threshold ? best : undefined;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[n];
}

interface ImportEntry {
  alias: string;   // what appears at the call site: `import foo` → "foo"; `import foo as f` → "f"
  module: string;  // what to actually probe: always the real module name
}

function scanImports(content: string): ImportEntry[] {
  const entries: ImportEntry[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments, blank lines, inside-function imports (conservative).
    if (!trimmed || trimmed.startsWith("#")) continue;
    let m = trimmed.match(/^import\s+([a-zA-Z_]\w*)\s+as\s+([a-zA-Z_]\w*)\s*(?:#.*)?$/);
    if (m) { entries.push({ module: m[1], alias: m[2] }); continue; }
    m = trimmed.match(/^import\s+([a-zA-Z_]\w*)\s*(?:#.*)?$/);
    if (m) { entries.push({ module: m[1], alias: m[1] }); continue; }
  }
  return entries;
}

// Find `<alias>.<attr>(` call sites and `<alias>.<attr>` attribute reads —
// distinguish them only by tracking line numbers, not by treatment.
// Returns unique (alias, attr, line) triples.
function scanAttrUses(content: string, aliases: Set<string>): Array<{ alias: string; attr: string; line: number }> {
  const uses = new Map<string, { alias: string; attr: string; line: number }>();
  const aliasPattern = Array.from(aliases).map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  if (!aliasPattern) return [];
  // Match `<alias>.<attr>` only at the start of identifiers (so submodule
  // chains `pkg.sub.X` don't double-report on `sub.X`). The leading
  // negative-lookbehind on `.` keeps `foo.bar.baz` from emitting `bar.baz`.
  const re = new RegExp(`(?<![\\w.])(${aliasPattern})\\.([a-zA-Z_]\\w*)`, "g");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comment-only lines.
    if (line.trim().startsWith("#")) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null) {
      const k = `${m[1]}.${m[2]}`;
      if (!uses.has(k)) uses.set(k, { alias: m[1], attr: m[2], line: i + 1 });
    }
  }
  return Array.from(uses.values());
}

const verifier: FileVerifier = {
  name: "python-import-attrs",
  mode: "warning",
  // Only files under .mica/card-classes/<name>/ — sidecars, not other
  // arbitrary .py files in the workspace.
  matches: (filepath) => /\/\.mica\/card-classes\/[^/]+\/.+\.py$/.test(filepath) || /\/card-classes\/[^/]+\/.+\.py$/.test(filepath),
  verify: async (filepath, content): Promise<VerifyResult> => {
    const imports = scanImports(content);
    if (imports.length === 0) return { ok: true };
    const checkable = imports.filter((e) => !SKIP_MODULES.has(e.module));
    if (checkable.length === 0) return { ok: true };

    // Probe each checkable module in parallel. Failed probes silently
    // drop out — we only emit warnings for modules we successfully
    // introspected (false-negative > false-positive in advisory mode).
    const probes = await Promise.all(
      checkable.map(async (e) => ({ entry: e, probe: await probeModule(e.module) })),
    );
    const aliasToAttrs = new Map<string, Set<string>>();
    const aliasToModule = new Map<string, string>();
    for (const { entry, probe } of probes) {
      if (!probe.ok) continue;
      aliasToAttrs.set(entry.alias, probe.attrs);
      aliasToModule.set(entry.alias, entry.module);
    }
    if (aliasToAttrs.size === 0) return { ok: true };

    const uses = scanAttrUses(content, new Set(aliasToAttrs.keys()));
    const problems: VerifyProblem[] = [];
    for (const u of uses) {
      const attrs = aliasToAttrs.get(u.alias);
      if (!attrs) continue;
      if (attrs.has(u.attr)) continue;
      // Miss. Suggest closest match if any.
      const suggest = closestMatch(u.attr, attrs);
      const mod = aliasToModule.get(u.alias) ?? u.alias;
      problems.push({
        file: filepath,
        line: u.line,
        problem:
          `\`${u.alias}.${u.attr}\` — \`${u.attr}\` is not in the top-level surface of \`${mod}\`. ` +
          `This will fail at runtime with \`AttributeError: module '${mod}' has no attribute '${u.attr}'\`.`,
        fix_hint: suggest
          ? `Did you mean \`${u.alias}.${suggest}\`? If \`${u.attr}\` is a real attribute that the introspection missed (set at runtime, lazy attribute, from a submodule), ignore this note.`
          : `Verify the API shape with \`mica_inspect_python_package({ name: "${mod}" })\` before retrying. If the attribute is genuinely there but set at runtime, this note is a false positive — ignore.`,
      });
    }
    if (problems.length === 0) return { ok: true };
    return { ok: false, verifier: "python-import-attrs", problems };
  },
};

registerVerifier(verifier);
