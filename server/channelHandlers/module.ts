/**
 * Module channel handler — bridges card class stream exports to ChannelHandler.
 *
 * Card classes that export onConnect/onMessage/onDisconnect get wired into the
 * unified ChannelManager through this handler. The pattern mirrors WebSockets:
 *
 *   onConnect(mica, args)   → called when first client attaches (session start)
 *   onMessage(msg, mica)    → called when any client sends data
 *   onDisconnect(mica)      → called when session is destroyed
 *
 * Supports two execution modes:
 * - Container: card code runs inside Docker, bridge calls cross the boundary
 * - Host (fallback): card code runs in the Mica server process
 */

import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { ModuleLoader, MicaBridge } from "../moduleLoader.js";
import type { ContainerRuntime } from "../containerRuntime.js";

export interface ModuleHandlerDeps {
  moduleLoader: ModuleLoader;
  getClassPath: (className: string, projectPath?: string) => string | null;
  resolveCardClass: (filename: string, content?: string) => { cardClass: string };
  getProjectPath: (project: string) => Promise<string>;
  createExecFn: (project: string) => (command: string, opts?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readCardFile: (project: string, canvas: string, cardName: string, filename: string) => Promise<string>;
  writeCardFile: (project: string, canvas: string, cardName: string, filename: string, content: string) => Promise<void>;
  getContainerRuntime: (project: string) => ContainerRuntime | undefined;
}

/**
 * Creates a HandlerFactory for module-based card classes.
 * The factory is registered once; it dynamically loads the right card class
 * based on the filename's extension.
 */
export function createModuleHandlerFactory(deps: ModuleHandlerDeps) {
  return async function moduleHandlerFactory(
    content: string,
    args: Record<string, unknown>,
    ctx: SessionContext,
  ): Promise<ChannelHandler> {
    const { moduleLoader, resolveCardClass, getClassPath, getProjectPath, getContainerRuntime } = deps;

    // Resolve card class
    const { cardClass } = resolveCardClass(ctx.filename, content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(ctx.project); } catch { /* fallback */ }
    const classPath = getClassPath(cardClass, projectPath);
    if (!classPath) {
      throw new Error(`Card class "${cardClass}" not found for ${ctx.filename}`);
    }

    const containerRuntime = getContainerRuntime(ctx.project);

    if (containerRuntime) {
      // ── Container mode: proxy stream handlers through container runtime ──
      return createContainerHandler(containerRuntime, cardClass, classPath, ctx, args);
    } else {
      // ── Host mode (fallback): run stream handlers directly ──
      return createHostHandler(moduleLoader, deps, cardClass, classPath, ctx, args);
    }
  };
}

// ── Container mode handler ──────────────────────────────────

function createContainerHandler(
  runtime: ContainerRuntime,
  cardClass: string,
  classPath: string,
  ctx: SessionContext,
  args: Record<string, unknown>,
): ChannelHandler {
  // onConnect runs inside the container. Bridge callbacks (send/reply) arrive
  // as messages from the container and are routed by ContainerRuntime.
  runtime.onConnect(cardClass, classPath, ctx.filename, args).catch((err) => {
    console.error(`[module-handler] Container onConnect error for ${ctx.filename}:`, err.message);
  });

  return {
    onAttach(clientId: string, _args: Record<string, unknown>): void {
      // Deliver synthetic "attached" message for reconnect replay
      runtime.onMessage(cardClass, classPath, ctx.filename, { type: "attached" }, clientId).catch(() => {});
    },

    onData(clientId: string, data: unknown): void {
      runtime.onMessage(cardClass, classPath, ctx.filename, data, clientId).catch((err) => {
        console.error(`[module-handler] Container onMessage error for ${ctx.filename}:`, err.message);
        ctx.broadcast({ type: "error", error: err.message });
      });
    },

    onDetach(_clientId: string): void {
      // Soft close — session stays alive.
    },

    onDestroy(): void {
      runtime.onDisconnect(cardClass, classPath, ctx.filename).catch((err) => {
        console.error(`[module-handler] Container onDisconnect error for ${ctx.filename}:`, err.message);
      });
    },
  };
}

// ── Host mode handler (fallback when no container) ──────────

async function createHostHandler(
  moduleLoader: ModuleLoader,
  deps: ModuleHandlerDeps,
  cardClass: string,
  classPath: string,
  ctx: SessionContext,
  args: Record<string, unknown>,
): Promise<ChannelHandler> {
  const handlers = await moduleLoader.getStreamHandlers(cardClass, classPath);
  if (!handlers) {
    throw new Error(`Card class "${cardClass}" has no stream handlers (onConnect/onMessage)`);
  }

  // Build a MicaBridge — read/write scoped to card directory
  const exec = deps.createExecFn(ctx.project);
  const { readCardFile: rcf, writeCardFile: wcf } = deps;
  const mica: MicaBridge = {
    project: ctx.project,
    canvas: ctx.canvas,
    filename: ctx.filename,
    send(data: unknown) {
      ctx.broadcast(data);
    },
    reply(data: unknown) {
      ctx.broadcast(data);
    },
    async read(filename: string) {
      return rcf(ctx.project, ctx.canvas, ctx.filename, filename);
    },
    async write(filename: string, content: string) {
      await wcf(ctx.project, ctx.canvas, ctx.filename, filename, content);
    },
    async exec(command: string, opts?: { cwd?: string; timeout?: number }) {
      return exec(command, opts);
    },
    async log(message: string) {
      const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      const line = `- **${timestamp}** — ${message}\n`;
      try {
        const existing = await ctx.readFile("_log.log");
        await ctx.writeFile("_log.log", existing + line);
      } catch {
        await ctx.writeFile("_log.log", `# Activity Log\n\n${line}`);
      }
    },
  };

  // Call onConnect
  if (handlers.onConnect) {
    await handlers.onConnect(mica, args);
  }

  return {
    onAttach(clientId: string, _args: Record<string, unknown>): void {
      if (handlers.onMessage) {
        const replyToClient = (d: unknown) => ctx.sendTo(clientId, d);
        const attachMica = Object.create(mica, {
          reply: { value: replyToClient, writable: true },
          send: { value: replyToClient, writable: true },
        });
        Promise.resolve(handlers.onMessage({ type: "attached" }, attachMica)).catch(() => {});
      }
    },

    onData(clientId: string, data: unknown): void {
      if (handlers.onMessage) {
        mica.reply = (d: unknown) => ctx.sendTo(clientId, d);
        Promise.resolve(handlers.onMessage(data, mica)).catch((err) => {
          console.error(`[module-handler] onMessage error for ${ctx.filename}:`, (err as Error).message);
          ctx.broadcast({ type: "error", error: (err as Error).message });
        });
      }
    },

    onDetach(_clientId: string): void {},

    onDestroy(): void {
      if (handlers.onDisconnect) {
        Promise.resolve(handlers.onDisconnect(mica)).catch((err) => {
          console.error(`[module-handler] onDisconnect error for ${ctx.filename}:`, (err as Error).message);
        });
      }
    },
  };
}
