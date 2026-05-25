// Card-class CRUD tools — exposed to the agent via SDK MCP server. Replaces
// the path-juggling failure mode where the agent uses raw write_file with
// hand-constructed paths and frequently picks the wrong location, wrong
// directory-name shape, or wrong metadata.json shape. With these tools the
// agent expresses intent (name, badge, scripts, content); the framework
// owns paths and shapes by construction. The set of "wrong paths" is
// empty, not enumerated.

import { join } from "path";
import { mkdir, writeFile, readFile, rm, readdir, stat, access } from "fs/promises";
import { runVerifiers, formatVerifyFailure } from "../verifiers/index.js";
import { existsSync } from "fs";
import { z } from "zod";
import { WORKSPACE_DIR, micaDir, readCanvasConfig, clearCardClassMetaCache, findCardClassInLibraries } from "../files.js";
import { lintCardJsContent } from "../cardValidators.js";
import { readSpecForClass, urlFromDep, type ParsedSpec } from "../specFrontmatter.js";

// SDK loader — these are populated lazily once micaAgent loads the SDK.
// We don't import them statically because cardClassTools.ts is loaded at
// startup but the SDK may not be available until the first agent turn.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _tool: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _createSdkMcpServer: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function bindSdk(tool: any, createSdkMcpServer: any): void {
  _tool = tool;
  _createSdkMcpServer = createSdkMcpServer;
}

// ── Validation helpers ─────────────────────────────────────────────

const NAME_RX = /^[a-z][a-z0-9-]*$/;

function normalizeName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return { ok: false, error: "name is required" };
  // Auto-normalize light cases: lowercase + spaces-to-dashes + strip leading dot.
  const candidate = trimmed.replace(/^\./, "").toLowerCase().replace(/\s+/g, "-");
  if (!NAME_RX.test(candidate)) {
    return { ok: false, error: `name "${raw}" is not a valid identifier — use lowercase alphanumeric + dashes only (e.g. "world-clock", "burndown", "stopwatch")` };
  }
  if (candidate.includes(".")) {
    return { ok: false, error: `name "${raw}" contains a dot — directory names cannot have dots. Did you mean to set the extension separately?` };
  }
  return { ok: true, name: candidate };
}

function normalizeExtension(raw: string | undefined, name: string): string {
  const e = String(raw || "").trim();
  if (!e) return "." + name;
  return e.startsWith(".") ? e : "." + e;
}

function projectDir(project: string): string {
  return join(WORKSPACE_DIR, project);
}

function classDir(project: string, name: string): string {
  return join(micaDir(project), "card-classes", name);
}

// ── Tool: mica_create_class ────────────────────────────────────────

export const createClassSchema = {
  name: z.string().describe("Card class identifier (becomes the directory name and, by default, the file extension). Lowercase alphanumeric + dashes only — e.g. \"world-clock\", \"burndown\". No dots. THIS IS THE ONLY REQUIRED FIELD. When `canvas/<name>-spec.md` has YAML frontmatter at its top (a `---`-delimited `card-class:` block per card-class-handbook § \"Spec format\"), Mica reads the other fields (badge, defaultTitle, scripts, styles, handler, sidecar, primaryFile) from there — you can call this tool with just `{ name }` and the spec frontmatter fills the rest. Explicit args still win over frontmatter when both are present."),
  badge: z.string().optional().describe("1-4 character abbreviation shown on the card's title bar (e.g. \"WCK\", \"BRN\"). Defaults to the first 3 letters of name, uppercase."),
  defaultTitle: z.string().optional().describe("Human-readable card title (e.g. \"World Clock\", \"Burndown\"). Defaults to title-cased name (\"world-clock\" → \"World Clock\")."),
  displayName: z.string().optional().describe("Human-friendly name shown on the canvas toolbar's create-card button tooltip and in class-picker surfaces (e.g. \"Qwen Code\", \"Claude Code\", \"Open Code\"). Independent of defaultTitle — defaultTitle is what each card instance calls itself in its title bar; displayName is what the CLASS is called on meta UI surfaces. Optional; when absent the toolbar falls back to a generic tooltip."),
  extension: z.string().optional().describe("File extension instances will use, with leading dot. Defaults to '.' + name. Override only when the extension differs from the directory name (rare)."),
  card_html: z.string().optional().describe("Full contents of card.html. If omitted, a minimal skeleton is written so subsequent edits land on the correct path. card.html is a FRAGMENT, not a full HTML document — no <!DOCTYPE>, no <html>, no <script src=\"card.js\">."),
  card_js: z.string().optional().describe("Full contents of card.js. If omitted, a minimal stub is written. card.js runs as a top-level script (NOT a module) — no import/export statements; the CARD_SHIM provides `mica`, `container`, etc. as globals."),
  card_css: z.string().optional().describe("Full contents of card.css (optional)."),
  scripts: z.array(z.string()).optional().describe("UMD-formatted CDN URLs to load before card.js runs. Use cdn.jsdelivr.net (every npm package has a jsDelivr URL by default). Each library exposes a window global the card.js can call directly."),
  styles: z.array(z.string()).optional().describe("CSS CDN URLs to load."),
  handler: z.string().optional().describe("Optional metadata.handler value to route this card class to a built-in channel handler (e.g. 'llm-direct', 'llm-agent'). Discover available handlers via GET /api/handlers."),
  primaryFile: z.string().optional().describe("Optional. Used by container-style card classes whose instance is a directory containing a specific filename — e.g. '.todo' classes whose instance dirs contain plan.todo."),
  sidecar: z.object({
    entry: z.string().describe("Path inside the card-class directory to the sidecar entry script. Extension picks the runtime: '.py' → Python, '.ts'/'.tsx' → tsx (Mica's TypeScript runner), '.js'/'.mjs' → node."),
    ready_path: z.string().optional().describe("HTTP path Mica probes for ready (must return 200 once the sidecar is serving real traffic). Default '/health'."),
    ready_timeout_ms: z.number().optional().describe("Max ms Mica waits for the ready_path to first respond. Default 30000. Bump for heavy first-load (model downloads / GPU init)."),
    python: z.string().optional().describe("Python sidecars only: 'system' (default, /usr/bin/python3) | 'voice-venv' (Parakeet/Kokoro shared venv) | absolute path to a python interpreter."),
    interpreter: z.string().optional().describe("Optional absolute-path explicit override of the interpreter. Wins over extension auto-detect. Use for per-card venvs (e.g. '.mica/card-classes/<name>/.venv/bin/python')."),
  }).optional().describe("Declare a card-class-private HTTP sidecar. When set, Mica spawns the entry script on first call from card.js (via mica.fetch('mica-internal://card-server/<path>')) and manages its lifecycle. Pass this AS AN OBJECT, not a JSON string. See card-class-handbook § Card-class-private sidecars for the full schema and authoring pattern."),
};

