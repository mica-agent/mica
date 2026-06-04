// cardValidators.ts — per-extension write_file validators.
//
// Each card class can ship a `validate.js` alongside its `card.html`/`card.js`.
// When the agent calls write_file (or write_to_file / create_file) for a path
// whose extension matches a card class with a validator, the validator runs;
// returning a non-empty string aborts the write and the string is sent to the
// agent as a tool-deny reason (so the agent learns the right format and retries).
//
// Lookup order matches the rest of the card-class system:
//   1. project-scoped:  <project>/.mica/card-classes/<ext>/validate.js
//   2. built-in:        <repo>/card-classes/<ext>/validate.js
// Returns null when no validator is registered (the common case — most card
// classes don't need one).
//
// validate.js shape (CommonJS or ESM, default export or named `validate`):
//   export default function validate(content) {
//     if (badThing(content)) return "human-readable hint";
//     return null;
//   }
// Async validators are supported (the hook awaits).

import { join } from "path";
import { existsSync } from "fs";
import { stat } from "fs/promises";
import { pathToFileURL } from "url";
import { WORKSPACE_DIR, getEffectiveWorkspaceDir, micaDir } from "./files.js";

export type Validator = (content: string) => string | null | Promise<string | null>;

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

interface CacheEntry {
  validator: Validator | null;
  mtime: number;  // 0 if no file
  path: string | null;
}

// Cache per `${project ?? "_builtin"}|${ext}`. The mtime guard auto-invalidates
// when the file changes on disk (so editing a validate.js doesn't require a
// server restart — useful while the user is iterating on hints).
const cache = new Map<string, CacheEntry>();

function cacheKey(project: string | null | undefined, ext: string): string {
  return `${project ?? "_builtin"}|${ext}`;
}

function resolveValidatorPath(project: string | null | undefined, ext: string): string | null {
  if (project) {
    const projPath = join(getEffectiveWorkspaceDir(), project, ".mica", "card-classes", ext, "validate.js");
    if (existsSync(projPath)) return projPath;
  }
  const builtinPath = join(CARD_CLASSES_DIR, ext, "validate.js");
  if (existsSync(builtinPath)) return builtinPath;
  return null;
}

/** Resolve the validator for an extension, or null if none. Cached + mtime-checked. */
export async function loadValidator(
  project: string | null | undefined,
  ext: string,
): Promise<Validator | null> {
  if (!ext) return null;
  void micaDir;  // (silence unused-import warning if we trim deps later)

  const path = resolveValidatorPath(project, ext);
  const key = cacheKey(project, ext);
  const cached = cache.get(key);

  if (!path) {
    if (cached?.validator === null && cached.path === null) return null;
    cache.set(key, { validator: null, mtime: 0, path: null });
    return null;
  }

  const s = await stat(path);
  const mtime = s.mtimeMs;
  if (cached && cached.path === path && cached.mtime === mtime) return cached.validator;

  try {
    // Cache-bust the import so re-edits load. URL fragment is ignored by Node
    // but treated as a unique specifier for the import cache.
    const url = pathToFileURL(path).href + `?v=${mtime}`;
    const mod = await import(url);
    const fn = (mod.default ?? mod.validate) as Validator | undefined;
    if (typeof fn !== "function") {
      console.warn(`[validators] ${path} has no default or named export 'validate'`);
      cache.set(key, { validator: null, mtime, path });
      return null;
    }
    cache.set(key, { validator: fn, mtime, path });
    return fn;
  } catch (err) {
    console.warn(`[validators] failed to load ${path}: ${(err as Error).message}`);
    cache.set(key, { validator: null, mtime, path });
    return null;
  }
}

/** Extract the file_path → extension for a write tool's input. Returns "" if missing. */
export function extensionFromWriteInput(input: Record<string, unknown>): string {
  const p = pathFromWriteInput(input);
  const dot = p.lastIndexOf(".");
  if (dot === -1) return "";
  return p.slice(dot + 1).toLowerCase();
}

/** Pull the file_path field out of a write tool's input regardless of which
 *  casing the SDK uses (file_path | filePath | path). Returns "" if absent. */
export function pathFromWriteInput(input: Record<string, unknown>): string {
  return ((input.file_path as string) || (input.filePath as string) || (input.path as string) || "");
}

/** Pull the file_path field out of a read tool's input. Same shape as writes. */
export function pathFromReadInput(input: Record<string, unknown>): string {
  return pathFromWriteInput(input);
}

// ── Preconditions (must-read-skill-before-write) ─────────────
//
// Some writes require the agent to have read a particular skill earlier in the
// turn — otherwise it improvises and produces wrong code (invented endpoints,
// wrong field names, fictional global registries). We deny the write with a
// short hint pointing to the skill; the agent reads it via read_file and
// retries. The full skill body costs tokens only when actually needed.

const CARD_CLASS_FILE_RX = /\.mica\/card-classes\/[^/]+\/(card\.(?:js|html|css)|metadata\.json)$/;
const CARD_CLASS_HANDBOOK_SKILL_RX = /\.(?:qwen|claude)\/skills\/card-class-handbook\/SKILL\.md$/;

/** If `filePath` is a card-class authoring file and the card-class-handbook skill
 *  hasn't been read in `readFiles`, returns the deny reason. Otherwise null. */
export function checkCardClassPrecondition(
  filePath: string,
  readFiles: Set<string>,
): string | null {
  if (!CARD_CLASS_FILE_RX.test(filePath)) return null;
  for (const p of readFiles) {
    if (CARD_CLASS_HANDBOOK_SKILL_RX.test(p)) return null;
  }
  return "Invoke `skill('card-class-handbook')` before writing card class code. The handbook is the contract `mica_create_class` / `mica_edit_class_file` enforce — CANONICAL CARD.JS shape, CARD_SHIM globals (`container` / `mica` are injected — do NOT redeclare), mica.* API, channel handlers, pitfalls. Improvising leads to invented endpoints, wrong field names (e.g. file.name vs file.path), and fictional registries (e.g. Mica.registerCardClass — does not exist). Load the handbook, then retry.";
}

// Design-doc files that bake in library/dependency decisions. Writing one
// without running the discover-dependency workflow first is the failure mode
// where the agent ships bespoke implementations and back-rationalizes them
// with invented user constraints ("User specified 'no external libraries'"
// when no such thing was said). Empirical: world clock 6 with qwen-code SDK
// produced exactly that confabulation when discover-dependency wasn't invoked.
//
// Match is intentionally loose — basename only — so it catches design docs
// regardless of which folder the project's canvasRoot is configured to.
const DESIGN_DOC_RX = /(?:^|\/)(spec|decomposition|interfaces)\.md$/;
const DISCOVER_DEPENDENCY_SKILL_RX = /\.(?:qwen|claude)\/skills\/discover-dependency\/SKILL\.md$/;

