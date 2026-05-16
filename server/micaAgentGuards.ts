// micaAgentGuards.ts — shared safety patterns for shell commands the chat
// agent might issue.
//
// Two consumers:
//   - micaAgent.ts's canUseTool guard (only fires in non-yolo permission modes —
//     today this is dead code under our yolo configuration, kept for the day
//     we can re-enable canUseTool without subagent hangs)
//   - agentTools/micaShell.ts (Mica-owned run_shell_command replacement; this
//     IS the live enforcement path, since MCP handlers always run regardless
//     of permission mode)
//
// Single source of truth so both layers stay in sync.

/** Patterns that would disrupt Mica itself. Block before the shell spawns. */
export const DANGEROUS_BASH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bpkill\b.*\bvite\b/i, reason: "pkill vite would kill Mica's own frontend dev server" },
  { re: /\bpkill\b.*\btsx\b/i, reason: "pkill tsx would kill Mica's own backend server" },
  { re: /\bpkill\b.*\bvllm\b/i, reason: "pkill vllm would kill Mica's LLM inference server" },
  { re: /\bpkill\b.*\bnode\b/i, reason: "pkill node would kill Mica's own processes" },
  { re: /\bkillall\b.*\b(vite|tsx|vllm|node)\b/i, reason: "killall would kill Mica's processes" },
  { re: /\bkill\s+(-\w+\s+)?-?(5173|3002|8012|8013)\b/, reason: "Never kill Mica's ports (5173/3002/8012/8013)" },
  // Raw `kill <PID>` against a PID the agent discovered via `ps aux | grep tsx`
  // or similar. The catastrophic case: agent decides tsx hasn't hot-reloaded
  // and tries to kill+respawn the backend; SIGTERM cascades through the
  // backend's process tree (which the agent IS), agent dies mid-tool-call,
  // the "restart" command never reliably runs from a dying parent. Same
  // failure mode as scripts/stop.sh from inside, just via raw PIDs. The
  // regex catches `kill` with a PID followed within ~200 chars by an
  // invocation of `tsx`, `vite`, or `node.*server/index`.
  { re: /\bkill\s+(-\w+\s+)?\d+\b[\s\S]{0,200}\b(?:tsx|vite|server\/index)\b/i, reason: "Killing the tsx/vite/backend PID by number is the same as `pkill tsx` — you (the agent) run INSIDE that process tree. The kill cascades SIGTERM through your own runtime, you die mid-tool-call, and any 'restart' command after the kill won't reliably execute from a dying parent. If you genuinely need a backend restart, ASK THE USER — they're outside your process tree. tsx does NOT auto-reload on file change; assume the change took effect on disk and ask the user to restart if a code change matters for what you're doing." },
  { re: /\b(?:tsx|vite)\b[\s\S]{0,200}\bkill\s+(-\w+\s+)?\d+/i, reason: "Same as above, opposite phrasing: killing the tsx/vite PID terminates the backend you run inside. Ask the user to restart instead." },
  { re: /\bfuser\s.*\b(5173|3002|8012|8013)/, reason: "fuser would kill Mica's ports" },
  { re: /\brm\s+-rf\s+\/workspaces\/mica\b/, reason: "Refusing to delete the Mica install" },
  { re: /\brm\s+-rf\s+\/\s*(?:$|[^\w])/, reason: "Refusing rm -rf / (destructive)" },
  // The agent runs INSIDE the Mica backend's process tree. stop.sh/restart.sh
  // SIGTERM the backend, which kills the agent before the script's start
  // phase can run — backend dies, agent dies, no recovery. Card classes are
  // hot-reloaded by the file watcher; the agent never needs to restart Mica.
  { re: /\bscripts\/(stop|restart)\.sh\b/, reason: "Never run scripts/stop.sh or scripts/restart.sh from inside the agent — you run inside the backend, the script will SIGTERM you mid-tool-call and the restart will not complete. Card classes hot-reload via the file watcher; if a class seems missing, query mica.cardClasses.list() from a card or check that the directory is at .mica/card-classes/<name>/ with metadata.json." },
  { re: /\bscripts\/start\.sh\b/, reason: "scripts/start.sh would spawn a duplicate backend on a port already held by the running one. If you genuinely need a restart, ask the user — they're outside your process tree." },
  // Card-class file placement: cp/mv/rsync targeting `card-classes/<name>` at
  // the project root (without the `.mica/` prefix) is the canonical mistake.
  { re: /\b(?:cp|mv|rsync)\b(?!.*\.mica\/card-classes\/).*\bcard-classes\/[^\/\s]+/, reason: "Card classes must live at `.mica/card-classes/<name>/` (with the leading dot — `.mica` is project-scoped). The Mica resolver only finds card classes there; `<project>/card-classes/<name>/` is invisible to the canvas. Use `cp -r <source> .mica/card-classes/<name>` instead. (Mica's built-in card classes live at `card-classes/` inside the Mica repo itself — not inside your project.)" },
];

/** Detects `cmd &` (background) without stdout/stderr redirect. Such a process
 *  inherits the tool-call shell's stdio; when the shell exits, the process
 *  loses its streams and dies (broken pipe / SIGHUP). */
export function isBackgroundWithoutRedirect(cmd: string): boolean {
  const trimmed = cmd.trim();
  if (!/(?<!&)&\s*$/.test(trimmed)) return false;
  if (/>\s*\S|>&|&>/.test(trimmed)) return false;
  if (/\b(nohup|setsid|disown)\b/.test(trimmed)) return false;
  return true;
}
