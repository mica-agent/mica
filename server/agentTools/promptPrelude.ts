// Unified prompt prelude — same prose for every agent (qwen, Claude,
// opencode). When a new tool ships in registry.ts, add a paragraph here
// and ALL agents get the guidance simultaneously. Per-agent tweaks live
// in each agent's own buildContext function (e.g. SDK-specific tool-call
// shape hints).

export function buildAgentToolsPrelude(): string {
  return `## Mica tools (available across all agent backends)

These tools come from Mica itself — same names, same input/output shape, same prose regardless of which backend you are (qwen, Claude, or opencode). They reach Mica's REST surface via your SDK's MCP plumbing; you call them by name like any other tool.

### Visual verification

\`render_capture\` — capture a PNG of a card on the canvas and return a vision-model description of what's actually visible. Use after building or editing a card class to verify the rendered output matches the spec — the canvas may render with broken layout / missing markers / wrong colors / runtime errors that source-only review can't catch. Input: \`{ filename: 'canvas/<name>.<ext>' }\`. Output: text. The browser tab must be open to the project's canvas; the model that captions runs locally via llama-server's vision encoder.

### Card-class authoring

Use these INSTEAD of \`write_file\` / \`edit\` when working with card classes — the framework owns paths and shapes, validates metadata, and rejects common card.js lint failures BEFORE the write so the agent sees them in the same turn.

- \`mica_create_class\` — create a card class atomically. You supply intent (\`name\`, optional \`badge\`, \`defaultTitle\`, \`extension\`, \`card_html\`, \`card_js\`, \`card_css\`, \`scripts\` (CDN URLs), \`styles\`, \`handler\`, \`primaryFile\`). The framework picks the directory and writes a correct \`metadata.json\`. Idempotent on identical args. Stubs are written for any omitted card_html / card_js so subsequent edits land on the right paths.
- \`mica_edit_class_file\` — edit \`card.html\` / \`card.js\` / \`card.css\` with PRE-WRITE validation (lint failures surface in the same turn). Args: \`class\` (directory name), \`file\`, and either \`content\` (replace) or \`old_string\` + \`new_string\` (partial edit). \`metadata.json\` edits go through \`mica_create_class\` instead.
- \`mica_create_card_instance\` — create an instance of an existing card class on the canvas. Args: \`class_extension\`, \`filename\`, optional \`content\`. Lands at \`<canvasRoot>/<filename>.<class_extension>\`.
- \`mica_delete_card_instance\` — delete a card instance file. Args: \`filename\`.
- \`mica_delete_class\` — delete a card class directory. Refuses if instances exist unless \`force: true\`. Args: \`name\`, optional \`force\`.
- \`mica_list_classes\` — list all card classes available in this project (project-scoped + built-in). Returns name, extension, badge, source. Useful before creating a new class to check for naming collisions, or before \`mica_create_card_instance\` to confirm the class exists.

When you need a card class, the canonical flow is: \`mica_list_classes\` → \`mica_create_class\` (if the class doesn't exist) → \`mica_create_card_instance\` (to put it on the canvas) → \`render_capture\` (to verify it renders correctly).

### Iterating on a working card class

When \`render_capture\` shows a card is partially working (e.g. Earth visible but Moon missing), use \`mica_edit_class_file\` with \`old_string\` + \`new_string\` to add ONLY the missing piece — the framework keeps the rest of the file intact. Saving a class file hot-reloads its live instance automatically.`;
}
