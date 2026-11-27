# Changelog / 更新日志

All notable changes to **OpenKatsura** are documented in this file.  
本文档记录 **OpenKatsura** 的所有重要变更。

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - Unreleased

### Added / 新增
- **OpenKatsura Fork Baseline / OpenKatsura 独立分支基线**：
  - Isolated data directories (`~/.katsura` / `~/.katsura-dev`) and single-instance `userData` (`Katsura`). / 默认数据目录与单实例隔离切换至 `~/.katsura` / `~/.katsura-dev` 与 `Katsura`。
  - Rebranded app icons, tray icons, and 1:1 silhouette assets; added the default `katsura` Yuan with bilingual persona templates, plus Apache-2.0 `NOTICE` and `THIRD_PARTY_NOTICES.md`. / 完成品牌图标、托盘图标与剪影重塑；新增默认 `katsura` 元及中英双语人设模板，并补齐 Apache-2.0 合规文档。
  - Unified Bridge plugin runtime (`defineBridgeProvider`) in `@hana/plugin-runtime`, fully registry-driven `BridgeManager` / `/api/bridge/*` / `BridgeTab.tsx`. / 在 `@hana/plugin-runtime` 统一扩展 Bridge 插件契约，核心管理层、路由与设置页 100% 注册表驱动。
  - Added Judge / Classifier multi-source discovery, EventBus & REST APIs (`/api/judge/*`), and opt-in per-turn incremental compaction (`session.incremental_compaction`). / 新增 Judge/Classifier 多路发现及 EventBus/REST 接口，新增默认关闭的每轮增量压缩开关。
  - Added `scripts/run-with-electron-node.mjs` and `scripts/smoke-desktop-server.mjs` for unified Electron Node testing and desktop server smoke verification ([#1](https://github.com/hsz1273327/openkatsura/issues/1)). / 新增 `scripts/run-with-electron-node.mjs` 与 `scripts/smoke-desktop-server.mjs`，统一在 Electron 内置 Node 下执行测试与桌面服务端冒烟验证（[#1](https://github.com/hsz1273327/openkatsura/issues/1)）。

### Changed / 变更
- **Pi SDK Upgrade / Pi SDK 升级**：
  - Upgraded `@earendil-works/pi-{agent-core,ai,coding-agent}` from `0.80.3` to `1.6.0`. / 将 Pi SDK 全套依赖从 `0.80.3` 升级至 `1.6.0`。
- **Server Runtime Unified on Electron Bundled Node.js / Server 运行时全面切换为 Electron 自带 Node.js** ([#1](https://github.com/hsz1273327/openkatsura/issues/1))：
  - Switched both dev and packaged server launches in `desktop/main.cjs` to `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, so background server lifecycle strictly follows the desktop app. / 开发与打包模式均改由 `process.execPath` 配合 `ELECTRON_RUN_AS_NODE=1` 启动 Server，后台生命周期完全跟随桌面 App 启停。
  - Upgraded `better-sqlite3` from `12.6.2` to `13.2.0` and integrated `@electron/rebuild` (`rebuild:electron` / `postinstall`) for Electron 42 (Node 24.15.0 / ABI 146). / 将 `better-sqlite3` 升级至 `13.2.0` 并接入 `@electron/rebuild` 适配 Electron 42（Node 24.15.0 / ABI 146）。
  - Stopped downloading and bundling a standalone Node.js binary in `scripts/build-server*.mjs`, reducing `dist-server` size from `397MB` → `272MB` → `169MB` (-57.4% overall). / 移除 `build-server` 独立 Node.js 二进制打包，`dist-server` 体积由 `397MB` → `272MB` → `169MB`（累计瘦身 57.4%）。
  - Hardened `lib/sandbox/win32-exec.ts` so Electron desktop executables are never exposed as plain `node` runtimes to user commands, and added `OpenKatsura.exe` process cleanup in `build/installer.nsh`. / 加固 Windows 沙箱防止 Electron 桌面程序被误暴露为普通 `node`，并在 `build/installer.nsh` 补齐 `OpenKatsura.exe` 进程清理。
- **Plugin-Driven Bridge UI & Session Decoupling / 社交平台 UI 全面插件驱动与会话查询解耦** ([#3](https://github.com/hsz1273327/openkatsura/issues/3))：
  - Preserved registered `platforms` metadata in `useBridgeState.ts` and removed hardcoded fallback platform cards from `BridgeTab.tsx`; added generic `configSchema` rendering for any third-party Bridge plugin and empty-state guidance when no plugin is enabled. / 修复 `useBridgeState.ts` 丢失 `platforms` 字段问题，移除 `BridgeTab.tsx` 硬编码平台兜底，支持按任意第三方 Bridge 插件声明的 `configSchema` 动态渲染表单。
  - Updated `BridgePanel.tsx` to derive tabs dynamically from registered plugins and historical sessions, and simplified `SessionRegistryFilesPanel.tsx` to a single `/api/bridge/sessions` query instead of looping over 6 hardcoded platforms. / 将 `BridgePanel.tsx` 标签页改为按已启用插件与历史会话动态生成，并将 `SessionRegistryFilesPanel.tsx` 收敛为单次全量 Bridge 会话查询。
  - Unified new Bridge session storage directly under standard `agents/<agentId>/sessions/` with explicit channel-binding metadata (`platform`, `chatType`, `chatId`, `role`) while preserving backward-compatible resolution for legacy `sessions/bridge/{owner,guests}/` files; added [`docs/BRIDGE_PLUGIN_GUIDE.md`](./docs/BRIDGE_PLUGIN_GUIDE.md). / 将新建 Bridge 会话统一落盘至标准 `agents/<agentId>/sessions/` 目录并显式记录通道绑定元数据（向下兼容历史 `sessions/bridge/{owner,guests}/` 文件），同时新增插件开发指南 `docs/BRIDGE_PLUGIN_GUIDE.md`。

### Removed / 移除
- Externalized 5 IM bridge implementations and 4 optional built-in plugins (`beautify`, `jimeng-cli`, `media`, `office`) out of the core repository, and removed Mobile PWA / LAN device pairing. / 将 5 个 IM Bridge 平台与 4 个可选内置插件外置出主仓库，并移除 Mobile PWA 与局域网设备配对。
- Removed headless Windows standalone server packaging (`pack:server:standalone` / `verify:standalone:server`) and standalone wrapper scripts (`hana-server` / `hana-server.exe`) from build and CI/release workflows ([#1](https://github.com/hsz1273327/openkatsura/issues/1)). / 移除无头模式 Windows standalone server 打包、独立 wrapper 脚本及对应 CI/发版步骤（[#1](https://github.com/hsz1273327/openkatsura/issues/1)）。
