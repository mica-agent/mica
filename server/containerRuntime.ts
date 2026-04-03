/**
 * ContainerRuntime — host-side proxy to the card runtime inside a project's Docker container.
 *
 * Starts a long-lived Node.js process inside the container that loads and executes
 * card class modules. Communicates via stdin/stdout line-delimited JSON.
 *
 * Bridge calls from card code (mica.send, mica.reply, mica.log) arrive as messages
 * from the container and are routed to the appropriate handler on the host.
 */

import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface } from "readline";
import type { RenderResult, MicaBridge } from "./moduleLoader.js";

// ── Types ──────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface BridgeCallbacks {
  onSend: (cardName: string, data: unknown) => void;
  onReply: (cardName: string, clientId: string, data: unknown) => void;
  onLog: (cardName: string, message: string) => void;
}

// ── ContainerRuntime ───────────────────────────────────────

export class ContainerRuntime {
  private containerName: string;
  private projectId: string;
  private canvas: string;
  private proc: ChildProcess | null = null;
  private rl: Interface | null = null;
  private pending = new Map<string, PendingRequest>();
  private idCounter = 0;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private bridgeCallbacks: BridgeCallbacks | null = null;

  constructor(containerName: string, projectId: string, canvas: string = "_root") {
    this.containerName = containerName;
    this.projectId = projectId;
    this.canvas = canvas;
  }

  /** Set callbacks for bridge calls from card code (send, reply, log). */
  setBridgeCallbacks(callbacks: BridgeCallbacks): void {
    this.bridgeCallbacks = callbacks;
  }

  /** Start the runtime process inside the container. */
  async start(): Promise<void> {
    if (this.proc) return;

    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    // Start Node.js inside the container with the runtime script
    this.proc = spawn("docker", [
      "exec", "-i",
      "-e", `MICA_PROJECT=${this.projectId}`,
      "-e", `MICA_CANVAS=${this.canvas}`,
      "-e", `PROJECT_DIR=/project`,
      "-e", `NODE_PATH=/opt/mica/node_modules`,
      "-e", `HOME=/home/sandbox`,
      this.containerName,
      "node", "--experimental-vm-modules", "/opt/mica/runtime/runtime.js",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Read stdout line by line — each line is a JSON message
    this.rl = createInterface({ input: this.proc.stdout!, terminal: false });
    this.rl.on("line", (line) => this.handleMessage(line));

    // Log stderr
    this.proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) console.error(`[container:${this.projectId}] ${text}`);
    });

    this.proc.on("exit", (code) => {
      console.warn(`[container:${this.projectId}] Runtime exited with code ${code}`);
      this.proc = null;
      this.rl = null;
      this.ready = false;
      // Reject all pending requests
      for (const [id, req] of this.pending) {
        clearTimeout(req.timeout);
        req.reject(new Error("Container runtime exited"));
        this.pending.delete(id);
      }
    });

