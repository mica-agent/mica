// Optional auth-token provider — DORMANT in single-tenant main.
//
// A multi-tenant fork (e.g. Supabase) calls registerAuthTokenProvider() at boot
// with a getter that returns the current session JWT. projFetch then attaches it
// as a `Bearer` header on API calls, and the WS client includes it on connection
// messages (subscribe-project / channel_open) so the server's auth verifier can
// derive the tenant. Main registers nothing → getAuthToken() returns null → no
// auth is attached and behavior is byte-identical to today.

let _provider: (() => string | null) | null = null;

/** Fork entry point: install a getter for the current session token. */
export function registerAuthTokenProvider(fn: () => string | null): void {
  _provider = fn;
}

/** Current session token, or null when none is configured (single-tenant). */
export function getAuthToken(): string | null {
  return _provider ? _provider() : null;
}
