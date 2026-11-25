/* eslint-disable @typescript-eslint/no-explicit-any */
import { createQQAdapter } from "./qq-adapter.ts";
import { maskSecretValue, isMaskedSecretValue } from "../../shared/secret-custody.ts";

function preferredSecret(cfg: Record<string, any> = {}): string {
  if (typeof cfg.appSecret === "string" && cfg.appSecret.trim()) return cfg.appSecret.trim();
  if (typeof cfg.token === "string" && cfg.token.trim()) return cfg.token.trim();
  return "";
}

export const qqBridgeProvider = {
  id: "qq",
  displayName: "QQ",
  description: "QQ 开放平台 v2 机器人（WebSocket 长连接，支持频道与私信）",
  connectionMode: "websocket" as const,
  connectsAsync: false,
  sessionPrefixes: [
    { prefix: "qq_dm_", chatType: "dm" as const },
    { prefix: "qq_group_", chatType: "group" as const },
  ],
  configSchema: [
    {
      key: "appID",
      label: "AppID",
      type: "string" as const,
      required: true,
      placeholder: "QQ 机器人 AppID",
    },
    {
      key: "appSecret",
      label: "AppSecret",
      type: "secret" as const,
      required: true,
      placeholder: "QQ 机器人 AppSecret",
      legacyKeys: ["token"],
    },
  ],
  getCredentials(cfg: Record<string, any>) {
    const secret = preferredSecret(cfg);
    return cfg?.enabled && cfg?.appID && secret
      ? { appID: cfg.appID, appSecret: secret, dmGuildMap: cfg.dmGuildMap }
      : null;
  },
  ownerSessionKey(userId: string, agentId: string) {
    return `qq_dm_${userId}@${agentId}`;
  },
  normalizeConfig(incoming: Record<string, any>, existing: Record<string, any> = {}) {
    const next: Record<string, any> = { ...existing, ...incoming };
    if (typeof incoming.appSecret === "string") {
      if (isMaskedSecretValue(incoming.appSecret)) {
        next.appSecret = preferredSecret(existing);
      } else {
        next.appSecret = incoming.appSecret.trim();
      }
    } else if (typeof incoming.token === "string") {
      next.appSecret = isMaskedSecretValue(incoming.token) ? preferredSecret(existing) : incoming.token.trim();
    }
    delete next.token;
    return next;
  },
  extractStatusMeta(cfg: Record<string, any> = {}) {
    const secret = preferredSecret(cfg);
    return {
      configured: !!(cfg?.appID && secret),
      appID: cfg?.appID || "",
      appSecret: maskSecretValue(secret),
      hasAppSecret: !!secret,
    };
  },
  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any, agentId: string | null) {
    return createQQAdapter({
      appID: creds.appID,
      appSecret: creds.appSecret,
      agentId,
      onMessage,
      dmGuildMap: creds.dmGuildMap,
      onDmGuildDiscovered: hooks?.onQqDmGuild,
      onStatus: hooks?.onStatus,
    });
  },
  async testConnection(config: Record<string, any>) {
    const appID = String(config?.appID || "").trim();
    const appSecret = preferredSecret(config);
    if (!appID || !appSecret) {
      return { ok: false, error: "AppID and AppSecret are required" };
    }
    const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: appID, clientSecret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const tokenData: any = await tokenRes.json();
    if (!tokenData?.access_token) {
      return { ok: false, error: tokenData?.message || "Failed to fetch QQ access token" };
    }
    const meRes = await fetch("https://api.sgroup.qq.com/users/@me", {
      headers: { Authorization: `QQBot ${tokenData.access_token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const me: any = await meRes.json();
    if (me?.id) {
      return { ok: true, botName: me.username, details: { username: me.username, name: me.username } };
    }
    return { ok: false, error: me?.message || "Failed to verify QQ bot info" };
  },
};

export default class BridgeQQPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-qq plugin loaded without event bus");
      return;
    }
    const result = await bus.request("bridge:register-provider", { provider: qqBridgeProvider });
    if (result?.ok === false) {
      throw new Error(result.error || "failed to register bridge-qq provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: qqBridgeProvider.id }).catch(() => {});
    });
  }
}