// Paths the agent should NEVER write directly via raw write_file. Each
// has a structured tool that owns the path's invariants — bypassing the
// tool produces malformed state (layout.json corruption, metadata schema
// errors, lint failures that don't surface until next save). The
// precondition deny redirects to the right tool.
const PROTECTED_PATH_RULES: Array<{ rx: RegExp; reason: string }> = [
  {
    // .mica/layout.json — runtime state owned by the canvas card class.
    // Drag, resize, click-to-front, smart-layout — all flow through the
    // canvas. Direct agent writes corrupt the layout (missing per-card
    // entries, inconsistent z-orders) and can survive across reloads.
    rx: /\.mica\/layout\.json$/,
    reason: "Refusing direct write_file to `.mica/layout.json`. Layout is runtime state owned by the canvas card class — drag, resize, smart-layout, and z-order all flow through it. The agent has no business editing it. If you need to reposition a card on canvas, ask the user; if you're trying to refresh a card after editing its class files, you don't need to — Mica's file-watcher broadcasts `card-class-changed` and the frontend hot-reloads existing instances on save.",
  },
  {
    // card.js / card.html / card.css inside a card class — should go
    // through mica_edit_class_file which (a) runs the same pre-write
    // lint that fires after every save, surfacing failures in this
    // same turn, and (b) supports partial edits (old_string/new_string)
    // so amending a working file doesn't accidentally regress it
    // through a full-file rewrite. Direct write_file makes both worse.
    rx: /\.mica\/card-classes\/[^/]+\/card\.(?:js|html|css)$/,
    reason: "Refusing direct write_file to a card class file. Use the `mica_edit_class_file` tool instead — it runs the same lint that fires post-save BEFORE the write (lint failures surface in this same turn) and supports partial edits via `old_string`/`new_string` so you can ADD content (e.g. add a Moon mesh) without rewriting the whole file and regressing what was already working. If you really must replace the entire file, pass `content=` to mica_edit_class_file. Args: `class` (directory name), `file` ('card.js' / 'card.html' / 'card.css'), then either `content` (full replace) or `old_string`+`new_string` (partial).",
  },
  {
    // metadata.json — should go through mica_create_class which
    // serializes from typed inputs (name, badge, extension, scripts,
    // styles, etc.) instead of free-form JSON the agent might shape
    // wrong (extension/dirname mismatch, missing required fields).
    rx: /\.mica\/card-classes\/[^/]+\/metadata\.json$/,
    reason: "Refusing direct write_file to a card class metadata.json. Use the `mica_create_class` tool instead — it serializes metadata from typed inputs (name, badge, defaultTitle, extension, scripts, styles, handler, primaryFile) so the schema is correct by construction. Editing free-form JSON here is the recurring failure mode where the extension doesn't match the directory name and the card silently renders as TXT.",
  },
];

/** If `filePath` is one of the agent-protected paths above (layout.json,
 *  card.js/html/css, metadata.json) reject the raw write and redirect to
 *  the structured tool. Otherwise null. */
export function checkProtectedPathPrecondition(filePath: string): string | null {
  for (const rule of PROTECTED_PATH_RULES) {
    if (rule.rx.test(filePath)) return rule.reason;
  }
  return null;
}

/** If `filePath` is a design doc (spec.md, decomposition.md, interfaces.md)
 *  and the discover-dependency skill hasn't been read in `readFiles`, returns
 *  the deny reason. Otherwise null.
 *
 *  Why this exists: the discover-dependency skill has a guard ("If the user
 *  said no external libraries — confirm before assuming") that fires only
 *  inside the skill's workflow. When the agent skips the skill entirely
 *  and writes spec/decomposition straight from priors, the guard never
 *  triggers, and the agent confabulates a user constraint to justify
 *  rolling bespoke. This precondition forces the skill onto the path.
 *  Same pattern as checkCardClassPrecondition. */
export function checkLibraryDiscoveryPrecondition(
  filePath: string,
  readFiles: Set<string>,
): string | null {
  if (!DESIGN_DOC_RX.test(filePath)) return null;
  for (const p of readFiles) {
    if (DISCOVER_DEPENDENCY_SKILL_RX.test(p)) return null;
  }
  return "Read `.qwen/skills/discover-dependency/SKILL.md` (or `.claude/skills/discover-dependency/SKILL.md` for Claude) before writing or modifying spec.md / decomposition.md / interfaces.md. Design docs that bake in library choices without running the discover-dependency workflow tend to default to bespoke implementations and back-rationalize the choice with invented user constraints (\"User specified 'no external libraries'\" when nothing of the sort was said). The skill takes <30 seconds: search → curl-verify → record the decision per subproblem. Library is the default; bespoke is the exception that requires a documented \"no library fits because Z\" reason. Read the skill, then retry.";
}

const METADATA_JSON_RX = /\.mica\/card-classes\/([^/]+)\/metadata\.json$/;

/** When the agent writes `.mica/card-classes/<dir>/metadata.json`, ensure the
 *  `extension` field matches the parent directory name. The Mica resolver maps
 *  an instance's extension directly to a directory — a mismatch means the
 *  card silently renders as TXT. Returns a deny reason on mismatch, else null. */
export function checkCardClassMetadataConsistency(
  filePath: string,
  content: string,
): string | null {
  const m = filePath.match(METADATA_JSON_RX);
  if (!m) return null;
  const dirName = m[1];

  let parsed: { extension?: unknown };
  try {
    parsed = JSON.parse(content);
  } catch {
    return "metadata.json must be valid JSON. Failed to parse — fix the syntax and retry.";
  }
  if (typeof parsed.extension !== "string") {
    return "metadata.json must have an `extension` string field (e.g. \"extension\": \".stopwatch\"). Add it and retry.";
  }
  const ext = parsed.extension.replace(/^\./, "");
  if (!ext) {
    return "metadata.json `extension` is empty. It must be the file extension including the leading dot (e.g. \".stopwatch\").";
  }
  if (ext !== dirName) {
    return `metadata.json declares extension \`.${ext}\` but the parent directory is \`${dirName}\`. The Mica resolver maps an instance file's extension directly to a directory NAME — they MUST be identical (no dot in the directory). Fix one of:\n  • rename the directory \`.mica/card-classes/${dirName}/\` to \`.mica/card-classes/${ext}/\`, OR\n  • change \`extension\` in metadata.json to \`.${dirName}\`.\nWithout this match, instance files render as plain TXT — there is NO error message.`;
  }
  return null;
}

