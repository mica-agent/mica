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

### File-write decision rule

Four paths in a Mica project have structured tools that own their schema and lint. Use the structured tool for these; \`write_file\` is right for everything else.

- \`.mica/card-classes/<name>/card.{js,html,css}\` → \`mica_edit_class_file\`
- \`.mica/card-classes/<name>/metadata.json\` → \`mica_create_class\` (it serializes from typed inputs)
- new card instance under canvas-root (e.g. \`canvas/foo.world-clock\`) → \`mica_create_card_instance\`
- \`.mica/layout.json\` → don't write at all (runtime state owned by the canvas card)

Everything else — \`spec.md\`, \`decomposition.md\`, \`questions.md\`, \`README.md\`, free-form markdown, generated data files, anything the user asked you to author — \`write_file\` is the right tool.

### Build flow — invoke \`develop\` first

For any build-shaped request ("build / create / implement / make / write / design / ship / develop / construct" — for a card class, standalone program, doc set, or any non-trivial artifact), your FIRST tool call is \`skill('develop')\`. That skill owns the universal flow: spec on canvas → plan-or-inline gate → library discovery → execute (branches by artifact type to \`create-card-class\` or \`write_file\` or task decomposition) → canvas update → verify → doc-consistency reconcile.

Do NOT invoke \`create-card-class\`, \`decompose-task\`, or any other build-flow skill directly without first invoking \`develop\` — those are downstream specifics that \`develop\` dispatches to at the right step. Skipping \`develop\` means skipping the plan-before-build and canvas-update invariants that apply to every build regardless of artifact type.`;
}
