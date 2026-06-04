---
name: add-third-party-tool
description: Wrap an existing CLI tool, third-party package, or open-source project as a project-scoped MCP server so the agent can call it as a tool. Use whenever the user asks to "use", "integrate", "wrap", "add", or "install" a tool that isn't already declared. Examples: gmail-cli, ffmpeg, jq, autoresearch, awscli, any GitHub repo with a CLI entry point. NOT for tools already on the agent's surface (mica.*, tavily, mcp__mica-card-class, etc.).
level: session
color: green
---

# Wrapping third-party CLI tools

Mica ships a generic adapter (`server/plugins/cliMcp.ts`) that turns a project's `<project>/.mica/tools.json` into a project-scoped MCP server. Each declared tool becomes callable as `mcp__mica-tools__<server>_<op>`. **No per-tool Mica code needed** — you just write the manifest entry, and the framework handles spawning, install lifecycle, timeouts, and result routing.

## The recipe

For each new tool the user wants:

1. **Find and read the tool's README.** Use `mcp__tavily__tavily_search` (with `max_results: 5`) to locate the README URL or repo. Then use `curl -s <raw-readme-url>` to retrieve the bytes — for a typical GitHub README, `curl -s "https://raw.githubusercontent.com/<owner>/<repo>/main/README.md" | head -c 8000` is fast and bounded. (READMEs are dense markdown; curl is the right tool — `web_fetch` adds 4 min of LLM round-trip for no extraction benefit on plain text. See `discover-dependency/SKILL.md` § Tool choice for the full curl-vs-web_fetch trade-off.) Identify:
   - Install command(s) — what does the user normally run to set it up?
   - Entry point — what command runs the tool?
   - Operations — what does the tool do, and what's its input/output shape?
   - Required env vars — API keys, config paths.