/** Auto-fix + error-surface a card-class metadata.json after the fact.
 *
 *  Why this exists: the SDK's `canUseTool` hook never fires under
 *  permissionMode: "yolo" (other modes hang on writes/shell in headless SDK
 *  setups), so `checkCardClassMetadataConsistency` above is dead code when
 *  the agent actually writes. This function gets called from the file
 *  watcher — it runs regardless of how the write happened (SDK write_file,
 *  bash `cat >`, an external editor, anything).
 *
 *  Behaviour:
 *  - File missing or unparseable: emit a card-error (agent will see it in chat).
 *  - `extension` field missing: auto-inject `".<dirName>"`. The directory
 *    name is the invariant — the Mica resolver maps file extensions directly
 *    to directory names, so the correct value is always knowable. Log a
 *    warning so the agent still gets feedback it skipped a field; don't
 *    spam the user with an error.
 *  - `extension` field mismatched: can't safely auto-fix (which side is
 *    wrong?). Emit a card-error with the exact reason. */
export async function enforceCardClassMetadata(
  absolutePath: string,
  opts: {
    onAutoFix?: (reason: string) => void;
    onError?: (reason: string) => void;
  } = {},
): Promise<void> {
  const m = absolutePath.match(/\.mica\/card-classes\/([^/]+)\/metadata\.json$/);
  if (!m) return;
  const dirName = m[1];

  const { readFile, writeFile, stat } = await import("fs/promises");
  let raw: string;
  try {
    const s = await stat(absolutePath);
    if (!s.isFile()) return;
    raw = await readFile(absolutePath, "utf-8");
  } catch {
    return; // deleted / unreadable — nothing to enforce
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    opts.onError?.(
      `\`${dirName}/metadata.json\` is not valid JSON. Fix the syntax and re-save.`,
    );
    return;
  }

  const ext = typeof parsed.extension === "string" ? parsed.extension : "";
  const bare = ext.replace(/^\./, "");

  if (!bare) {
    // Missing or empty — auto-inject. We reconstruct the JSON with the new
    // field at a predictable position so the file stays diff-readable.
    parsed.extension = `.${dirName}`;
    const out = JSON.stringify(parsed, null, 2) + "\n";
    try {
      await writeFile(absolutePath, out, "utf-8");
      opts.onAutoFix?.(
        `\`${dirName}/metadata.json\` was missing its \`extension\` field. Injected \`.${dirName}\` automatically — the directory name is authoritative. Future card classes: include \`"extension": ".<dirName>"\` when creating metadata.json.`,
      );
    } catch (err) {
      opts.onError?.(`Failed to auto-fix metadata.json: ${(err as Error).message}`);
    }
    return;
  }

  if (bare !== dirName) {
    // Specific case: agent copied the skeleton (templates/_card-class-skeleton/)
    // but never edited metadata.json to replace the placeholder. Same for
    // defaultTitle. Catch this BEFORE the generic mismatch error so the
    // agent gets a precise action — "you skipped step 1 of the recipe" —
    // rather than a vague "directory and extension don't match" that has
    // sent agents into long debugging loops.
    const looksLikePlaceholder = /REPLACE_ME|XYZ_PLACEHOLDER/i.test(bare) ||
      (typeof parsed.defaultTitle === "string" && /REPLACE_ME/i.test(parsed.defaultTitle));
    if (looksLikePlaceholder) {
      // Route through onAutoFix (server-log only) instead of onError (red
      // banner in chat). Reason: the placeholder state is TRANSIENT — it
      // exists for the brief window between `cp -r skeleton` and the
      // agent's followup `edit metadata.json`. Showing a red error during
      // that gap is spammy; the agent's STEP 0 mandatory grep check (in
      // the card-class-handbook skill) catches it on the authoring side
      // before the work continues, so the framework doesn't need to alarm.
      // We don't auto-rewrite the placeholder because the framework can't
      // know what `extension` / `defaultTitle` the user wants — only the
      // mismatch path below has a known authoritative value (the dir name).
      opts.onAutoFix?.(
        `\`${dirName}/metadata.json\` still has skeleton placeholders (\`extension: ".${bare}"\`${typeof parsed.defaultTitle === "string" && /REPLACE_ME/i.test(parsed.defaultTitle) ? `, \`defaultTitle: "${parsed.defaultTitle}"\`` : ""}) — agent should replace these per the card-class-handbook skill's STEP 0.`,
      );
      return;
    }
    // Mismatched — auto-fix to match the directory name, same precedent as
    // the missing-extension path above. The directory name IS the resolver's
    // lookup key, so any extension that doesn't match it is dead text. The
    // skill says "directory name is authoritative"; we trust that.
    //
    // Why auto-fix instead of card-error: agents repeatedly create the
    // mismatch (typing `.world-clock` while the dir is `world-time-clock`,
    // matching the spec name vs. matching the user's dir) and then burn
    // context trying to figure out which side the framework wanted them
    // to fix. Auto-fix is reversible (it's just a JSON edit) and short-
    // circuits the loop. Logged via onAutoFix so the server keeps a
    // record; nothing surfaces to the chat UI.
    parsed.extension = `.${dirName}`;
    const out = JSON.stringify(parsed, null, 2) + "\n";
    try {
      const { writeFile } = await import("fs/promises");
      await writeFile(absolutePath, out, "utf-8");
      opts.onAutoFix?.(
        `\`${dirName}/metadata.json\` declared \`extension: ".${bare}"\` which didn't match the parent directory \`${dirName}\`. Rewrote extension to \`".${dirName}"\` (directory name is the authoritative side per the resolver). If you actually wanted the extension \`.${bare}\`, rename the directory instead.`,
      );
    } catch (err) {
      opts.onError?.(
        `Failed to auto-fix metadata.json extension mismatch (${bare} vs ${dirName}): ${(err as Error).message}`,
      );
    }
    return; // The auto-fix re-triggers the file-watcher; field checks run next round.
  }

  // ── Field-shape checks (extension is now correct) ─────────────
  //
  // Smoke test 3 (2026-04-29) showed agents writing package.json-shaped
  // metadata.json: `{ "name": "...", "description": "...", "dependencies": {
  // "three": "0.160.0" } }`. The extension/dir match held (or got auto-fixed
  // above), but the card still rendered with `???` because `badge` was
  // missing — and the dependencies shape was wrong, so external scripts
  // never loaded. These checks catch the rest.

  const fieldErrors: string[] = [];

  if (typeof parsed.badge !== "string" || !parsed.badge.trim()) {
    fieldErrors.push(
      "missing required field `badge` — a 2-3 character mnemonic shown on the card chip (e.g. `\"badge\": \"CTR\"` for a counter). Without it, the canvas renders the card with `???`.",
    );
  }

  if (typeof parsed.defaultTitle !== "string" || !parsed.defaultTitle.trim()) {
    fieldErrors.push(
      "missing required field `defaultTitle` — the human-readable card title (e.g. `\"defaultTitle\": \"Counter\"`). Without it, the title falls back to the raw filename.",
    );
  }

  if (parsed.dependencies !== undefined) {
    const deps = parsed.dependencies as unknown;
    if (typeof deps !== "object" || deps === null || Array.isArray(deps)) {
      fieldErrors.push(
        "field `dependencies` must be an object with optional `scripts` and `styles` arrays (e.g. `\"dependencies\": { \"scripts\": [], \"styles\": [] }`). Got " + (Array.isArray(deps) ? "an array" : typeof deps) + ".",
      );
    } else {
      const depsObj = deps as Record<string, unknown>;
      const knownKeys = new Set(["scripts", "styles"]);
      const unknownKeys = Object.keys(depsObj).filter((k) => !knownKeys.has(k));
      const looksNpmShaped = unknownKeys.length > 0 &&
        unknownKeys.every((k) => typeof depsObj[k] === "string");
      if (looksNpmShaped) {
        fieldErrors.push(
          `field \`dependencies\` is npm-package-shaped (\`{ "${unknownKeys[0]}": "${String(depsObj[unknownKeys[0]])}" }\`). Mica's shape is \`{ "scripts": ["https://cdn.../lib.min.js"], "styles": ["https://cdn.../lib.css"] }\`. Replace each npm package with a verified CDN URL (run \`curl -sI -L "<url>" | head -1\` to confirm 200 before saving).`,
        );
      } else {
        if (depsObj.scripts !== undefined && (!Array.isArray(depsObj.scripts) || depsObj.scripts.some((s) => typeof s !== "string"))) {
          fieldErrors.push("field `dependencies.scripts` must be an array of URL strings.");
        }
        if (depsObj.styles !== undefined && (!Array.isArray(depsObj.styles) || depsObj.styles.some((s) => typeof s !== "string"))) {
          fieldErrors.push("field `dependencies.styles` must be an array of URL strings.");
        }
      }
    }
  }

  // Reject package.json-leak fields explicitly so the agent learns these
  // aren't part of the Mica schema. We don't strip them (the file might be
  // shared with non-Mica tooling), just surface the warning so the agent
  // knows they're noise.
  const packageJsonLeaks: string[] = [];
  if (typeof parsed.name === "string") packageJsonLeaks.push("`name`");
  if (typeof parsed.description === "string") packageJsonLeaks.push("`description`");
  if (typeof parsed.version === "string") packageJsonLeaks.push("`version`");
  if (packageJsonLeaks.length > 0) {
    fieldErrors.push(
      `metadata.json contains package.json-shaped fields (${packageJsonLeaks.join(", ")}) that Mica ignores. The Mica schema is: \`extension\`, \`badge\`, \`defaultTitle\`, \`primaryFile\` (optional), \`dependencies\` (optional, with \`scripts\`/\`styles\` arrays). Drop the package.json fields when next editing.`,
    );
  }

  if (fieldErrors.length > 0) {
    opts.onError?.(
      `\`${dirName}/metadata.json\` schema check failed:\n  • ${fieldErrors.join("\n  • ")}`,
    );
  }
}

