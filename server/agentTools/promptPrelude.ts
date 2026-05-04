// Unified prompt prelude — same prose for every agent (qwen, Claude,
// opencode). When a new tool ships in registry.ts, add a paragraph here
// and ALL agents get the guidance simultaneously. Per-agent tweaks live
// in each agent's own buildContext function (e.g. SDK-specific tool-call
// shape hints).

export function buildAgentToolsPrelude(): string {
  return `## Mica tools (available across all agent backends)

These tools come from Mica itself — same names, same input/output shape, same prose regardless of which backend you are (qwen, Claude, or opencode). They reach Mica's REST surface via your SDK's MCP plumbing; you call them by name like any other tool.

### \`render_capture\`
Capture a PNG screenshot of a card on the canvas and return a vision-model description of what's actually visible. Use after building or editing a card class to verify the rendered output matches the spec — the canvas may render with broken layout / missing markers / wrong colors / runtime errors that source-only review can't catch. Input: \`{ filename: 'canvas/<name>.<ext>' }\`. Output: text. The browser tab must be open to the project's canvas; the model that captions runs locally via llama-server's vision encoder.`;
}
