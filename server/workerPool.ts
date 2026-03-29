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

// ── Worker environment ────────────────────────────────────
// Workers receive a filtered env — no API keys, cloud credentials, or tokens.
// Only the minimum needed for Python to run and card classes to function.
export function buildWorkerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TERM: "xterm-256color",
    LANG: process.env.LANG || "en_US.UTF-8",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONPATH: path.join(__dirname, "mica_sdk"),
  };
}

/** Function that spawns a Python worker process. Override for Docker exec. */
export type SpawnWorkerFn = () => ChildProcess;

/** Default: spawn Python directly on the host. */
export function localSpawnFn(pythonPath: string, workerPath: string): SpawnWorkerFn {
  return () => spawn(pythonPath, ["-u", workerPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: buildWorkerEnv(),
  });
}

/** Spawn a worker inside a Docker container via `docker exec`. */
export function dockerSpawnFn(containerName: string, workerPath: string): SpawnWorkerFn {
  return () => spawn("docker", [
    "exec", "-i",
    "--env", "PYTHONDONTWRITEBYTECODE=1",
    containerName,
    "python3", "-u", workerPath,
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

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
  data?: unknown;
}

export interface RenderResult {
  html: string;
  exports: string[];
}

export interface RpcHandler {
  (
    method: string,
    args: Record<string, unknown>,
    requestContext: { project: string; canvas: string; filename: string }
  ): Promise<any>;
}

export interface ChannelDataHandler {
  (id: string, data: unknown): void;
}

export interface ChannelCloseHandler {
  (id: string): void;
}

// ── PythonWorker ───────────────────────────────────────────

class PythonWorker {
  private proc: ChildProcess;
  private pending: Map<string, PendingRequest> = new Map();
  private rl!: readline.Interface;
  private ready: boolean = false;
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private _busy: boolean = false;
  private rpcHandler: RpcHandler | null = null;
  private channelDataHandler: ChannelDataHandler | null = null;
  private channelCloseHandler: ChannelCloseHandler | null = null;
  private requestContexts: Map<string, { project: string; canvas: string; filename: string }> = new Map();
  private _hasChannel: boolean = false;
  private consecutiveFailures: number = 0;
  private static readonly BACKOFF_BASE_MS = 1000;
  private static readonly BACKOFF_MAX_MS = 30000;
  private static readonly MAX_CONSECUTIVE_FAILURES = 8;

  constructor(
    private spawnFn: SpawnWorkerFn,
    private autoRestart: boolean = true
  ) {
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });

    this.proc = this.spawnFn();
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
      this.scheduleRestart();
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

  private scheduleRestart() {
    if (!this.autoRestart) return;

    this.consecutiveFailures++;
    if (this.consecutiveFailures > PythonWorker.MAX_CONSECUTIVE_FAILURES) {
      console.error(`[mica-worker] ${this.consecutiveFailures} consecutive failures — giving up restarts`);
      return;
    }

    const delay = Math.min(
      PythonWorker.BACKOFF_BASE_MS * Math.pow(2, this.consecutiveFailures - 1),
      PythonWorker.BACKOFF_MAX_MS,
    );
    console.log(`[mica-worker] Restarting in ${(delay / 1000).toFixed(1)}s (attempt ${this.consecutiveFailures}/${PythonWorker.MAX_CONSECUTIVE_FAILURES})...`);

    setTimeout(() => {
      if (!this.autoRestart) return;
      this.readyPromise = new Promise((resolve) => {
        this.readyResolve = resolve;
      });
      this.proc = this.spawnFn();
      this.setupProcessHandlers();
      if (this.rpcHandler) this.setRpcHandler(this.rpcHandler);
    }, delay);
  }

  get hasChannel(): boolean {
    return this._hasChannel;
  }

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
  }

  setChannelDataHandler(handler: ChannelDataHandler) {
    this.channelDataHandler = handler;
  }

  setChannelCloseHandler(handler: ChannelCloseHandler) {
    this.channelCloseHandler = handler;
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
      this.consecutiveFailures = 0; // Reset backoff on successful start
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

    // Handle channel data from Python → forward to browser
    if (msg.type === "channel_data" || msg.type === "stream") {
      if (msg.id && this.channelDataHandler) {
        this.channelDataHandler(msg.id, msg.data);
      }
      return;
    }

    // Handle channel close from Python → forward to browser, free worker
    if (msg.type === "channel_close") {
      if (msg.id && this.channelCloseHandler) {
        this.channelCloseHandler(msg.id);
      }
      this._busy = false;
      return;
    }

    // Handle errors from channel threads — log them
    if (msg.type === "error" && msg.traceback) {
      console.error(`[mica-worker ${this.proc.pid}] Channel error: ${msg.error}\n${msg.traceback}`);
      // Also forward as channel close so the browser knows
      if (msg.id && this.channelCloseHandler) {
        this.channelCloseHandler(msg.id);
      }
      this._busy = false;
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
    this._busy = false;

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
      ? this.requestContexts.get(requestId) || { project: "", canvas: "workspace", filename: "" }
      : { project: "", canvas: "workspace", filename: "" };

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
    return this._busy;
  }

  get isAlive(): boolean {
    return this.ready && !this.proc.killed;
  }

  send(msg: Record<string, unknown>, timeoutMs = 30000): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = msg.id as string;
      this._busy = true;

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        this.requestContexts.delete(id);
        this._busy = false;
        reject(new Error(`Worker request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, { id, resolve, reject, timeout });
      this.sendToWorker(msg);
    });
  }

  setRequestContext(id: string, context: { project: string; canvas: string; filename: string }) {
    this.requestContexts.set(id, context);
  }

  /** Open a bidirectional channel — marks worker as busy for the channel's duration. */
  openChannel(msg: Record<string, unknown>) {
    this._busy = true;
    this._hasChannel = true;
    this.sendToWorker(msg);
  }

  /** Forward channel data from browser to Python worker. */
  sendChannelData(id: string, data: unknown) {
    this.sendToWorker({ type: "channel_data", id, data });
  }

  /** Request channel close from browser side. */
  closeChannel(id: string) {
    this.sendToWorker({ type: "channel_close", id });
  }

  invalidateClass(className: string) {
    this.sendToWorker({ type: "invalidate_class", class_name: className });
  }

  kill() {
    this.autoRestart = false;
    this.proc.kill("SIGTERM");
  }
}

// ── WorkerPool ─────────────────────────────────────────────

export interface WorkerPoolOptions {
  /** Number of idle workers to keep alive (default: 1) */
  warm?: number;
  /** Maximum workers (default: 6) */
  max?: number;
  /** Spawn function — defaults to local Python spawn */
  spawnFn?: SpawnWorkerFn;
  /** Python path for local spawn (ignored if spawnFn is provided) */
  pythonPath?: string;
  /** Label for logging */
  label?: string;
}

export class WorkerPool extends EventEmitter {
  private workers: PythonWorker[] = [];
  private warmCount: number;
  private maxCount: number;
  private spawnFn: SpawnWorkerFn;
  private rpcHandler: RpcHandler | null = null;
  private requestCounter = 0;
  private roundRobinIndex = 0;
  private channelWorkers: Map<string, PythonWorker> = new Map();
  private idleTimers: Map<PythonWorker, ReturnType<typeof setTimeout>> = new Map();
  private label: string;

  constructor(options?: WorkerPoolOptions) {
    super();
    this.warmCount = options?.warm ?? 1;
    this.maxCount = options?.max ?? 6;
    this.label = options?.label ?? "pool";
    const workerPath = path.join(__dirname, "mica_sdk", "mica_worker.py");
    this.spawnFn = options?.spawnFn
      ?? localSpawnFn(options?.pythonPath ?? "/usr/bin/python3", workerPath);
  }

  setRpcHandler(handler: RpcHandler) {
    this.rpcHandler = handler;
    for (const w of this.workers) {
      w.setRpcHandler(handler);
    }
  }

  async start(): Promise<void> {
    console.log(`[worker-pool:${this.label}] Starting ${this.warmCount} warm workers (max ${this.maxCount})...`);

    for (let i = 0; i < this.warmCount; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
    }

    // Wait for all warm workers to be ready
    await Promise.all(this.workers.map((w) => w.waitReady()));
    console.log(`[worker-pool:${this.label}] ${this.warmCount} warm workers ready.`);
  }

  private createWorker(): PythonWorker {
    const worker = new PythonWorker(this.spawnFn);
    if (this.rpcHandler) {
      worker.setRpcHandler(this.rpcHandler);
    }
    return worker;
  }

  /** Spawn an additional worker on demand (up to max). Returns null if at max. */
  private async spawnExtraWorker(): Promise<PythonWorker | null> {
    if (this.workers.length >= this.maxCount) return null;
    console.log(`[worker-pool:${this.label}] Spawning extra worker (${this.workers.length + 1}/${this.maxCount})`);
    const worker = this.createWorker();
    this.workers.push(worker);
    await worker.waitReady();
    return worker;
  }

  /** Start idle timer for a worker — kills it after 30s if pool is above warm count. */
  private startIdleTimer(worker: PythonWorker) {
    if (this.workers.length <= this.warmCount) return;
    if (worker.hasChannel) return;
    const timer = setTimeout(() => {
      this.evictWorker(worker);
    }, 30000);
    this.idleTimers.set(worker, timer);
  }

  private clearIdleTimer(worker: PythonWorker) {
    const timer = this.idleTimers.get(worker);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(worker);
    }
  }

  private evictWorker(worker: PythonWorker) {
    if (this.workers.length <= this.warmCount) return;
    if (worker.isBusy) return;
    console.log(`[worker-pool:${this.label}] Evicting idle worker (${this.workers.length - 1} remaining)`);
    this.clearIdleTimer(worker);
    worker.kill();
    this.workers = this.workers.filter((w) => w !== worker);
  }

  /** Evict idle workers under memory pressure — down to warm count. */
  evictIdleWorkers() {
    const idle = this.workers.filter((w) => !w.isBusy && !w.hasChannel);
    for (const w of idle) {
      if (this.workers.length <= this.warmCount) break;
      this.evictWorker(w);
    }
  }

  private nextId(): string {
    return `req-${++this.requestCounter}-${Date.now()}`;
  }

  private getIdleWorker(): PythonWorker | null {
    for (const w of this.workers) {
      if (w.isAlive && !w.isBusy) {
        this.clearIdleTimer(w);
        return w;
      }
    }
    return null;
  }

  private async waitForWorker(maxWait = 60000): Promise<PythonWorker> {
    // Try to get an idle worker
    const idle = this.getIdleWorker();
    if (idle) return idle;

    // Try to spawn an extra worker
    const extra = await this.spawnExtraWorker();
    if (extra) return extra;

    // All workers busy and at max — poll for one to become free
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
    context: { project: string; canvas: string; filename: string }
  ): Promise<RenderResult> {
    // Renders prefer idle workers; try spawning extra if all busy; fall back to round-robin
    let worker = this.getIdleWorker();
    if (!worker) {
      worker = await this.spawnExtraWorker() ?? this.getNextAliveWorker();
    }
    const id = this.nextId();
    worker.setRequestContext(id, context);
    try {
      return await worker.send(
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
    } finally {
      this.startIdleTimer(worker);
    }
  }

  async callExport(
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    context: { project: string; canvas: string; filename: string }
  ): Promise<any> {
    const worker = this.getIdleWorker() ?? (await this.waitForWorker());
    const id = this.nextId();
    worker.setRequestContext(id, context);
    try {
      return await worker.send(
        {
          type: "export_call",
          id,
          class_name: className,
          class_path: classPath,
          function: fn,
          content,
          args,
        },
        300000 // 5min timeout for exports (agent.chat can be slow)
      );
    } finally {
      this.startIdleTimer(worker);
    }
  }

  /**
   * Open a bidirectional channel to a @mica.channel handler in Python.
   * The worker is dedicated to this channel until it closes.
   * Uses the caller-provided channelId (passthrough from browser).
   */
  async openChannel(
    channelId: string,
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    context: { project: string; canvas: string; filename: string },
    onData: (data: unknown) => void,
    onClose: () => void
  ): Promise<string> {
    const worker = this.getIdleWorker() ?? (await this.waitForWorker());
    worker.setRequestContext(channelId, context);

    // Wire up handlers scoped to this channel
    worker.setChannelDataHandler((id, data) => {
      if (id === channelId) onData(data);
    });
    worker.setChannelCloseHandler((id) => {
      if (id === channelId) {
        onClose();
        this.channelWorkers.delete(channelId);
        this.startIdleTimer(worker);
      }
    });

    this.channelWorkers.set(channelId, worker);

    worker.openChannel({
      type: "channel_open",
      id: channelId,
      class_name: className,
      class_path: classPath,
      function: fn,
      content,
      args,
    });

    return channelId;
  }

  /** Forward channel data from browser to the Python worker owning this channel. */
  sendChannelData(channelId: string, data: unknown) {
    const worker = this.channelWorkers.get(channelId);
    if (worker) worker.sendChannelData(channelId, data);
  }

  /** Close a channel from the browser side. */
  closeChannel(channelId: string) {
    const worker = this.channelWorkers.get(channelId);
    if (worker) {
      worker.closeChannel(channelId);
      this.channelWorkers.delete(channelId);
    }
  }

  invalidateClass(className: string) {
    for (const w of this.workers) {
      w.invalidateClass(className);
    }
  }

  async stop(): Promise<void> {
    for (const w of this.workers) {
      this.clearIdleTimer(w);
      w.kill();
    }
    this.workers = [];
    this.channelWorkers.clear();
    this.idleTimers.clear();
  }

  get workerCount(): number {
    return this.workers.length;
  }

  get idleCount(): number {
    return this.workers.filter((w) => w.isAlive && !w.isBusy).length;
  }
}
