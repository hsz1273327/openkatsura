# OpenKatsura Bridge Plugin Authoring Guide / 社交平台（Bridge）插件开发指南

OpenKatsura's Bridge layer is **100% plugin-driven**: the core app contains zero hardcoded IM platforms. Any chat platform (QQ, WeChat, Telegram, Feishu, DingTalk, Synology Chat, Discord, Slack, Matrix, etc.) can be added as an independent plugin without modifying a single line of OpenKatsura core.

OpenKatsura 的社交平台（Bridge）层已实现 **100% 插件驱动**，主干不包含任何硬编码平台。无论你要接入 QQ、微信、飞书，还是**群晖 Chat（Synology Chat）**、Discord、Slack，都只需编写一个独立插件，无需修改 OpenKatsura 主干代码。

---

## 1. Architecture / 架构原则

- **Core owns UI & Security / 主干负责通用 UI 与安全边界**：
  - Settings UI (`BridgeTab`) dynamically renders configuration forms from your plugin's `configSchema` (`string`, `secret`, `select`), manages masked secret custody, test-connection buttons, and Owner selection.
  - Core `BridgeManager` & `BridgeSessionManager` manage session binding, Owner vs. non-Owner permission isolation, and message routing.
- **Plugin owns Protocol / 插件只负责协议适配**：
  - Declare `configSchema`, `sessionPrefixes`, `createAdapter`, and `testConnection`.
  - Register via `ctx.bus.request("bridge:register-provider", { provider })` in `onload()`.
- **Runtime Constraint / 运行时约束（Electron 42 自带 Node）**：
  - OpenKatsura runs its server inside Electron 42's bundled Node.js (Node 24).
  - Plugins should be **pure JS/ESM** (or WASM / N-API) and bundled into a single `index.js` with `esbuild` so users need **zero `npm install`** at install time.

---

## 2. Minimal Directory Layout / 标准插件目录结构

```text
katsura-bridge-synology-chat/
├── manifest.json          # Plugin manifest / 插件清单
├── package.json
├── scripts/
│   └── build.mjs          # esbuild single-file ESM bundle → dist/index.js
├── src/
│   └── index.ts           # Provider definition + BridgePlugin lifecycle
└── dist/                  # Installable output (copy to ~/.katsura/plugins/<id>/)
    ├── manifest.json
    └── index.js
```

### `manifest.json`

```json
{
  "id": "bridge-synology-chat",
  "name": "群晖 Chat",
  "version": "1.0.0",
  "description": "Connect Synology Chat via Incoming/Outgoing Webhooks.",
  "trust": "full-access",
  "activationEvents": ["onStartup"]
}
```

> **Note**: Bridge plugins require `"trust": "full-access"` and `"activationEvents": ["onStartup"]` so they register their provider as soon as OpenKatsura starts.

---

## 3. Complete Example: Synology Chat Plugin / 完整示例（以群晖 Chat 为例）

### `src/index.ts`

