// mica_inspect_url — server-side dependency-URL verification with a
// tiny structured return. Replaces the two-curl pattern (HEAD for
// status + partial GET for UMD body sniff) that research-candidates
// previously used per library/plugin candidate.
//
// Architectural fit: same shape as renderCaptureTool — Mica does the
// external work, returns a small structured result. The raw response
// body never enters chat history (a single 5KB JS bundle x 4
// candidates = 20KB of accumulated bloat avoided per build). Only the
// verdict ({ ok, status, format, ... }) makes it back to the model.
//
// Stays inside the augmentation-layer boundary (Tenet 10): we're not
// compressing chat history or rewriting the agent's prompt — we're
// providing a domain primitive that does a bounded task and returns
// a bounded result.

import { z } from "zod";
import type { AgentToolDef, AgentToolResult } from "./registry.js";

const inputSchema = {
  url: z
    .string()
    .url()
    .describe(
      "The HTTP(S) URL to inspect. Typically a CDN URL for a candidate " +
        "library / plugin (e.g. https://cdn.jsdelivr.net/npm/<pkg>@<ver>/...).",
    ),
} as const;

interface InspectResult {
  ok: boolean;
  url: string;
  status: number;
  contentType?: string;
  sizeBytes?: number;
  format?: "UMD" | "ESM" | "CommonJS" | "data" | "unknown";
  bodyHint?: string;
  /** Public method/function names extracted from the body sample.
   *  Used by the agent when a runtime "X.foo is not a function" error
   *  appears — instead of guessing other method names, the agent reads
   *  this list to find the actual API. May be incomplete on large
   *  minified bundles (we only fetch ~32KB); empty list doesn't mean
   *  the library has no methods, just none in the sample. */
  methods?: string[];
  reason?: string;
}

