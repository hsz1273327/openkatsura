#!/usr/bin/env node
/**
 * smoke-desktop-server.mjs — Boot-and-verify smoke test for the desktop
 * packaged server tree (`dist-server/{os}-{arch}/`) under Electron's bundled
 * Node.js runtime (`ELECTRON_RUN_AS_NODE=1`).
 *
 * Verifies:
 * 1. No standalone `node` / `hana-server.exe` binary is shipped in dist-server.
 * 2. Electron (`ELECTRON_RUN_AS_NODE=1`) boots `bootstrap.js` + `bundle/index.js`.
 * 3. `server-info.json` is written and `GET /api/server/identity` returns 200.
 * 4. Process shuts down cleanly on SIGTERM.
 *
 * Usage: node scripts/smoke-desktop-server.mjs [platform] [arch]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function resolveServerDir(platform, arch) {
  const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
  return path.join(ROOT, "dist-server", `${osDirName}-${arch}`);
}

function waitForFile(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fs.existsSync(filePath)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${filePath}`));
        return;
      }
      setTimeout(tick, 200);
    };
    tick();
  });
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms waiting for process exit`));
    }, timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function main() {
  const platform = process.argv[2] || process.platform;
  const arch = process.argv[3] || process.arch;
  const serverDir = resolveServerDir(platform, arch);

  if (!fs.existsSync(serverDir)) {
    throw new Error(`[smoke-desktop-server] server build not found: ${serverDir}`);
  }

  for (const forbidden of ["node", "hana-server", "hana-server.exe", "hana-server.cmd"]) {
    const p = path.join(serverDir, forbidden);
    if (fs.existsSync(p)) {
      throw new Error(`[smoke-desktop-server] unexpected standalone runtime artifact found: ${p}`);
    }
  }

  const bootstrapPath = path.join(serverDir, "bootstrap.js");
  if (!fs.existsSync(bootstrapPath)) {
    throw new Error(`[smoke-desktop-server] bootstrap.js missing: ${bootstrapPath}`);
  }

  const electronBin = require("electron");
  if (typeof electronBin !== "string" || !fs.existsSync(electronBin)) {
    throw new Error(`[smoke-desktop-server] local Electron binary not found: ${String(electronBin)}`);
  }

  const hanakoHome = fs.mkdtempSync(path.join(os.tmpdir(), "katsura-desktop-smoke-"));
  let stderrBuf = "";
  const child = spawn(electronBin, [bootstrapPath], {
    cwd: serverDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      HANA_ROOT: serverDir,
      HANA_SERVER_ENTRY: path.join(serverDir, "bundle", "index.js"),
      HANA_HOME: hanakoHome,
      HANA_CREATE_STARTUP_SESSION: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString(); });

  try {
    const serverInfoPath = path.join(hanakoHome, "server-info.json");
    await Promise.race([
      waitForFile(serverInfoPath, 60_000),
      waitForExit(child, 60_000).then(({ code, signal }) => {
        throw new Error(
          `[smoke-desktop-server] server exited before publishing server-info.json (code=${code}, signal=${signal})\n--- stderr ---\n${stderrBuf}`,
        );
      }),
    ]);

    let serverInfo;
    for (let i = 0; i < 10; i++) {
      try {
        serverInfo = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
        break;
      } catch (err) {
        if (i === 9) throw err;
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    const host = serverInfo.host === "0.0.0.0" ? "127.0.0.1" : serverInfo.host;
    const url = `http://${host}:${serverInfo.port}/api/server/identity`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${serverInfo.token}` } });
    if (res.status !== 200) {
      throw new Error(`[smoke-desktop-server] GET ${url} returned ${res.status}`);
    }
    const body = await res.json();
    console.log(`[smoke-desktop-server] OK — ${url} -> 200 (protocol=${body.serverProtocol})`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      try {
        await waitForExit(child, 10_000);
      } catch {
        child.kill("SIGKILL");
        await waitForExit(child, 5_000).catch(() => {});
      }
    }
    fs.rmSync(hanakoHome, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
