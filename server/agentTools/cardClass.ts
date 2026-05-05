// Card-class CRUD tools — wrapped from server/plugins/cardClassTools.ts
// into AgentToolDef shape so they're reachable from all three agent
// backends (qwen, Claude, opencode) through the unified mica-builtins
// surface.
//
// The actual logic (schemas, validation, impl functions) still lives in
// cardClassTools.ts. This file is just the registry-shaped wrapper that
// (a) extracts text from each impl's MCP-style return value and (b)
// requires an active project context.

import type { AgentToolDef, AgentToolResult } from "./registry.js";
import {
  createClassSchema,
  createClassImpl,
  editClassFileSchema,
  editClassFileImpl,
  createInstanceSchema,
  createInstanceImpl,
  deleteInstanceSchema,
  deleteInstanceImpl,
  deleteClassSchema,
  deleteClassImpl,
  listClassesImpl,
} from "../plugins/cardClassTools.js";

// Shared adapter — the existing impls return MCP-shaped results
// ({ content: [{ type: "text", text }], isError? }); the registry
// expects flat AgentToolResult ({ text, isError }). Unwrap the first
// text content; surface any isError flag.
function unwrap(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): AgentToolResult {
  const text = result.content?.[0]?.text ?? "(no content)";
  return { text, isError: result.isError };
}

function requireProject<T>(ctx: { project: string | null }, run: (project: string) => Promise<T>): Promise<T | AgentToolResult> {
  if (!ctx.project) {
    return Promise.resolve({
      isError: true,
      text: "This tool requires an active project session. Open a card on the canvas before invoking.",
    } satisfies AgentToolResult as T);
  }
  return run(ctx.project);
}

export const createClassTool: AgentToolDef<typeof createClassSchema> = {
  name: "mica_create_class",
  description:
    "Use this to create a new card class at `.mica/card-classes/<name>/` (writes metadata.json + card.html + card.js + card.css). You supply intent (name, badge, dependencies, content); the framework picks the directory, validates the metadata schema, and writes a canonical card.js stub when card_js is omitted. Idempotent on identical args (returns no-op if the class already exists with matching config). Class creation does not go through write_file — that path doesn't enforce the metadata schema or directory shape and produces extension/dirname mismatches that silently render as TXT.",
  inputSchema: createClassSchema,
  restPath: "/api/tools/mica-create-class",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await createClassImpl(ctx.project, input));
  },
};

export const editClassFileTool: AgentToolDef<typeof editClassFileSchema> = {
  name: "mica_edit_class_file",
  description:
    "Use this for any edit to `.mica/card-classes/<name>/card.{js,html,css}`. Pre-write lint catches CARD_SHIM-global redeclaration (`mica`, `container`), ESM `import`/`export`, IIFE wrappers, etc. so failures surface as a tool-result error in this same turn instead of a card-error broadcast on the next turn. Two edit modes: partial (`old_string` + `new_string`) preserves all surrounding code untouched — safer default for amending working files; full replace (`content=`) overwrites the whole file. Class-file edits don't go through `write_file` or `edit` — those paths bypass the lint and the partial-edit safety, and full-rewrites repeatedly regress working code (e.g. textured Earth → simple sphere because the rewrite drops the texture-loader code). metadata.json edits go through `mica_create_class`.",
  inputSchema: editClassFileSchema,
  restPath: "/api/tools/mica-edit-class-file",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await editClassFileImpl(ctx.project, input));
  },
};

export const createInstanceTool: AgentToolDef<typeof createInstanceSchema> = {
  name: "mica_create_card_instance",
  description:
    "Use this to put a new card instance on the canvas. Writes `<canvasRoot>/<filename>.<class_extension>` and verifies the class is registered first. Idempotent — calling twice with the same args returns no-op success on the second call (the file already exists with the requested content). Instance creation does not go through `write_file` — write_file doesn't know the canvas-root path or check class registration, so wrong paths silently render as TXT.",
  inputSchema: createInstanceSchema,
  restPath: "/api/tools/mica-create-card-instance",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await createInstanceImpl(ctx.project, input));
  },
};

export const deleteInstanceTool: AgentToolDef<typeof deleteInstanceSchema> = {
  name: "mica_delete_card_instance",
  description: "Delete a card instance file. Accepts canvas-relative or project-relative paths.",
  inputSchema: deleteInstanceSchema,
  restPath: "/api/tools/mica-delete-card-instance",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await deleteInstanceImpl(ctx.project, input));
  },
};

export const deleteClassTool: AgentToolDef<typeof deleteClassSchema> = {
  name: "mica_delete_class",
  description:
    "Delete a card class directory and all its files. Refuses if instance files of this class exist on the canvas, unless force=true. Recommended flow: delete instances first via mica_delete_card_instance, then delete the class.",
  inputSchema: deleteClassSchema,
  restPath: "/api/tools/mica-delete-class",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await deleteClassImpl(ctx.project, input));
  },
};

// listClassesImpl takes no args — registry shape still wants an inputSchema,
// so we use an empty raw shape (matches the existing _tool(... {} ...) call).
const listClassesSchema = {} as const;

export const listClassesTool: AgentToolDef<typeof listClassesSchema> = {
  name: "mica_list_classes",
  description:
    "List all card classes available in this project (both project-scoped and built-in). Returns name, extension, badge, and source for each. Useful before creating a new class to check for naming collisions or before creating an instance to confirm the extension exists.",
  inputSchema: listClassesSchema,
  restPath: "/api/tools/mica-list-classes",
  handler: async (input, ctx) => {
    if (!ctx.project) return { isError: true, text: "Active project required." };
    return unwrap(await listClassesImpl(ctx.project, input as Record<string, never>));
  },
};

// Suppress unused-import warning on requireProject (kept exported in case
// future tools want a more idiomatic version).
void requireProject;
