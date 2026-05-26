// Verification framework — build-time checks the agent must pass before
// a write lands on disk. Each verifier handles one artifact type (card.js,
// python scripts, bash scripts, etc.) and runs at one of three modes:
//
//   gate       — at write time; failure refuses the write (agent reads
//                structured report, fixes, retries)
//   warning    — at write time after success; attaches a card-warning
//                event the agent sees but isn't blocked on
//   on-demand  — runs only when explicitly invoked (via mica_verify)
//
// Verifiers are pure-by-call: { matches(filepath, project), verify(filepath,
// content, project) } — the framework hands them the would-be content, the
// project name, and the path. They return { ok: true } or a structured
// problem list with file/line/column + human-readable problem + fix_hint.
//
// Integration points: every write-capable tool (write_file,
// mica_edit_class_file, mica_create_class) calls runVerifiers before
// persisting and aggregates failures into the tool result.
//
// This file is the entry point — it re-exports the framework from
// ./registry.js and side-effect-imports each concrete verifier so that
// importing './verifiers/index.js' gives you a fully-loaded system. The
// registry lives in its own file to avoid an ESM TDZ trap: if the
// side-effect imports were here, ESM would hoist them above the
// VERIFIERS const initialization and registerVerifier() would crash.

export type { VerifierMode, VerifyProblem, VerifyResult, FileVerifier } from "./registry.js";
export { registerVerifier, runVerifiers, formatVerifyFailure } from "./registry.js";

import "./cardJsWrapperParse.js";
import "./cardJsUncalledFunctions.js";
import "./cardJsSelectorHtmlMatch.js";
import "./cardJsChannelArgs.js";
import "./pythonScriptParse.js";
import "./pythonImportAttrs.js";
import "./bashScriptParse.js";
