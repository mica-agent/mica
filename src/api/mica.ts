// mica.* client library — infrastructure the AI can't do alone.
// Card code calls these methods. They proxy to the server.

const API_BASE = import.meta.env.VITE_MICA_API || "";

async function rpc(namespace: string, method: string, params: unknown = {}): Promise<unknown> {
  const res = await fetch(`${API_BASE}/api/mica/${namespace}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as { error: string }).error || res.statusText);
  }
  return res.json();
}

// ── mica.chat.* ──────────────────────────────────────────────

export const chat = {
  /** Send a message and get a reply. */
  async send(chatId: string, message: string): Promise<{ reply: string; history: Array<{ role: string; content: string }> }> {
    return rpc("chat", "send", { chatId, message }) as Promise<{ reply: string; history: Array<{ role: string; content: string }> }>;
  },

  /** Get chat history. */
  async history(chatId: string): Promise<{ history: Array<{ role: string; content: string }> }> {
    return rpc("chat", "history", { chatId }) as Promise<{ history: Array<{ role: string; content: string }> }>;
  },

  /** Clear chat history. */
  async clear(chatId: string): Promise<void> {
    await rpc("chat", "clear", { chatId });
  },
};

// ── mica.file.* ──────────────────────────────────────────────

export const file = {
  async read(filename: string): Promise<string> {
    const res = await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error(`File not found: ${filename}`);
    const data = await res.json();
    return data.content;
  },

  async write(filename: string, content: string): Promise<void> {
    await fetch(`${API_BASE}/api/files/${encodeURIComponent(filename)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  },
};

// ── Export as single mica object ─────────────────────────────

const mica = { chat, file };
export default mica;
