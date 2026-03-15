/**
 * Widget Card Architecture — Integration Tests
 *
 * Tests the full pipeline: worker pool → card manager → server API → WebSocket.
 *
 * Run: npx vitest run test/widget-cards.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WorkerPool } from "../server/workerPool.js";
import { CardManager } from "../server/cardManager.js";
import { FileWatcher } from "../server/fileWatcher.js";
import { writeFile, mkdir, rm } from "fs/promises";
import { join } from "path";
import WebSocket from "ws";

// ── Helpers ─────────────────────────────────────────────────

const TEST_PORT = 3099;
const API = `http://localhost:${TEST_PORT}`;

function fetch_(path: string, opts?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, opts);
}

function waitForWs(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 10000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("WebSocket message timeout")),
      timeoutMs
    );
    function onMessage(data: WebSocket.RawData) {
      try {
        const msg = JSON.parse(data.toString());
        if (predicate(msg)) {
          clearTimeout(timer);
          ws.off("message", onMessage);
          resolve(msg);
        }
      } catch {}
    }
    ws.on("message", onMessage);
  });
}

const CTX = { layer: "mission", filename: "test.md" };

// ── Worker Pool Tests ───────────────────────────────────────

describe("Worker Pool", () => {
  let pool: WorkerPool;

  beforeAll(async () => {
    pool = new WorkerPool({ poolSize: 2, pythonPath: "/usr/bin/python3" });
    pool.setRpcHandler(async (method) => {
      if (method === "read_file") return null;
      return { success: true };
    });
    await pool.start();
  }, 15000);

  afterAll(() => pool.stop());

  it("renders a markdown card class", async () => {
    const classPath = join(process.cwd(), "card-classes/markdown/render.py");
    const result = await pool.render("markdown", classPath, "# Hello\n\nWorld", {}, CTX);
    expect(result.html).toContain("<h1>Hello</h1>");
    expect(result.html).toContain("<p>World</p>");
    expect(result.html).toContain('class="card-markdown"');
  });

  it("renders a mermaid card class", async () => {
    const classPath = join(process.cwd(), "card-classes/mermaid/render.py");
    const result = await pool.render("mermaid", classPath, "flowchart TD\n    A --> B", {}, CTX);
    expect(result.html).toContain('class="mermaid"');
    expect(result.html).toContain("A --&gt; B");
  });

  it("renders a text card class", async () => {
    const classPath = join(process.cwd(), "card-classes/text/render.py");
    const result = await pool.render("text", classPath, "Hello <world> & friends", {}, CTX);
    expect(result.html).toContain("card-text");
    expect(result.html).toContain("&lt;world&gt;");
    expect(result.html).toContain("&amp; friends");
  });

  it("renders a goal card with progress bar", async () => {
    const classPath = join(process.cwd(), "card-classes/goal/render.py");
    const content = "# Goal\n- [x] Done item\n- [ ] Pending item\n";
    const result = await pool.render("goal", classPath, content, {}, CTX);
    expect(result.html).toContain("card-goal");
    expect(result.html).toContain("card-progress");
    expect(result.html).toContain("1/2 complete");
  });

  it("renders a todo card with badge counts", async () => {
    const classPath = join(process.cwd(), "card-classes/todo/render.py");
    const content = "# Tasks\n## Active\n- [ ] Task A\n- [ ] Task B\n## Done\n- [x] Task C\n";
    const result = await pool.render("todo", classPath, content, {}, CTX);
    expect(result.html).toContain("card-todo");
    expect(result.html).toContain("2 active");
    expect(result.html).toContain("1 done");
  });

  it("renders a brief card", async () => {
    const classPath = join(process.cwd(), "card-classes/brief/render.py");
    const result = await pool.render("brief", classPath, "# Brief\nAgent instructions.", {}, CTX);
    expect(result.html).toContain("card-brief");
    expect(result.html).toContain("<h1>Brief</h1>");
  });

  it("renders a log card", async () => {
    const classPath = join(process.cwd(), "card-classes/log/render.py");
    const result = await pool.render("log", classPath, "# Log\n- Entry 1\n- Entry 2", {}, CTX);
    expect(result.html).toContain("card-log");
  });

  it("renders chat class with exports", async () => {
    const classPath = join(process.cwd(), "card-classes/chat/render.py");
    const result = await pool.render("chat", classPath, "", { layer: "mission" }, CTX);
    expect(result.html).toContain("chat-widget");
    expect(result.exports).toContain("send_message");
    expect(result.exports).toContain("check_in");
  });

  it("invalidates a cached class", async () => {
    const classPath = join(process.cwd(), "card-classes/text/render.py");
    await pool.render("text", classPath, "v1", {}, CTX);
    pool.invalidateClass("text");
    const result = await pool.render("text", classPath, "v2", {}, CTX);
    expect(result.html).toContain("v2");
  });

  it("returns error for non-existent class", async () => {
    await expect(
      pool.render("nonexistent", "/fake/path/render.py", "test", {}, CTX)
    ).rejects.toThrow();
  });
});

// ── Card Manager Tests ──────────────────────────────────────

describe("Card Manager", () => {
  let pool: WorkerPool;
  let manager: CardManager;

  beforeAll(async () => {
    pool = new WorkerPool({ poolSize: 2, pythonPath: "/usr/bin/python3" });
    pool.setRpcHandler(async (method) => {
      if (method === "read_file") return null;
      return { success: true };
    });
    await pool.start();
    manager = new CardManager(pool);
  }, 15000);

  afterAll(() => pool.stop());

  it("resolves markdown class from .md extension", async () => {
    const result = await manager.renderCard("mission", "hello.md", "# Hi\nParagraph.");
    expect(result.html).toContain("<h1>Hi</h1>");
    expect(result.meta.cardClass).toBe("markdown");
    expect(result.meta.badge).toBe("MD");
    expect(result.meta.isSystem).toBe(false);
  });

  it("resolves mermaid class from .mmd extension", async () => {
    const result = await manager.renderCard("mission", "diagram.mmd", "graph TD\n    X --> Y");
    expect(result.html).toContain("mermaid");
    expect(result.meta.cardClass).toBe("mermaid");
    expect(result.meta.badge).toBe("MMD");
  });

  it("resolves text class from .txt extension", async () => {
    const result = await manager.renderCard("mission", "note.txt", "plain text");
    expect(result.html).toContain("card-text");
    expect(result.meta.cardClass).toBe("text");
    expect(result.meta.badge).toBe("TXT");
  });

  it("resolves goal class from _goal.md filename", async () => {
    const result = await manager.renderCard("mission", "_goal.md", "- [x] Done\n- [ ] Pending");
    expect(result.meta.cardClass).toBe("goal");
    expect(result.meta.badge).toBe("GOAL");
    expect(result.meta.title).toBe("Layer Goal");
    expect(result.meta.isSystem).toBe(true);
    expect(result.html).toContain("card-goal");
  });

  it("resolves todo class from _todo.md", async () => {
    const result = await manager.renderCard("mission", "_todo.md", "## Active\n- [ ] A\n## Done\n- [x] B");
    expect(result.meta.cardClass).toBe("todo");
    expect(result.meta.isSystem).toBe(true);
  });

  it("resolves brief class from _brief.md", async () => {
    const result = await manager.renderCard("mission", "_brief.md", "# Brief");
    expect(result.meta.cardClass).toBe("brief");
    expect(result.meta.isSystem).toBe(true);
  });

  it("resolves log class from _log.md", async () => {
    const result = await manager.renderCard("mission", "_log.md", "# Log");
    expect(result.meta.cardClass).toBe("log");
    expect(result.meta.isSystem).toBe(true);
  });

  it("resolves chat class from _chat.md", async () => {
    const result = await manager.renderCard("mission", "_chat.md", "");
    expect(result.meta.cardClass).toBe("chat");
    expect(result.meta.isSystem).toBe(true);
    expect(result.exports).toContain("send_message");
  });

  it("parses frontmatter and uses card: field", async () => {
    const content = "---\ncard: text\ntitle: Custom Title\n---\nBody text here";
    const result = await manager.renderCard("mission", "custom.md", content);
    expect(result.meta.cardClass).toBe("text");
    expect(result.html).toContain("card-text");
    expect(result.html).toContain("Body text here");
    expect(result.html).not.toContain("---");
  });

  it("generates title from filename for content cards", async () => {
    const result = await manager.renderCard("mission", "my-cool-doc.md", "content");
    expect(result.meta.title).toBe("My Cool Doc");
  });

  it("caches renders and invalidates on request", async () => {
    await manager.renderCard("mission", "cache-test.md", "# Cache Test");
    manager.invalidateCard("mission", "cache-test.md");
    const r3 = await manager.renderCard("mission", "cache-test.md", "# Changed");
    expect(r3.html).toContain("Changed");
  });

  it("renders all cards in a layer", async () => {
    const cards = await manager.renderAllCards("mission");
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card.filename).toBeTruthy();
      expect(card.html).toBeTruthy();
      expect(card.meta.cardClass).toBeTruthy();
    }
  });
});

// ── File Watcher Tests ──────────────────────────────────────

describe("File Watcher", () => {
  let watcher: FileWatcher;
  const layerDir = join(process.cwd(), "layers", "experience");

  beforeAll(async () => {
    await mkdir(layerDir, { recursive: true });
    watcher = new FileWatcher();
    await watcher.start();
    await new Promise((r) => setTimeout(r, 500));
  }, 10000);

  afterAll(async () => {
    watcher?.stop();
    await rm(join(layerDir, "detect-create.md"), { force: true });
    await rm(join(layerDir, "detect-modify.md"), { force: true });
  });

  it("detects file creation", async () => {
    const filePath = join(layerDir, "detect-create.md");

    const eventPromise = new Promise<{ type: string; layer: string; filename: string }>((resolve) => {
      watcher.on("file-change", (event: { type: string; layer: string; filename: string }) => {
        if (event.filename === "detect-create.md") resolve(event);
      });
    });

    await writeFile(filePath, "# Created\n");

    const event = await Promise.race([
      eventPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Watcher timeout")), 5000)),
    ]);

    expect(event.layer).toBe("experience");
    expect(event.filename).toBe("detect-create.md");
    expect(["created", "changed"]).toContain(event.type);
  }, 10000);

  it("detects file modification", async () => {
    const filePath = join(layerDir, "detect-modify.md");
    await writeFile(filePath, "v1\n");
    await new Promise((r) => setTimeout(r, 600));

    const eventPromise = new Promise<{ type: string; filename: string }>((resolve) => {
      watcher.on("file-change", (event: { type: string; filename: string }) => {
        if (event.filename === "detect-modify.md") resolve(event);
      });
    });

    await writeFile(filePath, "v2 — modified\n");

    const event = await Promise.race([
      eventPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Watcher timeout")), 5000)),
    ]);

    expect(event.filename).toBe("detect-modify.md");
    expect(event.type).toBe("changed");
  }, 10000);

  it("detects file deletion", async () => {
    const filePath = join(layerDir, "detect-delete.md");
    await writeFile(filePath, "will be deleted\n");
    await new Promise((r) => setTimeout(r, 600));

    const eventPromise = new Promise<{ type: string; filename: string }>((resolve) => {
      watcher.on("file-change", (event: { type: string; filename: string }) => {
        if (event.filename === "detect-delete.md" && event.type === "deleted") resolve(event);
      });
    });

    await rm(filePath);

    const event = await Promise.race([
      eventPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Watcher timeout")), 5000)),
    ]);

    expect(event.type).toBe("deleted");
  }, 10000);
});

// ── Server Integration Tests ────────────────────────────────

describe("Server Integration", () => {
  let serverProcess: ReturnType<typeof import("child_process").spawn> | null = null;

  async function waitForServer(maxWait = 20000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      try {
        const res = await fetch(`${API}/api/health`);
        if (res.ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Server did not start in time");
  }

  beforeAll(async () => {
    const { spawn } = await import("child_process");
    serverProcess = spawn("npx", ["tsx", "server/index.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, MICA_PORT: String(TEST_PORT) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    serverProcess.stdout?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) process.stderr.write(`  [server] ${s}\n`);
    });
    serverProcess.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) process.stderr.write(`  [server:err] ${s}\n`);
    });

    await waitForServer();
  }, 30000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 1000));
      try { serverProcess.kill("SIGKILL"); } catch {}
    }
    await rm(join(process.cwd(), "layers", "mission", "_ws_test.md"), { force: true });
    await rm(join(process.cwd(), "layers", "mission", "_ws_del_test.md"), { force: true });
  });

  it("health check returns ok", async () => {
    const res = await fetch_("/api/health");
    const data = await res.json();
    expect(data.status).toBe("ok");
    expect(data.agents).toContain("mission");
  });

  it("GET /api/layers/mission/cards returns rendered cards", async () => {
    const res = await fetch_("/api/layers/mission/cards");
    expect(res.ok).toBe(true);
    const cards = (await res.json()) as Array<{
      filename: string; html: string; exports: string[];
      meta: { cardClass: string; badge: string; isSystem: boolean };
    }>;
    expect(cards.length).toBeGreaterThan(0);

    const goal = cards.find((c) => c.filename === "_goal.md");
    expect(goal).toBeDefined();
    expect(goal!.meta.cardClass).toBe("goal");
    expect(goal!.meta.isSystem).toBe(true);
    expect(goal!.html).toContain("card-goal");

    const mdCards = cards.filter((c) => c.meta.cardClass === "markdown");
    if (mdCards.length > 0) {
      expect(mdCards[0].html).toContain("card-markdown");
    }

    const mmdCards = cards.filter((c) => c.meta.cardClass === "mermaid");
    if (mmdCards.length > 0) {
      expect(mmdCards[0].html).toContain("mermaid");
    }
  });

  it("WebSocket connects and receives updates on file change", async () => {
    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/cards`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    });

    const testFile = join(process.cwd(), "layers", "mission", "_ws_test.md");
    const msgPromise = waitForWs(ws, (msg) =>
      (msg.type === "file-created" || msg.type === "file-changed") &&
      msg.filename === "_ws_test.md"
    );

    await writeFile(testFile, "# WebSocket Test\nTimestamp: " + Date.now());
    const msg = await msgPromise;

    expect(msg.layer).toBe("mission");
    expect(typeof msg.html).toBe("string");
    expect((msg.html as string)).toContain("WebSocket Test");

    ws.close();
  }, 15000);

  it("WebSocket receives file-deleted on removal", async () => {
    const testFile = join(process.cwd(), "layers", "mission", "_ws_del_test.md");
    await writeFile(testFile, "# Will Delete");
    await new Promise((r) => setTimeout(r, 1000));

    const ws = new WebSocket(`ws://localhost:${TEST_PORT}/ws/cards`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      setTimeout(() => reject(new Error("WS connect timeout")), 5000);
    });

    const msgPromise = waitForWs(ws, (msg) =>
      msg.type === "file-deleted" && msg.filename === "_ws_del_test.md"
    );

    await rm(testFile);
    const msg = await msgPromise;
    expect(msg.type).toBe("file-deleted");

    ws.close();
  }, 15000);

  it("returns error for non-existent export call", async () => {
    const res = await fetch_("/api/layers/mission/cards/_goal.md/call/nonexistent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBeTruthy();
  });

  it("returns 400 for invalid layer", async () => {
    const res = await fetch_("/api/layers/invalid/cards");
    expect(res.status).toBe(400);
  });
});

// ── Markdown Rendering Quality ──────────────────────────────

describe("Markdown rendering quality", () => {
  let pool: WorkerPool;
  const classPath = join(process.cwd(), "card-classes/markdown/render.py");

  beforeAll(async () => {
    pool = new WorkerPool({ poolSize: 1, pythonPath: "/usr/bin/python3" });
    await pool.start();
  }, 15000);

  afterAll(() => pool.stop());

  it("renders tables", async () => {
    const md = "| A | B |\n|---|---|\n| 1 | 2 |";
    const r = await pool.render("markdown", classPath, md, {}, CTX);
    expect(r.html).toContain("<table>");
    expect(r.html).toContain("<td>1</td>");
  });

  it("renders fenced code blocks", async () => {
    const md = "```js\nconsole.log('hi');\n```";
    const r = await pool.render("markdown", classPath, md, {}, CTX);
    expect(r.html).toContain("<code");
    expect(r.html).toContain("console.log");
  });

  it("renders bold, italic, links", async () => {
    const md = "**bold** *italic* [link](http://example.com)";
    const r = await pool.render("markdown", classPath, md, {}, CTX);
    expect(r.html).toContain("<strong>bold</strong>");
    expect(r.html).toContain("<em>italic</em>");
    expect(r.html).toContain('href="http://example.com"');
  });

  it("renders checklists without crashing", async () => {
    const md = "- [x] Done\n- [ ] Pending";
    const r = await pool.render("markdown", classPath, md, {}, CTX);
    expect(r.html).toContain("Done");
    expect(r.html).toContain("Pending");
  });

  it("handles HTML in content safely", async () => {
    const md = "Normal text\n\n<script>alert('xss')</script>";
    const r = await pool.render("markdown", classPath, md, {}, CTX);
    expect(r.html).toContain("Normal text");
  });
});