// ── Decomposition consistency (decomposition.md ↔ plan.todo) ───
//
// The task-decomposer's tenet-12 gate (see _conventions.md) says:
// if either gate fails (no real seams OR fits in the parent's working
// set), write NO artifacts and return `declined: parent can inline`.
// Pre-Wave-1 prose let agents produce "Decision: Inline" + a plan.todo
// with @component-coder items — operationally resolved in favor of the
// dispatch queue, defeating the gate. Wave 1 prose collapsed the
// "BUT not for these reasons" sprawl, but the contradiction is still
// possible if a buggy/stale decomposer slips through. This validator
// catches the contradiction at write time so the agent self-corrects
// before subagents are dispatched.

const DECOMPOSITION_FILE_RX = /(?:^|\/)decomposition\.md$/;
const PLAN_TODO_FILE_RX = /(?:^|\/)(?:plan|tasks)\.todo$/;

/** Fires after writes to decomposition.md or plan.todo. Reads both files
 *  from the same directory and broadcasts a card-error if decomposition.md
 *  declares Decision: Inline AND plan.todo has `@component-coder` items in
 *  `## Active`. */
export async function enforceDecompositionConsistency(
  filename: string,
  projectDirAbsolute: string,
  opts: {
    onError?: (reason: string) => void;
  } = {},
): Promise<void> {
  const isDecomp = DECOMPOSITION_FILE_RX.test(filename);
  const isPlan = PLAN_TODO_FILE_RX.test(filename);
  if (!isDecomp && !isPlan) return;

  const { dirname, join, basename } = await import("path");
  const { readFile } = await import("fs/promises");

  // Both files should live in the same directory (canvas root). Look for
  // a sibling regardless of which one fired.
  const dir = dirname(filename);
  const decompPath = join(projectDirAbsolute, dir, "decomposition.md");
  // The plan file naming convention is project-driven — try both common names.
  const planCandidates = isPlan
    ? [join(projectDirAbsolute, dir, basename(filename))]
    : [join(projectDirAbsolute, dir, "plan.todo"), join(projectDirAbsolute, dir, "tasks.todo")];

  const decompText = await readFile(decompPath, "utf-8").catch(() => null);
  if (!decompText) return;

  let planText: string | null = null;
  for (const c of planCandidates) {
    const t = await readFile(c, "utf-8").catch(() => null);
    if (t) { planText = t; break; }
  }
  if (!planText) return;

  // Detect "Decision: Inline" — match the heading + look at the next ~200
  // chars for the verdict word. Tolerate variants ("Inline", "INLINE",
  // "Decision: Inline.").
  const decisionMatch = decompText.match(/##\s*Decision[^\n]*\n([\s\S]{0,300}?)(?=\n##\s|\n#\s|$)/i);
  if (!decisionMatch) return;
  const decisionBody = decisionMatch[1];
  const isInline = /\bInline\b/i.test(decisionBody) && !/\bDecompose\b/i.test(decisionBody);
  if (!isInline) return;

  // Detect @component-coder items in `## Active`.
  const activeMatch = planText.match(/##\s*Active[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  if (!activeMatch) return;
  const activeBody = activeMatch[1];
  const hasComponentCoderItems = /@component-coder\b/i.test(activeBody);
  if (!hasComponentCoderItems) return;

  opts.onError?.(
    "`decomposition.md` declares `Decision: Inline` but `plan.todo` has `@component-coder` items in `## Active` — these contradict. " +
    "Per tenet 12, Inline means no subagent dispatch (write nothing, return `declined: parent can inline`). " +
    "Fix one of:\n" +
    "  • If the gate genuinely passes both (real seams AND whole exceeds parent's working set): change `decomposition.md` to `Decision: Decompose` with reasoning that satisfies both gates.\n" +
    "  • If the gate fails: delete the `@component-coder` items from `plan.todo` (the parent will inline this work).\n" +
    "Reusable design memory, narrative cleanliness, and future flexibility are not gates — see `_conventions.md` § Decomposition gates for the full procedure.",
  );
}

// ── Dependency URL reachability (Tier 1) ──────────────────────
//
// The card-class-handbook skill mandates Tier-1 verification of every CDN
// URL in metadata.json.dependencies BEFORE saving. Smoke test 5
// (2026-04-29) showed the agent skipping this — picked stale Three.js
// URLs from training priors, hit a runtime error, picked NEW stale
// URLs (also 404), iterated without ever curling the URL. Each
// iteration burns a turn and produces a broken card.
//
// This validator runs server-side after every metadata.json write:
// fetches each declared URL with a short timeout, broadcasts a
// card-error listing failures so the agent fixes them before the
// browser ever loads the card. Results are cached briefly to avoid
// re-fetching the same URL across rapid metadata edits.

interface ReachabilityResult { ok: boolean; status: number; error?: string }
const DEP_REACHABILITY_TTL_MS = 10 * 60 * 1000;
const depReachabilityCache = new Map<string, { result: ReachabilityResult; checkedAt: number }>();

async function checkUrlReachable(url: string, timeoutMs = 5000): Promise<ReachabilityResult> {
  const cached = depReachabilityCache.get(url);
  if (cached && Date.now() - cached.checkedAt < DEP_REACHABILITY_TTL_MS) {
    return cached.result;
  }

  // Use HEAD where supported; some CDNs reject it, so fall back to a
  // ranged GET that pulls only the first byte. Either way we just need
  // the response status — the body content is checked elsewhere.
  let result: ReachabilityResult;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { method: "HEAD", redirect: "follow", signal: controller.signal });
      // Some CDNs return 405/501 for HEAD; retry with ranged GET.
      if (res.status === 405 || res.status === 501) {
        res = await fetch(url, {
          method: "GET",
          headers: { Range: "bytes=0-0" },
          redirect: "follow",
          signal: controller.signal,
        });
      }
    } finally {
      clearTimeout(timer);
    }
    result = { ok: res.ok || res.status === 206, status: res.status };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    result = { ok: false, status: 0, error: msg };
  }
  depReachabilityCache.set(url, { result, checkedAt: Date.now() });
  return result;
}

