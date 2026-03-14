/**
 * WorkerPool — Manages a pool of long-lived Python mica_worker.py processes.
 *
 * Each worker communicates via JSON lines on stdin/stdout.
 * Workers cache loaded card classes in-process for fast re-renders.
 */

import { ChildProcess, spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import { EventEmitter } from "events";
import readline from "readline";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Types ──────────────────────────────────────────────────

interface PendingRequest {
  id: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  type: string;
  id?: string;
  request_id?: string;
  html?: string;
  exports?: string[];
  result?: any;
  error?: string;
  traceback?: string;
  class_name?: string;
  method?: string;
  args?: Record<string, unknown>;
}

export interface RenderResult {
  html: string;
  exports: string[];
}

export interface RpcHandler {
  (
    method: string,
    args: Record<string, unknown>,
    requestContext: { layer: string; filename: string }
  ): Promise<any>;
}

// ── PythonWorker ───────────────────────────────────────────

class PythonWorker {
  private proc: ChildProcess;
  private pending: Map<string, PendingRequest> = new Map();
  private rl: readline.Interface;
  private ready: boolean = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private busy: boolean = false;
  private rpcHandler: RpcHandler | null = null;
  private requestContexts: Map<string, { layer: string; filename: string }> = new Map();

  constructor(
    private workerPath: string,
    private pythonPath: string = "/usr/bin/python3"
  ) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.proc = spawn(this.pythonPath, ["-u", this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });

    this.setupProcessHandlers();
  }

  private setupProcessHandlers() {
    // Read stdout line by line
    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleMessage(line));
    this.rl.on("error", (err) => {
      console.error(`[mica-worker ${this.proc.pid}] readline error:`, err.message);
    });

    // Log stderr
    this.proc.stderr?.on("data", (data) => {
      console.error(`[mica-worker ${this.proc.pid}] ${data.toString().trim()}`);
    });

    this.proc.on("error", (err) => {
      console.error(`[mica-worker] Failed to spawn:`, err.message);
      this.rejectAllPending(`Worker spawn failed: ${err.message}`);
    });

    this.proc.on("exit", (code) => {
      console.log(`[mica-worker ${this.proc.pid}] exited with code ${code}`);
      this.rejectAllPending(`Worker exited with code ${code}`);
      // Auto-restart after 1s
      setTimeout(() => this.restart(), 1000);
    });
  }

  private rejectAllPending(reason: string) {
    for (const [, req] of this.pending) {
      clearTimeout(req.timeout);
      req.reject(new Error(reason));
    }
    this.pending.clear();
    this.ready = false;
  }

  private restart() {
    console.log("[mica-worker] Restarting worker...");
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
    this.proc = spawn(this.pythonPath, ["-u", this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
    });
    this.setupProcessHandlers();
    if (this.rpcHandler) this.setRpcHandler(this.rpcHandler);
  }

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
  }

  private handleMessage(line: string) {
    let msg: WorkerMessage;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[mica-worker] Invalid JSON from worker: ${line}`);
      return;
    }

    if (msg.type === "ready") {
      this.ready = true;
      this.readyResolve();
      return;
    }

    if (msg.type === "pong" || msg.type === "invalidated") {
      return;
    }

    // Handle RPC requests from Python (mica.write(), mica.agent.chat(), etc.)
    if (msg.type === "rpc") {
      this.handleRpc(msg);
      return;
    }

    // Handle responses to our requests
    const id = msg.id;
    if (!id) return;

    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(id);
    this.requestContexts.delete(id);
    this.busy = false;

    if (msg.type === "error") {
      pending.reject(new Error(msg.error || "Unknown worker error"));
    } else if (msg.type === "render_result") {
      pending.resolve({ html: msg.html, exports: msg.exports || [] });
    } else if (msg.type === "export_result") {
      pending.resolve(msg.result);
    } else {
      pending.resolve(msg);
    }
  }

  private async handleRpc(msg: WorkerMessage) {
    const requestId = msg.request_id;
    const method = msg.method || "";
    const args = msg.args || {};

    if (!this.rpcHandler) {
      this.sendToWorker({
        type: "rpc_response",
        request_id: requestId,
        error: "No RPC handler configured",
      });
      return;
    }

    // Get the context for this request
    const context = requestId
      ? this.requestContexts.get(requestId) || { layer: "mission", filename: "" }
      : { layer: "mission", filename: "" };

    try {
      const result = await this.rpcHandler(method, args, context);
      this.sendToWorker({
        type: "rpc_response",
        request_id: requestId,
        result,
      });
    } catch (err) {
      this.sendToWorker({
        type: "rpc_response",
        request_id: requestId,
        error: (err as Error).message,
      });
    }
  }

  private sendToWorker(msg: Record<string, unknown>) {
    if (!this.proc.stdin?.writable) return;
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  async waitReady(): Promise<void> {
    return this.readyPromise;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get isAlive(): boolean {
    return this.ready && !this.proc.killed;
  }

  send(msg: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = msg.id as string;
      this.busy = true;

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.requestContexts.delete(id);
        this.busy = false;
        reject(new Error(`Worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { id, resolve, reject, timeout });
      this.sendToWorker(msg);
    });
  }

  setRequestContext(id: string, context: { layer: string; filename: string }) {
    this.requestContexts.set(id, context);
  }

  invalidateClass(className: string) {
    this.sendToWorker({ type: "invalidate_class", class_name: className });
  }

  kill() {
    this.proc.kill("SIGTERM");
  }
}