export async function createClassImpl(
  project: string,
  args: z.infer<z.ZodObject<typeof createClassSchema>>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const nameResult = normalizeName(args.name);
  if (!nameResult.ok) {
    return { isError: true, content: [{ type: "text", text: nameResult.error }] };
  }
  const name = nameResult.name;

  // Spec-frontmatter fallback: when canvas/<name>-spec.md has a YAML
  // frontmatter block at its top, read structured fields from there and
  // use them as defaults for any args the caller didn't pass. This
  // collapses the spec → tool-call translation step: the agent writes
  // the structured data ONCE in the spec, mica_create_class reads it
  // directly. Caller's explicit args still win (override). Specs without
  // frontmatter parse to null — backward compatible with the prior shape
  // where the agent had to pass every field to mica_create_class.
  let parsedSpec: ParsedSpec | null = null;
  try {
    parsedSpec = await readSpecForClass(projectDir(project), name);
  } catch {
    // Spec read failed — treat as no frontmatter. The canvasHasSpecForClass
    // predicate handles missing-spec separately; we don't fail closed here.
  }
  if (parsedSpec?.parseError) {
    return {
      isError: true,
      content: [{
        type: "text",
        text:
          `Spec frontmatter at canvas/${name}-spec.md has a YAML syntax error:\n  ${parsedSpec.parseError}\n\n` +
          `Fix the YAML block at the top of the spec (between \`---\` delimiters), then retry. ` +
          `Common issues: unquoted strings containing colons, mixed tabs/spaces, missing dashes for list items.`,
      }],
    };
  }
  const fm = parsedSpec?.cardClass ?? null;

  const extension = normalizeExtension(args.extension, name);

  // Auto-default chain: caller's explicit arg → spec frontmatter → derived
  // default. Each successive layer fills in only what the prior left empty.
  // Local/weak models often can't reliably construct multiple string params
  // on one tool call; with frontmatter populated, the agent can call
  // mica_create_class with just { name } and Mica fills everything else.
  const badgeRaw = String(args.badge ?? fm?.badge ?? "").trim();
  const badge = badgeRaw || name.replace(/-/g, "").slice(0, 4).toUpperCase();
  if (badge.length > 4) return { isError: true, content: [{ type: "text", text: `badge "${badge}" too long — keep it 1-4 chars` }] };

  const defaultTitleRaw = String(args.defaultTitle ?? fm?.default_title ?? "").trim();
  const defaultTitle = defaultTitleRaw || name
    .split("-")
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");

  // Optional: explicit displayName for toolbar / class-picker surfaces.
  // No default — when absent, the toolbar uses its generic fallback.
  const displayNameRaw = String(args.displayName ?? fm?.display_name ?? "").trim();
  const displayName = displayNameRaw || undefined;

  // Pre-merge the remaining frontmatter-eligible fields so downstream code
  // (existing-class diff, metadata-build, recovery path) reads from a
  // single resolved snapshot. Bare-string URLs and structured
  // {url, format, version} entries both collapse to plain string arrays
  // via urlFromDep for compatibility with the existing metadata.json shape.
  // `umd_scripts` is the frontmatter slot for `<script>`-tag-loaded CDN
  // URLs. The name is explicit about format so the agent can't put ESM
  // URLs here by mistake (no ambiguous "scripts" slot to misuse). ESM
  // libraries are loaded inside card.js via `await import(url)`; they
  // have no frontmatter slot because they don't write into metadata.json.
  const resolvedScripts: string[] | undefined =
    args.scripts ?? (fm?.dependencies?.umd_scripts?.map(urlFromDep));
  const resolvedStyles: string[] | undefined =
    args.styles ?? (fm?.dependencies?.styles?.map(urlFromDep));
  const resolvedHandler: string | undefined = args.handler ?? fm?.handler;
  const resolvedPrimaryFile: string | undefined = args.primaryFile ?? fm?.primary_file;
  const resolvedSidecar = args.sidecar ?? fm?.sidecar;

  // Idempotency + in-place metadata update:
  //   - Dir exists, metadata.json missing/corrupt → REGENERATE it (recovery).
  //   - Existing extension differs → REFUSE (changing extension renames the
  //     class, which would orphan existing instance files — that's a delete-
  //     and-recreate operation, not an update).
  //   - Existing extension matches → fall through to overwrite metadata.json
  //     with the new args. This lets the agent re-call mica_create_class to
  //     change badge / defaultTitle / dependencies / scripts / styles /
  //     handler / primaryFile WITHOUT delete-then-recreate (which wastes
  //     5+ tool calls and forces re-writing card.html/js from scratch since
  //     the new class starts with stubs).
  //   The fall-through path below writes metadata.json unconditionally;
  //   card.html/card.js/card.css are only touched if the agent passed
  //   explicit content (existing files are preserved).
  const dir = classDir(project, name);
  const metadataPath = join(dir, "metadata.json");
  let updateChanges: string[] | null = null;
  if (existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(await readFile(metadataPath, "utf-8")) as {
        extension?: string;
        badge?: string;
        defaultTitle?: string;
        displayName?: string;
        dependencies?: { scripts?: string[]; styles?: string[] };
        handler?: string;
        primaryFile?: string;
        sidecar?: Record<string, unknown>;
      };
      if (existing.extension !== extension) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `Card class "${name}" already exists at ${dir} with extension "${existing.extension}". You're trying to set extension "${extension}". Changing the extension renames the routing key and would orphan existing instance files. To rename: (a) delete via mica_delete_class, (b) rename instance files to the new extension, (c) recreate. To change other fields (badge/defaultTitle/dependencies/scripts/styles/handler/primaryFile), call mica_create_class again with the SAME extension and the new values — metadata.json updates in place without disturbing card.html/card.js/card.css.`,
          }],
        };
      }
      // Extension matches. Compute the diff for a clear return message.
      const changes: string[] = [];
      if (existing.badge !== badge) changes.push(`badge "${existing.badge}" → "${badge}"`);
      if (existing.defaultTitle !== defaultTitle) changes.push(`defaultTitle "${existing.defaultTitle}" → "${defaultTitle}"`);
      if ((existing.displayName ?? "") !== (displayName ?? "")) changes.push(`displayName "${existing.displayName ?? ""}" → "${displayName ?? ""}"`);
      const exScripts = (existing.dependencies?.scripts ?? []).join(",");
      const nwScripts = (resolvedScripts ?? []).join(",");
      if (exScripts !== nwScripts) changes.push(`scripts (${(existing.dependencies?.scripts ?? []).length} → ${(resolvedScripts ?? []).length})`);
      const exStyles = (existing.dependencies?.styles ?? []).join(",");
      const nwStyles = (resolvedStyles ?? []).join(",");
      if (exStyles !== nwStyles) changes.push(`styles (${(existing.dependencies?.styles ?? []).length} → ${(resolvedStyles ?? []).length})`);
      if ((existing.handler ?? "") !== (resolvedHandler ?? "")) changes.push(`handler "${existing.handler ?? ""}" → "${resolvedHandler ?? ""}"`);
      if ((existing.primaryFile ?? "") !== (resolvedPrimaryFile ?? "")) changes.push(`primaryFile "${existing.primaryFile ?? ""}" → "${resolvedPrimaryFile ?? ""}"`);
      const exSidecar = existing.sidecar ? JSON.stringify(existing.sidecar) : "";
      const nwSidecar = resolvedSidecar ? JSON.stringify(resolvedSidecar) : "";
      if (exSidecar !== nwSidecar) changes.push(`sidecar (${exSidecar ? "set" : "unset"} → ${nwSidecar ? "set" : "unset"})`);
      updateChanges = changes;
    } catch { /* metadata corrupt — fall through to recovery write below */ }
  }

  // Build metadata.json from typed inputs — agent never writes JSON shape
  // directly. Only Mica-recognized fields land in the file. resolvedX
  // values already incorporated frontmatter fallback above.
  const metadata: Record<string, unknown> = {
    extension,
    badge,
    defaultTitle,
    dependencies: {
      scripts: resolvedScripts ?? [],
      styles: resolvedStyles ?? [],
    },
  };
  if (displayName) metadata.displayName = displayName;
  if (resolvedHandler) metadata.handler = resolvedHandler;
  if (resolvedPrimaryFile) metadata.primaryFile = resolvedPrimaryFile;
  if (resolvedSidecar) metadata.sidecar = resolvedSidecar;

  await mkdir(dir, { recursive: true });
  // Always write metadata (this is the recovery target — partial states or
  // heredoc bypasses commonly leave card.* files with missing/corrupt
  // metadata.json).
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf-8");

  // For card.html / card.js / card.css: if the agent passed explicit content,
  // write it. If they didn't AND the file is missing, write a minimal stub.
  // If they didn't AND the file exists, LEAVE IT ALONE — the recovery path
  // must not clobber prior content.
  const htmlPath = join(dir, "card.html");
  const jsPath = join(dir, "card.js");
  const cssPath = join(dir, "card.css");
  if (typeof args.card_html === "string") {
    await writeFile(htmlPath, args.card_html, "utf-8");
  } else if (!existsSync(htmlPath)) {
    // Canonical card.html stub — pairs with the canonical card.js below.
    // Working counter the agent can edit in place, so the first render is
    // a real card and not a placeholder.
    await writeFile(
      htmlPath,
      `<div class="card-${name}">\n  <h2 class="title">${defaultTitle}</h2>\n  <p class="count">0</p>\n  <button type="button">+</button>\n</div>\n`,
      "utf-8",
    );
  }
  if (typeof args.card_js === "string") {
    await writeFile(jsPath, args.card_js, "utf-8");
  } else if (!existsSync(jsPath)) {
    // Canonical card.js stub — six-step shape from card-class-handbook
    // SKILL.md § "CANONICAL CARD.JS". Demonstrates the pattern with a
    // working counter; agent edits the body of `render()` and step 5
    // (timers / library teardown) instead of writing card.js from scratch.
    // Imitation beats remembered rules — the stub is the spec.
    await writeFile(
      jsPath,
      [
        `// ${defaultTitle} — canonical card.js shape.`,
        `// Edit the render() body and step 5 (teardown) for your card's behavior.`,
        ``,
        `// 1. Query into container (the CARD_SHIM-injected DOM root).`,
        `const countEl = container.querySelector('.count');`,
        `const btnEl   = container.querySelector('button');`,
        ``,
        `// 2. Script-scoped state.`,
        `let count = 0;`,
        ``,
        `// 3. Functions at script scope. No IIFE, no import/export.`,
        `function render() {`,
        `  countEl.textContent = String(count);`,
        `}`,
        ``,
        `// 4. DOM events on container or its descendants (auto-cleaned on unmount).`,
        `btnEl.addEventListener('click', () => {`,
        `  count += 1;`,
        `  render();`,
        `});`,
        ``,
        `// 5. Anything that needs explicit teardown → mica.onDestroy.`,
        `// (Empty for this counter; add timers, library disposers, etc. here.)`,
        `mica.onDestroy(() => {});`,
        ``,
        `// 6. First render at the bottom.`,
        `render();`,
        ``,
      ].join("\n"),
      "utf-8",
    );
  }
  if (typeof args.card_css === "string") {
    await writeFile(cssPath, args.card_css, "utf-8");
  }

  // Invalidate the metadata cache so the next /api/files / file-watcher read
  // sees the new class immediately, not a stale "missing" result.
  clearCardClassMetaCache();

  const writtenFiles = ["metadata.json", "card.html", "card.js", ...(typeof css === "string" ? ["card.css"] : [])];
  const stubsUsed = [
    args.card_html ? null : "card.html",
    args.card_js ? null : "card.js",
  ].filter(Boolean) as string[];

  const isUpdate = updateChanges !== null;
  const verb = isUpdate
    ? (updateChanges!.length > 0 ? "Updated card class" : "Re-wrote card class (no metadata changes)")
    : `Created card class`;

  return {
    content: [{
      type: "text",
      text: [
        `${verb} "${name}" at .mica/card-classes/${name}/`,
        `  extension: ${extension}`,
        `  badge: ${badge}`,
        `  files: ${writtenFiles.join(", ")}`,
        isUpdate && updateChanges!.length > 0 ? `  metadata changes: ${updateChanges!.join("; ")}` : "",
        isUpdate ? `  card.html/card.js/card.css preserved (only touched when explicit content passed).` : "",
        !isUpdate && stubsUsed.length > 0 ? `  stubs (edit to fill in): ${stubsUsed.join(", ")}` : "",
        ``,
        !isUpdate ? `Create instances with mica_create_card_instance({ class_extension: "${extension}", filename: "<bare-name>" }).` : "",
        !isUpdate && stubsUsed.length > 0 ? `If you used stubs, edit them now via mica_edit_class_file:` : "",
        !isUpdate && stubsUsed.length > 0 ? `  ${join(dir, "card.html")}` : "",
        !isUpdate && stubsUsed.length > 0 ? `  ${join(dir, "card.js")}` : "",
      ].filter(Boolean).join("\n"),
    }],
  };
}

