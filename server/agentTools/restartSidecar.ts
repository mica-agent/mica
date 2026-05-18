// mica_restart_sidecar — server-side SIGTERM of a card-class sidecar.
//
// Replaces the agent's instinct to reach for `pkill -f "..."` after editing
// server.py / server.ts. The pkill pattern matches the bash subprocess's
// own argv and can suicide the agent CLI; this tool does the same kill
// server-side via the PID Mica already tracks in cardSidecar.ts, so there
// is no bash subprocess in the loop and no risk of self-suicide.
//
// Companion to the lifecycle fact "no file-change auto-restart" — edit the
// source, then call this, then re-trigger the endpoint.

import { z } from "zod";
import type { AgentToolDef, AgentToolResult } from "./registry.js";
import { restartCardSidecar } from "../cardSidecar.js";

const inputSchema = {
  card_class: z
    .string()
    .describe(
      "The card class name (the directory name under `.mica/card-classes/`, e.g. 'rag-chat' or 'hello-py'). Project is inferred from the active session.",
    ),
} as const;

export const restartSidecarTool: AgentToolDef<typeof inputSchema> = {
  name: "mica_restart_sidecar",
  description:
    "Kill the running sidecar process for a card class so the next call to `mica.fetch('mica-internal://card-server/...')` spawns a fresh process with the current code. **Use this after editing `server.py` / `server.ts`** — the running sidecar holds the OLD bytecode in memory and won't pick up file changes automatically. **Use this INSTEAD of `mica_shell pkill ...`** — pkill matches the bash subprocess's own argv and can suicide the agent CLI process (the user's prompt mentioning the card class name leaks into the agent's own command line). Returns `{ status: 'killed' | 'not_running', old_pid?, port? }`. The respawn is lazy: nothing happens until the next `mica.fetch` from card.js (or a manual `mica_shell curl http://127.0.0.1:<port>/health` if you want to trigger a warm restart without waiting for the user to interact with the card).",
  inputSchema,
  restPath: "/api/tools/mica-restart-sidecar",
  handler: async (input, ctx): Promise<AgentToolResult> => {
    if (!ctx.project) {
      return { isError: true, text: "Active project required." };
    }
    const result = await restartCardSidecar(ctx.project, input.card_class);
    if (result.status === "not_running") {
      return {
        text: `No sidecar currently running for card class '${input.card_class}' in project '${ctx.project}'. Nothing to restart — next call to mica.fetch will spawn fresh.`,
      };
    }
    return {
      text: JSON.stringify(
        {
          status: "killed",
          project: ctx.project,
          card_class: input.card_class,
          old_pid: result.oldPid,
          port: result.port,
          note: "Next mica.fetch call from card.js will lazy-spawn a fresh sidecar with the current code.",
        },
        null,
        2,
      ),
    };
  },
};
