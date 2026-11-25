import { Hono } from "hono";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MASKED_SECRET } from "../shared/secret-custody.ts";
import { registerMockBridgeProviders } from "./helpers/register-mock-bridge-providers.ts";

function withPrincipal(app, principal) {
  app.use("*", async (c, next) => {
    c.set("authPrincipal", Object.freeze(principal));
    await next();
  });
}

function remotePrincipal(scopes) {
  return {
    kind: "device",
    credentialKind: "device_credential",
    connectionKind: "lan",
    scopes,
  };
}

describe("secret custody across HTTP routes", () => {
  let cleanupProviders: (() => void) | null = null;
  beforeEach(() => {
    cleanupProviders = registerMockBridgeProviders();
  });
  afterEach(() => {
    cleanupProviders?.();
    cleanupProviders = null;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("masks provider secrets in summary responses", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            headers: { Authorization: "Bearer gateway-secret" },
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/summary");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers.deepseek.api_key).toBe(MASKED_SECRET);
    expect(body.providers.deepseek.headers.Authorization).toBe(MASKED_SECRET);
    expect(JSON.stringify(body)).not.toContain("sk-provider-secret");
    expect(JSON.stringify(body)).not.toContain("gateway-secret");
  });

  it("reveals a provider api key only through the explicit secret endpoint", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://api.deepseek.com",
            api: "openai-completions",
            api_key: "sk-provider-secret",
            models: ["deepseek-chat"],
          },
        }),
        get: () => ({ authType: "api-key", baseUrl: "", api: "openai-completions" }),
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: (name) => name === "deepseek"
        ? { api_key: "sk-provider-secret", base_url: "https://api.deepseek.com", api: "openai-completions" }
        : { api_key: "", base_url: "", api: "" },
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const summaryRes = await app.request("/api/providers/summary");
    const summaryBody = await summaryRes.json();
    expect(summaryBody.providers.deepseek.api_key).toBe(MASKED_SECRET);

    const revealRes = await app.request("/api/providers/deepseek/api-key");
    const revealBody = await revealRes.json();
    expect(revealRes.status).toBe(200);
    expect(revealBody).toEqual({ api_key: "sk-provider-secret" });
  });

  it("requires secret scope before a remote provider api key can be revealed", async () => {
    const { createProvidersRoute } = await import("../server/routes/providers.ts");
    const app = new Hono();
    withPrincipal(app, remotePrincipal(["providers.manage"]));
    const engine = {
      providerRegistry: {
        getAllProvidersRaw: () => ({}),
        get: () => null,
        isOAuth: () => false,
        getAuthType: () => "api-key",
        allowsMissingApiKey: () => false,
        getAuthJsonKey: (id) => id,
        getOAuthProviderIds: () => [],
        getAll: () => new Map(),
      },
      preferences: { getOAuthCustomModels: () => ({}) },
      resolveProviderCredentials: () => ({ api_key: "sk-provider-secret", base_url: "", api: "" }),
      hanakoHome: "/tmp",
    };

    app.route("/api", createProvidersRoute(engine));

    const res = await app.request("/api/providers/deepseek/api-key");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual({
      error: "secret_read_scope_required",
      scope: "secrets.write",
    });
  });

  it("preserves saved provider secrets when a masked config patch is submitted", async () => {
    const { createConfigRoute } = await import("../server/routes/config.ts");
    const saveProvider = vi.fn();
    const engine = {
      config: {},
      configPath: "/tmp/test-config.yaml",
      updateConfig: vi.fn().mockResolvedValue(undefined),
      onProviderChanged: vi.fn().mockResolvedValue(undefined),
      emitEvent: vi.fn(),
      providerRegistry: {
        getAllProvidersRaw: () => ({
          deepseek: {
            base_url: "https://old.example/v1",
            api_key: "sk-saved-provider",
            headers: { Authorization: "Bearer saved-gateway" },
          },
        }),
        saveProvider,
      },
    };
    const app = new Hono();
    app.route("/api", createConfigRoute(engine));

    const res = await app.request("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providers: {
          deepseek: {
            base_url: "https://new.example/v1",
            api_key: MASKED_SECRET,
            headers: { Authorization: MASKED_SECRET, "X-Corp-Auth": "new-token" },
          },
        },
      }),
    });

    expect(res.status).toBe(200);
    expect(saveProvider).toHaveBeenCalledWith("deepseek", {
      base_url: "https://new.example/v1",
      api_key: "sk-saved-provider",
      headers: {
        Authorization: "Bearer saved-gateway",
        "X-Corp-Auth": "new-token",
      },
    });
  });

  it("masks global preference secrets and resolves masked updates back to saved values", async () => {
    const { createPreferencesRoute } = await import("../server/routes/preferences.ts");
    const setSearchConfig = vi.fn();
    const setUtilityApi = vi.fn();
    const engine = {
      getSharedModels: () => ({}),
      getSearchConfig: () => ({ provider: "tavily", api_key: "tvly-secret" }),
      getUtilityApi: () => ({ provider: "openai", base_url: "https://api.example/v1", api_key: "sk-utility" }),
      setSearchConfig,
      setUtilityApi,
      emitEvent: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createPreferencesRoute(engine));

    const readRes = await app.request("/api/preferences/models");
    const readBody = await readRes.json();
    expect(readBody.search.api_key).toBe(MASKED_SECRET);
    expect(readBody.utility_api.api_key).toBe(MASKED_SECRET);
    expect(JSON.stringify(readBody)).not.toContain("tvly-secret");
    expect(JSON.stringify(readBody)).not.toContain("sk-utility");

    const writeRes = await app.request("/api/preferences/models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        search: { provider: "tavily", api_key: MASKED_SECRET },
        utility_api: { provider: "openai", base_url: "https://new.example/v1", api_key: MASKED_SECRET },
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(setSearchConfig).toHaveBeenCalledWith({ provider: "tavily", api_key: "tvly-secret" });
    expect(setUtilityApi).toHaveBeenCalledWith({
      provider: "openai",
      base_url: "https://new.example/v1",
      api_key: "sk-utility",
    });
  });

  it("masks bridge secrets in status and preserves masked config updates", async () => {
    const { createBridgeRoute } = await import("../server/routes/bridge.ts");
    const agent: any = {
      id: "hana",
      config: {
        bridge: {
          telegram: { token: "tg-secret", enabled: true },
          feishu: { appId: "cli-id", appSecret: "fs-secret" },
          dingtalk: {
            corpId: "corp-1",
            clientId: "dt-client",
            clientSecret: "dt-secret",
            robotCode: "ding-robot",
            restBaseUrl: "https://api.dingtalk.io/v1.0",
          },
          qq: { appID: "qq-id", appSecret: "qq-secret" },
          wechat: { botToken: "wx-secret" },
        },
      },
      updateConfig: vi.fn(),
    };
    const engine = {
      currentAgentId: "hana",
      getAgent: (id) => id === "hana" ? agent : null,
      getBridgeIndex: () => ({}),
      getBridgeReadOnly: () => false,
      getBridgeReceiptEnabled: () => true,
    };
    const bridgeManager = {
      getStatus: () => ({}),
      stopPlatform: vi.fn(),
      startPlatformFromConfig: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));

    const readRes = await app.request("/api/bridge/status?agentId=hana");
    const readBody = await readRes.json();

    expect(readBody.telegram.token).toBe(MASKED_SECRET);
    expect(readBody.telegram.hasToken).toBe(true);
    expect(readBody.feishu.appSecret).toBe(MASKED_SECRET);
    expect(readBody.feishu.hasAppSecret).toBe(true);
    expect(readBody.feishu.region).toBe("feishu_cn");
    expect(readBody.feishu.domain).toBe("https://open.feishu.cn");
    expect(readBody.dingtalk.clientSecret).toBe(MASKED_SECRET);
    expect(readBody.dingtalk.hasClientSecret).toBe(true);
    expect(readBody.dingtalk.corpId).toBe("corp-1");
    expect(readBody.dingtalk.clientId).toBe("dt-client");
    expect(readBody.dingtalk.robotCode).toBe("ding-robot");
    expect(readBody.dingtalk.apiBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.dingtalk.restBaseUrl).toBe("https://api.dingtalk.com/v1.0");
    expect(readBody.qq.appSecret).toBe(MASKED_SECRET);
    expect(readBody.qq.hasAppSecret).toBe(true);
    expect(readBody.wechat.token).toBe(MASKED_SECRET);
    expect(readBody.wechat.hasBotToken).toBe(true);
    expect(JSON.stringify(readBody)).not.toContain("tg-secret");
    expect(JSON.stringify(readBody)).not.toContain("fs-secret");
    expect(JSON.stringify(readBody)).not.toContain("dt-secret");
    expect(JSON.stringify(readBody)).not.toContain("qq-secret");
    expect(JSON.stringify(readBody)).not.toContain("wx-secret");

    const writeRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "telegram",
        credentials: { token: MASKED_SECRET },
        enabled: false,
      }),
    });

    expect(writeRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        telegram: { token: "tg-secret", enabled: false },
      },
    });

    agent.updateConfig.mockClear();
    const feishuWriteRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "feishu",
        credentials: { appId: "cli-id", appSecret: MASKED_SECRET, region: "lark_global" },
        enabled: true,
      }),
    });

    expect(feishuWriteRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        feishu: { appId: "cli-id", appSecret: "fs-secret", region: "lark_global", enabled: true },
      },
    });

    agent.updateConfig.mockClear();
    const dingtalkWriteRes = await app.request("/api/bridge/config?agentId=hana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: "dingtalk",
        credentials: {
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: MASKED_SECRET,
          robotCode: "ding-robot",
        },
        enabled: false,
      }),
    });

    expect(dingtalkWriteRes.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: {
        dingtalk: expect.objectContaining({
          corpId: "corp-1",
          clientId: "dt-client",
          clientSecret: "dt-secret",
          robotCode: "ding-robot",
          enabled: false,
        }),
      },
    });
  });
});
