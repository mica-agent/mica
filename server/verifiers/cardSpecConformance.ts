// Verifier — does the card's CODE conform to what the SPEC declared?
//
// Background. The spec at canvas/<class>-spec.md has machine-readable
// contracts: a `dependencies` block (umd_scripts, styles) and a
// `subtasks` array where each subtask names a `mechanism` (e.g.
// "sidecar proxy (OpenSky has no CORS)", "card.js + Leaflet UMD").
// Those contracts are emitted by the develop skill at spec time. Every
// existing verifier ignores them — they check syntax, structure, and
// runtime mount, but not whether the generated code USES what the spec
// declared or FOLLOWS the architectural mechanism the spec chose.
//
// What this catches. Three contracts, in order of severity:
//
//   Contract 1 — DECLARED-DEP USE
//     For each entry in spec.dependencies.{umd_scripts,styles}, check
//     that card.html actually loads that URL (substring match including
//     the version segment). Missing → [ERROR]. For each external
//     <script>/<link> in card.html NOT in the declared set, emit
//     [WARN]("undeclared dependency in card.html: …").
//
//   Contract 2 — MECHANISM CONFORMANCE
//     For each subtask.mechanism, match known phrases:
//       /sidecar proxy/i  → no direct external URL allowed in card.js
//                            for that subtask's domain. card.js must
//                            route through mica.fetch('mica-internal:
//                            //card-server/...'). Direct external URL
//                            → [ERROR] (proxy bypass — CORS + arch
//                            violation in one).
//       /card\.js \+ (\w+)/i → captured library must appear in
//                              spec.dependencies. Mismatch → [WARN].
//     Unrecognized mechanisms are skipped (matcher list grows as
//     patterns recur).
//
//   Contract 3 — URL-LITERAL CITATIONS
//     Walk card.js, card.html, card.css, server.py for URL literals
//     (https?://…). Accept if ANY of:
//       (a) substring appears in spec.dependencies
//       (b) within 3 lines above, a `// Per <url>` / `# Per <url>`
//           comment exists (discover-dependency § 3c convention)
//       (c) within 1 line, an opt-out comment `// mica-skip-cite: <r>`
//           (or `#`)
//     Uncited URLs → [WARN]. This is the gate that would have steered
//     the agent toward verifying OpenSky's OAuth URL in zing-sunday2
//     before the 401 shipped.
//
// Mode is `warning` — never blocks the write. Severity ([ERROR] vs
// [WARN]) is encoded as a prefix in each problem.problem string so the
// agent reads it without a schema change to VerifyProblem.
//
// Triggers on writes to any of card.html, card.js, card.css, server.py
// inside .mica/card-classes/<class>/ when the canvas-root sibling spec
// `canvas/<class>-spec.md` exists. Re-reads all four code files on
// every fire because Contracts 1 and 2 are cross-file (card.js +
// card.html together; mechanism declared in spec but checked in code).

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { load as cheerioLoad } from "cheerio";
import {
  registerVerifier,
  type FileVerifier,
  type VerifyProblem,
  type VerifyResult,
} from "./registry.js";
import {
  readSpecForClass,
  urlFromDep,
  type CardClassFrontmatter,
  type SpecDependencyEntry,
} from "../specFrontmatter.js";
import { projectDir } from "../files.js";

const CODE_FILE_NAMES = new Set(["card.html", "card.js", "card.css", "server.py"]);

const CARD_CLASS_RE = /[/\\]\.mica[/\\]card-classes[/\\]([^/\\]+)[/\\]([^/\\]+)$/;

interface CodeFiles {
  cardHtml: string;
  cardJs: string;
  cardCss: string;
  serverPy: string;
  metadataJson: string;
  /** Absolute paths so problem messages point at real files. */
  paths: {
    cardHtml: string;
    cardJs: string;
    cardCss: string;
    serverPy: string;
    metadataJson: string;
  };
}

async function loadCodeFiles(
  classDir: string,
  writingFile: string,
  writingContent: string,
): Promise<CodeFiles> {
  const paths = {
    cardHtml: join(classDir, "card.html"),
    cardJs: join(classDir, "card.js"),
    cardCss: join(classDir, "card.css"),
    serverPy: join(classDir, "server.py"),
    metadataJson: join(classDir, "metadata.json"),
  };
  async function readOr(p: string): Promise<string> {
    if (p === writingFile) return writingContent;
    if (!existsSync(p)) return "";
    try {
      return await readFile(p, "utf-8");
    } catch {
      return "";
    }
  }
  return {
    cardHtml: await readOr(paths.cardHtml),
    cardJs: await readOr(paths.cardJs),
    cardCss: await readOr(paths.cardCss),
    serverPy: await readOr(paths.serverPy),
    metadataJson: await readOr(paths.metadataJson),
    paths,
  };
}

