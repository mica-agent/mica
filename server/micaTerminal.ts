// micaTerminal.ts -- Terminal channel handler.
// Bridges the terminal card class's onConnect/onMessage/onDestroy
// exports to the ChannelManager handler interface.

import { join } from "path";
import type { ChannelHandler, SessionContext } from "./channelManager.js";

const CARD_CLASSES_DIR = join(process.cwd(), "card-classes");

export function createTerminalHandler() {
  return async function terminalHandlerFactory(
    _content: string,
    args: Record<string, unknown>,
    ctx: SessionContext
  ): Promise<ChannelHandler> {

    // Load the terminal card class module
    const renderPath = join(CARD_CLASSES_DIR, "terminal", "render.js");
    const mod = await import(renderPath);

    // Create a mica bridge compatible with the card class exports
    const micaBridge = {
      project: "_",
      canvas: "_",
      filename: ctx.filename,
      send(data: unknown) { ctx.broadcast(data); },
      reply(data: unknown) { ctx.broadcast(data); },
      async read(fname: string) { return ctx.readFile(fname); },
      async write(fname: string, content: string) { await ctx.writeFile(fname, content); },
      on(_event: string, _cb: (data: unknown) => void) { return () => {}; },
    };

    // Call onConnect
    if (mod.onConnect) {
      await mod.onConnect(micaBridge, args);
    }

    return {
      onAttach(clientId, attachArgs) {
        // Re-send history/scrollback on reattach
        if (mod.onConnect) {
          const reattachBridge = {
            ...micaBridge,
            send(data: unknown) { ctx.sendTo(clientId, data); },
            reply(data: unknown) { ctx.sendTo(clientId, data); },
          };
          mod.onConnect(reattachBridge, attachArgs);
        }
      },

      onData(_clientId, data) {
        if (mod.onMessage) {
          mod.onMessage(data, micaBridge);
        }
      },

      onDestroy() {
        if (mod.onDestroy) {
          mod.onDestroy(micaBridge);
        }
      },
    };
  };
}
