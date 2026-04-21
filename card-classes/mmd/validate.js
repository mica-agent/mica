// Server-side validator for .mmd files.
// Runs when the agent calls write_file with a .mmd path. Returning a string
// vetoes the write and the string is sent back to the agent as the deny reason.
// Keep checks loose — false positives reject good edits and erode trust.

const MERMAID_KEYWORDS = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram", "stateDiagram",
  "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "gitGraph",
  "mindmap", "timeline", "quadrantChart", "requirementDiagram", "sankey",
  "xychart-beta", "block-beta", "architecture-beta", "C4Context",
];

export default function validate(content) {
  const trimmed = content.trim();
  if (!trimmed) return null;

  if (/```\s*(mmd|mermaid)\b/.test(trimmed)) {
    return "Don't wrap .mmd files in markdown ```mmd / ```mermaid fences. Write raw mermaid source — the FIRST line must be a diagram keyword like `flowchart TD`, `sequenceDiagram`, `classDiagram`, etc.";
  }

  if (/^\s*#/.test(trimmed)) {
    return "Don't put a markdown heading at the top of a .mmd file. The first non-blank line must be a diagram keyword (`flowchart TD`, `sequenceDiagram`, etc.). Comments inside mermaid use `%%`.";
  }

  const fenceCount = (trimmed.match(/^```/gm) || []).length;
  if (fenceCount > 0) {
    return ".mmd files contain raw mermaid source — no triple-backtick fences anywhere. Remove them.";
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  const startsWithKeyword = MERMAID_KEYWORDS.some((k) => firstLine.startsWith(k));
  if (!startsWithKeyword) {
    return "First non-blank line of a .mmd file must be a mermaid diagram keyword (e.g. `flowchart TD`, `sequenceDiagram`, `classDiagram`, `stateDiagram-v2`, `erDiagram`, `mindmap`, `timeline`, `gitGraph`).";
  }

  // Escaped double-quotes inside ["..."] node labels break mermaid's parser.
  // This was a real failure mode the agent hit (see filebrowser-ux.mmd).
  if (/\["[^"]*\\"/.test(trimmed)) {
    return "Mermaid node labels (the `[\"...\"]` brackets) can't contain escaped double-quotes (`\\\"`). Use single quotes inside the label, or HTML-encode the doubles as `&quot;`.";
  }

  return null;
}