// Format check for `dependencies.scripts` URLs. <script> tags require UMD /
// classic-script format; an ESM module declared in metadata.scripts will
// fetch fine but the library's namespace will be undefined at runtime. This
// catches the mismatch at create-time with a prescriptive error.
//
// Cache shares the same TTL as reachability — both are about "what's at this
// URL right now" and invalidate together.
const FORMAT_HEAD_BYTES = 4096;
type ScriptFormat = "UMD" | "ESM" | "CommonJS" | "data" | "unknown" | "unchecked";
interface ScriptInfo {
  format: ScriptFormat;
  deprecation?: string;
}
const scriptFormatCache = new Map<string, { info: ScriptInfo; checkedAt: number }>();

async function checkScriptFormat(url: string, timeoutMs = 5000): Promise<ScriptInfo> {
  const cached = scriptFormatCache.get(url);
  if (cached && Date.now() - cached.checkedAt < DEP_REACHABILITY_TTL_MS) {
    return cached.info;
  }
  let info: ScriptInfo = { format: "unchecked" };
  try {
    // Late import — avoids a static import cycle (cardValidators is imported
    // from index.ts very early; inspectUrl pulls registry types that import
    // back into the agent-tools graph).
    const { detectFormat } = await import("./agentTools/inspectUrl.js");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { Range: `bytes=0-${FORMAT_HEAD_BYTES - 1}` },
        redirect: "follow",
        signal: controller.signal,
      });
      if (res.ok || res.status === 206) {
        const body = await res.text();
        const detected = detectFormat(body);
        info = {
          format: (detected.format ?? "unknown") as ScriptFormat,
          ...(detected.deprecation ? { deprecation: detected.deprecation } : {}),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Network failure during the format probe is non-fatal — reachability
    // check already covers "URL doesn't load." Leave format as "unchecked"
    // so the validator doesn't claim ESM on a probe failure.
    info = { format: "unchecked" };
  }
  scriptFormatCache.set(url, { info, checkedAt: Date.now() });
  return info;
}

/** Fetches every URL in `dependencies.scripts` and `dependencies.styles`
 *  and broadcasts a card-error listing any that don't return 200/206/3xx.
 *  Runs after metadata.json writes; returns silently when the file is
 *  unreadable or has no URL deps. */
