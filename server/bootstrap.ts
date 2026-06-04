// Fork bootstrap seam — DORMANT in single-tenant main.
//
// A multi-tenant / cloud fork installs a bootstrap function via
// registerBootstrap() at startup (before it imports this server module). The
// server invokes it once during app setup — after the core middleware is
// mounted but BEFORE the tenant-auth middleware — so the fork can add its own
// Express middleware/routes (e.g. an anonymous-tenant cookie minter, or
// fork-specific /api/cloud/* endpoints) at the right point in the chain.
//
// Main registers nothing → runBootstrap() is a no-op and behavior is
// byte-identical to before. Mirrors the auth/hooks.ts + tenantContext.ts
// enablers (docs/CLOUD_HOSTING.md §5).
//
// Kept import-light (only the Express *type*, erased at compile) so it can be
// imported anywhere without pulling express at runtime or creating an ESM cycle.

import type { Express } from "express";

export type BootstrapFn = (app: Express) => void;

let _bootstrap: BootstrapFn | null = null;

/** Fork entry point: install a function that mounts fork middleware/routes on
 *  the app. Called (in the fork's boot module) before this server is imported. */
export function registerBootstrap(fn: BootstrapFn): void { _bootstrap = fn; }

/** True when a fork has installed a bootstrap — lets main fast-path. */
export function hasBootstrap(): boolean { return _bootstrap !== null; }

/** Run the installed bootstrap, or no-op in main. Invoked once during app setup,
 *  synchronously, so any middleware the fork registers is in place before the
 *  tenant-auth middleware (and everything after it) is mounted. */
export function runBootstrap(app: Express): void { if (_bootstrap) _bootstrap(app); }
