// propose_changes — agent tool for suggesting cascade edits to OTHER
// canvas files without writing them. The agent emits a structured
// proposal; the chat card renders an Apply / Dismiss UI; the user
// drives the writes from there.
//
// Why this is a tool (not a write):
//   When the user revises a draft (a [Draft revision] reactive turn),
//   the agent often spots related docs on the canvas that would need
//   matching edits. Writing those siblings directly via `write_file`
//   would (a) bypass user approval and (b) trigger another reactive
//   turn, risking cascade loops. propose_changes keeps the agent
//   in the "suggest, don't mutate" lane: the proposal lives in the
//   server's proposal store, the chat card renders a button, the user
//   decides.
//
// Cascade safety:
//   - The agent never writes sibling files inside the [Draft revision]
//     turn — it only proposes. Mica's mechanism guarantees no autonomous
//     cascade.
//   - When the user clicks Apply, the apply endpoint tags writes with
//     suppressNextCascadeWrite so the file-watcher doesn't fire a new
//     reactive turn for those edits. Single-step cascade by design.

import { z } from "zod";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { createProposal, type ProposalFile } from "../proposalStore.js";
import { getActiveChannelManager } from "../channelManager.js";
import { WORKSPACE_DIR } from "../files.js";

const inputSchema = {
  files: z
    .array(
      z.object({
        file: z
          .string()
          .describe(
            "Canvas-relative path of the file to edit (e.g. 'canvas/about.md'). Must already exist on disk.",
          ),
        hunks: z
          .array(
            z.object({
              old_string: z
                .string()
                .describe(
                  "Exact substring to replace. Must appear EXACTLY ONCE in the target file at apply time — include enough surrounding context to disambiguate.",
                ),
              new_string: z.string().describe("Replacement text."),
              label: z
                .string()
                .optional()
                .describe(
                  "Short human-readable label rendered above this hunk's diff in the chat card UI (e.g. 'rename badge', 'update reference').",
                ),
            }),
          )
          .min(1)
          .describe("One or more replacement hunks for this file."),
      }),
    )
    .min(1)
    .describe("Files to edit and their replacement hunks. At least one file required."),
  reason: z
    .string()
    .optional()
    .describe(
      "Optional one-paragraph 'why' rendered with the proposal so the user can decide whether to apply. Reference the [Draft revision] that motivated the cascade.",
    ),
} as const;

export const proposeChangesTool: AgentToolDef<typeof inputSchema> = {
  name: "propose_changes",
  description:
    "Propose textual edits to OTHER canvas files WITHOUT writing them. Use this when a [Draft revision] (user-edit on a file you authored) implies consequential edits elsewhere — e.g. you renamed a card spec and another doc references the old name. The user reviews the proposed diffs in the chat card and clicks Apply (or Dismiss). DO NOT call this for your own self-revisions or files only you read — use write_file / edit for normal authoring. Cascade safety: applied writes are tagged so they don't fire a fresh [Draft revision] turn (no loop). Input: { files: [{ file, hunks: [{ old_string, new_string, label? }] }], reason? }. old_string must match exactly once per file at apply time — include surrounding context to disambiguate. The tool returns the proposal id and a one-line summary; no writes happen until the user clicks Apply.",
  inputSchema,
  restPath: "/api/tools/propose-changes",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "propose_changes requires an active project session." };
    }
    if (!ctx.chatFilename) {
      return {
        isError: true,
        text:
          "propose_changes requires an originating chat card (the proposal renders in that card). " +
          "Re-invoke from inside a chat-card session.",
      };
    }

    // Best-effort existence check. Reject early if the agent named a
    // file that isn't on disk — the apply step would fail anyway, and
    // catching it here gives a same-turn fixup hint.
    const projectRoot = join(WORKSPACE_DIR, ctx.project);
    const missing: string[] = [];
    const ambiguous: string[] = [];
    const filesValidated: ProposalFile[] = [];
    for (const f of input.files) {
      const abs = join(projectRoot, f.file);
      if (!abs.startsWith(projectRoot + "/")) {
        return {
          isError: true,
          text: `Path '${f.file}' escapes the project root. Use canvas-relative paths only.`,
        };
      }
      if (!existsSync(abs)) {
        missing.push(f.file);
        continue;
      }
      // Disambiguity check: every old_string must appear exactly once.
      // We don't reject the whole proposal — we list the ambiguous hunks
      // so the agent can re-try with more context.
      try {
        const content = readFileSync(abs, "utf-8");
        for (const hunk of f.hunks) {
          const occurrences = countOccurrences(content, hunk.old_string);
          if (occurrences === 0) {
            ambiguous.push(`${f.file}: old_string not found ('${truncate(hunk.old_string, 40)}')`);
          } else if (occurrences > 1) {
            ambiguous.push(
              `${f.file}: old_string matches ${occurrences} places ('${truncate(hunk.old_string, 40)}') — add surrounding context to disambiguate`,
            );
          }
        }
      } catch {
        // unreadable file → let apply surface that
      }
      filesValidated.push({ file: f.file, hunks: f.hunks });
    }

    if (missing.length > 0 || ambiguous.length > 0) {
      const parts: string[] = ["Proposal not stored. Fix the issues below and call propose_changes again."];
      if (missing.length > 0) parts.push("Missing files:\n  " + missing.join("\n  "));
      if (ambiguous.length > 0) parts.push("Ambiguous or unmatched hunks:\n  " + ambiguous.join("\n  "));
      return { isError: true, text: parts.join("\n\n") };
    }

    const proposal = createProposal({
      project: ctx.project,
      chatFilename: ctx.chatFilename,
      reason: input.reason,
      files: filesValidated,
    });

    // Broadcast the proposal to the chat card. If the card isn't open
    // (no clients attached, session destroyed), the tool still succeeds —
    // the proposal is stored, the user can apply later by reopening the
    // card. The card's onAttach replay would also need to surface
    // pending proposals; out of scope for the first cut.
    const cm = getActiveChannelManager();
    let broadcastOk = false;
    if (cm) {
      broadcastOk = cm.broadcastToFilename(ctx.project, ctx.chatFilename, {
        type: "propose_changes",
        proposalId: proposal.id,
        reason: proposal.reason,
        files: proposal.files,
        createdAt: proposal.createdAt,
      });
    }

    const fileCount = filesValidated.length;
    const hunkCount = filesValidated.reduce((n, f) => n + f.hunks.length, 0);
    const summary =
      `Proposed ${hunkCount} hunk${hunkCount === 1 ? "" : "s"} across ${fileCount} file${fileCount === 1 ? "" : "s"}.` +
      (broadcastOk ? " The user sees Apply/Dismiss buttons in the chat card." : " (Chat card not attached; proposal stored.)") +
      ` proposal_id=${proposal.id}`;
    return { text: summary };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let i = 0;
  let count = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