    // Wait for the "ready" message
    await this.readyPromise;
    console.log(`[container:${this.projectId}] Runtime ready`);
  }

  /** Stop the runtime process. */
  stop(): void {
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill("SIGTERM");
      this.proc = null;
    }
    this.rl = null;
    this.ready = false;
  }

  /** Ensure the runtime is started. */
  private async ensureRunning(): Promise<void> {
    if (!this.ready) {
      await this.start();
    }
  }

  // ── Send message to container ─────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) {
      throw new Error("Container runtime not running");
    }
    this.proc.stdin.write(JSON.stringify(msg) + "\n");
  }

  private nextId(): string {
    return `cr-${++this.idCounter}`;
  }

  private request(msg: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
    const id = this.nextId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Container request timed out: ${msg.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.send({ ...msg, id });
    });
  }

  // ── Handle messages from container ────────────────────────

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      console.warn(`[container:${this.projectId}] Invalid JSON from runtime: ${line}`);
      return;
    }

    // Ready signal
    if (msg.type === "ready") {
      this.ready = true;
      this.readyResolve?.();
      return;
    }

    // Bridge callbacks from card code
    if (msg.type === "bridge") {
      const cardName = msg.cardName as string;
      const method = msg.method as string;
      switch (method) {
        case "send":
          this.bridgeCallbacks?.onSend(cardName, msg.data);
          break;
        case "reply":
          this.bridgeCallbacks?.onReply(cardName, msg.replyClientId as string, msg.data);
          break;
        case "log":
          this.bridgeCallbacks?.onLog(cardName, (msg.data as { message: string }).message);
          break;
      }
      return;
    }

    // Response to a pending request
    const id = msg.id as string;
    const pending = this.pending.get(id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pending.delete(id);

    if (msg.type === "error") {
      pending.reject(new Error(msg.message as string));
    } else {
      pending.resolve(msg.value);
    }
  }

  // ── Public API (matches ModuleLoader interface) ───────────

  async render(
    className: string,
    classPath: string,
    content: string,
    config: Record<string, unknown>,
  ): Promise<RenderResult> {
    await this.ensureRunning();
    const result = await this.request({
      type: "render",
      className,
      classPath: this.toContainerPath(classPath),
      content,
      config,
    }) as RenderResult;
    return result;
  }

  async callExport(
    className: string,
    classPath: string,
    fn: string,
    content: string,
    args: Record<string, unknown>,
    cardName: string,
  ): Promise<unknown> {
    await this.ensureRunning();
    return this.request({
      type: "callExport",
      className,
      classPath: this.toContainerPath(classPath),
      fn,
      content,
      args,
      cardName,
    });
  }

  async onConnect(
    className: string,
    classPath: string,
    cardName: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    await this.ensureRunning();
    await this.request({
      type: "onConnect",
      className,
      classPath: this.toContainerPath(classPath),
      cardName,
      args,
    });
  }

  async onMessage(
    className: string,
    classPath: string,
    cardName: string,
    msg: unknown,
    replyClientId?: string,
  ): Promise<void> {
    await this.ensureRunning();
    await this.request({
      type: "onMessage",
      className,
      classPath: this.toContainerPath(classPath),
      cardName,
      msg,
      replyClientId,
    });
  }

  async onDisconnect(
    className: string,
    classPath: string,
    cardName: string,
  ): Promise<void> {
    await this.ensureRunning();
    await this.request({
      type: "onDisconnect",
      className,
      classPath: this.toContainerPath(classPath),
      cardName,
    });
  }

  async getStreamHandlers(
    className: string,
    classPath: string,
  ): Promise<boolean> {
    await this.ensureRunning();
    // We can check by doing a render and checking hasStream, or
    // add a dedicated "hasStream" message. For now, render returns hasStream.
    // This is called to check if a card class has stream exports.
    // We'll do a lightweight check by loading the module.
    const result = await this.request({
      type: "render",
      className,
      classPath: this.toContainerPath(classPath),
      content: "",
      config: {},
    }) as RenderResult;
    return result.hasStream;
  }

  async invalidateClass(className: string): Promise<void> {
    if (!this.ready) return;
    await this.request({ type: "invalidateClass", className });
  }

  async invalidateAll(): Promise<void> {
    if (!this.ready) return;
    await this.request({ type: "invalidateAll" });
  }

  // ── Path mapping ──────────────────────────────────────────
  // Host paths need to be converted to container paths.

  private toContainerPath(hostPath: string): string {
    // card-classes/ → /opt/mica/card-classes/
    if (hostPath.includes("/card-classes/")) {
      const rel = hostPath.slice(hostPath.indexOf("/card-classes/") + "/card-classes/".length);
      return `/opt/mica/card-classes/${rel}`;
    }
    // Project .mica/.card-classes/ → /project/.mica/.card-classes/
    if (hostPath.includes("/.mica/.card-classes/")) {
      const rel = hostPath.slice(hostPath.indexOf("/.mica/.card-classes/"));
      return `/project${rel}`;
    }
    return hostPath;
  }
}
