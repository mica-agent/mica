// Pluggable hooks for the multi-tenant fork — DORMANT in single-tenant main.
//
// Main registers nothing, so every hook here is a no-op and behavior is
// byte-identical to before. A multi-tenant fork (see docs/CLOUD_HOSTING.md)
// calls the register* functions at startup to inject:
//   - auth verification (derive a tenant id from a request),
//   - sponsor/per-tenant API-key resolution (the "free periods" feature),
//   - usage metering (token→$ accounting for budget enforcement).
//
// This module has NO imports from server internals (files.ts, index.ts) so it
// can be imported anywhere without an ESM cycle. Tenant id is read from
// tenantContext at call time by consumers, not threaded here.

import type { IncomingMessage } from "node:http";

// ── Auth verification ────────────────────────────────────────────────
export interface AuthResult {
  /** Tenant id to bind for this request (filesystem path segment). Undefined ⇒
   *  no tenant (single-tenant / anonymous-at-root). */
  tenantId?: string;
}
export type AuthVerifier = (req: IncomingMessage) => AuthResult | Promise<AuthResult>;

let _authVerifier: AuthVerifier | null = null;
/** Fork entry point: install the request authenticator (e.g. Supabase JWT → tenantId). */
export function registerAuthVerifier(v: AuthVerifier): void { _authVerifier = v; }
/** True when a fork has installed a verifier — lets main fast-path with zero overhead. */
export function hasAuthVerifier(): boolean { return _authVerifier !== null; }
/** Run the installed verifier, or return an empty result (no tenant) in main. */
export async function verifyRequest(req: IncomingMessage): Promise<AuthResult> {
  if (!_authVerifier) return {};
  return _authVerifier(req);
}

// ── Injected API-key resolution (sponsor tokens / per-tenant BYO) ─────
export interface KeyRequest {
  provider: "openrouter" | "gemini" | "openai-compat";
  project?: string;
  /** Tenant in scope, supplied by the caller (from tenantContext). */
  tenant?: string;
}
/** Return a key to use, or undefined to fall through to the normal on-disk
 *  lookup. The fork's sponsor-token resolver lives here. */
export type KeyResolver = (req: KeyRequest) => Promise<string | undefined> | string | undefined;

let _keyResolver: KeyResolver | null = null;
/** Fork entry point: install a key resolver consulted BEFORE the on-disk lookup. */
export function registerKeyResolver(r: KeyResolver): void { _keyResolver = r; }
/** Resolve an injected key, or undefined when none installed / none applies
 *  (⇒ caller proceeds with its existing config→credentials→env chain). */
export async function resolveInjectedKey(req: KeyRequest): Promise<string | undefined> {
  if (!_keyResolver) return undefined;
  return _keyResolver(req);
}

// ── Usage metering (token→$ accounting) ──────────────────────────────
export interface UsageEvent {
  tenant?: string;
  project?: string;
  provider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}
export type UsageMeter = (e: UsageEvent) => void;

let _usageMeter: UsageMeter | null = null;
/** Fork entry point: install a per-turn usage meter (drives free-period budgets). */
export function registerUsageMeter(m: UsageMeter): void { _usageMeter = m; }
/** Record a usage event. No-op in main; the fork's meter enforces budgets. */
export function recordUsage(e: UsageEvent): void { if (_usageMeter) _usageMeter(e); }
