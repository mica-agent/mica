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

/** Extract the post-write content from a write tool's input, if available.
 *  Returns null for partial-edit tools (edit_file with old_string/new_string)
 *  where we can't see the resulting file content cheaply — those are skipped. */
export function contentFromWriteInput(input: Record<string, unknown>): string | null {
  if (typeof input.content === "string") return input.content;
  // edit_file is a partial — validating new_string alone would yield false
  // positives (e.g. "no flowchart keyword" on a small fragment). Skip.
  return null;
}
