// mica-sidecar — Mica-owned primitives for card-class sidecars (TypeScript).
//
// Sidecars run as separate Node/tsx processes spawned by Mica's backend.
// They wrap a chosen library as a small HTTP service that card.js consumes
// via mica.fetch('mica-internal://card-server/...'). This package exposes
// the few capabilities Mica itself owns — primarily LLM access — so sidecars
// don't have to know URLs, model names, or auth tokens.
//
// Typical usage:
//
//   import mica from "mica-sidecar";
//
//   const resp = await mica.llm.chat({
//     messages: [
//       { role: "system", content: "You are concise." },
//       { role: "user",   content: "Summarize: <text>" },
//     ],
//   });
//   mica.log("got reply:", resp.text);
//
//   const project  = mica.projectDir;     // absolute path to active project
//   const classdir = mica.cardclassDir;   // absolute path to this card class dir
//
// NOT the same as the client-side `mica` global (which is injected into
// card.js by Mica's CARD_SHIM and provides fetch/openChannel/on). The
// surfaces don't overlap. mica.llm.chat is sidecar-only; the client uses
// mica.openChannel('turn', { systemPrompt, model }) for streaming LLM UX.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ChatOptions {
  messages: ChatMessage[];
  /** Default 2048. */
  max_tokens?: number;
  /** Default 0.3 (factual). Raise to ~0.7 for creative tasks. */
  temperature?: number;
  /** Default: first model from the local /v1/models list (Mica resolves). */
  model?: string;
  /** Default false. If true, vLLM uses chain-of-thought template; bump max_tokens accordingly. */
  thinking?: boolean;
  /** Default 120000 ms. */
  timeout_ms?: number;
}

function requireEnv(): { backendUrl: string; token: string } {
  const backendUrl = process.env.MICA_BACKEND_URL;
  const token = process.env.MICA_SIDECAR_TOKEN;
  if (!backendUrl || !token) {
    throw new Error(
      "mica-sidecar called outside a Mica-spawned sidecar — " +
      "MICA_BACKEND_URL or MICA_SIDECAR_TOKEN env var not set. This " +
      "package only works inside a sidecar process Mica spawned.",
    );
  }
  return { backendUrl, token };
}

export const llm = {
  /** Call Mica's local LLM. URL, default model, and auth owned by Mica. */
  async chat(opts: ChatOptions): Promise<ChatResponse> {
    const { backendUrl, token } = requireEnv();
    const body: Record<string, unknown> = {
      messages: opts.messages,
      max_tokens: opts.max_tokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      thinking: opts.thinking ?? false,
    };
    if (opts.model) body.model = opts.model;

    const ctrl = new AbortController();
    const timeoutMs = opts.timeout_ms ?? 120_000;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const resp = await fetch(`${backendUrl}/api/llm/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-mica-sidecar-auth": token,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        throw new Error(`LLM HTTP ${resp.status}: ${errText.slice(0, 500)}`);
      }
      const data = (await resp.json()) as ChatResponse;
      return data;
    } finally {
      clearTimeout(timer);
    }
  },
};

/** Print to stdout with the card-class prefix. Logs go to Mica's backend log
 *  under `[card-sidecar:<name>] ...` lines. */
export function log(...args: unknown[]): void {
  const label = process.env.MICA_CARD_CLASS || "sidecar";
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(`[${label}] ${msg}`);
}

/** Absolute path to the active project directory. */
export const projectDir: string = process.env.MICA_PROJECT_DIR || "";

/** Absolute path to this card class directory (.mica/card-classes/<name>/). */
export const cardclassDir: string = process.env.MICA_CARD_CLASS_DIR || "";

// Default export — supports `import mica from "mica-sidecar"`.
const mica = { llm, log, projectDir, cardclassDir };
export default mica;
