/* eslint-disable @typescript-eslint/no-explicit-any */
import { createTelegramAdapter } from "./telegram-adapter.ts";
import { telegramBotOptions } from "../../lib/net/outbound-proxy.ts";
import { maskSecretValue } from "../../shared/secret-custody.ts";

export const telegramBridgeProvider = {
  id: "telegram",
  displayName: "Telegram",
  description: "Telegram Bot API（长轮询）",
  connectionMode: "long_polling" as const,
  connectsAsync: false,
  sessionPrefixes: [
    { prefix: "tg_dm_", chatType: "dm" as const },
    { prefix: "tg_group_", chatType: "group" as const },
  ],
  configSchema: [
    {
      key: "token",
      label: "Bot Token",
      type: "secret" as const,
      required: true,
      placeholder: "从 @BotFather 获取的 Token",
    },
  ],
  getCredentials(cfg: Record<string, any>) {
    return cfg?.enabled && cfg?.token ? { token: cfg.token } : null;
  },
  ownerSessionKey(userId: string, agentId: string) {
    return `tg_dm_${userId}@${agentId}`;
  },
  extractStatusMeta(cfg: Record<string, any> = {}) {
    const token = cfg?.token || "";
    return {
      configured: !!token,
      token: maskSecretValue(token),
      hasToken: !!token,
    };
  },
  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any, agentId: string | null) {
    return createTelegramAdapter({
      token: creds.token,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    });
  },
  async testConnection(config: Record<string, any>) {
    const token = String(config?.token || "").trim();
    if (!token) return { ok: false, error: "Bot Token is required" };
    const TelegramBot = (await import("node-telegram-bot-api")).default;
    const bot = new TelegramBot(token, telegramBotOptions());
    const me = await bot.getMe();
    return {
      ok: true,
      botName: me.username || me.first_name,
      details: { username: me.username, name: me.first_name },
    };
  },
};

export default class BridgeTelegramPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-telegram plugin loaded without event bus");
      return;
    }
    const result = await bus.request("bridge:register-provider", { provider: telegramBridgeProvider });
    if (result?.ok === false) {
      throw new Error(result.error || "failed to register bridge-telegram provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: telegramBridgeProvider.id }).catch(() => {});
    });
  }
}