interface MetadataDeps {
  scripts: string[];
  styles: string[];
}

function readMetadataDeps(json: string): MetadataDeps {
  const out: MetadataDeps = { scripts: [], styles: [] };
  if (!json) return out;
  try {
    const parsed = JSON.parse(json) as { dependencies?: { scripts?: unknown; styles?: unknown } };
    const deps = parsed.dependencies;
    if (Array.isArray(deps?.scripts)) {
      for (const s of deps!.scripts as unknown[]) if (typeof s === "string") out.scripts.push(s);
    }
    if (Array.isArray(deps?.styles)) {
      for (const s of deps!.styles as unknown[]) if (typeof s === "string") out.styles.push(s);
    }
  } catch {
    // metadata.json parse errors are surfaced by a separate verifier path
    // (cardClass validates the schema on write). Skip silently here.
  }
  return out;
}

// ── Contract 1 ──────────────────────────────────────────────────

interface DeclaredDep {
  url: string;
  kind: "umd_script" | "style";
  version?: string;
}

function collectDeclaredDeps(fm: CardClassFrontmatter | null): DeclaredDep[] {
  if (!fm?.dependencies) return [];
  const out: DeclaredDep[] = [];
  for (const d of fm.dependencies.umd_scripts ?? []) {
    const url = urlFromDep(d);
    const version = typeof d === "object" ? (d as SpecDependencyEntry).version : undefined;
    out.push({ url, kind: "umd_script", version });
  }
  for (const d of fm.dependencies.styles ?? []) {
    const url = urlFromDep(d);
    const version = typeof d === "object" ? (d as SpecDependencyEntry).version : undefined;
    out.push({ url, kind: "style", version });
  }
  return out;
}

interface HtmlExternalAsset {
  url: string;
  tag: "script" | "link";
}

