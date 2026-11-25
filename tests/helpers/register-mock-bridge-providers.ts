import { bridgeProviderRegistry } from "../../lib/bridge/bridge-provider-registry.ts";

const MASK = "********";

/**
 * Registers lightweight mock bridge platform providers for unit tests that
 * exercise BridgeManager / createBridgeRoute with legacy platform IDs now that
 * concrete IM platform plugins are externalized from the core repository.
 */
export function registerMockBridgeProviders(
  overrides: Partial<Record<string, (cfg: any, host: any) => any>> = {},
): () => void {
  const ids: string[] = [];

  const register = (def: any) => {
    bridgeProviderRegistry.register(
      {
        ...def,
        extractStatusMeta: def.extractStatusMeta || ((cfg: any) => ({
          configured: Boolean(def.isConfigured?.(cfg)),
          ...(def.sanitizeForStatus ? def.sanitizeForStatus(cfg) : {}),
        })),
      },
      { owner: `test-mock-${def.id}` },
    );
    ids.push(def.id);
  };

  register({
    id: "telegram",
    displayName: "Telegram",
    sessionPrefixes: ["tg_dm_", "tg_grp_"],
    secretFields: ["token"],
    configSchema: [{ key: "token", label: "Bot Token", type: "secret", required: true }],
    getCredentials: (cfg: any) => (cfg?.token ? { token: cfg.token } : null),
    ownerSessionKey: (ownerId: string, agentId: string) => `tg_dm_${ownerId}@${agentId}`,
    isConfigured: (cfg: any) => Boolean(cfg?.token),
    sanitizeForStatus: (cfg: any) => ({
      token: cfg?.token ? MASK : "",
      hasToken: Boolean(cfg?.token),
    }),
    createAdapter: (cfg: any, host: any) =>
      overrides.telegram ? overrides.telegram(cfg, host) : { stop: () => {} },
  });

  register({
    id: "feishu",
    displayName: "Feishu",
    sessionPrefixes: ["fs_dm_", "fs_grp_"],
    secretFields: ["appSecret"],
    configSchema: [
      { key: "appId", label: "App ID", type: "text", required: true },
      { key: "appSecret", label: "App Secret", type: "secret", required: true },
    ],
    getCredentials: (cfg: any) => (cfg?.appId && cfg?.appSecret ? { appId: cfg.appId, appSecret: cfg.appSecret } : null),
    ownerSessionKey: (ownerId: string, agentId: string) => `fs_dm_${ownerId}@${agentId}`,
    isConfigured: (cfg: any) => Boolean(cfg?.appId && cfg?.appSecret),
    sanitizeForStatus: (cfg: any) => ({
      appId: cfg?.appId || "",
      appSecret: cfg?.appSecret ? MASK : "",
      hasAppSecret: Boolean(cfg?.appSecret),
      region: cfg?.region || "feishu_cn",
      domain: cfg?.domain || "https://open.feishu.cn",
    }),
    createAdapter: (cfg: any, host: any) =>
      overrides.feishu ? overrides.feishu(cfg, host) : { stop: () => {} },
  });

  register({
    id: "dingtalk",
    displayName: "DingTalk",
    sessionPrefixes: ["dt_dm_", "dt_grp_"],
    secretFields: ["clientSecret", "appSecret"],
    configSchema: [
      { key: "corpId", label: "Corp ID", type: "text" },
      { key: "clientId", label: "Client ID", type: "text", required: true },
      { key: "clientSecret", label: "Client Secret", type: "secret", required: true },
      { key: "robotCode", label: "Robot Code", type: "text" },
    ],
    getCredentials: (cfg: any) => {
      if (cfg?.enabled && cfg?.corpId && !cfg?.robotCode) {
        return { error: "enterprise robotCode is required" };
      }
      if (cfg?.enabled && !cfg?.corpId && cfg?.authMode !== "legacy_app") {
        return { error: "corpId is required" };
      }
      const clientId = cfg?.clientId || cfg?.appKey;
      const clientSecret = cfg?.clientSecret || cfg?.appSecret;
      if (!clientId || !clientSecret) return null;
      return { corpId: cfg?.corpId || "", clientId, clientSecret, robotCode: cfg?.robotCode || "" };
    },
    ownerSessionKey: (ownerId: string, agentId: string) => `dt_dm_${ownerId}@${agentId}`,
    isConfigured: (cfg: any) => Boolean((cfg?.clientId || cfg?.appKey) && (cfg?.clientSecret || cfg?.appSecret)),
    sanitizeForStatus: (cfg: any) => {
      const apiBase = (cfg?.apiBaseUrl || cfg?.restBaseUrl || "https://api.dingtalk.com/v1.0")
        .replace("api.dingtalk.io", "api.dingtalk.com");
      return {
        corpId: cfg?.corpId || "",
        clientId: cfg?.clientId || cfg?.appKey || "",
        clientSecret: (cfg?.clientSecret || cfg?.appSecret) ? MASK : "",
        hasClientSecret: Boolean(cfg?.clientSecret || cfg?.appSecret),
        robotCode: cfg?.robotCode || "",
        apiBaseUrl: apiBase,
        restBaseUrl: apiBase,
      };
    },
    createAdapter: (cfg: any, host: any) =>
      overrides.dingtalk ? overrides.dingtalk(cfg, host) : { stop: () => {} },
  });

  register({
    id: "qq",
    displayName: "QQ",
    sessionPrefixes: ["qq_dm_", "qq_grp_"],
    secretFields: ["appSecret"],
    configSchema: [
      { key: "appID", label: "App ID", type: "text", required: true },
      { key: "appSecret", label: "App Secret", type: "secret", required: true },
    ],
    getCredentials: (cfg: any) => (cfg?.appID && cfg?.appSecret ? { appID: cfg.appID, appSecret: cfg.appSecret } : null),
    ownerSessionKey: (ownerId: string, agentId: string) => `qq_dm_${ownerId}@${agentId}`,
    isConfigured: (cfg: any) => Boolean(cfg?.appID && cfg?.appSecret),
    sanitizeForStatus: (cfg: any) => ({
      appID: cfg?.appID || "",
      appSecret: cfg?.appSecret ? MASK : "",
      hasAppSecret: Boolean(cfg?.appSecret),
    }),
    createAdapter: (cfg: any, host: any) =>
      overrides.qq ? overrides.qq(cfg, host) : { stop: () => {} },
  });

  register({
    id: "wechat",
    displayName: "WeChat",
    initialStatus: "connecting",
    sessionPrefixes: ["wx_dm_", "wx_grp_"],
    secretFields: ["botToken", "token"],
    configSchema: [{ key: "botToken", label: "Bot Token", type: "secret", required: true }],
    getCredentials: (cfg: any) => ((cfg?.botToken || cfg?.token) ? { botToken: cfg?.botToken || cfg?.token } : null),
    ownerSessionKey: (ownerId: string, agentId: string) => `wx_dm_${ownerId}@${agentId}`,
    isConfigured: (cfg: any) => Boolean(cfg?.botToken || cfg?.token),
    sanitizeForStatus: (cfg: any) => ({
      token: (cfg?.botToken || cfg?.token) ? MASK : "",
      hasBotToken: Boolean(cfg?.botToken || cfg?.token),
    }),
    createAdapter: (cfg: any, host: any) =>
      overrides.wechat ? overrides.wechat(cfg, host) : { stop: () => {} },
  });

  return () => {
    for (const id of ids) {
      try { bridgeProviderRegistry.unregister(id); } catch { /* ignore */ }
    }
  };
}
