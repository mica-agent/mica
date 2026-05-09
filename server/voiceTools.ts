// voiceTools.ts — lightweight tool implementations for the voice agent.
//
// Voice avoids the qwen-code SDK / MCP stack so its turn loop stays fast
// (~2s for in-LLM-knowledge answers). When the user asks something the
// LLM can't answer from training data ("what time is it in Tokyo?",
// "search for X"), voice's iter-0 LLM emits one of these tool calls;
// the dispatch site in voiceAgent.ts runs the function below; iter-1
// LLM gets the result via the read-tool synthetic followup and composes
// the spoken answer.
//
// Each function returns a SHORT, LLM-friendly result body. The caller
// wraps it in a `<result tool="..." ...>` block and feeds to iter 1.

import { readPasteKey } from "./connections.js";

const SEARCH_RESULT_CAP = 5;
const SEARCH_SNIPPET_CAP = 300;
const WEB_FETCH_TIMEOUT_MS = 8000;
const WEB_FETCH_BODY_CAP = 3000;

/** Search the web via Tavily. Returns a short numbered list of top
 *  results for the LLM to summarize. Throws (with a friendly message)
 *  when no Tavily key is configured or the API rejects the request. */
export async function tavilySearch(query: string): Promise<string> {
  const q = (query || "").trim();
  if (!q) throw new Error("empty query");
  const keyEntry = await readPasteKey("tavily");
  if (!keyEntry) {
    throw new Error("no Tavily API key configured (set one in Mica's Connections panel)");
  }
  const resp = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: keyEntry.key,
      query: q,
      max_results: SEARCH_RESULT_CAP,
      search_depth: "basic",
    }),
    signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    const errText = (await resp.text()).slice(0, 200);
    throw new Error(`Tavily HTTP ${resp.status}: ${errText}`);
  }
  const data = (await resp.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
    answer?: string;
  };
  const results = data.results || [];
  if (results.length === 0 && !data.answer) {
    return `No results for "${q}".`;
  }
  const lines: string[] = [];
  if (data.answer) {
    lines.push(`Tavily summary: ${data.answer.slice(0, 500).trim()}`);
  }
  results.slice(0, SEARCH_RESULT_CAP).forEach((r, i) => {
    const title = (r.title || "(no title)").trim();
    const url = (r.url || "").trim();
    const snippet = (r.content || "").trim().slice(0, SEARCH_SNIPPET_CAP);
    lines.push(`${i + 1}. ${title}\n   ${url}\n   ${snippet}`);
  });
  return lines.join("\n\n");
}

/** Fetch a URL and return text content (HTML stripped, capped). SSRF
 *  guard: only http/https on public hostnames. Throws on disallowed
 *  schemes / hostnames / timeouts. */
export async function webFetch(rawUrl: string): Promise<string> {
  const url = (rawUrl || "").trim();
  if (!url) throw new Error("empty URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error(`invalid URL: ${url}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported scheme: ${parsed.protocol}`);
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new Error(`refusing to fetch internal address: ${parsed.hostname}`);
  }
  const resp = await fetch(parsed.toString(), {
    headers: { "User-Agent": "Mica-Voice-Agent/1.0" },
    signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${parsed.hostname}`);
  }
  const ct = resp.headers.get("content-type") || "";
  const raw = await resp.text();
  // Strip HTML if the response looks like markup; otherwise return as-is.
  let text = raw;
  if (ct.includes("html") || /<html[\s>]/i.test(raw)) {
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  }
  if (text.length > WEB_FETCH_BODY_CAP) {
    text = text.slice(0, WEB_FETCH_BODY_CAP).trim() + " …(truncated)";
  }
  return text || "(empty body)";
}

/** Format the current time in a given IANA timezone. No network. Throws
 *  on invalid timezone names (Intl.DateTimeFormat raises RangeError). */
export function timeAt(tz: string | undefined | null): string {
  const now = new Date();
  const timeZone = (tz || "").trim() || undefined;  // undefined → server local
  let fmt: Intl.DateTimeFormat;
  try {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch {
    throw new Error(`unknown timezone: ${tz}`);
  }
  return fmt.format(now);
}

// ── Helpers ─────────────────────────────────────────────────────────

// SSRF guard: block hostnames that resolve (or are literally written as)
// loopback/private. Conservative — checks the literal hostname only;
// doesn't do DNS resolution. Catches the common foot-guns
// (localhost / 127.x / 10.x / 192.168.x / 172.16-31.x) without external
// lookups. A determined attacker controlling DNS could still bypass;
// voice's other paths (send_to_card, read_card) don't reach the
// network so this remains the only surface to harden.
function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "ip6-localhost" || h === "::1") return true;
  // IPv4 literals
  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const o = ipv4.slice(1).map(Number);
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 169 && o[1] === 254) return true;  // link-local
    if (o[0] === 0) return true;
    return false;
  }
  // IPv6 literals (very common form: fe80::, ::1, etc.)
  if (h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  return false;
}
