import { readCanvasFile, writeCanvasFile } from "../canvasFiles.js";
import type { CanvasId } from "./types.js";

export function describeToolUse(name: string, input?: Record<string, unknown>): string {
  if (!input) return name;
  switch (name) {
    case "Bash": {
      const cmd = String(input.command || "").split("\n")[0].slice(0, 80);
      return cmd ? `$ ${cmd}` : "Running command";
    }
    case "Read": {
      const fp = String(input.file_path || "");
      return fp ? `Read ${fp.split("/").pop()}` : "Reading file";
    }
    case "Write": {
      const fp = String(input.file_path || "");
      return fp ? `Write ${fp.split("/").pop()}` : "Writing file";
    }
    case "Edit": {
      const fp = String(input.file_path || "");
      return fp ? `Edit ${fp.split("/").pop()}` : "Editing file";
    }
    case "Glob":
      return input.pattern ? `Glob ${input.pattern}` : "Searching files";
    case "Grep":
      return input.pattern ? `Grep ${input.pattern}` : "Searching code";
    default: {
      if (name.includes("__")) {
        const toolPart = name.split("__").pop() || name;
        const firstArg = Object.values(input).find((v) => typeof v === "string" && v.length > 0);
        return firstArg ? `${toolPart}: ${String(firstArg).slice(0, 60)}` : toolPart;
      }
      return name;
    }
  }
}

export function getAgentMeta(canvas: string): { name: string; role: string } {
  const label = canvas
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    name: `${label} Agent`,
    role: `AI collaborator for the ${label} workspace`,
  };
}

export async function appendToLog(project: string, canvas: CanvasId, entry: string) {
  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
  const line = `- **${timestamp}** — ${entry}\n`;
  try {
    const existing = await readCanvasFile(project, canvas, "_log.log");
    await writeCanvasFile(project, canvas, "_log.log", existing.content + line);
  } catch {
    await writeCanvasFile(project, canvas, "_log.log", `# Activity Log\n\n${line}`);
  }
}
