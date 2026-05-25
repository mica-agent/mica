// In-memory store for cascade-edit proposals emitted by the
// `propose_changes` agent tool and applied (or dismissed) by the chat
// card. Proposals live in memory only — survive across turns but not
// server restarts, which matches the intended UX (a server restart
// drops the chat-card UI state anyway).
//
// Lifecycle:
//   tool handler  → createProposal()  (stores; broadcasts propose_changes event)
//   chat card     → POST /api/proposals/apply { proposalId, hunkIndexes }
//                   → resolveProposal() + applyProposalHunks() (file writes,
//                                                                cascade-tag the writes)
//                   → markApplied() (broadcast propose_changes_applied)
//   chat card     → POST /api/proposals/dismiss { proposalId }  (drops it)
//   inactivity    → expireOldProposals() sweeps anything older than TTL
//
// Concurrency: single Node process; Map mutation is atomic enough for
// this small surface. No locking needed.

import { randomUUID } from "crypto";

/** One concrete textual edit inside a proposal. The model picks
 *  `old_string` + `new_string` like Mica's existing edit tool, so the
 *  shape rhymes with what the agent already knows. `old_string` must
 *  appear exactly once in the target file at apply time — otherwise
 *  the hunk is rejected (we can't safely guess which match the agent
 *  meant). The agent can include surrounding context to disambiguate. */
export interface ProposalHunk {
  old_string: string;
  new_string: string;
  /** Optional human-facing label rendered above the diff in the chat
   *  card. Keeps the apply UI scannable when one proposal touches many
   *  short hunks. */
  label?: string;
}

export interface ProposalFile {
  file: string;            // canvas-relative path
  hunks: ProposalHunk[];
}

export interface Proposal {
  id: string;
  project: string;
  chatFilename: string;    // chat card that originated this proposal
  reason?: string;         // optional one-paragraph "why" from the agent
  files: ProposalFile[];
  createdAt: number;
  applied: boolean;
}

const TTL_MS = 30 * 60 * 1000;  // 30 minutes — proposals stale after this

const proposals = new Map<string, Proposal>();

/** Store a fresh proposal. Returns the assigned ID. Caller is
 *  responsible for broadcasting `propose_changes` to the chat card —
 *  this module is storage-only. */
export function createProposal(args: {
  project: string;
  chatFilename: string;
  reason?: string;
  files: ProposalFile[];
}): Proposal {
  expireOldProposals();
  const id = randomUUID();
  const p: Proposal = {
    id,
    project: args.project,
    chatFilename: args.chatFilename,
    reason: args.reason,
    files: args.files,
    createdAt: Date.now(),
    applied: false,
  };
  proposals.set(id, p);
  return p;
}

/** Resolve a stored proposal by ID. Returns undefined if missing or
 *  already applied (the apply endpoint should reject double-applies). */
export function getProposal(id: string): Proposal | undefined {
  return proposals.get(id);
}

/** Mark a proposal applied and drop it from the store. Idempotent on
 *  missing IDs. */
export function consumeProposal(id: string): void {
  const p = proposals.get(id);
  if (!p) return;
  p.applied = true;
  proposals.delete(id);
}

/** Drop a proposal without applying. Idempotent. */
export function dismissProposal(id: string): boolean {
  return proposals.delete(id);
}

/** Sweep proposals older than TTL_MS. Called opportunistically from
 *  createProposal; explicit GC isn't needed but a periodic
 *  setInterval could be added if the surface grows. */
export function expireOldProposals(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, p] of proposals) {
    if (p.createdAt < cutoff) proposals.delete(id);
  }
}