// ── WorkerPool ─────────────────────────────────────────────

export class WorkerPool extends EventEmitter {
  private workers: PythonWorker[] = [];
  private workerPath: string;
  private pythonPath: string;
  private poolSize: number;
  private rpcHandler: RpcHandler | null = null;
  private requestCounter = 0;
  private roundRobinIndex = 0;

  constructor(options?: {
    poolSize?: number;
    pythonPath?: string;
  }) {
    super();
    this.poolSize = options?.poolSize ?? 8;
    this.pythonPath = options?.pythonPath ?? "/usr/bin/python3";
    this.workerPath = path.join(__dirname, "mica_sdk", "mica_worker.py");
  }

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
    for (const w of this.workers) {
      w.setRpcHandler(handler);
    }
  }

  async start(): Promise<void> {
    console.log(`[worker-pool] Starting ${this.poolSize} Python workers...`);

    for (let i = 0; i < this.poolSize; i++) {
      const worker = new PythonWorker(this.workerPath, this.pythonPath);
      if (this.rpcHandler) {
        worker.setRpcHandler(this.rpcHandler);
      }
      this.workers.push(worker);
    }

    // Wait for all workers to be ready
    await Promise.all(this.workers.map((w) => w.waitReady()));
    console.log(`[worker-pool] All ${this.poolSize} workers ready.`);
  }

  private nextId(): string {
    return `req-${++this.requestCounter}-${Date.now()}`;
  }

  private getIdleWorker(): PythonWorker | null {
    for (const w of this.workers) {
      if (w.isAlive && !w.isBusy) return w;
    }
    return null;
  }

  private async waitForWorker(maxWait = 60000): Promise<PythonWorker> {
    // Simple polling for an idle worker
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const worker = this.getIdleWorker();
      if (worker) return worker;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("No workers available (pool exhausted)");
  }

  private getNextAliveWorker(): PythonWorker {
    // Round-robin across alive workers, regardless of busy state.
    // Renders are fast and can queue behind an in-progress export.
    for (let i = 0; i < this.workers.length; i++) {
      const idx = (this.roundRobinIndex + i) % this.workers.length;
      if (this.workers[idx].isAlive) {
        this.roundRobinIndex = (idx + 1) % this.workers.length;
        return this.workers[idx];
      }
    }
    throw new Error("No alive workers available");
  }

  async render(
    className: string,
    classPath: string,
    content: string,
    config: Record<string, unknown>,
    context: { layer: string; filename: string }
  ): Promise<RenderResult> {
    // Renders prefer idle workers but never wait — fall back to round-robin
    // so they don't get stuck behind long-running export calls
    const worker = this.getIdleWorker() ?? this.getNextAliveWorker();
    const id = this.nextId();
    worker.setRequestContext(id, context);
    return worker.send(
      {
        type: "render",
        id,
        class_name: className,
        class_path: classPath,
        content,
        config,
      },
      30000 // 30s timeout for renders
    );
  }

  async callExport(
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    context: { layer: string; filename: string }
  ): Promise<any> {
    const worker = this.getIdleWorker() ?? (await this.waitForWorker());
    const id = this.nextId();
    worker.setRequestContext(id, context);
    return worker.send(
      {
        type: "export_call",
        id,
        class_name: className,
        class_path: classPath,
        function: fn,
        content,
        args,
      },
      120000 // 2min timeout for exports (agent.chat can be slow)
    );
  }

  invalidateClass(className: string) {
    for (const w of this.workers) {
      w.invalidateClass(className);
    }
  }

  async stop(): Promise<void> {
    for (const w of this.workers) {
      w.kill();
    }
    this.workers = [];
  }
}
