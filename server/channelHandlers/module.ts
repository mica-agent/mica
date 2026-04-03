/**
 * Module channel handler — bridges ModuleLoader stream exports to ChannelHandler.
 *
 * Card classes that export onConnect/onMessage/onDisconnect get wired into the
 * unified ChannelManager through this handler. The pattern mirrors WebSockets:
 *
 *   onConnect(mica)        → called when first client attaches (session start)
 *   onMessage(msg, mica)   → called when any client sends data
 *   onDisconnect(mica)     → called when session is destroyed
 *
 * The MicaBridge's send() method broadcasts to all attached clients via ctx.broadcast().
 */

import type { ChannelHandler, SessionContext } from "../channelManager.js";
import type { ModuleLoader, MicaBridge } from "../moduleLoader.js";

export interface ModuleHandlerDeps {
  moduleLoader: ModuleLoader;
  getClassPath: (className: string, projectPath?: string) => string | null;
  resolveCardClass: (filename: string, content?: string) => { cardClass: string };
  getProjectPath: (project: string) => Promise<string>;
  createExecFn: (project: string) => (command: string, opts?: { cwd?: string; timeout?: number }) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  readCardFile: (project: string, canvas: string, cardName: string, filename: string) => Promise<string>;
  writeCardFile: (project: string, canvas: string, cardName: string, filename: string, content: string) => Promise<void>;
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
    const { moduleLoader, resolveCardClass, getClassPath, getProjectPath, createExecFn } = deps;

    // Resolve card class and load stream handlers
    const { cardClass } = resolveCardClass(ctx.filename, content);
    let projectPath: string | undefined;
    try { projectPath = await getProjectPath(ctx.project); } catch { /* fallback */ }
    const classPath = getClassPath(cardClass, projectPath);
    if (!classPath) {
      throw new Error(`Card class "${cardClass}" not found for ${ctx.filename}`);
    }

    const handlers = await moduleLoader.getStreamHandlers(cardClass, classPath);
    if (!handlers) {
      throw new Error(`Card class "${cardClass}" has no stream handlers (onConnect/onMessage)`);
    }

    // Build a MicaBridge — read/write scoped to card directory
    const exec = createExecFn(ctx.project);
    const { readCardFile: rcf, writeCardFile: wcf } = deps;
    const mica: MicaBridge = {
      project: ctx.project,
      canvas: ctx.canvas,
      filename: ctx.filename,
      send(data: unknown) {
        ctx.broadcast(data);
      },
      reply(data: unknown) {
        // Default: broadcast. Overridden per-call in onData to target the sender.
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

    // Call onConnect when the handler is created (first client attach)
    if (handlers.onConnect) {
      await handlers.onConnect(mica, args);
    }

    return {
      onAttach(clientId: string, _args: Record<string, unknown>): void {
        // For reconnecting clients (refresh, second window), deliver a synthetic
        // "attached" message so the card class can replay state (scrollback, history).
        // Use a per-call mica proxy so concurrent attaches don't clobber each other.
        // This runs synchronously inside channelManager.open() — the client handle
        // is already registered, so sendTo() will deliver data immediately.
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
          // Set reply() to target this specific client for the duration of the handler
          mica.reply = (d: unknown) => ctx.sendTo(clientId, d);
          Promise.resolve(handlers.onMessage(data, mica)).catch((err) => {
            console.error(`[module-handler] onMessage error for ${ctx.filename}:`, (err as Error).message);
            ctx.broadcast({ type: "error", error: (err as Error).message });
          });
        }
      },

      onDetach(_clientId: string): void {
        // Soft close — session stays alive. Handler decides idle behavior.
      },

      onDestroy(): void {
        if (handlers.onDisconnect) {
          Promise.resolve(handlers.onDisconnect(mica)).catch((err) => {
            console.error(`[module-handler] onDisconnect error for ${ctx.filename}:`, (err as Error).message);
          });
        }
      },
    };
  };
}