```ts
/* eslint-disable @typescript-eslint/no-explicit-any */

const MASKED_SECRET = "********";
const isMasked = (v: unknown) => typeof v === "string" && v.trim() === MASKED_SECRET;
const maskSecret = (v: unknown) => (typeof v === "string" && v.length > 0 ? MASKED_SECRET : "");

/**
 * Minimal adapter implementing HanaBridgeAdapter:
 * - start(): connect / start polling or webhook listener
 * - stop(): clean up timers & connections
 * - sendReply(chatId, text, replyContext?): send outbound message
 */
function createSynologyChatAdapter(opts: {
  incomingUrl: string;
  botToken: string;
  onMessage: (msg: any) => void;
  onStatus?: (status: string, error?: string) => void;
}) {
  let stopped = false;

  return {
    async start() {
      stopped = false;
      opts.onStatus?.("connected");
      // Start your platform listener / polling loop here and call:
      // opts.onMessage({
      //   platform: "synology-chat",
      //   chatId: "<channel_or_user_id>",
      //   userId: "<sender_id>",
      //   sender: "<display_name>",
      //   isGroup: false,
      //   text: "<message_text>",
      // });
    },

    stop() {
      stopped = true;
      opts.onStatus?.("disconnected");
    },

    async sendReply(_chatId: string, text: string) {
      if (stopped) return;
      const body = new URLSearchParams({
        payload: JSON.stringify({ text }),
      });
      const res = await fetch(opts.incomingUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`Synology Chat webhook returned ${res.status}`);
      }
    },
  };
}

export const synologyChatProvider = {
  id: "synology-chat",
  displayName: "群晖 Chat",
  description: "通过 Synology Chat Incoming/Outgoing Webhook 接入私聊与频道。",
  connectionMode: "webhook" as const,
  connectsAsync: false,

  // Session key prefixes registered dynamically into core session-key parser
  sessionPrefixes: [
    { prefix: "syno_dm_", chatType: "dm" as const },
    { prefix: "syno_group_", chatType: "group" as const },
  ],

  // Drives Settings → Social Platforms form automatically!
  configSchema: [
    {
      key: "incomingUrl",
      label: "Incoming Webhook URL",
      type: "string" as const,
      required: true,
      placeholder: "https://nas.local:5001/webapi/entry.cgi?...",
    },
    {
      key: "botToken",
      label: "Outgoing Token",
      type: "secret" as const,
      required: true,
      placeholder: "Synology Chat Outgoing Token",
    },
  ],

  getCredentials(cfg: Record<string, any>) {
    return cfg?.enabled && cfg?.incomingUrl && cfg?.botToken
      ? { incomingUrl: cfg.incomingUrl, botToken: cfg.botToken }
      : null;
  },

  ownerSessionKey(userId: string, agentId: string) {
    return `syno_dm_${userId}@${agentId}`;
  },

  normalizeConfig(incoming: Record<string, any>, existing: Record<string, any> = {}) {
    const next = { ...existing, ...incoming };
    if (typeof incoming.botToken === "string") {
      next.botToken = isMasked(incoming.botToken)
        ? (existing.botToken || "")
        : incoming.botToken.trim();
    }
    return next;
  },

  extractStatusMeta(cfg: Record<string, any> = {}) {
    const token = typeof cfg.botToken === "string" ? cfg.botToken : "";
    return {
      configured: !!(cfg.incomingUrl && token),
      incomingUrl: cfg.incomingUrl || "",
      botToken: maskSecret(token),
      hasBotToken: !!token,
    };
  },

  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any) {
    return createSynologyChatAdapter({
      incomingUrl: creds.incomingUrl,
      botToken: creds.botToken,
      onMessage,
      onStatus: hooks?.onStatus,
    });
  },

  async testConnection(config: Record<string, any>) {
    const url = String(config?.incomingUrl || "").trim();
    const token = String(config?.botToken || "").trim();
    if (!url || !token) {
      return { ok: false, error: "Incoming URL and Outgoing Token are required" };
    }
    try {
      new URL(url);
      return { ok: true, botName: "Synology Chat" };
    } catch {
      return { ok: false, error: "Invalid Incoming Webhook URL" };
    }
  },
};

export default class BridgeSynologyChatPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-synology-chat loaded without event bus");
      return;
    }
    const res = await bus.request("bridge:register-provider", {
      provider: synologyChatProvider,
    });
    if (res?.ok === false) {
      throw new Error(res.error || "failed to register synology-chat provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: synologyChatProvider.id }).catch(() => {});
    });
  }
}
```

---

## 4. Bundling & Installing / 打包与安装

### `scripts/build.mjs`

```js
import fs from "node:fs";
import path from "node:path";
import * as esbuild from "esbuild";

fs.rmSync("dist", { recursive: true, force: true });
fs.mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
});

fs.copyFileSync("manifest.json", "dist/manifest.json");
```

### Install & Enable / 安装与启用

1. Copy `dist/` to:
   - Development: `~/.katsura-dev/plugins/<plugin-id>/`
   - Production: `~/.katsura/plugins/<plugin-id>/`
2. Restart OpenKatsura.
3. Open **Settings → Plugins (设置 → 插件)** and enable **Allow full-access community plugins (允许完全访问权限插件)**.
4. Open **Settings → Social Platforms (设置 → 社交平台)** — your plugin's configuration card will automatically appear from its `configSchema`!

---

## 5. Reference Implementation / 官方参考实现

See the standalone QQ Bot bridge plugin repository for a complete production-ready template with WebSocket reconnects, chunked media uploads, Vitest unit tests, and GitHub Actions CI:
- [`hsz1273327/katsra-bridge-qq`](https://github.com/hsz1273327/katsra-bridge-qq)
