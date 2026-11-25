/* eslint-disable @typescript-eslint/no-explicit-any */
import crypto from "node:crypto";
import { createWechatAdapter } from "./wechat-adapter.ts";
import { getWechatQrcode, pollWechatQrcodeStatus } from "./wechat-login.ts";
import { maskSecretValue } from "../../shared/secret-custody.ts";

export const wechatBridgeProvider = {
  id: "wechat",
  displayName: "微信",
  description: "微信 iLink 协议（支持扫码登录与长连接）",
  connectionMode: "long_connection" as const,
  connectsAsync: true,
  sessionPrefixes: [
    { prefix: "wx_dm_", chatType: "dm" as const },
  ],
  configSchema: [
    {
      key: "botToken",
      label: "Bot Token",
      type: "secret" as const,
      required: true,
      placeholder: "通过扫码登录获取或手动填入",
    },
  ],
  getCredentials(cfg: Record<string, any>, host?: any) {
    return cfg?.enabled && cfg?.botToken
      ? { botToken: cfg.botToken, hanaHome: host?.hanakoHome || cfg._hanaHome || "" }
      : null;
  },
  ownerSessionKey(userId: string, agentId: string) {
    return `wx_dm_${userId}@${agentId}`;
  },
  extractStatusMeta(cfg: Record<string, any> = {}) {
    const token = cfg?.botToken || "";
    return {
      configured: !!token,
      token: maskSecretValue(token),
      hasBotToken: !!token,
    };
  },
  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any, agentId: string | null, host?: any) {
    return createWechatAdapter({
      botToken: creds.botToken,
      hanaHome: creds.hanaHome || host?.hanakoHome || "",
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    });
  },
  async testConnection(config: Record<string, any>) {
    const botToken = String(config?.botToken || "").trim();
    if (!botToken) return { ok: false, error: "Bot Token is required" };
    const uin = Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64");
    const res = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/getconfig", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "AuthorizationType": "ilink_bot_token",
        "Authorization": `Bearer ${botToken}`,
        "X-WECHAT-UIN": uin,
      },
      body: JSON.stringify({ base_info: { channel_version: "1.0.0" } }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await res.json();
    if (data?.ret && data.ret !== 0) {
      return { ok: false, error: data.errmsg || `errcode ${data.ret}` };
    }
    return { ok: true, message: "微信 iLink 连接成功" };
  },
  actions: {
    qrcode: async () => getWechatQrcode(),
    qrcodeStatus: async (payload: Record<string, any>) => pollWechatQrcodeStatus(payload?.qrcodeId),
  },
};

export default class BridgeWechatPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-wechat plugin loaded without event bus");
      return;
    }
    const result = await bus.request("bridge:register-provider", { provider: wechatBridgeProvider });
    if (result?.ok === false) {
      throw new Error(result.error || "failed to register bridge-wechat provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: wechatBridgeProvider.id }).catch(() => {});
    });
  }
}
