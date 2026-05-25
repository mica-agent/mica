// micaFetch plugin — mica.fetch.* server primitive.
//
// Cards call `mica.fetch(url, opts)` to make HTTP requests to public
// services (APIs, web pages) that browser CORS normally blocks. The request
// is proxied through the Mica server after SSRF protection + rate limiting.
//
// The Promise ALWAYS resolves. Upstream HTTP errors come back as the result's
// `status`; our-side failures (SSRF, DNS, timeout, rate limit, bad URL) come
// back with `status: 0` and a structured `{ errorCode, error }`. Card
// authors check fields on the result rather than wrapping every call in
// try/catch.
//
// NOT exposed: streaming, binary bodies, credential vault, shell-out. See the
// plan for context on why; add them only when a concrete use case demands it.

import { lookup } from "dns/promises";
import * as net from "net";
import { existsSync } from "fs";
import { join } from "path";
import { micaDir, findCardClassInLibraries, WORKSPACE_DIR } from "../files.js";
import { ensureCardSidecar, touchCardSidecar } from "../cardSidecar.js";
import { recordPendingError } from "../cardErrorBuffer.js";

// Built-in card classes ship under <repo>/card-classes/<name>/. Same constant
// as index.ts's CARD_CLASSES_DIR (kept local so this file stays self-contained).
const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

// Mirror of resolveCardClassDir in index.ts. Project-scoped → library → built-in.
function resolveClassDir(className: string, project: string | null): string | null {
  if (project) {
    const projectScoped = join(micaDir(project), "card-classes", className);
    if (existsSync(join(projectScoped, "card.html"))) return projectScoped;
  }
  const lib = findCardClassInLibraries(className);
  if (lib) return lib.dir;
  const builtIn = join(CARD_CLASSES_DIR, className);
  if (existsSync(join(builtIn, "card.html"))) return builtIn;
  return null;
}

// Reference WORKSPACE_DIR so the import isn't pruned if we don't use it elsewhere.
void WORKSPACE_DIR;

// ── Configuration ────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
// Card-class sidecars (mica-internal:// scheme) get a much higher cap because
// (a) we own both ends — no malicious-external-endpoint defense needed and
// (b) first-call costs include large model downloads (~7GB SDXL-Turbo) plus
// GPU load that legitimately exceed a minute. External fetches stay at 60s.
const MAX_INTERNAL_TIMEOUT_MS = 10 * 60_000;  // 10 minutes
const RESPONSE_MAX_BYTES = 10 * 1024 * 1024;  // 10 MB
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 120;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"]);

// ── SSRF block-list (CIDR form, v4 + v6) ─────────────────────

// CIDR ranges to block. We keep this narrow: anything that's clearly private,
// loopback, link-local, multicast, or reserved. Public addresses pass through.
const BLOCKED_V4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8],          // this-network / unspecified
  ["10.0.0.0", 8],         // RFC1918 private
  ["100.64.0.0", 10],      // RFC6598 CGNAT
  ["127.0.0.0", 8],        // loopback
  ["169.254.0.0", 16],     // link-local (incl. cloud metadata 169.254.169.254)
  ["172.16.0.0", 12],      // RFC1918 private (incl. Docker bridge)
  ["192.0.0.0", 24],       // IETF protocol assignments
  ["192.168.0.0", 16],     // RFC1918 private
  ["224.0.0.0", 4],        // multicast
  ["240.0.0.0", 4],        // reserved / broadcast
];

const BLOCKED_V6_CIDRS: Array<[string, number]> = [
  ["::", 128],             // unspecified
  ["::1", 128],            // loopback
  ["fc00::", 7],           // unique local
  ["fe80::", 10],          // link-local
  ["ff00::", 8],           // multicast
];

function ipToBigInt(ip: string): bigint {
  if (net.isIPv4(ip)) {
    const parts = ip.split(".").map((n) => BigInt(parseInt(n, 10)));
    return (parts[0] << 24n) | (parts[1] << 16n) | (parts[2] << 8n) | parts[3];
  }
  // IPv6 — expand and pack into 128 bits
  const expanded = expandV6(ip);
  const groups = expanded.split(":").map((g) => BigInt(parseInt(g, 16)));
  let result = 0n;
  for (const g of groups) result = (result << 16n) | g;
  return result;
}