export async function enforceDependenciesReachable(
  absolutePath: string,
  opts: {
    onError?: (reason: string) => void;
    onAdvisory?: (reason: string) => void;
  } = {},
): Promise<void> {
  const m = absolutePath.match(/\.mica\/card-classes\/([^/]+)\/metadata\.json$/);
  if (!m) return;
  const dirName = m[1];

  const { readFile, stat: fstat } = await import("fs/promises");
  let raw: string;
  try {
    const s = await fstat(absolutePath);
    if (!s.isFile()) return;
    raw = await readFile(absolutePath, "utf-8");
  } catch {
    return;
  }

  let parsed: { dependencies?: { scripts?: unknown; styles?: unknown } };
  try {
    parsed = JSON.parse(raw) as { dependencies?: { scripts?: unknown; styles?: unknown } };
  } catch {
    return; // JSON syntax errors are handled by enforceCardClassMetadata
  }

  const urls: Array<{ url: string; field: "scripts" | "styles" }> = [];
  const deps = parsed.dependencies;
  if (deps && typeof deps === "object") {
    if (Array.isArray(deps.scripts)) {
      for (const s of deps.scripts) {
        if (typeof s === "string" && /^https?:\/\//.test(s)) {
          urls.push({ url: s, field: "scripts" });
        }
      }
    }
    if (Array.isArray(deps.styles)) {
      for (const s of deps.styles) {
        if (typeof s === "string" && /^https?:\/\//.test(s)) {
          urls.push({ url: s, field: "styles" });
        }
      }
    }
  }
  if (urls.length === 0) return;

  const results = await Promise.all(
    urls.map(({ url, field }) => checkUrlReachable(url).then((r) => ({ url, field, ...r }))),
  );
  const failures = results.filter((r) => !r.ok);

  // For every reachable `scripts` URL, also check the format + deprecation.
  // A 200 OK with ESM contents is a silent failure mode — fetches fine but
  // the library's namespace is undefined at runtime. That's a blocker and
  // goes through onError.
  //
  // Deprecation strings (some UMD bundles emit `console.warn('...deprecated
  // ...')` in their head) are different: the URL works today, the global
  // is defined, the card renders. Surfacing it as a card-error puts the
  // agent into an investigation/iteration loop on a non-blocker. Routed
  // through onAdvisory (server-log only) so it stays observable without
  // pulling the agent off a working state.
  const reachableScripts = results.filter((r) => r.ok && r.field === "scripts");
  const formatChecks = await Promise.all(
    reachableScripts.map((r) => checkScriptFormat(r.url).then((info) => ({ ...r, ...info }))),
  );
  const esmInScripts = formatChecks.filter((r) => r.format === "ESM");
  const deprecatedScripts = formatChecks.filter((r) => r.format !== "ESM" && r.deprecation);

  if (failures.length === 0 && esmInScripts.length === 0 && deprecatedScripts.length === 0) return;

  const sections: string[] = [];
  const advisorySections: string[] = [];

  if (failures.length > 0) {
    const failureLines = failures
      .map((f) => {
        const detail = f.status === 0 ? f.error || "fetch failed" : `HTTP ${f.status}`;
        return `  • \`dependencies.${f.field}\`: ${f.url} — ${detail}`;
      })
      .join("\n");
    sections.push(
      `\`${dirName}/metadata.json\` declares dependency URLs that don't resolve:\n${failureLines}\n\n` +
      `Tier-1 verification (per the card-class-handbook skill) must pass BEFORE these go in metadata.json. ` +
      `Common causes: wrong version, missing \`@scope/\` prefix, wrong subpath. Look up the real URL via:\n` +
      `  • npm registry: \`curl -s https://registry.npmjs.org/<pkg>\` → \`dist-tags.latest\` + \`main\` field\n` +
      `  • jsdelivr file index: \`https://www.jsdelivr.com/package/npm/<pkg>\` lists every file in the published tarball`,
    );
  }

  if (esmInScripts.length > 0) {
    const esmLines = esmInScripts
      .map((f) => `  • \`dependencies.scripts\`: ${f.url} — detected ES module (top-level import/export)`)
      .join("\n");
    sections.push(
      `\`${dirName}/metadata.json\` declares ES-module URL(s) in \`dependencies.scripts\` — \`<script>\` tags require UMD / classic-script format, not ESM. The URL fetches fine but the library's namespace will be UNDEFINED at runtime (e.g. \`THREE\` is not declared on \`window\` because ES modules don't pollute globals).\n${esmLines}\n\n` +
      `Two fixes:\n` +
      `  1. PIN to a UMD-compatible version of the same library. Many libraries shipped UMD historically and dropped it later — check the jsdelivr file index (\`https://www.jsdelivr.com/package/npm/<pkg>\`) for older versions that include a non-module \`.js\` or \`.min.js\` build under \`/build/\` or \`/dist/\`. Verify with \`mica_inspect_url\` that \`format: 'UMD'\` before committing.\n` +
      `  2. REMOVE from \`metadata.scripts\` and load via dynamic import inside card.js (no metadata declaration needed):\n` +
      `       const NS = await import("<url>");\n` +
      `       // use NS.foo, NS.Bar, ...\n` +
      `     CARD_SHIM wraps card.js in an async function — top-level \`await\` works without any extra setup.\n\n` +
      `Library-specific notes:\n` +
      `  • Three.js dropped UMD after r147. Last UMD build: \`https://cdn.jsdelivr.net/npm/three@0.146.0/build/three.min.js\`. For >= r148, use dynamic import.\n` +
      `  • transformers.js / @xenova/* / lit / preact-signals: ESM-only — use dynamic import.`,
    );
  }

  if (deprecatedScripts.length > 0) {
    const depLines = deprecatedScripts
      .map((f) => `  • \`dependencies.scripts\`: ${f.url}\n    Deprecation notice from the bundle: "${(f.deprecation ?? "").slice(0, 240)}"`)
      .join("\n");
    advisorySections.push(
      `INFORMATIONAL — bundle deprecation notice on a working dependency. NOT a blocker; do NOT iterate if the card already renders.\n${depLines}\n\n` +
      `The URL resolves, the bundle loads as UMD, and the global is defined. The maintainers have flagged this specific build for future removal — at some later date the URL may stop serving UMD. Until that happens the card works.\n\n` +
      `If your most recent \`render_capture\` returned CLEAN or MATCHES, you are done — log this for awareness and stop. Don't switch versions or rewrite to Pattern B just to silence the warning.\n\n` +
      `When you DO address it (a separate task, not this one): pin to an earlier release of the same library that doesn't emit the warning, OR move to ESM via \`await import("<esm-url>")\` inside card.js with empty \`metadata.scripts\`.`,
    );
  }

  if (sections.length > 0) opts.onError?.(sections.join("\n\n"));
  if (advisorySections.length > 0) opts.onAdvisory?.(advisorySections.join("\n\n"));
}

// (former enforceCardClassPath retired. The regex-based wrong-path detector
// kept enumerating new failure shapes without catching the next one — every
// new project found a new shape (smoke test 3 hit `card-classes/<x>/` at
// canvas root; world clock hit `canvas/<x>.card/`; the regex caught one and
// missed the other). Path enforcement is now structural via mica_create_class
// in server/plugins/cardClassTools.ts: the agent expresses intent and the
// framework owns the path. The set of "wrong paths" becomes empty by
// construction, not by enumeration.)

/** Extract the post-write content from a write tool's input, if available.
 *  Returns null for partial-edit tools (edit_file with old_string/new_string)
 *  where we can't see the resulting file content cheaply — those are skipped. */
export function contentFromWriteInput(input: Record<string, unknown>): string | null {
  if (typeof input.content === "string") return input.content;
  // edit_file is a partial — validating new_string alone would yield false
  // positives (e.g. "no flowchart keyword" on a small fragment). Skip.
  return null;
}

