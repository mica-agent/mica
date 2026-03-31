export interface CanonicalToolParam {
  name: string;
  type: "string";
  description: string;
  required: boolean;
}

export interface CanonicalTool {
  name: string;
  description: string;
  parameters: CanonicalToolParam[];
}

export const MICA_TOOLS: CanonicalTool[] = [
  {
    name: "list_files",
    description: "List all files on the current canvas's whiteboard. Returns filename, type, and last modified date.",
    parameters: [],
  },
  {
    name: "read_file",
    description: "Read a specific file's content from the whiteboard.",
    parameters: [
      { name: "filename", type: "string", description: "The filename to read (e.g., product-brief.md)", required: true },
    ],
  },
  {
    name: "write_file",
    description: "Create or update a file on the whiteboard. For canvas cards, use a simple filename. For card classes, use .card-classes/<name>/render.js",
    parameters: [
      { name: "filename", type: "string", description: "Filename with extension (e.g., user-persona.md, system-flow.mmd)", required: true },
      { name: "content", type: "string", description: "The file content", required: true },
      { name: "summary", type: "string", description: "One-line summary of what you did and why (for the activity log)", required: true },
    ],
  },
  {
    name: "delete_file",
    description: "Delete a file from the whiteboard.",
    parameters: [
      { name: "filename", type: "string", description: "The filename to delete", required: true },
      { name: "reason", type: "string", description: "Why this file is being deleted (for the activity log)", required: true },
    ],
  },
  {
    name: "list_cross_canvas",
    description: "List files on another canvas's whiteboard.",
    parameters: [
      { name: "canvas", type: "string", description: "Canvas name to list files from", required: true },
    ],
  },
  {
    name: "read_cross_canvas",
    description: "Read a file from another canvas's whiteboard.",
    parameters: [
      { name: "canvas", type: "string", description: "Canvas name", required: true },
      { name: "filename", type: "string", description: "Filename to read", required: true },
    ],
  },
  {
    name: "consult_canvas",
    description: "Consult another canvas's agent — ask a question and get their response. The Q&A is saved as a decision record on both whiteboards.",
    parameters: [
      { name: "target_canvas", type: "string", description: "Which canvas agent to ask", required: true },
      { name: "question", type: "string", description: "The question or decision needed", required: true },
      { name: "context", type: "string", description: "Relevant context for the target agent", required: true },
    ],
  },
];

// ── OpenAI function-calling format adapter ────────────────────

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export function toOpenAITools(tools: CanonicalTool[]): OpenAIToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: "object" as const,
        properties: Object.fromEntries(
          t.parameters.map((p) => [p.name, { type: p.type, description: p.description }])
        ),
        required: t.parameters.filter((p) => p.required).map((p) => p.name),
      },
    },
  }));
}
