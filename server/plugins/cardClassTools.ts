// Card-class CRUD tools — exposed to the agent via SDK MCP server. Replaces
// the path-juggling failure mode where the agent uses raw write_file with
// hand-constructed paths and frequently picks the wrong location, wrong
// directory-name shape, or wrong metadata.json shape. With these tools the
// agent expresses intent (name, badge, scripts, content); the framework
// owns paths and shapes by construction. The set of "wrong paths" is
// empty, not enumerated.

import { join } from "path";
import { mkdir, writeFile, readFile, rm, readdir, stat, access } from "fs/promises";
import { existsSync } from "fs";
import { z } from "zod";
import { WORKSPACE_DIR, micaDir, readCanvasConfig, clearCardClassMetaCache } from "../files.js";
import { lintCardJsContent } from "../cardValidators.js";

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
  name: z.string().describe("Card class identifier (becomes the directory name and, by default, the file extension). Lowercase alphanumeric + dashes only — e.g. \"world-clock\", \"burndown\". No dots. THIS IS THE ONLY REQUIRED FIELD; everything else has reasonable defaults."),
  badge: z.string().optional().describe("1-4 character abbreviation shown on the card's title bar (e.g. \"WCK\", \"BRN\"). Defaults to the first 3 letters of name, uppercase."),
  defaultTitle: z.string().optional().describe("Human-readable card title (e.g. \"World Clock\", \"Burndown\"). Defaults to title-cased name (\"world-clock\" → \"World Clock\")."),
  extension: z.string().optional().describe("File extension instances will use, with leading dot. Defaults to '.' + name. Override only when the extension differs from the directory name (rare)."),
  card_html: z.string().optional().describe("Full contents of card.html. If omitted, a minimal skeleton is written so subsequent edits land on the correct path. card.html is a FRAGMENT, not a full HTML document — no <!DOCTYPE>, no <html>, no <script src=\"card.js\">."),
  card_js: z.string().optional().describe("Full contents of card.js. If omitted, a minimal stub is written. card.js runs as a top-level script (NOT a module) — no import/export statements; the CARD_SHIM provides `mica`, `container`, etc. as globals."),
  card_css: z.string().optional().describe("Full contents of card.css (optional)."),
  scripts: z.array(z.string()).optional().describe("UMD-formatted CDN URLs to load before card.js runs. Use cdn.jsdelivr.net (every npm package has a jsDelivr URL by default). Each library exposes a window global the card.js can call directly."),
  styles: z.array(z.string()).optional().describe("CSS CDN URLs to load."),
  handler: z.string().optional().describe("Optional metadata.handler value to route this card class to a built-in channel handler (e.g. 'llm-direct', 'llm-agent'). Discover available handlers via GET /api/handlers."),
  primaryFile: z.string().optional().describe("Optional. Used by container-style card classes whose instance is a directory containing a specific filename — e.g. '.todo' classes whose instance dirs contain plan.todo."),
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
  const extension = normalizeExtension(args.extension, name);

  // Auto-default badge and defaultTitle from name. Local/weak models often
  // can't reliably construct 3 string params on a tool call; making name the
  // only required field eliminates that failure mode. Caller can still pass
  // explicit badge/defaultTitle for nicer display values.
  const badgeRaw = String(args.badge || "").trim();
  const badge = badgeRaw || name.replace(/-/g, "").slice(0, 4).toUpperCase();
  if (badge.length > 4) return { isError: true, content: [{ type: "text", text: `badge "${badge}" too long — keep it 1-4 chars` }] };

  const defaultTitleRaw = String(args.defaultTitle || "").trim();
  const defaultTitle = defaultTitleRaw || name
    .split("-")
    .map(p => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");

  // Idempotency: check whether the class already exists.
  //   - All metadata matches → no-op success.
  //   - Dir exists but metadata.json is missing/corrupt → REGENERATE it.
  //     This is the recovery path: when an earlier partial tool run or a
  //     heredoc bypass left files in the dir without valid metadata, we
  //     write the missing piece rather than fail.
  //   - Metadata exists with conflicting config → refuse (delete first).
  const dir = classDir(project, name);
  const metadataPath = join(dir, "metadata.json");
  if (existsSync(metadataPath)) {
    try {
      const existing = JSON.parse(await readFile(metadataPath, "utf-8")) as { extension?: string; badge?: string };
      if (existing.extension === extension && existing.badge === badge) {
        return {
          content: [{
            type: "text",
            text: `Card class "${name}" already exists at ${dir} with matching extension and badge. No-op (idempotent). To replace, delete first via mica_delete_class.`,
          }],
        };
      }
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Card class "${name}" already exists at ${dir} with different config (existing: ext=${existing.extension}, badge=${existing.badge}). Delete first via mica_delete_class to replace.`,
        }],
      };
    } catch { /* metadata corrupt — fall through to recovery write below */ }
  }

  // Build metadata.json from typed inputs — agent never writes JSON shape
  // directly. Only Mica-recognized fields land in the file.
  const metadata: Record<string, unknown> = {
    extension,
    badge,
    defaultTitle,
    dependencies: {
      scripts: args.scripts ?? [],
      styles: args.styles ?? [],
    },
  };
  if (args.handler) metadata.handler = args.handler;
  if (args.primaryFile) metadata.primaryFile = args.primaryFile;

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
    await writeFile(htmlPath, `<div class="card-${name}">\n  <p>TODO: implement ${defaultTitle} markup</p>\n</div>\n`, "utf-8");
  }
  if (typeof args.card_js === "string") {
    await writeFile(jsPath, args.card_js, "utf-8");
  } else if (!existsSync(jsPath)) {
    await writeFile(jsPath, `// ${defaultTitle} — TODO: implement\nconsole.log("${name} card mounted");\n`, "utf-8");
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

  return {
    content: [{
      type: "text",
      text: [
        `Created card class "${name}" at .mica/card-classes/${name}/`,
        `  extension: ${extension}`,
        `  badge: ${badge}`,
        `  files: ${writtenFiles.join(", ")}`,
        stubsUsed.length > 0 ? `  stubs (edit to fill in): ${stubsUsed.join(", ")}` : "",
        ``,
        `Create instances with mica_create_card_instance({ class_extension: "${extension}", filename: "<bare-name>" }).`,
        `If you used stubs, edit them now via write_file at the absolute paths:`,
        `  ${join(dir, "card.html")}`,
        `  ${join(dir, "card.js")}`,
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

  if (existsSync(absPath)) {
    return {
      isError: true,
      content: [{ type: "text", text: `Instance "${projectRelative}" already exists. Delete via mica_delete_card_instance to replace, or pick a different filename.` }],
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

  type Entry = { name: string; extension: string; source: "project" | "builtin"; badge: string };
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
        const m = JSON.parse(await readFile(join(dir, d.name, "metadata.json"), "utf-8")) as { extension?: string; badge?: string };
        entries.push({
          name: d.name,
          extension: typeof m.extension === "string" ? m.extension : `.${d.name}`,
          source: src,
          badge: typeof m.badge === "string" ? m.badge : "",
        });
        seenNames.add(d.name);
      } catch { /* skip unreadable */ }
    }
  }

  if (entries.length === 0) {
    return { content: [{ type: "text", text: "No card classes registered for this project (project + builtin both empty)." }] };
  }

  const lines = entries.map(e => `  ${e.name.padEnd(20)} ext=${e.extension.padEnd(20)} badge=${e.badge.padEnd(6)} (${e.source})`);
  return {
    content: [{
      type: "text",
      text: `Registered card classes (${entries.length}):\n${lines.join("\n")}\n\nProject classes live at .mica/card-classes/<name>/; builtins at <mica-repo>/card-classes/<name>/. Project takes precedence on name collision.`,
    }],
  };
}

// ── Tool: mica_edit_class_file ─────────────────────────────────────

export const editClassFileSchema = {
  class: z.string().describe("Card class name (directory name, e.g. 'world-clock'). Must already exist."),
  file: z.enum(["card.html", "card.js", "card.css"]).describe("Which file to edit. metadata.json edits go through mica_create_class instead — that tool serializes the metadata from typed inputs and avoids JSON-shape mistakes."),
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
      "Edit a card class's card.html, card.js, or card.css file with PRE-WRITE validation. For card.js, the same lint that runs after every save (rejecting top-level redeclaration of CARD_SHIM globals like `mica`/`container`, `import`/`export` statements, etc.) runs BEFORE the write — lint failures surface as a tool-result error in this same turn instead of as a card-error broadcast on the next turn. Use this INSTEAD of write_file or edit when modifying class files; it gives you same-turn fixup on the most common card.js mistakes. Supports full-content replacement (content=) or partial edit (old_string=+new_string=). metadata.json edits go through mica_create_class instead — that tool serializes from typed inputs.",
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
