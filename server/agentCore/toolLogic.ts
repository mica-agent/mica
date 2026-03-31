import {
  listFiles,
  readCanvasFile,
  writeCanvasFile,
  deleteCanvasFile,
  invalidateExtensionCache,
} from "../canvasFiles.js";
import { getProjectPath } from "../projectConnection.js";
import { appendToLog, getAgentMeta } from "./logging.js";
import type { AgentResponse } from "./types.js";
import fs from "fs";
import path from "path";

export interface ToolContext {
  project: string;
  canvas: string;
  onAgentWrite: ((project: string, canvas: string, filename: string) => void) | null;
  filesChanged: { value: boolean };
  /** For consult_canvas — a function that can call another canvas's agent. */
  chatFn?: (project: string, canvas: string, message: string) => Promise<AgentResponse>;
}

/** Sanitize mermaid node labels with special chars. */
function sanitizeMermaid(content: string): string {
  return content.replace(
    /\[([^\]"]*[(){}<>][^\]"]*)\]/g,
    '["$1"]',
  );
}

export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  try {
    switch (name) {
      case "list_files": {
        const files = await listFiles(ctx.project, ctx.canvas);
        const listing = files
          .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
          .join("\n");
        return listing || "(No files yet)";
      }

      case "read_file": {
        const file = await readCanvasFile(ctx.project, ctx.canvas, args.filename as string);
        return file.content;
      }

      case "write_file": {
        const filename = args.filename as string;
        let content = args.content as string;
        const summary = args.summary as string;

        if (filename.includes("..")) return "Invalid path: '..' not allowed.";

        // Route .card-classes/ to .mica/.card-classes/
        if (filename.startsWith(".card-classes/")) {
          const projectPath = await getProjectPath(ctx.project);
          const targetPath = path.join(projectPath, ".mica", filename);
          await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
          await fs.promises.writeFile(targetPath, content, "utf-8");
          if (filename.endsWith("_manifest.json")) invalidateExtensionCache();
          ctx.filesChanged.value = true;
          await appendToLog(ctx.project, ctx.canvas, `Updated **${filename}**: ${summary}`);
          return `File "${filename}" written to .mica/${filename}`;
        }

        // Mermaid sanitization
        if (filename.endsWith(".mmd")) {
          content = content.replace(/^```(?:mermaid)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
          content = sanitizeMermaid(content);
        }

        ctx.onAgentWrite?.(ctx.project, ctx.canvas, filename);
        await writeCanvasFile(ctx.project, ctx.canvas, filename, content);
        ctx.filesChanged.value = true;
        if (filename !== "_log.log") {
          await appendToLog(ctx.project, ctx.canvas, `Updated **${filename}**: ${summary || "(no summary)"}`);
        }
        return `File "${filename}" written to whiteboard.`;
      }

      case "delete_file": {
        const filename = args.filename as string;
        ctx.onAgentWrite?.(ctx.project, ctx.canvas, filename);
        await deleteCanvasFile(ctx.project, ctx.canvas, filename);
        ctx.filesChanged.value = true;
        await appendToLog(ctx.project, ctx.canvas, `Deleted **${filename}**: ${args.reason || "(no reason)"}`);
        return `File "${filename}" deleted.`;
      }

      case "list_cross_canvas": {
        const files = await listFiles(ctx.project, args.canvas as string);
        const listing = files
          .map((f) => `${f.name} (${f.type}, modified ${f.modifiedAt})`)
          .join("\n");
        return `[${args.canvas} canvas files]\n${listing || "(No files)"}`;
      }

      case "read_cross_canvas": {
        const file = await readCanvasFile(ctx.project, args.canvas as string, args.filename as string);
        return `[From ${args.canvas} canvas — ${args.filename}]\n\n${file.content}`;
      }

      case "consult_canvas": {
        if (!ctx.chatFn) return "Error: Cross-canvas consultation not available for this provider.";
        const targetCanvas = args.target_canvas as string;
        const fromMeta = getAgentMeta(ctx.canvas);
        const toMeta = getAgentMeta(targetCanvas);
        const prompt = `[Cross-canvas question from ${fromMeta.name} (${ctx.canvas} canvas)]\n\nQuestion: ${args.question}\n\nContext: ${args.context}\n\nPlease respond from your perspective as the ${toMeta.name}. Be concrete and actionable. If this leads to a decision, state it clearly.`;

        const response = await ctx.chatFn(ctx.project, targetCanvas, prompt);
        const responseText = response.message || "(No response)";

        // Write decision record to both canvases
        const timestamp = new Date().toISOString().slice(0, 10);
        const slug = (args.question as string)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .slice(0, 40)
          .replace(/-$/, "");
        const decisionFilename = `_decision-${slug}.md`;
        const decisionContent = `# Cross-Canvas Decision\n\n**Date:** ${timestamp}\n**From:** ${fromMeta.name} (${ctx.canvas})\n**To:** ${toMeta.name} (${targetCanvas})\n\n## Question\n${args.question}\n\n## Context\n${args.context}\n\n## Response from ${toMeta.name}\n${responseText}\n`;

        await writeCanvasFile(ctx.project, ctx.canvas, decisionFilename, decisionContent);
        await appendToLog(ctx.project, ctx.canvas, `Cross-canvas decision with ${targetCanvas}: "${args.question}" → saved to **${decisionFilename}**`);
        await writeCanvasFile(ctx.project, targetCanvas, decisionFilename, decisionContent);
        await appendToLog(ctx.project, targetCanvas, `Responded to ${ctx.canvas} canvas: "${args.question}" → saved to **${decisionFilename}**`);

        ctx.filesChanged.value = true;
        return `[Response from ${toMeta.name} (${targetCanvas} canvas)]\n\n${responseText}\n\n---\nDecision saved to ${decisionFilename} on both whiteboards.`;
      }

      default:
        return `Error: Unknown tool "${name}"`;
    }
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