function expandV6(ip: string): string {
  const parts = ip.split("::");
  let left = parts[0] ? parts[0].split(":") : [];
  let right = parts.length > 1 ? (parts[1] ? parts[1].split(":") : []) : [];
  const missing = 8 - left.length - right.length;
  const zeros = Array(Math.max(0, missing)).fill("0");
  const full = [...left, ...zeros, ...right];
  return full.map((g) => g || "0").join(":");
}

function ipInCidr(ip: string, cidrIp: string, cidrBits: number): boolean {
  const ipIsV4 = net.isIPv4(ip);
  const cidrIsV4 = net.isIPv4(cidrIp);
  if (ipIsV4 !== cidrIsV4) return false;
  const bitWidth = ipIsV4 ? 32 : 128;
  const ipInt = ipToBigInt(ip);
  const cidrInt = ipToBigInt(cidrIp);
  const mask = cidrBits === 0 ? 0n : ((1n << BigInt(bitWidth)) - 1n) ^ ((1n << BigInt(bitWidth - cidrBits)) - 1n);
  return (ipInt & mask) === (cidrInt & mask);
}

function isBlockedIP(ip: string): boolean {
  const list = net.isIPv4(ip) ? BLOCKED_V4_CIDRS : net.isIPv6(ip) ? BLOCKED_V6_CIDRS : [];
  for (const [cidrIp, bits] of list) {
    if (ipInCidr(ip, cidrIp, bits)) return true;
  }
  return false;
}

// ── Rate limiter (rolling window, per-project) ───────────────

const rateBuckets = new Map<string, number[]>();  // project → timestamps (ms)

function checkRateLimit(project: string | null): { ok: true } | { ok: false; retryAfterMs: number } {
  const key = project ?? "_workspace";
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  let bucket = rateBuckets.get(key);
  if (!bucket) { bucket = []; rateBuckets.set(key, bucket); }
  // Drop expired entries
  while (bucket.length > 0 && bucket[0] < cutoff) bucket.shift();
  if (bucket.length >= RATE_LIMIT_MAX_REQUESTS) {
    const retryAfterMs = bucket[0] + RATE_LIMIT_WINDOW_MS - now;
    return { ok: false, retryAfterMs };
  }
  bucket.push(now);
  return { ok: true };
}

// ── Log redaction ────────────────────────────────────────────

// Strip values from query params whose keys look like secrets, and from the
// Authorization header. "Looks like" covers the common cases; anything weirder
// is the user's responsibility.
const SECRET_KEY_RX = /([?&](?:key|token|apikey|api_key|access_token|bearer|auth|secret)=)([^&#]*)/gi;
function redactUrlForLog(url: string): string {
  return url.replace(SECRET_KEY_RX, "$1***");
}
function redactHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k in headers) {
    if (k.toLowerCase() === "authorization") out[k] = "***";
    else out[k] = headers[k];
  }
  return out;
}

// ── Result shape returned to cards ───────────────────────────

type FetchErrorCode =
  | "url_invalid" | "ssrf_blocked" | "dns_error"
  | "connect_error" | "timeout" | "rate_limited"
  | "response_error" | "internal_error";

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  truncated?: boolean;
  durationMs: number;
  error?: string;
  errorCode?: FetchErrorCode;
  retryAfterMs?: number;
}

function errorResult(errorCode: FetchErrorCode, error: string, startedAt: number, extra: Partial<FetchResult> = {}): FetchResult {
  return {
    status: 0,
    headers: {},
    body: "",
    durationMs: Date.now() - startedAt,
    error,
    errorCode,
    ...extra,
  };
}

// ── URL validation ───────────────────────────────────────────

interface ParsedRequestUrl {
  url: URL;
  hostname: string;
}

function parseUrl(raw: unknown): { ok: true; parsed: ParsedRequestUrl } | { ok: false; reason: string } {
  if (typeof raw !== "string" || !raw) return { ok: false, reason: "URL is required (string)" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, reason: `Malformed URL: ${raw.slice(0, 120)}` }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `URL must use http: or https: (got ${url.protocol})` };
  }
  // Hostname with square brackets for IPv6 literals; strip brackets for DNS/IP work.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return { ok: true, parsed: { url, hostname } };
}

