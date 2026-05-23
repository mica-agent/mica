// Singleton headless Chromium for the live-mount verifier. Cold launch is
// 1-2s; we keep one Browser process alive for the server's lifetime and
// spawn a fresh BrowserContext per check (~100-200ms, isolated state).
//
// Lazy: the browser launches on first call, not at server startup, so a
// server that never runs a live mount never pays the cost.
//
// Failure mode: if Chromium isn't installed (e.g. fresh devcontainer that
// hasn't run `npx playwright install chromium` yet), launch throws. The
// live-mount verifier catches that and returns a "skip" — the agent is
// not blocked on a missing dev-tool dependency.

import { chromium, type Browser } from "playwright";

let browser: Browser | null = null;
let launchPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    const b = await chromium.launch({
      headless: true,
      // --no-sandbox is required when running as root or in some container
      // configurations (devcontainer with user-namespace remapping). The
      // tradeoff is reduced isolation between page and host — acceptable
      // because the host is the devcontainer, not a production environment,
      // and the mounted card.js is already trusted (the agent wrote it).
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
    browser = b;
    launchPromise = null;
    return b;
  })();
  return launchPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browser) {
    const b = browser;
    browser = null;
    try { await b.close(); } catch { /* already gone */ }
  }
}

// Best-effort shutdown when the server process exits cleanly. Doesn't fire
// on SIGKILL — Chromium will be reaped by the OS anyway.
process.once("beforeExit", () => { void closeBrowser(); });
process.once("SIGINT",     () => { void closeBrowser(); });
process.once("SIGTERM",    () => { void closeBrowser(); });
