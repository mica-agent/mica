#!/usr/bin/env node
// Wrapper around the bundled @qwen-code/sdk CLI that injects
// --experimental-lsp into argv before delegating. The SDK's
// QueryOptions doesn't expose this flag (as of v0.1.7), and the
// CLI default is `false`, so this wrapper is the supported way to
// flip LSP on for SDK-driven sessions like Mica's chat agent.
//
// Mica points the SDK at this wrapper via the QWEN_CODE_CLI_PATH
// environment variable (set in scripts/start.sh). The SDK respects
// that env var when auto-detecting `pathToQwenExecutable`.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Resolve the bundled CLI path. The SDK's package.json `exports` field
// only allows resolving the main entry and `./package.json`, NOT
// `./dist/cli/cli.js` directly — so we resolve package.json to find
// the package root, then build the CLI path from there.
const require = createRequire(import.meta.url);
const pkgJsonPath = require.resolve("@qwen-code/sdk/package.json");
const cliPath = join(dirname(pkgJsonPath), "dist", "cli", "cli.js");

// Inject the flag once. Use splice at index 2 (after node + this script)
// so the flag appears before any user-supplied args, which the CLI's
// arg parser accepts in any order anyway.
if (!process.argv.includes("--experimental-lsp")) {
  process.argv.splice(2, 0, "--experimental-lsp");
}

// Defer to the bundled CLI. ESM dynamic import handles its own arg
// parsing on import-time-side-effect.
await import(cliPath);