// ── Tool: mica_create_card_instance ────────────────────────────────

export const createInstanceSchema = {
  class_extension: z.string().describe("Extension of the card class to instantiate, with leading dot (e.g. '.world-clock'). Class must already exist (use mica_create_class first if needed)."),
  filename: z.string().describe("Bare filename for the instance, no extension. The class extension is appended automatically. E.g. 'tokyo' for a world-clock instance becomes 'canvas/tokyo.world-clock'."),
  parent: z.string().optional().describe("Optional sub-folder under canvasRoot to place the instance in (e.g. 'cities'). Defaults to canvasRoot itself."),
  content: z.string().optional().describe("Optional initial content for the instance file. Defaults to empty string."),
};

export async function createInstanceImpl(
  project: string,
  args: z.infer<z.ZodObject<typeof createInstanceSchema>>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const ext = normalizeExtension(args.class_extension, "").toLowerCase();
  const className = ext.replace(/^\./, "");
  if (!className) return { isError: true, content: [{ type: "text", text: "class_extension is required" }] };

  // Verify the class exists (project-scoped first, then built-in).
  const projectClassDir = join(micaDir(project), "card-classes", className);
  const builtinClassDir = join(process.cwd(), "card-classes", className);
  const exists = existsSync(join(projectClassDir, "metadata.json")) || existsSync(join(builtinClassDir, "metadata.json"));
  if (!exists) {
    return {
      isError: true,
      content: [{ type: "text", text: `No card class found for extension "${ext}". Create it first via mica_create_class, or check mica_list_classes for available extensions.` }],
    };
  }

  const baseName = String(args.filename || "").trim();
  if (!baseName) return { isError: true, content: [{ type: "text", text: "filename is required" }] };
  if (baseName.includes("/")) return { isError: true, content: [{ type: "text", text: `filename "${baseName}" cannot contain '/' — use the parent arg for sub-folders` }] };
  if (baseName.endsWith(ext)) {
    return { isError: true, content: [{ type: "text", text: `filename "${baseName}" already includes the extension. Pass just the bare name; the extension is appended automatically.` }] };
  }

  const cfg = await readCanvasConfig(project);
  const subdir = (args.parent || "").replace(/^\/+|\/+$/g, "");
  const projectRelative = subdir
    ? `${cfg.canvasRoot}/${subdir}/${baseName}${ext}`
    : `${cfg.canvasRoot}/${baseName}${ext}`;
  const absPath = join(projectDir(project), projectRelative);

  // Idempotency: if the file already exists, treat the call as a no-op
  // success when the existing content matches (or when no content was
  // requested). Returning isError: true on "already exists" caused tight
  // retry loops — agents read the error as a transient failure, retry with
  // identical args, get the same error, retry again. Observed in production:
  // 176 consecutive calls in one session, agent never converged. Match
  // mica_create_class's existing idempotency pattern (above, line 119).
  if (existsSync(absPath)) {
    const requested = args.content ?? "";
    let existing = "";
    try {
      const { readFile } = await import("fs/promises");
      existing = await readFile(absPath, "utf-8");
    } catch { /* unreadable — fall through to mismatch-style report */ }
    if (requested === "" || existing === requested) {
      return {
        content: [{
          type: "text",
          text: `Card instance "${projectRelative}" already exists. No-op (idempotent).\n  class: ${className} (${ext})\n  absolute path: ${absPath}\n\nIf you wanted to replace its content, edit the file directly via write_file or call mica_delete_card_instance first.`,
        }],
      };
    }
    return {
      isError: true,
      content: [{ type: "text", text: `Instance "${projectRelative}" already exists with different content. Delete via mica_delete_card_instance to replace, or pick a different filename.` }],
    };
  }

  await mkdir(join(absPath, ".."), { recursive: true });
  await writeFile(absPath, args.content ?? "", "utf-8");

  return {
    content: [{
      type: "text",
      text: `Created card instance at ${projectRelative}\n  class: ${className} (${ext})\n  absolute path: ${absPath}\n\nThe canvas card-class resolver will pick it up on the next render.`,
    }],
  };
}

