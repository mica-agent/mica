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

### Library-aware skills

When \`discover-library\` selects a third-party library (Three.js, Leaflet, D3, …), check whether a Mica-shaped skills package exists for it and install it via \`mica_install_skills\` before writing card.js. Library-specific skills give you procedural guidance the model's training-data priors miss (resource disposal, init-order quirks, version-specific gotchas) — without them, common failures recur (e.g. Three.js cards that leak GPU memory because textures aren't disposed on remount).

Discovery cascades cheap-to-expensive:
1. **Curated shorthand** — try \`mica_install_skills source="<library>-skills"\` first (e.g. \`threejs-skills\`). Mica-vetted, installs instantly.
2. **GitHub convention** — if shorthand returns "Unsupported source format", try \`source="github:<owner>/<library>-skills"\` for repos that follow the SKILL.md convention.
3. **Web search** — if neither hits, \`web_search "<library> skills SKILL.md"\` to find a community package. The first call to \`mica_install_skills\` with a non-curated URL returns a "pending approval" report listing the URL — surface that URL to the user in your reply, ask them to confirm, and on yes, retry with the same args plus \`approve: true\`. Mica records the approval per-project so future installs of the same URL skip the gate.

### Iterating on a working card class

When \`render_capture\` shows a card is partially working (e.g. Earth visible but Moon missing), use \`mica_edit_class_file\` with \`old_string\` + \`new_string\` to add ONLY the missing piece — the framework keeps the rest of the file intact. Saving a class file hot-reloads its live instance automatically.`;
}