2. **Append a server entry to `<project>/.mica/tools.json`** (create the file if it doesn't exist). One entry per upstream tool, multiple operations per entry. See schema below.

3. **No settings.json change needed** — the `mica-tools` MCP server is registered automatically by Mica. Tools become available on the **next chat session**, OR after the user manually triggers a reload (the SDK rebinds MCP servers per session).

4. **Verify** by attempting one tool call (or asking the user to test). If install fails, the failure surfaces as an MCP tool error with `[stage: install]` and the last 50 lines of stderr.

## tools.json schema

```json
{
  "<server-name>": {
    "install": [
      "bash command 1",
      "bash command 2"
    ],
    "command": "<binary or interpreter>",
    "args": ["<persistent args appended to every invocation>"],
    "env": {
      "API_KEY": "${API_KEY}"
    },
    "tools": [
      {
        "name": "<operation>",
        "description": "human-readable",
        "input": { "field1": "string", "field2": "number" },
        "output": "string",
        "io": "args",
        "argv_template": ["--flag", "{{field1}}", "{{field2}}"],
        "timeout_ms": 300000
      }
    ],
    "install_dir": "/workspaces/.cache/<server-name>"
  }
}
```

### Field reference

- **`install`** — bash commands run sequentially on first invocation. Each runs as `sh -c <cmd>`. Output captured to `<install_dir>/.mica-install.log`. Marker `<install_dir>/.mica-installed` written on success; subsequent invocations skip install. **Empty array `[]` means "no install — binary is already on PATH"** (use this for system binaries like `ffmpeg`, `jq`, `git`, `curl`).
- **`command`** + **`args`** — the run command. Spawned per tool call. `args` are persistent (appended every time); per-tool argv comes from `argv_template`.
- **`env`** — passed to install AND run. `${VAR}` interpolation against backend's process.env. Use this for credentials.
- **`tools[]`** — declared operations. Each becomes `mcp__mica-tools__<server-name>_<op-name>`.
  - **`name`** — operation name. Combined with server-name to form the MCP tool id.
  - **`description`** — what the tool does. Read by the agent at session start.
  - **`input`** — typed input schema. Keys become MCP tool parameters; values are types (`string`, `number`, `boolean`, `array`, `object`).
  - **`io`** — how input flows to the subprocess:
    - `"args"` — input fields baked into argv via `argv_template` placeholders. Use for tools whose CLI takes positional/flag args.
    - `"stdin-json/stdout-text"` — input serialized as JSON to stdin; raw text from stdout returned as MCP result. Use for tools that read JSONL or have a JSON-in/text-out shape.
    - `"stdin-json/stdout-json"` — same as above but the stdout is parsed as JSON.
  - **`argv_template`** — array of strings interpolated with `{{field}}` placeholders from input. Used when `io` is `"args"`.
  - **`timeout_ms`** — wall-clock limit per invocation. Default 300_000 (5 min). Subprocess SIGKILLed at timeout.
- **`install_dir`** — where the install lands. Default `/workspaces/.cache/<server-name>` (persists across container rebuilds). Override per-server if the tool requires a specific path.

## Install command patterns — ranked by reliability

When writing the `install` array, prefer patterns in this order:

### 1. Language package managers (highest reliability)

```bash
pipx install <pkg>          # Python tools — preferred (per-app virtualenv)
pip install <pkg>           # fallback if pipx isn't there
npm install -g <pkg>        # Node tools
cargo install <pkg>         # Rust tools
go install <pkg>@latest     # Go tools
```

Package names are unambiguous; you almost can't get these wrong. Use these whenever the tool ships via a language registry.

### 2. System package manager

```bash
sudo apt-get update && sudo apt-get install -y <pkg>
```

For system binaries: `ffmpeg`, `jq`, `ripgrep`, `curl`, `imagemagick`, `pandoc`, `kubectl`. The Mica container has passwordless sudo configured. **Note:** apt installs land in `/usr/`, which is part of the container image — they're lost on container rebuild. Reinstall is lazy on first post-rebuild use, so the cost is minor for ad-hoc use.

### 3. Direct repo clone + build (for projects without registry releases)

```bash
git clone https://github.com/<user>/<repo> /workspaces/.cache/<name>
cd /workspaces/.cache/<name>
pip install -r requirements.txt    # or: make, npm install, etc.
```

Use this when the README says "clone the repo and run." Pin to a commit if reproducibility matters: `git -C /workspaces/.cache/<name> checkout <sha>`.

### 4. Static binary download (last resort)

```bash
curl -L https://github.com/<user>/<repo>/releases/download/v1.2.3/tool-linux-amd64.tar.gz | tar xz -C /workspaces/.cache/bin/
chmod +x /workspaces/.cache/bin/<tool>
```

Avoid unless 1-3 don't work. URLs change between versions, archive structures vary, file naming is inconsistent. Hallucinated URLs are easy to write here.  **Verify first** with `curl -I <url>` to confirm the URL exists before committing to the manifest.

## io pattern selection

Pick by inspecting the tool's CLI:

- Tool takes a query as a positional arg or flag (`mytool research "query"`)? → `"io": "args"` with an `argv_template`.
- Tool reads input from stdin? → `"io": "stdin-json/stdout-text"` (or `stdout-json` if the tool emits JSON).
- Tool is interactive? → not supported in v1; flag this to the user.

## Worked example: autoresearch

User: "I want to use karpathy/autoresearch on this canvas."

```json
{
  "autoresearch": {
    "install": [
      "git clone https://github.com/karpathy/autoresearch /workspaces/.cache/autoresearch",
      "cd /workspaces/.cache/autoresearch && pip install -r requirements.txt"
    ],
    "command": "python",
    "args": ["/workspaces/.cache/autoresearch/main.py"],
    "env": {
      "OPENAI_API_KEY": "${OPENAI_API_KEY}"
    },
    "tools": [
      {
        "name": "research",
        "description": "Research a topic using LLM-driven web search and synthesis. Returns a markdown summary.",
        "input": { "query": "string" },
        "output": "markdown",
        "io": "args",
        "argv_template": ["--query", "{{query}}"],
        "timeout_ms": 600000
      }
    ]
  }
}
```

After the user starts a new chat session (or you confirm the agent has refreshed), the agent gains a new tool: `mcp__mica-tools__autoresearch_research`. Calling it with `{ query: "..." }` runs the install on first call (only once), then runs `python /workspaces/.cache/autoresearch/main.py --query "..."` and returns the stdout as the tool result.

## Worked example: jq (no install)

```json
{
  "jq": {
    "install": [],
    "command": "jq",
    "tools": [
      {
        "name": "query",
        "description": "Query JSON data with a jq expression.",
        "input": { "expression": "string", "input_json": "string" },
        "io": "args",
        "argv_template": ["{{expression}}"]
      }
    ]
  }
}
```

But this won't work for jq's actual usage — jq expects JSON on stdin, not as an argv. Use `stdin-json/stdout-text` instead, **with a small caveat**: the tool's stdin is the entire input args object as JSON, not just the `input_json` field. For tools like jq that need a SPECIFIC field on stdin, you may need a tiny wrapper script. v1 expectation: the stdin pattern works for tools that consume the whole JSON args object.

## Failure modes and recovery

- **Install fails (e.g., network error during git clone):** MCP tool result is an error with `[stage: install]` and stderr tail. Marker not written. Next invocation retries the install. Look at `<install_dir>/.mica-install.log` for the full output.
- **Install succeeds but tool isn't found:** the `command` field is wrong. Check the install log to see where the binary actually landed; update the manifest's `command` field.
- **Tool runs but exits non-zero:** MCP tool result is an error with `[stage: run]`, exit code, and stderr tail. The agent can adapt (try different args, surface the error to the user, etc.).
- **Tool hangs:** wall-clock timeout (default 5 min) SIGKILLs the subprocess. Increase `timeout_ms` per-tool if the tool legitimately takes longer.
- **Need to re-install (e.g., to pick up an upstream update):** delete the marker manually:

```bash
rm /workspaces/.cache/<server-name>/.mica-installed
```

The next invocation reinstalls.

## Observability

Backend log lines:

```
[cli-mcp:autoresearch] install starting
[cli-mcp:autoresearch] install OK (47s)
[cli-mcp:autoresearch] research called (input bytes=42, timeout=600000ms)
[cli-mcp:autoresearch] research returned in 12300ms (output bytes=8472, exit=0)
```

Per-server log files:
- `<install_dir>/.mica-install.log` — full install stdout+stderr, retained even after success. Inspect when install fails.

The MCP tool error response includes the last 500 chars of stderr inline, so you don't need to read the log file in the chat — it's visible in the tool_result.

## OAuth / interactive setup

Some tools (gmail-cli, github-cli) require a one-time interactive login that involves a browser flow. The cli-mcp adapter passes stdin/stdout but not a TTY — interactive prompts won't work via the adapter.

**Workaround for v1:** ask the user to run the tool's setup once in a terminal card. Example:

```bash
# In a terminal card:
gmail-cli auth login
# Browser opens, user authenticates, token cached to ~/.config/gmail-cli/
```

After that, the cached token is used by the adapter on subsequent calls. The `install` field can include a comment-only step like `echo "Run 'gmail-cli auth login' once in a terminal card before first use"` if it's important the user sees the instruction.

## Do NOT

- **Don't put one-off project-specific Python scripts in tools.json** — those go in `<project>/.mica/scripts/` or wherever fits the project. tools.json is for **third-party tools that the user wants to integrate**.
- **Don't write to `/workspaces/mica/server/`** — that's framework code, not project code. The whole point of cli-mcp is to AVOID modifying the framework. If you find yourself wanting to write a server plugin, write a tools.json entry instead.
- **Don't hard-code API keys in `env`** — use `${VAR}` references and tell the user to set the var in their `.env` file.
- **Don't omit `description`** — the agent reads descriptions to decide when to call the tool. A vague description means the tool gets ignored.
- **Don't set unbounded `timeout_ms`** — every tool gets a default 5-min cap. Long-running operations (complex transcoding, large research) can raise it explicitly, but always finite.