// ── Tool: mica_delete_card_instance ─────────────────────────────────

export const deleteInstanceSchema = {
  filename: z.string().describe("Project-relative path of the instance file to delete (e.g. 'canvas/tokyo.world-clock'). Or canvas-relative bare name; framework canonicalizes."),
};

export async function deleteInstanceImpl(
  project: string,
  args: z.infer<z.ZodObject<typeof deleteInstanceSchema>>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const cfg = await readCanvasConfig(project);
  const raw = String(args.filename || "").trim();
  if (!raw) return { isError: true, content: [{ type: "text", text: "filename is required" }] };

  // Canonicalize: project-relative if it already starts with canvasRoot/, otherwise prepend canvasRoot.
  const projectRelative = raw.startsWith(cfg.canvasRoot + "/") || raw === cfg.canvasRoot
    ? raw
    : `${cfg.canvasRoot}/${raw}`;
  const absPath = join(projectDir(project), projectRelative);

  if (!existsSync(absPath)) {
    return { isError: true, content: [{ type: "text", text: `Instance "${projectRelative}" does not exist (looked at ${absPath}).` }] };
  }
  const s = await stat(absPath);
  if (!s.isFile()) {
    return { isError: true, content: [{ type: "text", text: `"${projectRelative}" is not a file. mica_delete_card_instance only deletes regular instance files.` }] };
  }

  await rm(absPath);
  return { content: [{ type: "text", text: `Deleted card instance ${projectRelative}.` }] };
}

