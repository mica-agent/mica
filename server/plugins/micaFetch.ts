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

// ── Configuration ────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
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

// ── Main handler ─────────────────────────────────────────────

export async function fetchHandler(
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
  };

  const startedAt = Date.now();
  const projLabel = project ?? "-";

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
