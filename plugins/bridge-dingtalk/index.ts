/* eslint-disable @typescript-eslint/no-explicit-any */
import { createDingTalkAdapter } from "./dingtalk-adapter.ts";
import {
  DINGTALK_API_BASE_URL,
  assertNoUnsupportedDingTalkRobotFields,
  canonicalizeDingTalkBridgeConfig,
  normalizeDingTalkBridgeCredentials,
} from "./dingtalk-contract.ts";
import { DingTalkApiError, dingtalkErrorInfo, requestDingTalkAccessToken } from "./dingtalk-api.ts";
import { createBridgeOutboundHttp } from "../../lib/bridge/outbound-http.ts";
import { maskSecretValue, isMaskedSecretValue } from "../../shared/secret-custody.ts";

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

export const dingtalkBridgeProvider = {
  id: "dingtalk",
  displayName: "钉钉",
  description: "钉钉企业应用机器人 Stream 长连接",
  connectionMode: "long_connection" as const,
  connectsAsync: true,
  sessionPrefixes: [
    { prefix: "dt_dm_", chatType: "dm" as const },
    { prefix: "dt_group_", chatType: "group" as const },
  ],
  configSchema: [
    {
      key: "authMode",
      label: "鉴权模式",
      type: "select" as const,
      default: "current",
      options: [
        { value: "current", label: "新版应用凭证 (ClientId / ClientSecret)" },
        { value: "legacy_app", label: "旧版应用凭证 (AppKey / AppSecret)" },
      ],
    },
    {
      key: "corpId",
      label: "CorpId",
      type: "string" as const,
      placeholder: "企业 CorpId（可选）",
    },
    {
      key: "clientId",
      label: "Client ID / AppKey",
      type: "string" as const,
      required: true,
      placeholder: "钉钉应用 Client ID",
      legacyKeys: ["appKey"],
    },
    {
      key: "clientSecret",
      label: "Client Secret / AppSecret",
      type: "secret" as const,
      required: true,
      placeholder: "钉钉应用 Client Secret",
      legacyKeys: ["appSecret"],
    },
    {
      key: "robotCode",
      label: "Robot Code",
      type: "string" as const,
      placeholder: "机器人编码（可选）",
    },
  ],
  getCredentials(cfg: Record<string, any>) {
    return cfg?.enabled ? normalizeDingTalkBridgeCredentials(cfg) : null;
  },
  ownerSessionKey(userId: string, agentId: string) {
    return `dt_dm_${userId}@${agentId}`;
  },
  normalizeConfig(incoming: Record<string, any>, existing: Record<string, any> = {}) {
    const merged: Record<string, any> = { ...existing, ...incoming };
    const existingSecret = clean(existing.clientSecret || existing.appSecret);
    const incomingSecret = incoming.clientSecret ?? incoming.appSecret;
    if (typeof incomingSecret === "string") {
      merged.clientSecret = isMaskedSecretValue(incomingSecret) ? existingSecret : incomingSecret.trim();
    }
    delete merged.appSecret;
    assertNoUnsupportedDingTalkRobotFields(merged);
    const canonical = canonicalizeDingTalkBridgeConfig(merged);
    if (canonical.enabled) normalizeDingTalkBridgeCredentials(canonical);
    return canonical;
  },
  extractStatusMeta(cfg: Record<string, any> = {}) {
    let authMode = cfg?.authMode === "legacy_app" ? "legacy_app" : "current";
    let corpId = clean(cfg?.corpId);
    let clientId = clean(cfg?.clientId || cfg?.appKey);
    let clientSecret = clean(cfg?.clientSecret || cfg?.appSecret);
    let robotCode = clean(cfg?.robotCode);
    let apiBaseUrl = clean(cfg?.apiBaseUrl || cfg?.restBaseUrl || DINGTALK_API_BASE_URL);
    let configured = false;
    let configError: string | null = null;
    if (cfg?.enabled || clientId || clientSecret || corpId) {
      try {
        const normalized = normalizeDingTalkBridgeCredentials(cfg);
        corpId = normalized.corpId;
        authMode = normalized.authMode;
        clientId = normalized.clientId;
        clientSecret = normalized.clientSecret;
        robotCode = normalized.robotCode;
        apiBaseUrl = normalized.apiBaseUrl;
        configured = true;
      } catch (err: any) {
        configError = err?.message || String(err);
      }
    }
    return {
      configured,
      authMode,
      corpId,
      clientId,
      clientSecret: maskSecretValue(clientSecret),
      hasClientSecret: !!clientSecret,
      robotCode,
      apiBaseUrl,
      restBaseUrl: apiBaseUrl,
      configError,
    };
  },
  createAdapter(creds: Record<string, any>, onMessage: any, hooks: any, agentId: string | null) {
    return createDingTalkAdapter({
      authMode: creds.authMode === "legacy_app" ? creds.authMode : undefined,
      corpId: creds.corpId,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      robotCode: creds.robotCode,
      apiBaseUrl: creds.apiBaseUrl,
      streamOpenUrl: creds.streamOpenUrl,
      agentId,
      onMessage,
      onStatus: hooks?.onStatus,
    });
  },
  async testConnection(config: Record<string, any>) {
    const creds = normalizeDingTalkBridgeCredentials(config);
    const http = createBridgeOutboundHttp({ platform: "dingtalk", fetchImpl: fetch as any });
    try {
      const result = await requestDingTalkAccessToken(
        creds,
        (request) => http.request({
          stage: "token_test",
          url: request.url,
          ...request.init,
          timeoutMs: 10_000,
          idempotent: true,
          maxRetries: 0,
        }),
      );
      return {
        ok: true,
        message: "钉钉应用凭证验证成功",
        details: { authMode: creds.authMode, metadata: result.metadata },
      };
    } catch (err: any) {
      if (err instanceof DingTalkApiError) {
        const errorInfo = dingtalkErrorInfo(err);
        return {
          ok: false,
          error: errorInfo?.dingtalkMessage || err.message,
          details: { authMode: creds.authMode, errorInfo },
        };
      }
      throw err;
    }
  },
};

export default class BridgeDingTalkPlugin {
  declare ctx: any;
  declare register: any;

  async onload() {
    const { bus, log } = this.ctx;
    if (!bus?.request) {
      log?.warn?.("bridge-dingtalk plugin loaded without event bus");
      return;
    }
    const result = await bus.request("bridge:register-provider", { provider: dingtalkBridgeProvider });
    if (result?.ok === false) {
      throw new Error(result.error || "failed to register bridge-dingtalk provider");
    }
    this.register?.(() => {
      bus.request("bridge:unregister-provider", { platformId: dingtalkBridgeProvider.id }).catch(() => {});
    });
  }
}