// ── Tool: mica_delete_class ────────────────────────────────────────

export const deleteClassSchema = {
  name: z.string().describe("Card class name (directory name, no dot). Same name used in mica_create_class."),
  force: z.boolean().optional().describe("If true, delete even when instance files of this class exist. Default false: refuse and list the instances so the agent can decide."),
};

export async function deleteClassImpl(
  project: string,
  args: z.infer<z.ZodObject<typeof deleteClassSchema>>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const nameResult = normalizeName(args.name);
  if (!nameResult.ok) {
    return { isError: true, content: [{ type: "text", text: nameResult.error }] };
  }
  const name = nameResult.name;
  const dir = classDir(project, name);
  if (!existsSync(dir)) {
    return { isError: true, content: [{ type: "text", text: `Card class "${name}" does not exist at ${dir}.` }] };
  }

  // Find instance files of this class (any file under canvasRoot/ ending with .name)
  const cfg = await readCanvasConfig(project);
  const ext = "." + name;
  const canvasAbs = join(projectDir(project), cfg.canvasRoot);
  const instances: string[] = [];
  try {
    async function walk(d: string, rel: string): Promise<void> {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        const next = join(d, e.name);
        const nextRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(next, nextRel);
        else if (e.isFile() && e.name.endsWith(ext)) instances.push(`${cfg.canvasRoot}/${nextRel}`);
      }
    }
    if (existsSync(canvasAbs)) await walk(canvasAbs, "");
  } catch { /* swallow walk errors */ }

  if (instances.length > 0 && !args.force) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Card class "${name}" has ${instances.length} live instance(s):\n  ${instances.join("\n  ")}\n\nPass force=true to delete the class anyway (instances will render as plain TXT after deletion), or delete the instances first via mica_delete_card_instance.`,
      }],
    };
  }

  await rm(dir, { recursive: true, force: true });
  clearCardClassMetaCache();
  return {
    content: [{
      type: "text",
      text: `Deleted card class "${name}" (${dir}).${instances.length > 0 ? `\n${instances.length} instance(s) of this class remain at:\n  ${instances.join("\n  ")}\n(Render as plain TXT until the class is recreated.)` : ""}`,
    }],
  };
}

// ── Tool: mica_list_classes ─────────────────────────────────────────

export async function listClassesImpl(
  project: string,
  _args: Record<string, never>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const projectClassesDir = join(micaDir(project), "card-classes");
  const builtinClassesDir = join(process.cwd(), "card-classes");

  type Entry = {
    name: string;
    extension: string;
    source: "project" | "builtin";
    badge: string;
    defaultTitle: string;
    handler: string;          // metadata.handler if declared, else ""
    primaryFile: string;      // metadata.primaryFile if declared, else ""
    hasSidecar: boolean;      // metadata.sidecar declared (Tier 4)
  };
  const entries: Entry[] = [];
  const seenNames = new Set<string>();

  for (const [src, dir] of [["project", projectClassesDir], ["builtin", builtinClassesDir]] as const) {
    try {
      await access(dir);
    } catch { continue; }
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      if (seenNames.has(d.name)) continue;  // project takes precedence over builtin
      try {
        const m = JSON.parse(await readFile(join(dir, d.name, "metadata.json"), "utf-8")) as {
          extension?: string;
          badge?: string;
          defaultTitle?: string;
          handler?: string;
          primaryFile?: string;
          sidecar?: unknown;
        };
        entries.push({
          name: d.name,
          extension: typeof m.extension === "string" ? m.extension : `.${d.name}`,
          source: src,
          badge: typeof m.badge === "string" ? m.badge : "",
          defaultTitle: typeof m.defaultTitle === "string" ? m.defaultTitle : "",
          handler: typeof m.handler === "string" ? m.handler : "",
          primaryFile: typeof m.primaryFile === "string" ? m.primaryFile : "",
          hasSidecar: Boolean(m.sidecar && typeof m.sidecar === "object"),
        });
        seenNames.add(d.name);
      } catch { /* skip unreadable */ }
    }
  }

  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No card classes registered for this project (project + builtin both empty)." }] };
  }

  // Format each line with the new metadata. When the class declares a
  // handler or sidecar, surface that BEFORE name padding — that's the
  // capability signal the agent needs during decomposition. Without it,
  // `mica_list_classes` looks like a flat name list and the agent reaches
  // for CDN libraries for capabilities a built-in handler already provides.
  const lines = entries.map((e) => {
    const cap = e.handler
      ? `handler=${e.handler}`
      : e.hasSidecar
        ? `(sidecar)`
        : `(static)`;
    const title = e.defaultTitle ? `  ${e.defaultTitle}` : "";
    const primary = e.primaryFile ? `  primaryFile=${e.primaryFile}` : "";
    return `  ${e.name.padEnd(20)} ext=${e.extension.padEnd(18)} badge=${e.badge.padEnd(6)} ${cap.padEnd(28)} (${e.source})${title}${primary}`;
  });
  return {
    content: [{
      type: "text",
      text:
        `Registered card classes (${entries.length}):\n${lines.join("\n")}\n\n` +
        `Project classes live at .mica/card-classes/<name>/; builtins at <mica-repo>/card-classes/<name>/. Project takes precedence on name collision.\n` +
        `The capability column shows how each class talks to the backend:\n` +
        `  handler=<name>   uses a registered channel handler — run mica_list_handlers for what each handler offers and its modelConstraints.\n` +
        `  (sidecar)        declares its own card-class-private server.py/server.ts (Tier 4).\n` +
        `  (static)         no server-side compute — pure card.js + browser APIs (Tier 1).`,
    }],
  };
}

// ── Tool: mica_edit_class_file ─────────────────────────────────────

export const editClassFileSchema = {
  class: z.string().describe("Card class name (directory name, e.g. 'world-clock'). Must already exist."),
  file: z.enum(["card.html", "card.js", "card.css", "server.py", "server.ts"]).describe("Which file to edit. metadata.json edits go through mica_create_class instead — that tool serializes the metadata from typed inputs and avoids JSON-shape mistakes. server.py / server.ts are the sidecar entries for T4 cards; editing them through this tool keeps writes inside the class directory and runs the same verifier gates write_file would skip."),
  content: z.string().optional().describe("Full file content (replaces existing). Mutually exclusive with old_string/new_string."),
  old_string: z.string().optional().describe("Substring to find in the existing file. Combined with new_string for partial edits. The old_string must match exactly once; if it matches zero or multiple times, the edit fails."),
  new_string: z.string().optional().describe("Replacement for old_string. Required when old_string is provided."),
};

export async function editClassFileImpl(
  project: string,
  args: z.infer<z.ZodObject<typeof editClassFileSchema>>,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const nameResult = normalizeName(args.class);
  if (!nameResult.ok) {
    return { isError: true, content: [{ type: "text", text: nameResult.error }] };
  }
  const name = nameResult.name;
  const dir = classDir(project, name);
  if (!existsSync(dir)) {
    // Before claiming "doesn't exist," check whether the class lives in a
    // library project (visible via the resolver but not editable from this
    // project). The user's mental model: "open the home project to edit."
    const lib = findCardClassInLibraries(name);
    if (lib) {
      const libName = lib.libraryProject.split("/").filter(Boolean).pop() || lib.libraryProject;
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `Card class "${name}" lives in library project '${libName}' (${lib.libraryProject}). ` +
            `Open that project to edit — changes there propagate to every project using it. ` +
            `If you want a forked copy local to this project instead, use mica_create_class to ` +
            `make a new class here (it will shadow the library version for this project only).`,
        }],
      };
    }
    return { isError: true, content: [{ type: "text", text: `Card class "${name}" does not exist at ${dir}. Create it first via mica_create_class.` }] };
  }

  const filePath = join(dir, args.file);

  // Resolve final content from either mode.
  let finalContent: string;
  if (typeof args.content === "string") {
    if (args.old_string !== undefined || args.new_string !== undefined) {
      return { isError: true, content: [{ type: "text", text: "Pass EITHER content (full replacement) OR old_string+new_string (partial edit), not both." }] };
    }
    finalContent = args.content;
  } else if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    // No-op detection: identical old_string and new_string would write the
    // file unchanged. Surfaces a soft loop where the agent intended a
    // different tool (commonly render_capture) but generated tool-call args
    // that round-trip to a degenerate edit. Without this check the tool
    // returns success, the model reads "edit completed" → "now verify with
    // screenshot" → emits the same degenerate edit, and the loop persists
    // indefinitely. Observed: 90+ identical-args edits in one opencode
    // session before catching it manually.
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        content: [{
          type: "text",
          text:
            `No-op edit refused: old_string and new_string are identical, so this call ` +
            `would write the file unchanged. If you intended to verify the rendered card, ` +
            `call \`render_capture\` with \`{ filename: "<canvas-relative path>" }\`. If ` +
            `you intended to read the current content, call \`read_file\`. If you genuinely ` +
            `wanted to edit, the new_string must differ from old_string.`,
        }],
      };
    }
    let existing: string;
    try {
      existing = await readFile(filePath, "utf-8");
    } catch {
      return { isError: true, content: [{ type: "text", text: `Cannot read ${args.file} at ${filePath} (does not exist or is unreadable). Use content= for full replacement, or create the class first.` }] };
    }
    const matches = existing.split(args.old_string).length - 1;
    if (matches === 0) {
      return { isError: true, content: [{ type: "text", text: `old_string not found in ${args.file}. Re-read the file via read_file to get the exact text, then retry with the matching substring.` }] };
    }
    if (matches > 1) {
      return { isError: true, content: [{ type: "text", text: `old_string matches ${matches} times in ${args.file} — must match exactly once. Add more surrounding context to make the match unique.` }] };
    }
    finalContent = existing.replace(args.old_string, args.new_string);
  } else {
    return { isError: true, content: [{ type: "text", text: "Provide either content= (full replacement) or both old_string= and new_string= (partial edit)." }] };
  }

  // Pre-write lint for card.js. The same checks run post-write via the
  // file-watcher's enforceCardJsLint; running them here too means lint
  // failures surface in THIS turn's tool result instead of the NEXT turn's
  // prompt context — same-turn feedback is far more reliable for fix-loops.
  if (args.file === "card.js") {
    const lintError = lintCardJsContent(finalContent);
    if (lintError) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Lint failed (write rejected): ${lintError}\n\nThe file was NOT written. Fix the content and call mica_edit_class_file again.`,
        }],
      };
    }
  }

  // Run the extensible verifier framework on the would-be content. Each
  // registered verifier matches on filepath shape (card.js, card.html,
  // *.py, *.sh, ...) and validates a different invariant. Any gate-mode
  // failure refuses the write with an aggregated structured report; the
  // agent reads it and retries.
  const verifyResult = await runVerifiers(filePath, finalContent, project, "gate");
  if (!verifyResult.ok) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `${formatVerifyFailure(verifyResult)}\nThe file was NOT written. Fix the problems above and call mica_edit_class_file again.`,
      }],
    };
  }

  await writeFile(filePath, finalContent, "utf-8");
  return {
    content: [{
      type: "text",
      text: `Wrote ${args.file} for card class "${name}" (${finalContent.length} chars).`,
    }],
  };
}

// ── MCP server factory ─────────────────────────────────────────────

/** Build the mica-card-class MCP server bound to a session's project.
 *  Returns null if the SDK isn't loaded yet or there's no active project
 *  (workspace-level chat sessions don't have a project to write into). */
export function buildCardClassMcpServer(sessionProject: string | null): unknown | null {
  if (!sessionProject || !_tool || !_createSdkMcpServer) return null;

  const tools = [
    _tool(
      "mica_create_class",
      "Create a card class atomically. The framework owns paths and shapes — you supply intent (name, badge, dependencies) and content. Use this INSTEAD of write_file for new card classes. The directory location, name shape, and metadata.json schema are all enforced by the tool; the agent cannot accidentally write to wrong paths or invalid metadata. Idempotent on identical args. card_html and card_js are optional — if omitted, minimal stubs are written so subsequent edits land on the correct paths returned in the success message.",
      createClassSchema,
      (args: z.infer<z.ZodObject<typeof createClassSchema>>) => createClassImpl(sessionProject, args),
    ),
    _tool(
      "mica_edit_class_file",
      "Edit a card class's card.html, card.js, card.css, server.py, or server.ts file with PRE-WRITE validation. For card.js, the same lint that runs after every save (rejecting top-level redeclaration of CARD_SHIM globals like `mica`/`container`, `import`/`export` statements, etc.) runs BEFORE the write — lint failures surface as a tool-result error in this same turn instead of as a card-error broadcast on the next turn. server.py / server.ts (T4 sidecars) go through the same verifier framework so writes that introduce common sidecar mistakes are caught before the file lands on disk. Use this INSTEAD of write_file or edit when modifying class files; it gives you same-turn fixup. Supports full-content replacement (content=) or partial edit (old_string=+new_string=). metadata.json edits go through mica_create_class instead — that tool serializes from typed inputs.",
      editClassFileSchema,
      (args: z.infer<z.ZodObject<typeof editClassFileSchema>>) => editClassFileImpl(sessionProject, args),
    ),
    _tool(
      "mica_create_card_instance",
      "Create an instance of an existing card class on the canvas. The instance file lands at <canvasRoot>/<filename>.<class_extension>. Verifies the class exists before writing. Use this INSTEAD of write_file for new card instances; it picks the right path and confirms the class is registered first.",
      createInstanceSchema,
      (args: z.infer<z.ZodObject<typeof createInstanceSchema>>) => createInstanceImpl(sessionProject, args),
    ),
    _tool(
      "mica_delete_card_instance",
      "Delete a card instance file. Accepts canvas-relative or project-relative paths.",
      deleteInstanceSchema,
      (args: z.infer<z.ZodObject<typeof deleteInstanceSchema>>) => deleteInstanceImpl(sessionProject, args),
    ),
    _tool(
      "mica_delete_class",
      "Delete a card class directory and all its files. Refuses if instance files of this class exist on the canvas, unless force=true. Recommended flow: delete instances first via mica_delete_card_instance, then delete the class.",
      deleteClassSchema,
      (args: z.infer<z.ZodObject<typeof deleteClassSchema>>) => deleteClassImpl(sessionProject, args),
    ),
    _tool(
      "mica_list_classes",
      "List all card classes available in this project (both project-scoped and built-in). Returns name, extension, badge, and source for each. Useful before creating a new class to check for naming collisions or before creating an instance to confirm the extension exists.",
      {},
      (args: Record<string, never>) => listClassesImpl(sessionProject, args),
    ),
  ];

  return _createSdkMcpServer({
    name: "mica-card-class",
    version: "1.0.0",
    tools,
  });
}
