// probe-canusetool.ts — Standalone test for @qwen-code/sdk canUseTool
// behavior under different permissionMode settings against our local
// llama-server. Answers the question we've been going in circles on:
// does canUseTool actually fire for write_file and run_shell_command
// in our headless Express setup, or does the SDK hang as the old
// comment in micaAgent.ts claimed.
//
// Usage:
//   npx tsx scripts/probe-canusetool.ts default write
//   npx tsx scripts/probe-canusetool.ts default shell
//   npx tsx scripts/probe-canusetool.ts auto-edit shell
//   npx tsx scripts/probe-canusetool.ts yolo write
//
// Prerequisites: llama-server running on http://127.0.0.1:8012 (just do
// `scripts/start.sh` if unsure — Mica starts it automatically).

import { query } from "@qwen-code/sdk";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

type Mode = "default" | "auto-edit" | "plan" | "yolo";
type TestKind = "write" | "shell" | "subagent-write" | "subagent-shell";

const mode = (process.argv[2] || "default") as Mode;
const kind = (process.argv[3] || "write") as TestKind;

if (!["default", "auto-edit", "plan", "yolo"].includes(mode)) {
  console.error(`Invalid mode: ${mode}`);
  process.exit(2);
}
if (!["write", "shell", "subagent-write", "subagent-shell"].includes(kind)) {
  console.error(`Invalid kind: ${kind}`);
  process.exit(2);
}

const workDir = mkdtempSync(join(tmpdir(), "probe-canusetool-"));
const probeFile = join(workDir, "probe-output.txt");

const LLAMA_URL = process.env.LLAMA_URL || "http://127.0.0.1:8012";

let canUseToolCalls = 0;
let firstToolUseAt: number | null = null;
let firstCanUseAt: number | null = null;
const toolUseSeen: string[] = [];

const HARD_TIMEOUT_MS = 60_000;
const stampStart = Date.now();
function ts() { return String(Date.now() - stampStart).padStart(6, " "); }

const abort = new AbortController();
const timeout = setTimeout(() => {
  console.log(`[${ts()}ms] HARD TIMEOUT after ${HARD_TIMEOUT_MS}ms — aborting`);
  abort.abort();
}, HARD_TIMEOUT_MS);

// Prompts per scenario. Subagent tests ask the parent to DELEGATE to a
// "writer" subagent that performs the work. The question we're trying to
// answer is whether canUseTool fires for the subagent's tool calls (or
// hangs, as the old in-code comment claimed).
const prompt =
  kind === "write" ? `Write the single word "hello" to the file ${probeFile}. Do it immediately via your write_file tool. No discussion, no follow-ups.` :
  kind === "shell" ? `Run the shell command \`echo hello-from-probe > ${probeFile}\`. Do it immediately. No discussion, no follow-ups.` :
  kind === "subagent-write" ? `Use the writer subagent to create the file ${probeFile} containing the single word "hello". Invoke it with the agent tool. Do not write the file yourself.` :
  /* subagent-shell */           `Use the writer subagent to run \`echo hello-from-probe > ${probeFile}\`. Invoke it with the agent tool. Do not run the shell yourself.`;

// Subagent definition for the subagent-* test kinds. Only included when the
// kind is subagent-*; otherwise the SDK sees no subagents at all, matching
// the parent-only tests above.
const agents = kind.startsWith("subagent-")
  ? [{
      name: "writer",
      description: "Creates a file or runs a single shell command exactly as instructed by the parent. No discussion; one tool call and return.",
      systemPrompt: "You are invoked to perform exactly one file or shell operation as specified in the task prompt. Do it with the appropriate tool, then return a one-line summary. Do NOT ask follow-up questions.",
    }]
  : undefined;

async function main() {
  console.log(`[${ts()}ms] probe start: mode=${mode} kind=${kind}`);
  console.log(`[${ts()}ms] workDir=${workDir}`);
  console.log(`[${ts()}ms] sending prompt (len=${prompt.length}): ${prompt.slice(0, 80)}…`);

  const q = query({
    prompt,
    options: {
      cwd: workDir,
      model: "openai:local",
      authType: "openai" as const,
      permissionMode: mode,
      abortController: abort,
      ...(agents ? { agents } : {}),
      // Include the subagent-launch tools in allowedTools so the parent's
      // `agent`/`task` call bypasses canUseTool. In default mode, trying
      // to gate the agent tool via canUseTool hangs — the callback never
      // gets invoked but the SDK still waits for it.
      allowedTools: ["agent", "task"],
      canUseTool: async (toolName: string, input: Record<string, unknown>, _opts: unknown) => {
        canUseToolCalls++;
        if (firstCanUseAt === null) firstCanUseAt = Date.now() - stampStart;
        console.log(`[${ts()}ms] canUseTool INVOKED: ${toolName} input=${JSON.stringify(input).slice(0, 120)}`);
        return { behavior: "allow" as const, updatedInput: input };
      },
      env: {
        OPENAI_API_KEY: "dummy",
        OPENAI_BASE_URL: `${LLAMA_URL.replace(/\/v1$/, "")}/v1`,
      },
    },
  }) as AsyncIterable<Record<string, unknown>>;

  try {
    for await (const evt of q) {
      const type = evt.type as string;
      const parent = (evt as { parent_tool_use_id?: string | null }).parent_tool_use_id || "";
      const parentTag = parent ? ` (from subagent parent=${parent.slice(0, 8)})` : "";
      if (type === "assistant" && (evt as { message?: { content?: unknown[] } }).message?.content) {
        for (const block of (evt as { message: { content: Array<Record<string, unknown>> } }).message.content) {
          if (block.type === "tool_use" && typeof block.name === "string") {
            if (firstToolUseAt === null) firstToolUseAt = Date.now() - stampStart;
            toolUseSeen.push(block.name);
            console.log(`[${ts()}ms] tool_use observed: ${block.name}${parentTag}`);
          }
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            console.log(`[${ts()}ms] text: ${String(block.text).slice(0, 120)}${parentTag}`);
          }
        }
      }
      if (type === "result") {
        console.log(`[${ts()}ms] result event`);
      }
    }
  } catch (err) {
    console.log(`[${ts()}ms] query threw: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }

  console.log("");
  console.log("===== PROBE SUMMARY =====");
  console.log(`mode                 = ${mode}`);
  console.log(`kind                 = ${kind}`);
  console.log(`tool_use events      = ${toolUseSeen.length} (${toolUseSeen.join(", ") || "—"})`);
  console.log(`firstToolUseAt       = ${firstToolUseAt !== null ? firstToolUseAt + "ms" : "never"}`);
  console.log(`canUseTool calls     = ${canUseToolCalls}`);
  console.log(`firstCanUseAt        = ${firstCanUseAt !== null ? firstCanUseAt + "ms" : "never"}`);
  console.log(`elapsed              = ${Date.now() - stampStart}ms`);
  console.log("");

  if (toolUseSeen.length === 0) {
    console.log("VERDICT: no tool_use observed — the model didn't try the write/shell. Retry with a clearer prompt.");
  } else if (canUseToolCalls > 0) {
    console.log(`VERDICT: ✅ canUseTool FIRED ${canUseToolCalls}× in "${mode}" mode. Safe to switch micaAgent.`);
  } else if (mode === "yolo") {
    console.log("VERDICT: ✅ canUseTool didn't fire (expected — yolo auto-approves). Sanity check that yolo works.");
  } else {
    console.log(`VERDICT: ❌ tool_use happened but canUseTool never fired in "${mode}" mode. Old comment was accurate — do NOT switch.`);
  }

  try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
