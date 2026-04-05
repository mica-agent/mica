/**
 * Drawing converter — converts hand-drawn images to Mermaid diagrams via Claude.
 */

import os from "os";
import path from "path";
import fs from "fs";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import { readMicaConfig } from "./projectConnection.js";
import { writeCanvasFile } from "./canvasFiles.js";

export async function convertDrawingToMermaid(
  project: string,
  canvas: string,
  imageBase64: string
): Promise<{ mermaid: string; filename: string }> {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `mica-drawing-${Date.now()}.png`);
  fs.writeFileSync(tmpFile, Buffer.from(imageBase64, "base64"));

  const micaConfig = await readMicaConfig(project);
  const model = micaConfig?.agents?.[canvas]?.model
    || micaConfig?.model
    || "claude-sonnet-4-6";

  let resultText = "";

  try {
    for await (const message of query({
      prompt: `Read the image file at ${tmpFile} and convert the hand-drawn diagram into Mermaid syntax. Output ONLY the raw mermaid code. No markdown fences, no explanation, no commentary. Just the mermaid diagram code.`,
      options: {
        allowedTools: ["Read"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 3,
        model,
        settings: { forceLoginMethod: "claudeai" as const },
        settingSources: ["user" as const],
      } as import("@anthropic-ai/claude-agent-sdk").Options,
    })) {
      const msg = message as SDKMessage;
      if (msg.type === "result" && "result" in msg) {
        resultText = (msg as SDKResultSuccess).result || "";
      }
    }
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }

  let mermaidCode = resultText.trim();
  if (mermaidCode.startsWith("```")) {
    mermaidCode = mermaidCode.replace(/^```(?:mermaid)?\n?/, "").replace(/\n?```$/, "");
  }

  if (!mermaidCode) {
    throw new Error("Failed to convert drawing to mermaid");
  }

  const filename = `drawing-${Date.now()}.mmd`;
  await writeCanvasFile(project, canvas, filename, mermaidCode);
  return { mermaid: mermaidCode, filename };
}
