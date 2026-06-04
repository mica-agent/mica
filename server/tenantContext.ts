// Tenant context — a per-request/per-turn tenant id carried via
// AsyncLocalStorage so path/key resolution can scope to a tenant WITHOUT
// threading a `tenantId` parameter through the ~140 callsites that build
// workspace paths.
//
// DORMANT BY DEFAULT (single-tenant enabler, per docs/CLOUD_HOSTING.md). Nothing
// in main sets the store, so `getCurrentTenant()` returns undefined and every
// consumer (`getEffectiveWorkspaceDir` in files.ts, key-resolver, namespacing)
// falls back to exactly today's single-tenant behavior. A multi-tenant fork
// wraps each HTTP request / WS turn in `runWithTenant(tenantId, …)`; from then on
// `getEffectiveWorkspaceDir()` resolves to `WORKSPACE_DIR/<tenantId>` and the
// namespacing keys carry the tenant. See ARCHITECTURE.md once this lands.
//
// This module intentionally has NO imports from files.ts (which defines
// WORKSPACE_DIR and imports getCurrentTenant from here) — keeping the dependency
// one-directional avoids an ESM cycle.

import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  /** Opaque tenant id — a filesystem path segment (validated by the caller,
   *  same discipline as a project name). Single-tenant main never sets this. */
  tenantId: string;
}

const tenantStore = new AsyncLocalStorage<TenantContext>();

/** Run `fn` with `tenantId` bound for the duration of the async call tree.
 *  The fork's auth middleware / WS turn loop wraps work in this. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantStore.run({ tenantId }, fn);
}

/** The tenant id in scope, or undefined when none is bound (single-tenant). */
export function getCurrentTenant(): string | undefined {
  return tenantStore.getStore()?.tenantId;
}

/** Bind `tenantId` for the REMAINDER of the current async execution, without a
 *  wrapping callback. For un-wrappable entry points — EventEmitter handlers
 *  (the file-watcher listeners) where the work isn't a single callback we can
 *  pass to runWithTenant. Each handler invocation is its own async context, so
 *  this doesn't leak across events. Single-tenant: callers gate on an undefined
 *  tenant and never invoke this, so behavior is unchanged. */
export function enterTenant(tenantId: string): void {
  tenantStore.enterWith({ tenantId });
}
