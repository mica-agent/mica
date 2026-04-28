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
import { WORKSPACE_DIR, micaDir } from "./files.js";

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
    const projPath = join(WORKSPACE_DIR, project, ".mica", "card-classes", ext, "validate.js");
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
const CREATE_CARD_CLASS_SKILL_RX = /\.(?:qwen|claude)\/skills\/create-card-class\/SKILL\.md$/;

/** If `filePath` is a card-class authoring file and the create-card-class skill
 *  hasn't been read in `readFiles`, returns the deny reason. Otherwise null. */
export function checkCardClassPrecondition(
  filePath: string,
  readFiles: Set<string>,
): string | null {
  if (!CARD_CLASS_FILE_RX.test(filePath)) return null;
  for (const p of readFiles) {
    if (CREATE_CARD_CLASS_SKILL_RX.test(p)) return null;
  }
  return "Read `.qwen/skills/create-card-class/SKILL.md` (or `.claude/skills/create-card-class/SKILL.md` for Claude) before writing card class code. The Mica API surface (mica.files.*, mica.openChannel, channel sessions, file events) is documented there. Improvising leads to invented endpoints, wrong field names (e.g. file.name vs file.path), and fictional registries (e.g. Mica.registerCardClass — does not exist). Read the skill, then retry.";
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
      // the create-card-class skill) catches it on the authoring side
      // before the work continues, so the framework doesn't need to alarm.
      // We don't auto-rewrite the placeholder because the framework can't
      // know what `extension` / `defaultTitle` the user wants — only the
      // mismatch path below has a known authoritative value (the dir name).
      opts.onAutoFix?.(
        `\`${dirName}/metadata.json\` still has skeleton placeholders (\`extension: ".${bare}"\`${typeof parsed.defaultTitle === "string" && /REPLACE_ME/i.test(parsed.defaultTitle) ? `, \`defaultTitle: "${parsed.defaultTitle}"\`` : ""}) — agent should replace these per the create-card-class skill's STEP 0.`,
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
  }
}

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
// Each detector below targets a pattern the create-card-class skill
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
    return "card.js calls `Mica.registerCardClass(...)` — this API does NOT exist. Mica has no class-registration model. Remove the class wrapper and the registerCardClass call; write top-level code that uses `container` and `mica` directly (both injected as globals). See create-card-class/SKILL.md § FORBIDDEN.";
  }
  if (/\bthis\.context\.api\.\w+\s*\(/.test(content)) {
    return "card.js calls `this.context.api.X(...)` — this API does NOT exist. Mica injects `mica` as a global with `mica.files.*`, `mica.on`, etc. Read `.qwen/skills/create-card-class/SKILL.md` (or `.claude/skills/...`) for the actual API surface.";
  }
  if (/\bthis\.context\.template\b/.test(content)) {
    return "card.js references `this.context.template` — this property does NOT exist. card.html is loaded by the runtime separately; read it via DOM queries against `container` (e.g. `container.querySelector('#my-id')`).";
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
    return `card.js wraps everything in \`function ${fnName}(...) {…}\` but never calls it. Mica injects card.js as the body of \`(async function(mica,_c){…})()\`, so top-level code runs immediately — but a bare function declaration just declares; it doesn't run. The card will mount with the HTML shell but no behavior. Either remove the wrapper (write top-level code directly using the injected \`container\` and \`mica\` globals), OR convert to an IIFE so it runs: \`(function(){ /* your code */ })();\`. See create-card-class/SKILL.md § "✅ CORRECT — card.js runs as top-level code".`;
  }
  // If `after` exists but doesn't include a call to fnName, it's still suspect,
  // but more permissive than we want here — skip and let runtime handle it.
  return null;
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

  // Run checks in priority order. First hit wins so the most specific
  // message reaches the agent (e.g. "you have an export" beats the generic
  // parse-error fallback that triggers on the same file).
  const checks: Array<(c: string) => string | null> = [
    _detectModuleSyntax,
    _detectInventedAPIs,
    _detectRedeclaredGlobals,
    _detectWrappedNotCalled,
    _detectParseError,
  ];

  for (const check of checks) {
    const reason = check(content);
    if (reason) {
      opts.onError?.(`\`${dirName}/card.js\` lint failed: ${reason}`);
      return;
    }
  }
}
