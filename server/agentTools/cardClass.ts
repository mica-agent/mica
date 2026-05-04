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
    "Create a card class atomically. The framework owns paths and shapes — you supply intent (name, badge, dependencies) and content. Use this INSTEAD of write_file for new card classes. The directory location, name shape, and metadata.json schema are all enforced by the tool; the agent cannot accidentally write to wrong paths or invalid metadata. Idempotent on identical args. card_html and card_js are optional — if omitted, minimal stubs are written so subsequent edits land on the correct paths returned in the success message.",
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
    "Edit a card class's card.html, card.js, or card.css file with PRE-WRITE validation. For card.js, the same lint that runs after every save (rejecting top-level redeclaration of CARD_SHIM globals like `mica`/`container`, `import`/`export` statements, etc.) runs BEFORE the write — lint failures surface as a tool-result error in this same turn instead of as a card-error broadcast on the next turn. Use this INSTEAD of write_file or edit when modifying class files; it gives you same-turn fixup on the most common card.js mistakes. Supports full-content replacement (content=) or partial edit (old_string=+new_string=). metadata.json edits go through mica_create_class instead — that tool serializes from typed inputs.",
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
    "Create an instance of an existing card class on the canvas. The instance file lands at <canvasRoot>/<filename>.<class_extension>. Verifies the class exists before writing. Use this INSTEAD of write_file for new card instances; it picks the right path and confirms the class is registered first.",
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