function collectExternalAssetsFromHtml(html: string): HtmlExternalAsset[] {
  const out: HtmlExternalAsset[] = [];
  if (!html) return out;
  try {
    const $ = cheerioLoad(html);
    $("script[src]").each((_, el) => {
      const src = $(el).attr("src");
      if (src && /^https?:\/\//.test(src)) out.push({ url: src, tag: "script" });
    });
    $("link[rel='stylesheet'][href]").each((_, el) => {
      const href = $(el).attr("href");
      if (href && /^https?:\/\//.test(href)) out.push({ url: href, tag: "link" });
    });
  } catch {
    // cheerio failure → skip; selector verifier covers parse-level concerns
  }
  return out;
}

/** True when `cdnUrl` (from spec.dependencies) is considered "used" by any
 *  asset URL in `htmlAssets`. Substring match on the path portion is
 *  good enough — pinned versions show up in the URL ("leaflet@1.9.4").
 *  Strip the protocol/host so http vs https doesn't make us miss. */
function depIsUsed(declared: DeclaredDep, htmlAssets: HtmlExternalAsset[]): boolean {
  const key = declared.url.replace(/^https?:\/\//, "");
  return htmlAssets.some((a) => a.url.replace(/^https?:\/\//, "").includes(key) || key.includes(a.url.replace(/^https?:\/\//, "")));
}

/** Url-key normalizer: strip protocol so http:// vs https:// don't miss,
 *  and lowercase since CDN hosts are case-insensitive. Substring-match
 *  on the normalized form. */
function urlKey(u: string): string {
  return u.replace(/^https?:\/\//, "").toLowerCase();
}

function urlsOverlap(a: string, b: string): boolean {
  const ka = urlKey(a), kb = urlKey(b);
  return ka.includes(kb) || kb.includes(ka);
}

function contract1(
  declared: DeclaredDep[],
  files: CodeFiles,
): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  if (declared.length === 0) return problems;

  // Mica's loader pattern: card.html does NOT carry the canonical
  // <script>/<link> tags — metadata.json.dependencies.{scripts,styles}
  // is what CardRuntime injects at mount time. card.html can carry
  // EXTRA inline external assets, which the verifier also walks (a
  // card with an ad-hoc <script src="..."> there is exactly the
  // drift surface Contract 1 is meant to catch).
  const meta = readMetadataDeps(files.metadataJson);
  const htmlAssets = collectExternalAssetsFromHtml(files.cardHtml);

  // Missing → ERROR. A declared dep must appear in metadata.json (the
  // primary loader surface) OR card.html (the secondary surface).
  for (const d of declared) {
    const haystack = d.kind === "umd_script" ? meta.scripts : meta.styles;
    const inMeta = haystack.some((u) => urlsOverlap(u, d.url));
    const inHtml = htmlAssets.some((a) => urlsOverlap(a.url, d.url));
    if (!inMeta && !inHtml) {
      const versionTag = d.version ? `@${d.version}` : "";
      const where = d.kind === "umd_script" ? "scripts" : "styles";
      problems.push({
        file: files.paths.metadataJson,
        problem: `[ERROR] Contract 1 — declared dep not loaded: ${d.kind} ${d.url}${versionTag} is in spec.dependencies but neither metadata.json.dependencies.${where} nor card.html load it.`,
        fix_hint: `Mica's loader reads metadata.json.dependencies.${where}; the canonical fix is to add "${d.url}" there. \`mica_create_class({ name })\` will re-derive the metadata from the spec frontmatter — that's the normal path. If you've drifted, re-call mica_create_class to resync, or hand-edit metadata.json.`,
      });
    }
  }

  // Undeclared external assets → WARNING. Either surface (metadata or
  // card.html) carrying an URL the spec didn't declare is drift.
  for (const url of meta.scripts) {
    if (!declared.some((d) => urlsOverlap(d.url, url))) {
      problems.push({
        file: files.paths.metadataJson,
        problem: `[WARN] Contract 1 — undeclared dependency in metadata.json.dependencies.scripts: ${url}. Spec.dependencies.umd_scripts does not list this URL.`,
        fix_hint: `Add the URL (with pinned version) to spec.dependencies.umd_scripts so the contract is explicit. If it was added ad-hoc, promote to the spec; if obsolete, remove from metadata.json.`,
      });
    }
  }
  for (const url of meta.styles) {
    if (!declared.some((d) => urlsOverlap(d.url, url))) {
      problems.push({
        file: files.paths.metadataJson,
        problem: `[WARN] Contract 1 — undeclared dependency in metadata.json.dependencies.styles: ${url}. Spec.dependencies.styles does not list this URL.`,
        fix_hint: `Add the URL to spec.dependencies.styles so the contract is explicit. If it was added ad-hoc, promote to the spec; if obsolete, remove from metadata.json.`,
      });
    }
  }
  for (const a of htmlAssets) {
    if (!declared.some((d) => urlsOverlap(d.url, a.url))) {
      problems.push({
        file: files.paths.cardHtml,
        problem: `[WARN] Contract 1 — undeclared external asset in card.html: <${a.tag} ${a.tag === "script" ? "src" : "href"}="${a.url}">. Spec.dependencies does not list this URL.`,
        fix_hint: `If this is a real dep, add it to spec.dependencies.${a.tag === "script" ? "umd_scripts" : "styles"} (and also to metadata.json.dependencies.${a.tag === "script" ? "scripts" : "styles"} so Mica's loader sees it). Inline asset tags in card.html bypass the loader contract.`,
      });
    }
  }
  return problems;
}

// ── Contract 2 ──────────────────────────────────────────────────

interface CardJsExternalCall {
  url: string;
  line: number;
}

const EXTERNAL_URL_IN_CODE_RE = /(["'`])(https?:\/\/[^"'`\s]+)\1/g;

/** Find every `mica.fetch(...)` or `fetch(...)` call in card.js whose
 *  first argument is a string literal beginning with http(s)://. Cheap
 *  regex over source — robust enough for the conformance signal we
 *  want. False positives (URL in a comment) are uncommon in card.js. */
function collectExternalFetchUrlsFromCardJs(js: string): CardJsExternalCall[] {
  if (!js) return [];
  const out: CardJsExternalCall[] = [];
  // Match `<id>.fetch(` or bare `fetch(` followed by a string literal URL.
  // The string literal is captured separately so we get the URL even when
  // template literals are used (no interpolation inside the URL itself).
  const fetchCall = /(?:\b(?:mica\s*\.\s*fetch|fetch)\s*\(\s*)(["'`])(https?:\/\/[^"'`]+)\1/g;
  let m: RegExpExecArray | null;
  while ((m = fetchCall.exec(js)) !== null) {
    const url = m[2];
    if (url.startsWith("mica-internal://")) continue; // sidecar proxy — fine
    const line = js.slice(0, m.index).split("\n").length;
    out.push({ url, line });
  }
  return out;
}

function contract2(
  fm: CardClassFrontmatter | null,
  declared: DeclaredDep[],
  files: CodeFiles,
): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const subtasks = fm?.subtasks ?? [];
  if (subtasks.length === 0) return problems;

  const sidecarProxyDeclared = subtasks.some((s) =>
    /sidecar proxy/i.test(s.mechanism || ""),
  );

  if (sidecarProxyDeclared) {
    const externalCalls = collectExternalFetchUrlsFromCardJs(files.cardJs);
    const offending = subtasks
      .filter((s) => /sidecar proxy/i.test(s.mechanism || ""))
      .map((s) => s.name)
      .join(", ");
    for (const call of externalCalls) {
      problems.push({
        file: files.paths.cardJs,
        line: call.line,
        problem: `[ERROR] Contract 2 — mechanism drift: subtask(s) [${offending}] declare "sidecar proxy" mechanism, but card.js calls external URL directly: ${call.url}. The proxy is declared but not used; this is a CORS violation AND an architectural violation in one.`,
        fix_hint: `Route this fetch through the sidecar: replace the URL with \`mica-internal://card-server/<sidecar-endpoint>\` and add the matching @app.get/@app.post route to server.py that calls the real ${call.url}. If the spec was wrong (this subtask doesn't actually need a sidecar proxy), update spec.subtasks[].mechanism to reflect reality before editing card.js.`,
      });
    }
  }

  // /card.js + <lib>/ matcher
  // Browser APIs / built-ins don't need a CDN URL — they're part of the
  // platform. The matcher should NOT flag a subtask whose mechanism says
  // "card.js + setInterval" the way it would flag "card.js + Leaflet."
  // /card.js + <lib>/ matcher
  // Two narrowings to reduce noise:
  //   (a) Tokens containing `.` (e.g. `mica.fetch`, `Math.random`) are
  //       method references, not library names. Skip.
  //   (b) Tokens that match a browser API, the Mica host-API surface,
  //       or a stdlib data structure don't need a CDN URL.
  //   (c) Single short lowercase tokens (`heading`, `velocity`) are
  //       almost always domain nouns inside a longer mechanism phrase,
  //       not a library handle. Skip when no capital letter and ≤8 chars.
  const PLATFORM_LIB = new Set([
    // Browser APIs
    "setinterval", "settimeout", "fetch", "promise", "requestanimationframe",
    "indexeddb", "localstorage", "sessionstorage", "websocket", "eventsource",
    "intersectionobserver", "mutationobserver", "resizeobserver",
    "performanceobserver", "broadcastchannel", "audiocontext",
    "speechrecognition", "speechsynthesis", "canvas", "webgl", "webgl2",
    "crypto", "subtle", "url", "urlsearchparams", "formdata", "blob", "file",
    "filereader", "abortcontroller", "geolocation", "navigator",
    "document", "window", "console", "math", "json", "date", "regexp",
    // Mica host-API surface
    "mica", "container",
  ]);
  const libRe = /card\.js\s*\+\s*([A-Za-z][\w.-]+)/i;
  const declaredLibSurface = declared
    .map((d) => d.url.toLowerCase())
    .join(" ");
  for (const s of subtasks) {
    const m = (s.mechanism || "").match(libRe);
    if (!m) continue;
    const lib = m[1];
    const libKey = lib.toLowerCase();
    if (lib.includes(".")) continue;             // method reference, not library
    if (PLATFORM_LIB.has(libKey)) continue;
    // Lowercase-only short token → almost always a domain noun, not a library.
    if (lib === libKey && lib.length <= 8) continue;
    // Permissive: match if the library name (lowercased) appears in any
    // declared URL — e.g. "Leaflet" → matches "leaflet@1.9.4".
    if (!declaredLibSurface.includes(libKey)) {
      problems.push({
        file: files.paths.cardHtml,
        problem: `[WARN] Contract 2 — subtask "${s.name}" declares mechanism "card.js + ${lib}" but "${libKey}" does not appear in spec.dependencies URLs.`,
        fix_hint: `Add the ${lib} CDN URL (with version) to spec.dependencies.umd_scripts so the dep is contract-tracked. If ${lib} is loaded a different way (e.g. ESM dynamic import), update the subtask mechanism to say so. If ${lib} is a browser/platform API, no spec dep is needed — file a PR adding "${libKey}" to the PLATFORM_LIB set in server/verifiers/cardSpecConformance.ts.`,
      });
    }
  }
  return problems;
}

// ── Contract 3 ──────────────────────────────────────────────────

interface UrlOccurrence {
  url: string;
  line: number;
  file: string;
  /** All lines of the file, so we can look back for citation comments. */
  allLines: string[];
}

function collectUrlLiterals(content: string, file: string): UrlOccurrence[] {
  if (!content) return [];
  const lines = content.split("\n");
  const out: UrlOccurrence[] = [];
  // Match URLs inside string-literal quotes (`'`, `"`, `` ` ``). This avoids
  // picking up URLs that appear inside comments — which is exactly the
  // citation-comment shape we want to allowlist.
  const re = new RegExp(EXTERNAL_URL_IN_CODE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const url = m[2];
    if (url.startsWith("mica-internal://")) continue;
    const line = content.slice(0, m.index).split("\n").length;
    out.push({ url, line, file, allLines: lines });
  }
  return out;
}

function urlIsDeclared(url: string, declared: DeclaredDep[]): boolean {
  const key = url.replace(/^https?:\/\//, "");
  return declared.some((d) => {
    const dk = d.url.replace(/^https?:\/\//, "");
    return key.includes(dk) || dk.includes(key);
  });
}

const PER_COMMENT_RE = /(?:\/\/|#)\s*Per\s+(https?:\/\/\S+)/i;
const SKIP_CITE_RE = /(?:\/\/|#)\s*mica-skip-cite\s*:/i;

function urlIsCited(occ: UrlOccurrence): boolean {
  // Skip-cite: within 1 line above or on the same line.
  const start = Math.max(0, occ.line - 2);
  for (let i = start; i < occ.line; i++) {
    if (SKIP_CITE_RE.test(occ.allLines[i] || "")) return true;
  }
  // Per <url>: within 3 lines above.
  const perStart = Math.max(0, occ.line - 4);
  for (let i = perStart; i < occ.line; i++) {
    if (PER_COMMENT_RE.test(occ.allLines[i] || "")) return true;
  }
  return false;
}

function contract3(
  declared: DeclaredDep[],
  files: CodeFiles,
): VerifyProblem[] {
  const problems: VerifyProblem[] = [];
  const sources: Array<{ content: string; path: string }> = [
    { content: files.cardJs, path: files.paths.cardJs },
    { content: files.cardHtml, path: files.paths.cardHtml },
    { content: files.cardCss, path: files.paths.cardCss },
    { content: files.serverPy, path: files.paths.serverPy },
  ];
  for (const src of sources) {
    if (!src.content) continue;
    const occs = collectUrlLiterals(src.content, src.path);
    for (const occ of occs) {
      if (urlIsDeclared(occ.url, declared)) continue;
      if (urlIsCited(occ)) continue;
      problems.push({
        file: occ.file,
        line: occ.line,
        problem: `[WARN] Contract 3 — URL not cited per discover-dependency § 3c: ${occ.url}. Was this URL verified against authoritative docs?`,
        fix_hint: `Add a citation comment within 3 lines above: \`// Per <doc-url>\` (or \`# Per <doc-url>\` in Python). The cited URL should be where you confirmed the endpoint, response schema, or asset path. If this is a legitimate exception (e.g. a tile-server template, a known fixed asset), use \`// mica-skip-cite: <reason>\` (or \`# mica-skip-cite: <reason>\`).`,
      });
    }
  }
  return problems;
}

// ── Orchestrator ────────────────────────────────────────────────

const verifier: FileVerifier = {
  name: "card-spec-conformance",
  mode: "warning",
  matches: async (filepath, project) => {
    if (!project) return false;
    const m = filepath.match(CARD_CLASS_RE);
    if (!m) return false;
    const fileBase = basename(filepath);
    if (!CODE_FILE_NAMES.has(fileBase)) return false;
    const className = m[1];
    const specPath = join(projectDir(project), "canvas", `${className}-spec.md`);
    return existsSync(specPath);
  },
  verify: async (filepath, content, project): Promise<VerifyResult> => {
    if (!project) return { ok: true };
    const m = filepath.match(CARD_CLASS_RE);
    if (!m) return { ok: true };
    const className = m[1];
    const classDir = dirname(filepath);

    const parsed = await readSpecForClass(projectDir(project), className);
    if (!parsed) return { ok: true };
    const fm = parsed.cardClass;
    // No frontmatter → no contract. Verifier sleeps quietly (back-compat).
    if (!fm) return { ok: true };

    const files = await loadCodeFiles(classDir, filepath, content);
    const declared = collectDeclaredDeps(fm);

    const problems: VerifyProblem[] = [
      ...contract1(declared, files),
      ...contract2(fm, declared, files),
      ...contract3(declared, files),
    ];

    if (problems.length === 0) return { ok: true };
    return { ok: false, verifier: "card-spec-conformance", problems };
  },
};

registerVerifier(verifier);
