# Changelog

All notable changes to **OpenKatsura** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Server Runtime Unified on Electron Bundled Node.js** ([#1](https://github.com/hsz1273327/openkatsura/issues/1)):
  - Switched both dev and packaged server launches in `desktop/main.cjs` to `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, ensuring background server lifecycle strictly follows the desktop app.
  - Upgraded `better-sqlite3` from `12.6.2` to `13.2.0` and added `@electron/rebuild` (`rebuild:electron` / `postinstall`) for Electron 42 (Node 24.15.0 / ABI 146) native addon compatibility.
  - Updated `npm test` and server smoke scripts to execute under Electron's bundled Node.js runtime via `scripts/run-with-electron-node.mjs`.
  - Updated `scripts/build-server*.mjs` to stop downloading/bundling a standalone Node.js binary, reducing `dist-server` size from `272MB` to `169MB` (-37.9%).
  - Added `scripts/smoke-desktop-server.mjs` and hardened `lib/sandbox/win32-exec.ts` so desktop GUI executables are never exposed as plain `node` binaries to user commands.
  - Added `OpenKatsura.exe` process detection/cleanup in `build/installer.nsh`.

### Removed
- Removed legacy headless Windows standalone server packaging (`pack:server:standalone` / `verify:standalone:server`) and standalone wrapper generation (`hana-server` / `hana-server.exe`) from build and CI/release workflows.

## [1.0.0] - 2026-11-26

### Added
- Initial **OpenKatsura** fork baseline from HanaAgent / openhanako:
  - Isolated data directories (`~/.katsura` / `~/.katsura-dev`) and single-instance `userData` (`Katsura`).
  - Upgraded Pi SDK (`@earendil-works/pi-{agent-core,ai,coding-agent}`) to `1.6.0`.
  - Rebranded icons/silhouettes, added `katsura` default Yuan & bilingual persona templates, and Apache-2.0 `NOTICE` / `THIRD_PARTY_NOTICES.md`.
  - Unified Bridge plugin runtime (`defineBridgeProvider`) in `@hana/plugin-runtime` and externalized IM bridges and optional built-in plugins.
  - Added Judge/Classifier multi-source discovery & REST/EventBus APIs and opt-in incremental compaction (`session.incremental_compaction`).
