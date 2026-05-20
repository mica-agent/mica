// handlerBaselineInjection.ts — auto-inject channel-handler examples into
// the agent's per-turn canvas baseline.
//
// The failure shape this prevents: agent picks a handler (e.g. `llm-direct`)
// in the spec frontmatter, then writes card.js in a LATER turn whose context
// no longer contains the spec body OR the handler's manifest examples.
// Hallucinated channel APIs follow — `channel.on('token', cb)` instead of
// `channel.onData(evt => ...)`, `openChannel({handler, args})` instead of
// `openChannel('turn', args)`, wrong message-payload shape — and the card
// throws at runtime.
//
// The fix is structural: every turn the agent is on a canvas, scan the
// declared handlers (in `canvas/*-spec.md` frontmatter AND in
// `.mica/card-classes/*/metadata.json`), look up each one's manifest
// `examples` block, and append a "## Channel handler contracts in this
// project" section. The example skeleton is always in context where the
// card.js write happens — no separate tool call, no re-read step, no
// discovery the agent can skip.
//
// Cost: ~1-2KB per unique handler in baseline. Typical project has 1-3
// card classes → 1-6KB overhead against a ~10K-token baseline. Trivial
// compared to the cost of a hallucinated channel API (the card breaks at
// runtime; the agent burns N debug turns fixing it).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_DIR } from "./files.js";
import { readSpecForClass } from "./specFrontmatter.js";
import { getManifest } from "./handlerManifest.js";

/** Scan the project's `canvas/` specs and materialized card-class metadata
 *  for declared handlers. Returns the deduped set, with a usage trace so
 *  the baseline section can name which card class uses each. */
async function collectDeclaredHandlers(
  project: string,
): Promise<Map<string, string[]>> {
  const handlers = new Map<string, Set<string>>();
  const projectRoot = join(WORKSPACE_DIR, project);

  // 1. Specs under canvas/
  try {
    const canvasEntries = await readdir(join(projectRoot, "canvas"), { withFileTypes: true });
    for (const entry of canvasEntries) {
      if (!entry.isFile() || !entry.name.endsWith("-spec.md")) continue;
      const className = entry.name.slice(0, -"-spec.md".length);
      try {
        const parsed = await readSpecForClass(projectRoot, className);
        const handlerName = parsed?.cardClass?.handler;
        if (typeof handlerName === "string" && handlerName.trim()) {
          addUsage(handlers, handlerName.trim(), `spec:${className}`);
        }
      } catch { /* skip unreadable spec */ }
    }
  } catch { /* no canvas/ dir — fine */ }

  // 2. Materialized card classes under .mica/card-classes/
  try {
    const classDir = join(projectRoot, ".mica", "card-classes");
    const classEntries = await readdir(classDir, { withFileTypes: true });
    for (const entry of classEntries) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(await readFile(join(classDir, entry.name, "metadata.json"), "utf-8"));
        const handlerName = meta?.handler;
        if (typeof handlerName === "string" && handlerName.trim()) {
          addUsage(handlers, handlerName.trim(), `class:${entry.name}`);
        }
      } catch { /* skip classes without metadata.handler */ }
    }
  } catch { /* no card-classes/ — fine */ }

  // Convert Set → Array for deterministic rendering order.
  const out = new Map<string, string[]>();
  for (const [name, usages] of handlers) {
    out.set(name, Array.from(usages).sort());
  }
  return out;
}

function addUsage(map: Map<string, Set<string>>, handler: string, usage: string): void {
  let s = map.get(handler);
  if (!s) { s = new Set(); map.set(handler, s); }
  s.add(usage);
}

/** Build the "## Channel handler contracts in this project" section.
 *  Returns null when no handlers are declared (caller appends nothing).
 *  Handlers without a registered manifest are skipped silently — the
 *  validator catches "handler does not exist" elsewhere; baseline injection
 *  is just for surfacing examples of REAL handlers. */
export async function buildHandlerContractsBaseline(project: string | null): Promise<string | null> {
  if (!project) return null;
  const declared = await collectDeclaredHandlers(project);
  if (declared.size === 0) return null;

  const sections: string[] = [];
  for (const [handlerName, usages] of declared) {
    const manifest = getManifest(handlerName);
    if (!manifest) continue;
    const usageList = usages
      .map((u) => u.startsWith("spec:") ? `spec ${u.slice(5)}` : `class ${u.slice(6)}`)
      .join(", ");
    const parts: string[] = [];
    parts.push(`### \`${handlerName}\` — used by: ${usageList}`);
    parts.push(manifest.description);
    if (manifest.examples) {
      parts.push("");
      parts.push("Working card.js skeleton (copy this — do NOT invent the channel API):");
      parts.push("");
      parts.push("```js");
      parts.push(manifest.examples.trim());
      parts.push("```");
    }
    if (manifest.modelConstraints && Object.keys(manifest.modelConstraints).length > 0) {
      parts.push("");
      parts.push("**Model constraints** (per-model limits — respect these or vLLM/the model server rejects):");
      for (const [model, c] of Object.entries(manifest.modelConstraints)) {
        const bits: string[] = [];
        if (c.maxImagesPerTurn !== undefined) bits.push(`max ${c.maxImagesPerTurn} images/turn`);
        if (c.maxImageDimensionPx !== undefined) bits.push(`max ${c.maxImageDimensionPx}px long edge`);
        if (c.supportedImageFormats) bits.push(`formats: ${c.supportedImageFormats.join("/")}`);
        if (c.maxOutputTokens !== undefined) bits.push(`max ${c.maxOutputTokens} output tokens`);
        const note = c.notes ? ` — ${c.notes}` : "";
        parts.push(`- \`${model}\`: ${bits.join(", ") || "(no numeric limits)"}${note}`);
      }
    }
    sections.push(parts.join("\n"));
  }

  if (sections.length === 0) return null;

  return [
    `## Channel handler contracts in this project`,
    ``,
    `The card classes on this canvas declare the following channel handlers (via spec frontmatter's \`handler:\` field or \`metadata.json:handler\`). The working card.js skeleton for each is below — **copy from these examples when authoring or editing card.js**. Do not invent \`channel.on(...)\` / \`mica.openChannel({handler, args})\` shapes from prior assumptions; the canonical API is what's shown here.`,
    ``,
    sections.join("\n\n"),
  ].join("\n");
}