// ── card.js lint ───────────────────────────────────────────────────────────
//
// Mica wraps card.js in `(async function(mica,_c){ <CARD_SHIM> <card.js> })()`
// — a function body, NOT a module. The agent's "syntax valid" verification
// (typically `node -c` or similar) parses card.js as a module or CommonJS
// script and clears patterns that fail in Mica's runtime: top-level
// `export`/`import`, function-declared-but-never-called wrappers, redeclared
// CARD_SHIM globals (`container`/`mica`), invented APIs (`Mica.registerCardClass`).
//
// Each detector below targets a pattern the card-class-handbook skill
// explicitly forbids. When a write produces card.js with one of these
// patterns, we surface a card-error broadcast — the chat agent sees it on
// its next turn and self-corrects before the user notices a broken card.

function _stripCommentsAndStrings(content: string): string {
  // Cheap-and-good-enough: strip /* */ and // comments. We don't strip
  // string literals — false positives from "export" inside a comment have
  // been removed; "export" inside a string literal is rare enough to ignore.
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function _detectModuleSyntax(content: string): string | null {
  const stripped = _stripCommentsAndStrings(content);
  // Top-level `export ...` — `export default X`, `export const`, `export {`, `export function`, etc.
  if (/^\s*export\s+(?:default|const|let|var|function|class|async\s+function|\{|\*)/m.test(stripped)) {
    return "card.js contains a top-level `export` statement. Mica wraps card.js in `(async function(mica,_c){…})()`, which is a function body — `export` is module-only syntax and throws `SyntaxError: Unexpected keyword 'export'` at script-parse time. Remove the export and write top-level code: just call functions or assign to variables. The runtime injects `container` and `mica` as globals; nothing needs exporting.";
  }
  // Top-level `import ...`
  if (/^\s*import\s+(?:[\w*{][^;]*from\s+)?["'][^"']+["']/m.test(stripped) ||
      /^\s*import\s*\(/.test(stripped)) {
    return "card.js contains a top-level `import` statement. Mica wraps card.js in a function body — `import` is module-only syntax and throws SyntaxError at script-parse time. List external libraries in `metadata.json.dependencies.scripts` (CDN URLs); they're loaded as global `<script>` tags before card.js runs. For Mica APIs, use the injected `mica` global directly — no import needed.";
  }
  return null;
}

function _detectInventedAPIs(content: string): string | null {
  if (/\bMica\.registerCardClass\s*\(/.test(content)) {
    return "card.js calls `Mica.registerCardClass(...)` — this API does NOT exist. Mica has no class-registration model. Remove the class wrapper and the registerCardClass call; write top-level code that uses `container` and `mica` directly (both injected as globals). See card-class-handbook/SKILL.md § FORBIDDEN.";
  }
  if (/\bthis\.context\.api\.\w+\s*\(/.test(content)) {
    return "card.js calls `this.context.api.X(...)` — this API does NOT exist. Mica injects `mica` as a global with `mica.files.*`, `mica.on`, etc. Read `.qwen/skills/card-class-handbook/SKILL.md` (or `.claude/skills/...`) for the actual API surface.";
  }
  if (/\bthis\.context\.template\b/.test(content)) {
    return "card.js references `this.context.template` — this property does NOT exist. card.html is loaded by the runtime separately; read it via DOM queries against `container` (e.g. `container.querySelector('#my-id')`).";
  }
  return null;
}

/** CARD_SHIM is the internal name of the wrapper-prelude STRING in
 *  src/whiteboard/CardRuntime.tsx — not a runtime global. The handbook uses
 *  the name to refer to the contract ("CARD_SHIM injects `container` and
 *  `mica`"), and agents sometimes mistake the name for a reference-able
 *  symbol, writing things like `CARD_SHIM.onInit(...)` or `if (CARD_SHIM)
 *  {...}`. At runtime the literal `CARD_SHIM` resolves to nothing and the
 *  card throws `ReferenceError: CARD_SHIM is not defined` at mount. Pre-write
 *  lint catches it as a same-turn tool error so the broken file never lands. */
function _detectCardShimLiteralReference(content: string): string | null {
  const stripped = _stripCommentsAndStrings(content);
  if (/\bCARD_SHIM\b/.test(stripped)) {
    return "card.js references the literal symbol `CARD_SHIM` — this is NOT a runtime global, it's the internal name we use in docs for the wrapper prelude that runs in CardRuntime.tsx. There are no `CARD_SHIM.onInit`, `CARD_SHIM.lifecycle`, or similar hooks. The shim's effect is invisible to card.js: it just makes `container` and `mica` available as globals, scopes `document.*` to the container, and auto-cleans timers/listeners on unmount. Remove every `CARD_SHIM` reference and use `container` / `mica` directly. For cleanup, register callbacks with `mica.onDestroy(() => ...)`.";
  }
  return null;
}

function _detectRedeclaredGlobals(content: string): string | null {
  const stripped = _stripCommentsAndStrings(content);
  if (/^\s*(?:const|let|var)\s+container\s*[=,;]/m.test(stripped)) {
    return "card.js has a top-level `const`/`let`/`var container = …` declaration. `container` is injected as a global by CARD_SHIM (it's THIS card's DOM root). Redeclaring it produces `SyntaxError: Cannot declare a const variable twice: 'container'` at mount time. Use a different name OR query inside it: `const mapEl = container.querySelector('#map');`.";
  }
  if (/^\s*(?:const|let|var)\s+mica\s*[=,;]/m.test(stripped)) {
    return "card.js has a top-level `const`/`let`/`var mica = …` declaration. `mica` is injected as a global by CARD_SHIM. Redeclaring it throws SyntaxError. Use a different name (e.g. `_mica`, or just access `mica` directly without binding it).";
  }
  return null;
}

/** Detects the "wrapper function declared but never invoked" pattern.
 *  card.js should be top-level code; wrapping it in `function createCard(container) {...}`
 *  declares the function but doesn't run it — the card mounts with a working
 *  HTML shell but no behavior. The chat agent typically reports this card as
 *  "verified" because the file parses successfully; only at runtime does the
 *  user notice "buttons don't do anything." Catching it at write time short-
 *  circuits that round-trip. */
function _detectWrappedNotCalled(content: string): string | null {
  const stripped = _stripCommentsAndStrings(content).trim();
  // Match `function NAME(...) { ... }` at file start.
  const m = stripped.match(/^function\s+(\w+)\s*\([^)]*\)\s*\{/);
  if (!m) return null;
  const fnName = m[1];
  // Find the matching closing brace by counting depth.
  const startBrace = stripped.indexOf("{");
  let depth = 0;
  let endIdx = -1;
  for (let i = startBrace; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx === -1) return null; // unbalanced — let the parse check catch it
  // What's after the closing brace at top level? If the file is just the
  // function declaration with no top-level invocation of it, the card is inert.
  const after = stripped.slice(endIdx + 1).trim();
  // Allow trailing whitespace/comments only — otherwise we'd false-positive
  // on files that have legitimate post-function code.
  if (after.length === 0) {
    return `card.js wraps everything in \`function ${fnName}(...) {…}\` but never calls it. Mica injects card.js as the body of \`(async function(mica,_c){…})()\`, so top-level code runs immediately — but a bare function declaration just declares; it doesn't run. The card will mount with the HTML shell but no behavior. Either remove the wrapper (write top-level code directly using the injected \`container\` and \`mica\` globals), OR convert to an IIFE so it runs: \`(function(){ /* your code */ })();\`. See card-class-handbook/SKILL.md § "✅ CORRECT — card.js runs as top-level code".`;
  }
  // If `after` exists but doesn't include a call to fnName, it's still suspect,
  // but more permissive than we want here — skip and let runtime handle it.
  return null;
}

/** Detects card.js that's essentially the unmodified skeleton — the agent
 *  copied the template but never replaced the placeholder behaviour.
 *
 *  Suppresses the broadcast for the transient post-`cp -r` state, where the
 *  agent has just copied the skeleton and is still in spec-design phase
 *  (no code added yet). Mirrors `enforceCardClassMetadata`'s placeholder
 *  handling: that state is normal and brief, broadcasting it as a red
 *  banner is spammy.
 *
 *  Fires the broadcast only when the agent has added substantive code
 *  AROUND the skeleton placeholder without removing it — that's the real
 *  failure mode (card.js with new logic but the placeholder render still
 *  obscuring it). Skeleton card.js has ~3 lines of real code; once the
 *  count exceeds ~5 and the markers are still there, the agent edited
 *  around them. */
function _detectUnmodifiedSkeleton(content: string): string | null {
  const SKELETON_HEADER = "// Card class skeleton — edit this file, do NOT write it from scratch.";
  const SKELETON_PLACEHOLDER = "bodyEl.textContent = content || '(empty)';";
  if (!content.includes(SKELETON_HEADER) || !content.includes(SKELETON_PLACEHOLDER)) {
    return null;
  }
  // Strip comments and count non-blank code lines. Skeleton has 3 real
  // lines: the bodyEl querySelector, the await mica.getContent(), and the
  // textContent assignment. Below ~5 we assume the file is still
  // essentially the unmodified skeleton (transient).
  const stripped = _stripCommentsAndStrings(content);
  const codeLines = stripped
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (codeLines.length <= 5) {
    return null; // unmodified skeleton — transient post-cp state, suppress
  }
  return "card.js still contains the skeleton's placeholder code (header comment + `bodyEl.textContent = content || '(empty)'`) AND has been edited with additional code. The card will mount but the placeholder render will still obscure your behavior. Per the card-class-handbook skill, the skeleton is the STARTING shape — REPLACE the placeholder lines with your logic, don't just edit around them. Specifically: remove the `bodyEl.textContent = content || '(empty)'` line and the typical-patterns comment block.";
}

function _detectParseError(content: string): string | null {
  // Mica's runtime wraps card.js in `(async function(mica,_c){…})()` — an
  // ASYNC function body. Use AsyncFunction (not the regular Function
  // constructor) so the parse test allows top-level `await` — which our
  // canonical card.js skeleton actually uses (`const x = await mica.getContent()`)
  // and which is valid in the runtime wrap. Earlier this validator used
  // `new Function(content)`, which doesn't allow top-level await and
  // produced false positives that the agent then "fixed" by mangling
  // valid code.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AsyncFunction = (async function () {}).constructor as any;
  try {
    new AsyncFunction(content);
    return null;
  } catch (e) {
    const msg = (e as Error).message;
    // export/import errors are caught with specific messages above; if we
    // reach here for those, fall through.
    if (/Unexpected (?:keyword|token) ['"]?(?:export|import)/.test(msg)) return null;
    return `card.js fails to parse as an async function body: ${msg}. Mica wraps card.js in \`(async function(mica,_c){…})()\`, so the file content must be valid as an async function body. Common causes: unbalanced braces, stray top-level keywords (\`return\` outside a function — though \`await\` IS fine at top level since the wrapper is async), accidentally pasted shell/HTML content, or an extra closing brace at the end of the file.`;
  }
}

/** Lint a card class's `card.js` after a write. Surfaces specific Mica-runtime
 *  violations as `card-error` broadcasts so the chat agent self-corrects on
 *  its next turn. Mirrors `enforceCardClassMetadata`'s shape: file-watcher
 *  driven, post-write, can't BLOCK the write but the post-write feedback loop
 *  is fast enough that the user rarely sees the bad card. */
/** Pure content-only lint: takes the proposed card.js text, returns the
 *  first lint error or null. Used by both the post-write file-watcher
 *  validator (enforceCardJsLint) and the pre-write tool gate
 *  (mica_edit_class_file). Identical detector chain so post-write and
 *  pre-write paths agree on what's a lint failure. */
export function lintCardJsContent(content: string): string | null {
  // Run checks in priority order. First hit wins so the most specific
  // message reaches the agent (e.g. "you have an export" beats the generic
  // parse-error fallback that triggers on the same file).
  const checks: Array<(c: string) => string | null> = [
    _detectModuleSyntax,
    _detectInventedAPIs,
    _detectCardShimLiteralReference,
    _detectRedeclaredGlobals,
    _detectWrappedNotCalled,
    _detectUnmodifiedSkeleton,
    _detectParseError,
  ];
  for (const check of checks) {
    const reason = check(content);
    if (reason) return reason;
  }
  return null;
}

export async function enforceCardJsLint(
  absolutePath: string,
  opts: {
    onError?: (reason: string) => void;
  } = {},
): Promise<void> {
  const m = absolutePath.match(/\.mica\/card-classes\/([^/]+)\/card\.js$/);
  if (!m) return;
  const dirName = m[1];

  const { readFile, stat } = await import("fs/promises");
  let content: string;
  try {
    const s = await stat(absolutePath);
    if (!s.isFile()) return;
    content = await readFile(absolutePath, "utf-8");
  } catch {
    return; // deleted / unreadable — nothing to lint
  }

  const reason = lintCardJsContent(content);
  if (reason) opts.onError?.(`\`${dirName}/card.js\` lint failed: ${reason}`);
}
