#!/usr/bin/env node
/**
 * run-with-electron-node.mjs — Execute a JS/TS script or CLI using the
 * local Electron binary in pure Node.js mode (ELECTRON_RUN_AS_NODE=1).
 *
 * Ensures tests, build-time native addon smoke checks, and server smoke
 * runners execute against the exact same Electron-bundled Node.js ABI
 * as the desktop app runtime.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const electronBin = require("electron");
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-with-electron-node.mjs <script-or-flag> [...args]");
  process.exit(1);
}

const child = spawn(electronBin, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  },
});

child.on("error", (err) => {
  console.error(`[run-with-electron-node] failed to spawn Electron: ${err.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
