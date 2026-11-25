/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFeishuAdapter } from "./feishu-adapter.ts";
import { maskSecretValue } from "../../shared/secret-custody.ts";

const DEFAULT_FEISHU_REGION = "feishu_cn";
const FEISHU_DOMAIN_BY_REGION: Record<string, string> = Object.freeze({
  feishu_cn: "https://open.feishu.cn",
  lark_global: "https://open.larksuite.com",
});

function resolveFeishuDomain(region: any = DEFAULT_FEISHU_REGION) {
  const value = typeof region === "string" ? region.trim() : region;
  const normalized = !value ? DEFAULT_FEISHU_REGION : value;
  if (normalized !== "feishu_cn" && normalized !== "lark_global") {
    throw new Error(`unsupported Feishu region: ${normalized}`);
  }
  const domain = FEISHU_DOMAIN_BY_REGION[normalized];
  return {
    region: normalized,
    domain,
    tenantTokenUrl: `${domain}/open-apis/auth/v3/tenant_access_token/internal`,
  };
}

export const feishuBridgeProvider = {
  id: "feishu",
  displayName: "飞书 / Lark",
  description: "飞书开放平台 WebSocket 长连接",
  connectionMode: "long_connection" as const,
  connectsAsync: true,
  sessionPrefixes: [
    { prefix: "fs_dm_", chatType: "dm" as const },
    { prefix: "fs_group_", chatType: "group" as const },
  ],
  configSchema: [
    {
      key: "region",
      label: "区域",
      type: "select" as const,
      default: "feishu_cn",
      options: [
        { value: "feishu_cn", label: "飞书中国 (open.feishu.cn)" },
        { value: "lark_global", label: "Lark 国际 (open.larksuite.com)" },
      ],
    },
    {
      key: "appId",
      label: "App ID",
      type: "string" as const,
      required: true,
      placeholder: "cli_xxxxxxxx",
    },
    {
      key: "appSecret",
      label: "App Secret",
      type: "secret" as const,
      required: true,
      placeholder: "飞书应用 App Secret",
    },
  ],
  getCredentials(cfg: Record<string, any>) {
    return cfg?.enabled && cfg?.appId && cfg?.appSecret
      ? { appId: cfg.appId, appSecret: cfg.appSecret, region: cfg.region || DEFAULT_FEISHU_REGION }
      : null;
  },
  ownerSessionKey(userId: string, agentId: string) {
    return `fs_dm_${userId}@${agentId}`;
  },
  normalizeConfig(incoming: Record<string, any>, existing: Record<string, any> = {}) {
    const merged: Record<string, any> = { ...existing, ...incoming };
    merged.region = resolveFeishuDomain(merged.region).region;
    return merged;
  },
  extractStatusMeta(cfg: Record<string, any> = {}) {
    const appId = cfg?.appId || "";
    const appSecret = cfg?.appSecret || "";
    let domainInfo: any;
    try {
      domainInfo = { ...resolveFeishuDomain(cfg?.region), configError: null };
    } catch (err: any) {
      domainInfo = {
        region: cfg?.region || DEFAULT_FEISHU_REGION,
        domain: null,
        configError: err?.message || String(err),
      };
    }
    return {
      configured: !!(appId && appSecret && !domainInfo.configError),
      appId,
      appSecret: maskSecretValue(appSecret),
      hasAppSecret: !!appSecret,
      region: domainInfo.region,
      domain: domainInfo.domain,
      configError: domainInfo.configError,
    };
  },
  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any, agentId: string | null) {
    return createFeishuAdapter({
      appId: creds.appId,
      appSecret: creds.appSecret,
      region: creds.region,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    });
  },
  async testConnection(config: Record<string, any>) {
    const domainInfo = resolveFeishuDomain(config?.region);
    const resp = await fetch(domainInfo.tenantTokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: config?.appId,
        app_secret: config?.appSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await resp.json();
    if (data?.code === 0) {
      return {
        ok: true,
        message: "Token 验证成功",
        details: { region: domainInfo.region, domain: domainInfo.domain },
      };
    }
    return {
      ok: false,
      error: data?.msg || "Feishu verification failed",
      details: { region: domainInfo.region, code: data?.code },
    };
  },
};

export default class BridgeFeishuPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-feishu plugin loaded without event bus");
      return;
    }
    const result = await bus.request("bridge:register-provider", { provider: feishuBridgeProvider });
    if (result?.ok === false) {
      throw new Error(result.error || "failed to register bridge-feishu provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: feishuBridgeProvider.id }).catch(() => {});
    });
  }
}