async function resolveHost(hostname: string): Promise<{ ok: true; ips: string[] } | { ok: false; reason: string }> {
  // Numeric IP: no DNS needed.
  if (net.isIP(hostname)) return { ok: true, ips: [hostname] };
  // Use dns.lookup (system resolver, includes /etc/hosts). Critical for SSRF:
  // if a user has `localhost` or their own private entries in /etc/hosts,
  // a plain DNS query won't see them — but the TCP connect downstream WILL
  // hit the system resolver, so we must check the same source.
  try {
    const results = await lookup(hostname, { all: true });
    const ips = results.map((r) => r.address).filter(Boolean);
    if (ips.length === 0) {
      return { ok: false, reason: `DNS resolution failed for '${hostname}' (no addresses returned)` };
    }
    return { ok: true, ips };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, reason: `DNS resolution failed for '${hostname}': ${e.code || e.message || "unknown"}` };
  }
}

// ── Card-class-sidecar proxy ─────────────────────────────────

// Handles mica-internal://card-server/<path> URLs. Spawns the card class's
// declared sidecar (if not running), waits for /health, proxies the HTTP
// request to its localhost port, returns the response in the same shape
// the normal fetchHandler returns. Errors come back as `status: 0` with
// a `card_sidecar_*` errorCode.
async function proxyToCardSidecar(
  p: {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
    timeout?: unknown;
    _cardClass?: unknown;
  },
  project: string | null,
  projLabel: string,
  startedAt: number,
): Promise<unknown> {
  const errorResult2 = (code: string, msg: string) => ({
    status: 0,
    headers: {} as Record<string, string>,
    body: "",
    durationMs: Date.now() - startedAt,
    error: msg,
    errorCode: code,
  });

  if (!project) {
    return errorResult2("card_sidecar_no_project", "card-server requires an active project");
  }
  const className = typeof p._cardClass === "string" ? p._cardClass : "";
  if (!className) {
    return errorResult2("card_sidecar_no_class", "mica-internal://card-server/ requires a card class — bridge must inject _cardClass (derived from filename extension)");
  }

  // Path is everything after the "mica-internal://card-server" prefix.
  // URL example: mica-internal://card-server/search → path "/search"
  const rawUrl = p.url as string;
  const pathPart = rawUrl.slice("mica-internal://card-server".length) || "/";

  const classDir = resolveClassDir(className, project);
  if (!classDir) {
    return errorResult2("card_sidecar_class_not_found", `Card class '${className}' not found`);
  }

  let port: number;
  try {
    const r = await ensureCardSidecar(project, className, classDir);
    port = r.port;
  } catch (e) {
    console.log(`[mica-fetch:${projLabel}] mica-internal card-server (${className}) -> ERROR card_sidecar_spawn ${Date.now() - startedAt}ms: ${(e as Error).message}`);
    return errorResult2("card_sidecar_spawn_failed", (e as Error).message);
  }

  const requestMethod = typeof p.method === "string" ? p.method.toUpperCase() : "GET";
  const requestHeaders: Record<string, string> = {};
  if (p.headers && typeof p.headers === "object") {
    for (const [k, v] of Object.entries(p.headers as Record<string, unknown>)) {
      if (typeof v === "string") requestHeaders[k] = v;
    }
  }
  // Default to application/json for POST/PUT/PATCH if caller didn't set it —
  // matches the common pattern of cards sending JSON to their sidecar.
  if ((requestMethod === "POST" || requestMethod === "PUT" || requestMethod === "PATCH")
      && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === "content-type")) {
    requestHeaders["content-type"] = "application/json";
  }
  const requestBody = typeof p.body === "string" ? p.body : undefined;
  // Internal sidecars get a 10-minute cap (vs 60s for external) — first-call
  // model downloads + GPU loads legitimately exceed a minute. Card authors
  // who need more should still set explicit `timeout:` in the mica.fetch call;
  // unset defaults to DEFAULT_TIMEOUT_MS (30s) which is fine for warm calls.
  const timeoutMs = Math.max(1, Math.min(typeof p.timeout === "number" ? p.timeout : DEFAULT_TIMEOUT_MS, MAX_INTERNAL_TIMEOUT_MS));

  const targetUrl = `http://127.0.0.1:${port}${pathPart}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(targetUrl, {
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
    });
    // Read body. Same 10MB cap as public fetch for symmetry.
    const reader = resp.body?.getReader();
    let total = 0;
    let truncated = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.length;
          if (total > RESPONSE_MAX_BYTES) {
            truncated = true;
            const keep = value.subarray(0, RESPONSE_MAX_BYTES - (total - value.length));
            chunks.push(keep);
            await reader.cancel().catch(() => {});
            break;
          }
          chunks.push(value);
        }
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const bodyText = buffer.toString("utf-8");

    const headersOut: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headersOut[k] = v; });

    touchCardSidecar(project, className);
    const durationMs = Date.now() - startedAt;
    console.log(`[mica-fetch:${projLabel}] mica-internal card-server (${className}) ${requestMethod} ${pathPart} -> ${resp.status} ${durationMs}ms`);
    return {
      status: resp.status,
      headers: headersOut,
      body: bodyText,
      durationMs,
      truncated: truncated || undefined,
    };
  } catch (e) {
    const aborted = (e as { name?: string })?.name === "AbortError";
    const code = aborted ? "timeout" : "card_sidecar_connect_failed";
    const msg = aborted
      ? `card-sidecar '${className}' timed out after ${timeoutMs}ms`
      : `card-sidecar '${className}' connection failed: ${(e as Error).message}`;
    console.log(`[mica-fetch:${projLabel}] mica-internal card-server (${className}) -> ERROR ${code} ${Date.now() - startedAt}ms`);
    return errorResult2(code, msg);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── Persistent-failure streak tracking ──────────────────────
//
// Track consecutive same-status (or same-errorCode) failures per
// (project, cardFilename, urlPattern). After STREAK_THRESHOLD
// consecutive failures with no intervening success, fire ONE card-error
// broadcast (routed through cardErrorBuffer's holdback so the agent has
// a chance to self-heal first). Reset on success.
//
// Why: cards routinely catch their own failures, console.error them, and
// move on. Mica never sees them. A persistent 429 / 500 loop is invisible
// to the agent until the user pastes browser console output. This makes
// "stuck broken" visible automatically while still being quiet about
// transient single failures (one 429 is fine — the card handles it via
// backoff).

interface StreakEntry {
  /** What kind of failure: `status:429`, `errorCode:rate_limited`, etc. */
  label: string;
  count: number;
  firstSeenAt: number;
  /** True once we've already fired the broadcast for this streak — prevents
   *  the same streak firing again on the 4th/5th/Nth failure. Cleared on
   *  the next success (which deletes the entry entirely). */
  reported: boolean;
}

const STREAK_THRESHOLD = 3;
const STREAK_PRUNE_AFTER_MS = 10 * 60_000;  // 10 min idle → forget
const streaks = new Map<string, StreakEntry>();

function streakKey(project: string, cardFilename: string, urlPattern: string): string {
  return `${project}|${cardFilename}|${urlPattern}`;
}

function urlPatternFromUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

/** Update the streak for one fetch outcome. Fires card-error after
 *  STREAK_THRESHOLD consecutive matching failures. */
function recordOutcome(
  project: string,
  cardFilename: string,
  url: string,
  result: FetchResult,
): void {
  const pattern = urlPatternFromUrl(url);
  const key = streakKey(project, cardFilename, pattern);

  // Success (any 2xx or 3xx) → reset.
  if (result.status >= 200 && result.status < 400) {
    streaks.delete(key);
    return;
  }

  // Failure shape. errorCode means our-side; status >=400 means upstream.
  const label = result.errorCode
    ? `errorCode:${result.errorCode}`
    : result.status > 0 ? `status:${result.status}` : "unknown";

  const existing = streaks.get(key);
  if (existing && existing.label === label) {
    existing.count++;
    if (existing.count === STREAK_THRESHOLD && !existing.reported) {
      existing.reported = true;
      const elapsedSec = Math.round((Date.now() - existing.firstSeenAt) / 1000);
      const hint = result.errorCode === "rate_limited"
        ? "Mica's own rate limiter — slow the polling cadence or batch requests."
        : label.startsWith("status:4") || label.startsWith("status:5")
          ? "Check the URL, auth headers, request body, or upstream rate limit."
          : "Check the card's request URL or network reachability.";
      recordPendingError(
        project,
        cardFilename,
        `mica.fetch persistent failure on ${pattern}: ${label} ` +
        `(${existing.count} consecutive times over ${elapsedSec}s). ${hint}`,
      );
    }
  } else {
    // First failure, or different shape than the prior streak — reset.
    streaks.set(key, { label, count: 1, firstSeenAt: Date.now(), reported: false });
  }
}

// Periodic prune: a card that errored 3× then went idle shouldn't keep
// a stale streak around forever (would prevent a fresh streak from
// reporting if the same card's URL fails again after a long gap).
setInterval(() => {
  const cutoff = Date.now() - STREAK_PRUNE_AFTER_MS;
  for (const [k, e] of streaks) {
    if (e.firstSeenAt < cutoff) streaks.delete(k);
  }
}, STREAK_PRUNE_AFTER_MS).unref();

// ── Main handler ─────────────────────────────────────────────

export async function fetchHandler(
  method: string,
  params: unknown,
  project: string | null,
): Promise<unknown> {
  const result = await fetchHandlerInner(method, params, project);
  // Track outcome for streak detection. Skip if we don't have the calling
  // card's filename (older bridge versions, internal callers) — there's
  // nowhere to attribute the broadcast.
  if (method === "request" && project && result && typeof result === "object") {
    const p = params as { url?: unknown; _cardFilename?: unknown };
    const cardFilename = typeof p._cardFilename === "string" ? p._cardFilename : null;
    const url = typeof p.url === "string" ? p.url : "";
    if (cardFilename && url && !url.startsWith("mica-internal://card-server/")) {
      recordOutcome(project, cardFilename, url, result as FetchResult);
    }
  }
  return result;
}

async function fetchHandlerInner(
  method: string,
  params: unknown,
  project: string | null,
): Promise<unknown> {
  if (method !== "request") {
    throw new Error(`Unknown method: mica.fetch.${method}`);
  }

  const p = (params || {}) as {
    url?: unknown;
    method?: unknown;
    headers?: unknown;
    body?: unknown;
    timeout?: unknown;
    _cardClass?: unknown;
    _cardFilename?: unknown;
  };

  const startedAt = Date.now();
  const projLabel = project ?? "-";

  // Card-class-private sidecar proxy. URLs of the form
  //   mica-internal://card-server/<path>
  // are routed to THIS card's class sidecar (spawned lazily). The card's
  // class name is injected by the client bridge (CardRuntime.tsx) via the
  // _cardClass payload field — derived from mica.filename's extension.
  // Skips SSRF / DNS / rate-limit checks: the destination is a process we
  // ourselves spawned on 127.0.0.1, and the per-card concurrency is bounded
  // by the underlying TCP semantics.
  if (typeof p.url === "string" && p.url.startsWith("mica-internal://card-server/")) {
    return proxyToCardSidecar(p, project, projLabel, startedAt);
  }

  // 1. URL validation.
  const parsed = parseUrl(p.url);
  if (!parsed.ok) {
    const e = errorResult("url_invalid", parsed.reason, startedAt);
    console.log(`[mica-fetch:${projLabel}] ${String(p.method || "GET")} <invalid-url> -> BLOCKED url_invalid 0ms`);
    return e;
  }
  const { url: targetUrl, hostname } = parsed.parsed;

  // 2. Rate limit.
  const rl = checkRateLimit(project);
  if (!rl.ok) {
    const e = errorResult(
      "rate_limited",
      `Rate limit exceeded for project '${projLabel}' (${RATE_LIMIT_MAX_REQUESTS} req/${RATE_LIMIT_WINDOW_MS / 1000}s). Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s.`,
      startedAt,
      { retryAfterMs: rl.retryAfterMs },
    );
    console.log(`[mica-fetch:${projLabel}] ${String(p.method || "GET")} ${redactUrlForLog(targetUrl.href)} -> BLOCKED rate_limited 0ms`);
    return e;
  }

  // 3. SSRF check: resolve hostname, reject if any IP is in a blocked range.
  const resolution = await resolveHost(hostname);
  if (!resolution.ok) {
    const e = errorResult("dns_error", resolution.reason, startedAt);
    console.log(`[mica-fetch:${projLabel}] ${String(p.method || "GET")} ${redactUrlForLog(targetUrl.href)} -> ERROR dns_error 0ms`);
    return e;
  }
  for (const ip of resolution.ips) {
    if (isBlockedIP(ip)) {
      const e = errorResult(
        "ssrf_blocked",
        `Host '${hostname}' resolves to ${ip} which is in a blocked range (loopback / private / link-local / metadata). Mica's fetch proxy only allows public addresses to prevent server-side request forgery.`,
        startedAt,
      );
      console.log(`[mica-fetch:${projLabel}] ${String(p.method || "GET")} ${redactUrlForLog(targetUrl.href)} -> BLOCKED ssrf_blocked (${ip}) 0ms`);
      return e;
    }
  }

  // 4. Assemble request params.
  const requestMethod = typeof p.method === "string" ? p.method.toUpperCase() : "GET";
  if (!ALLOWED_METHODS.has(requestMethod)) {
    const e = errorResult("url_invalid", `Unsupported method '${requestMethod}'. Allowed: ${[...ALLOWED_METHODS].join(", ")}`, startedAt);
    console.log(`[mica-fetch:${projLabel}] ${requestMethod} ${redactUrlForLog(targetUrl.href)} -> BLOCKED url_invalid 0ms`);
    return e;
  }

  const requestHeaders: Record<string, string> = {};
  if (p.headers && typeof p.headers === "object") {
    for (const [k, v] of Object.entries(p.headers as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      // Drop hop-by-hop and host-manipulation headers. The rest pass through.
      const lower = k.toLowerCase();
      if (["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authorization", "proxy-connection"].includes(lower)) continue;
      requestHeaders[k] = v;
    }
  }

  const requestBody = typeof p.body === "string" ? p.body : undefined;

  const timeoutMs = Math.max(1, Math.min(typeof p.timeout === "number" ? p.timeout : DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(targetUrl.href, {
      method: requestMethod,
      headers: requestHeaders,
      body: requestBody,
      signal: controller.signal,
      redirect: "follow",
    });

    // 5. Read body with size cap.
    const reader = resp.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    if (reader) {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > RESPONSE_MAX_BYTES) {
          // Take what fits and stop.
          const keep = value.subarray(0, RESPONSE_MAX_BYTES - (total - value.length));
          chunks.push(keep);
          truncated = true;
          try { await reader.cancel(); } catch { /* best-effort */ }
          break;
        }
        chunks.push(value);
      }
    }

    const bodyBuf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const body = bodyBuf.toString("utf-8");

    const headers: Record<string, string> = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });

    const durationMs = Date.now() - startedAt;
    console.log(`[mica-fetch:${projLabel}] ${requestMethod} ${redactUrlForLog(targetUrl.href)} -> ${resp.status} ${bodyBuf.length}b ${durationMs}ms${truncated ? " [truncated]" : ""}`);

    return {
      status: resp.status,
      headers,
      body,
      durationMs,
      ...(truncated ? { truncated: true } : {}),
    } satisfies FetchResult;

  } catch (err) {
    const errAny = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    const durationMs = Date.now() - startedAt;
    let errorCode: FetchErrorCode = "connect_error";
    let message = errAny.message || String(err);
    if (errAny.name === "AbortError" || errAny.name === "TimeoutError") {
      errorCode = "timeout";
      message = `Request exceeded timeout of ${timeoutMs}ms`;
    } else if (errAny.cause?.code === "ENOTFOUND" || errAny.code === "ENOTFOUND") {
      errorCode = "dns_error";
    } else if (errAny.cause?.code === "ECONNREFUSED" || errAny.code === "ECONNREFUSED" ||
               errAny.cause?.code === "ECONNRESET" || errAny.code === "ECONNRESET") {
      errorCode = "connect_error";
    }
    console.log(`[mica-fetch:${projLabel}] ${requestMethod} ${redactUrlForLog(targetUrl.href)} -> ERROR ${errorCode} ${durationMs}ms`);
    return errorResult(errorCode, message, startedAt);

  } finally {
    clearTimeout(timeoutHandle);
  }
}
