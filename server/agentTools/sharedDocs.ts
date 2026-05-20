// mica_list_shared_docs and mica_pin_shared_doc — workspace-shared library
// discovery and pinning.
//
// Workspace-shared docs live under /workspaces/shared/ and are pinnable
// into any project's canvas. The first use case is a CDN library catalog
// (verified UMD/ESM URLs), so a card-class build can consult a curated
// list before burning research turns on Tavily + mica_inspect_url for
// libraries the team already vetted.
//
// Surface split:
//   - mica_list_shared_docs returns metadata (name, title, description,
//     tags) for every doc under /workspaces/shared/ — agent uses this
//     to decide whether something relevant exists.
//   - mica_pin_shared_doc pins a doc into the current project so its
//     content lands in the canvas baseline (via extractDocAbstract on
//     the `shared/<name>` listing entry). Emits a `pin-added` toast
//     broadcast so the user sees what Mica pinned in real time.
//
// Per-project pin state lives in .mica/config.json:sharedPinned[]; the
// shared/ virtual prefix routes file reads to /workspaces/shared/<name>
// at resolveFilePath time. See server/files.ts § SHARED_DIR.

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { listSharedDocs, SHARED_DIR } from "../files.js";
import { pinSharedDoc } from "../sharedPin.js";

// ── mica_list_shared_docs ────────────────────────────────────────────

const listInputSchema = {} as const;

export const listSharedDocsTool: AgentToolDef<typeof listInputSchema> = {
  name: "mica_list_shared_docs",
  description:
    "List every workspace-shared doc available for pinning into the current " +
    "project's canvas. Shared docs live at /workspaces/shared/ and carry " +
    "metadata in YAML frontmatter (title, description, tags). USE THIS at " +
    "the START of any build that needs a CDN library, an external service " +
    "endpoint, or a pre-vetted snippet — the team curates verified entries " +
    "here so you skip the research-thrash loop. Output is a JSON array; " +
    "each entry has { name, virtualName, path, title, description, tags, " +
    "size, modifiedAt }. `path` is the absolute on-disk path you pass to " +
    "`read_file` if you need the body before pinning. If a doc is " +
    "relevant, call `mica_pin_shared_doc` — it pins to canvas AND returns " +
    "the body in the tool result (one call, no separate read). Fall back " +
    "to web research only when nothing in the catalog fits.",
  inputSchema: listInputSchema,
  restPath: "/api/tools/list-shared-docs",
  handler: async (): Promise<AgentToolResult> => {
    const docs = await listSharedDocs();
    return { text: JSON.stringify(docs) };
  },
};

void z; // imported for symmetry with other tools

// ── mica_pin_shared_doc ──────────────────────────────────────────────

const pinInputSchema = {
  name: z.string().describe(
    "Bare filename of the shared doc to pin (e.g. \"cdn-library-catalog.md\"). " +
    "Get the exact name from mica_list_shared_docs output.",
  ),
} as const;

export const pinSharedDocTool: AgentToolDef<typeof pinInputSchema> = {
  name: "mica_pin_shared_doc",
  description:
    "Pin a workspace-shared doc into the current project's canvas AND " +
    "return its body in the tool result. This is the one-shot path: " +
    "pinning is the side effect (user sees a 'Mica pinned X' toast, " +
    "card lands on canvas), reading is the value (the file's full " +
    "content is in the result text, ready to use without a separate " +
    "`read_file` call). USE THIS when `mica_list_shared_docs` surfaces " +
    "something relevant — pinning twice is idempotent (no duplicate " +
    "toast), so re-pinning to fetch the body again is safe if you need " +
    "to refresh the content mid-build. Output: { ok, pinned, path, " +
    "sharedPinned, content }. The `content` field is the file's full " +
    "text — treat it as if you'd just `read_file`'d it.",
  inputSchema: pinInputSchema,
  restPath: "/api/tools/pin-shared-doc",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { text: "Error: no active project context. mica_pin_shared_doc must be called from within a project session.", isError: true };
    }
    try {
      const sharedPinned = await pinSharedDoc(ctx.project, input.name, "agent");
      const path = join(SHARED_DIR, input.name);
      let content = "";
      let readError: string | undefined;
      try {
        content = await readFile(path, "utf-8");
      } catch (err) {
        readError = (err as Error).message;
      }
      return {
        text: JSON.stringify({
          ok: true,
          pinned: input.name,
          path,
          sharedPinned,
          content,
          ...(readError ? { readError } : {}),
        }),
      };
    } catch (err) {
      return { text: `Error: ${(err as Error).message}`, isError: true };
    }
  },
};