// Match common UMD wrappers in the first ~30 lines of a JS bundle.
// jsdelivr/unpkg JS files almost always lead with one of these
// patterns when they're browser-loadable. Order matters: try the
// most-specific (UMD wrapper detection) first.
function detectFormat(body: string): {
  format: InspectResult["format"];
  bodyHint?: string;
} {
  const head = body.slice(0, 4096);
  const firstNonEmpty = head
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 30);

  if (firstNonEmpty.length === 0) return { format: "unknown" };

  // Strip leading /*! ... */ or // ... license comments to find the
  // real first line of code. Bundles often start with a license block.
  let codeStart = 0;
  while (codeStart < firstNonEmpty.length) {
    const line = firstNonEmpty[codeStart];
    if (/^\/\*|^\*|^\*\/|^\/\//.test(line)) {
      codeStart++;
      continue;
    }
    break;
  }
  const codeLines = firstNonEmpty.slice(codeStart);
  const codeHead = codeLines.join("\n");
  const firstCodeLine = codeLines[0] ?? firstNonEmpty[0];

  // Data: JSON / CSS / plain text starting with structural punctuation.
  if (/^[{\[]/.test(firstCodeLine)) return { format: "data", bodyHint: firstCodeLine.slice(0, 80) };

  // UMD: IIFE wrapper. Match either `(function(...){...})(this, ...)`
  // or `!function(...){...}(...)` shape in the first code lines.
  // Real UMD wrappers usually fit on one or two lines.
  if (
    /^[(!]function\s*\(/.test(firstCodeLine) ||
    /^[(!]\s*function\s*\(/.test(firstCodeLine) ||
    // Some bundlers emit: `(self.webpackChunk = ...).push(...)` — also UMD-ish.
    /\(self\.[A-Za-z_$][\w$]*\s*=/.test(firstCodeLine)
  ) {
    return { format: "UMD", bodyHint: firstCodeLine.slice(0, 80) };
  }

  // ESM: top-level import/export statements. Look for them in the
  // code-head (after stripping comments).
  if (/^(import|export)\b/m.test(codeHead)) {
    const line = codeLines.find((l) => /^(import|export)\b/.test(l));
    return { format: "ESM", bodyHint: (line ?? firstCodeLine).slice(0, 80) };
  }

  // CommonJS: require()/module.exports/exports.X with no IIFE wrap.
  // Bare `require("...")` at top level is the giveaway. Same for
  // `module.exports = ` early in the file.
  if (/\brequire\s*\(/m.test(codeHead) || /\bmodule\.exports\b/m.test(codeHead) || /^exports\./m.test(codeHead)) {
    const line = codeLines.find(
      (l) => /\brequire\s*\(/.test(l) || /\bmodule\.exports\b/.test(l) || /^exports\./.test(l),
    );
    return { format: "CommonJS", bodyHint: (line ?? firstCodeLine).slice(0, 80) };
  }

  return { format: "unknown", bodyHint: firstCodeLine.slice(0, 80) };
}

// Extract plausible public-method names from a JS bundle's body sample.
// Targets the patterns most likely to surface library methods the agent
// might be tempted to hallucinate (`setDate`, `setTime`, etc. on a
// Leaflet polygon). Best-effort: a minified bundle that hides method
// names under short aliases or that lives past the 32KB fetch budget
// won't show up here. Empty array doesn't mean "no methods exist" —
// it means "no methods in this sample."
function extractMethods(body: string): string[] {
  const found = new Set<string>();

  // 1. `Foo.prototype.bar = ...` — classic ES5 method assignment.
  for (const m of body.matchAll(/\b[A-Z][a-zA-Z0-9_$]*\.prototype\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[=:]/g)) {
    if (m[1]) found.add(m[1]);
  }

  // 2. Leaflet's mixin pattern: `L.Class.include({ foo: ..., bar: ... })`.
  // Extract keys of the object literal passed to .include() / .extend() /
  // .addInitHook(). Matches a single-level block (won't recurse into
  // nested objects, but the top-level keys are what's public).
  for (const m of body.matchAll(/\.(?:include|extend|addInitHook)\s*\(\s*\{([^}]+)\}/g)) {
    const block = m[1] || "";
    for (const k of block.matchAll(/(?:^|,)\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g)) {
      if (k[1]) found.add(k[1]);
    }
  }

  // 3. `export function name(...)` — ESM named exports.
  for (const m of body.matchAll(/\bexport\s+(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g)) {
    if (m[1]) found.add(m[1]);
  }

  // 4. `exports.name = function` / `module.exports.name = function`
  //    — CommonJS named exports.
  for (const m of body.matchAll(/\b(?:module\.)?exports\.([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*function/g)) {
    if (m[1]) found.add(m[1]);
  }

  // 5. `Foo.bar = function (...)` — static methods on a capitalized
  //    identifier. Filter the captured names to lowercase-starting only
  //    so we don't pick up nested ClassNames.
  for (const m of body.matchAll(/\b[A-Z][a-zA-Z0-9_$]*\.([a-z_$][a-zA-Z0-9_$]*)\s*=\s*function/g)) {
    if (m[1]) found.add(m[1]);
  }

  // Strip a stop-list of common JS-language / framework names that the
  // agent already knows about — they're not useful API discovery.
  const STOP = new Set([
    "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
    "propertyIsEnumerable", "then", "catch", "finally", "call", "apply",
    "bind",
  ]);
  for (const s of STOP) found.delete(s);

  // Cap at 40 — past that the list isn't useful, just noise.
  return Array.from(found).sort().slice(0, 40);
}

function pkgFromCdnUrl(url: string): string | null {
  // Best-effort: extract `<pkg>` from a jsdelivr/unpkg URL.
  // Returns null if the URL shape isn't recognizable.
  // jsdelivr: https://cdn.jsdelivr.net/npm/<pkg>[@version]/...
  // unpkg:    https://unpkg.com/<pkg>[@version]/...
  const m =
    url.match(/cdn\.jsdelivr\.net\/npm\/((?:@[^/]+\/)?[^/@]+)/) ||
    url.match(/unpkg\.com\/((?:@[^/]+\/)?[^/@]+)/);
  return m ? m[1] : null;
}

async function fetchPartialBody(url: string): Promise<{
  text: string;
  contentType?: string;
  sizeBytes?: number;
}> {
  // Try Range request first to avoid pulling the whole bundle. 32KB is
  // enough to (a) detect the wrapper format from the head and (b) catch
  // method definitions for small/medium libraries. The body stays on
  // the server — only the structured result returns to the model.
  const RANGE_BYTES = 32 * 1024;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${RANGE_BYTES - 1}` },
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") || undefined;
    const contentRange = res.headers.get("content-range");
    let sizeBytes: number | undefined;
    if (contentRange) {
      const total = contentRange.split("/")[1];
      if (total && /^\d+$/.test(total)) sizeBytes = parseInt(total, 10);
    } else {
      const cl = res.headers.get("content-length");
      if (cl && /^\d+$/.test(cl)) sizeBytes = parseInt(cl, 10);
    }
    const buf = await res.arrayBuffer();
    const text = new TextDecoder("utf-8", { fatal: false }).decode(buf.slice(0, RANGE_BYTES));
    return { text, contentType, sizeBytes };
  } finally {
    clearTimeout(timer);
  }
}

export const inspectUrlTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_inspect_url",
  description:
    "Inspect an HTTP(S) URL and return a STRUCTURED verdict — does the work " +
    "of (curl -sI + curl -s | head) in a single call, but with ~300-800 bytes " +
    "of output instead of 1-3KB of raw body that would sit in chat history. " +
    "Use this for dependency-URL verification during research-candidates " +
    "(library / plugin / asset / data URLs) AND for API discovery when fixing " +
    "runtime errors (see `methods` field below). Returns JSON: { ok, status, " +
    "contentType, sizeBytes, format, bodyHint, methods? } where format is " +
    "'UMD' | 'ESM' | 'CommonJS' | 'data' | 'unknown'. UMD = browser-loadable " +
    "as <script>; CommonJS or ESM = WON'T load in a card class without a " +
    "bundler (mark the candidate as unverified for browser use). The optional " +
    "`methods` array lists public method names extracted from the body sample " +
    "(prototypes, Leaflet-style .include({...}) mixins, ESM/CommonJS named " +
    "exports). USE THIS when a runtime error of shape 'X.foo is not a function' " +
    "appears — read the `methods` array for the actual API instead of guessing " +
    "more method names. Empty array means none in the ~32KB sample, not 'no " +
    "methods exist'. On non-200 the result includes a `reason` with a pivot " +
    "suggestion (e.g. jsdelivr file listing). Use INSTEAD of raw curl for " +
    "verification — saves ~3KB of context per candidate. Keep curl for the " +
    "remaining cases: jsdelivr file listings on 404 pivot, CORS header checks " +
    "on asset URLs, and live-service smoke tests.",
  inputSchema,
  restPath: "/api/tools/inspect-url",
  handler: async (input): Promise<AgentToolResult> => {
    const url = input.url;
    let status = 0;
    let contentType: string | undefined;
    let sizeBytes: number | undefined;
    try {
      // HEAD first — cheap and gives us status + content-type without
      // pulling the body. Some CDNs don't allow HEAD; we'll fall back
      // to GET below if HEAD's status is not in [200, 405, 501].
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "HEAD",
          redirect: "follow",
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      status = res.status;
      contentType = res.headers.get("content-type") || undefined;
      const cl = res.headers.get("content-length");
      if (cl && /^\d+$/.test(cl)) sizeBytes = parseInt(cl, 10);

      // Non-200 status — return the failure verdict with a pivot
      // suggestion if we recognize the CDN.
      if (status < 200 || status >= 300) {
        const pkg = pkgFromCdnUrl(url);
        const reason =
          status === 404 && pkg
            ? `Not Found on this path. Pivot to the jsdelivr file listing: curl -s https://data.jsdelivr.com/v1/package/npm/${pkg}`
            : `HTTP ${status}`;
        return {
          text: JSON.stringify({ ok: false, url, status, contentType, sizeBytes, reason } satisfies InspectResult),
        };
      }

      // For body sniff, only bother if the response is likely text.
      // application/javascript, text/*, application/json all qualify.
      const isTextish =
        !contentType ||
        /^text\//i.test(contentType) ||
        /^application\/(javascript|json|x-javascript|ecmascript|xml|.*\+json)\b/i.test(contentType);
      if (!isTextish) {
        // Binary / image / font — caller probably wanted asset reachability.
        return {
          text: JSON.stringify({ ok: true, url, status, contentType, sizeBytes, format: "unknown" } satisfies InspectResult),
        };
      }

      const { text: body, contentType: bodyContentType, sizeBytes: bodySize } = await fetchPartialBody(url);
      const fmt = detectFormat(body);
      // Skip method extraction for non-code bodies (JSON/data, unknown).
      const methods =
        fmt.format === "UMD" || fmt.format === "ESM" || fmt.format === "CommonJS"
          ? extractMethods(body)
          : undefined;
      const result: InspectResult = {
        ok: true,
        url,
        status,
        contentType: bodyContentType ?? contentType,
        sizeBytes: bodySize ?? sizeBytes,
        format: fmt.format,
        bodyHint: fmt.bodyHint,
        ...(methods && methods.length > 0 ? { methods } : {}),
      };
      return { text: JSON.stringify(result) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        text: JSON.stringify({
          ok: false,
          url,
          status: status || 0,
          reason: `Fetch failed: ${msg}`,
        } satisfies InspectResult),
      };
    }
  },
};
