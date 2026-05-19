// mica_list_handlers — discovery surface for registered channel handlers.
//
// Parallel to mica_list_classes (which lists card classes on disk) and
// mica_list_skill_packages (which lists curated library packs). Returns
// a structured summary of every handler the backend has registered:
// name, whenToUse, args schema highlights, and modelConstraints summary
// when the handler ships one.
//
// Why this is a registered tool and not just curl /api/handlers:
//   - The /api/handlers endpoint is the source of truth and returns the
//     full manifest. But the agent has to remember it's there and curl
//     it manually. Multiple observed builds reached for CDN libraries
//     (TFJS, MobileNet, transformers.js) before considering whether a
//     handler already provided the capability — because the discovery
//     surface they DO naturally reach for (the registered mica_list_*
//     tools) didn't include handlers.
//   - Promoting handler discovery to a first-class tool puts it in the
//     agent's tool list and biases the decomposition flow to check
//     "what does Mica already provide?" before "what new dep do I add?".
//   - For the rich detail (full sendShapes/recvShapes/examples), the
//     agent still curls /api/handlers/<name> or /api/handlers. This
//     tool is the index, not the spec.

import { z } from "zod";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { getManifests, type ModelConstraints } from "../handlerManifest.js";

const inputSchema = {} as const;

interface HandlerSummary {
  name: string;
  version: string;
  description: string;
  whenToUse: string;
  /** Distilled args list — top-level property names with one-line descriptions. */
  args: Array<{ name: string; description: string }>;
  /** Truthy when the handler has modelConstraints documented. */
  hasModelConstraints: boolean;
  /** Per-model constraint summaries when modelConstraints is populated. */
  modelConstraints?: Record<string, ModelConstraintsSummary>;
}

interface ModelConstraintsSummary {
  maxImagesPerTurn?: number;
  maxImageDimensionPx?: number;
  supportedImageFormats?: string[];
  maxOutputTokens?: number;
  notes?: string;
}

function summarizeArgs(argsSchema: unknown): Array<{ name: string; description: string }> {
  if (!argsSchema || typeof argsSchema !== "object") return [];
  const schema = argsSchema as { properties?: Record<string, { description?: string }> };
  if (!schema.properties) return [];
  return Object.entries(schema.properties).map(([name, prop]) => ({
    name,
    description: (prop?.description ?? "").slice(0, 140),
  }));
}

function summarizeConstraints(c: ModelConstraints): ModelConstraintsSummary {
  const out: ModelConstraintsSummary = {};
  if (c.maxImagesPerTurn !== undefined) out.maxImagesPerTurn = c.maxImagesPerTurn;
  if (c.maxImageDimensionPx !== undefined) out.maxImageDimensionPx = c.maxImageDimensionPx;
  if (c.supportedImageFormats) out.supportedImageFormats = c.supportedImageFormats;
  if (c.maxOutputTokens !== undefined) out.maxOutputTokens = c.maxOutputTokens;
  if (c.notes) out.notes = c.notes;
  return out;
}

export const listHandlersTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_list_handlers",
  description:
    "List every channel handler the backend has registered, with the args " +
    "they accept and (when applicable) the model-level constraints. " +
    "USE THIS at the START of discover-dependency for any card class that " +
    "needs server-side capability (LLM call, vision, classification, " +
    "summarization, subprocess wrap). The list shows whether Mica already " +
    "provides the capability via a built-in handler — common case: vision " +
    "classification is `llm-direct` + `qwen3-vl-local`, NOT TFJS + MobileNet. " +
    "Output is a JSON array; each entry has { name, version, description, " +
    "whenToUse, args: [{name, description}], hasModelConstraints, " +
    "modelConstraints? }. For full manifest detail (sendShapes, recvShapes, " +
    "examples) curl /api/handlers — this tool is the INDEX; that endpoint is " +
    "the spec.",
  inputSchema,
  restPath: "/api/tools/list-handlers",
  handler: async (): Promise<AgentToolResult> => {
    const manifests = getManifests();
    const summaries: HandlerSummary[] = manifests.map((m) => {
      const summary: HandlerSummary = {
        name: m.name,
        version: m.version,
        description: m.description,
        whenToUse: m.whenToUse,
        args: summarizeArgs(m.argsSchema),
        hasModelConstraints: Boolean(m.modelConstraints && Object.keys(m.modelConstraints).length > 0),
      };
      if (m.modelConstraints) {
        const mc: Record<string, ModelConstraintsSummary> = {};
        for (const [model, c] of Object.entries(m.modelConstraints)) {
          mc[model] = summarizeConstraints(c);
        }
        summary.modelConstraints = mc;
      }
      return summary;
    });
    return { text: JSON.stringify(summaries) };
  },
};

void z; // schema declared for type symmetry with other tools
