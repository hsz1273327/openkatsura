import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { BridgeProviderRegistry } from "../lib/bridge/bridge-provider-registry.ts";
import { registerBridgeBusHandlers } from "../lib/bridge/bridge-bus-handlers.ts";
import { parseSessionKey } from "../lib/bridge/session-key.ts";
import { qqBridgeProvider } from "../plugins/bridge-qq/index.ts";
import { telegramBridgeProvider } from "../plugins/bridge-telegram/index.ts";
import { feishuBridgeProvider } from "../plugins/bridge-feishu/index.ts";
import { wechatBridgeProvider } from "../plugins/bridge-wechat/index.ts";
import { dingtalkBridgeProvider } from "../plugins/bridge-dingtalk/index.ts";

describe("Unified Bridge Plugin Contract & Registry", () => {
  let registry: BridgeProviderRegistry;

  beforeEach(() => {
    registry = new BridgeProviderRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it("starts cleanly with zero bridge platform plugins installed", () => {
    expect(registry.list()).toHaveLength(0);
    expect(registry.describeForClient()).toEqual([]);
    expect(registry.has("qq")).toBe(false);
  });

  it("registers and unregisters all 5 extracted platform plugins cleanly", () => {
    const all = [
      qqBridgeProvider,
      telegramBridgeProvider,
      feishuBridgeProvider,
      wechatBridgeProvider,
      dingtalkBridgeProvider,
    ];
    for (const provider of all) {
      registry.register(provider as any);
    }
    expect(registry.getPlatformIds().sort()).toEqual(["dingtalk", "feishu", "qq", "telegram", "wechat"]);
    expect(registry.getSecretFieldKeys("qq")).toContain("appSecret");
    expect(registry.getSecretFieldKeys("telegram")).toContain("token");
    expect(registry.describeForClient().find((p) => p.id === "wechat")?.actions).toEqual(["qrcode", "qrcodeStatus"]);

    // Unregistering removes only the target platform
    expect(registry.unregister("telegram")).toBe(true);
    expect(registry.has("telegram")).toBe(false);
    expect(registry.has("qq")).toBe(true);
  });

  it("registers custom third-party session prefixes dynamically", () => {
    registry.register({
      id: "discord",
      displayName: "Discord",
      connectionMode: "websocket",
      sessionPrefixes: [{ prefix: "dc_dm_", chatType: "dm" }],
      configSchema: [{ key: "botToken", label: "Bot Token", type: "secret", required: true }],
      getCredentials: (cfg: any) => (cfg?.enabled && cfg?.botToken ? { botToken: cfg.botToken } : null),
      ownerSessionKey: (userId: string, agentId: string) => `dc_dm_${userId}@${agentId}`,
      createAdapter: () => ({}),
    });

    const parsed = parseSessionKey("dc_dm_user42@katsura");
    expect(parsed).toEqual({
      platform: "discord",
      chatType: "dm",
      chatId: "user42",
      agentId: "katsura",
    });
  });

  it("wires EventBus register/unregister handlers identically to media-gen plugins", async () => {
    const handlers = new Map<string, Function>();
    const fakeBus = {
      handle: (type: string, fn: Function) => {
        handlers.set(type, fn);
        return () => handlers.delete(type);
      },
    };
    const stopped: string[] = [];
    const started: string[] = [];
    const cleanup = registerBridgeBusHandlers(fakeBus, {
      registry,
      getBridgeManager: () => ({
        autoStartPlatform: (id: string) => started.push(id),
        stopAllForPlatform: (id: string) => stopped.push(id),
      }),
      getAgents: () => new Map([["main", {}]]),
    });

    const regRes = handlers.get("bridge:register-provider")?.({ provider: qqBridgeProvider });
    expect(regRes).toEqual({ ok: true, platformId: "qq" });
    expect(started).toEqual(["qq"]);
    expect(registry.has("qq")).toBe(true);

    const listRes = handlers.get("bridge:list-providers")?.();
    expect(listRes.ok).toBe(true);
    expect(listRes.providers.map((p: any) => p.id)).toEqual(["qq"]);

    const unregRes = handlers.get("bridge:unregister-provider")?.({ platformId: "qq" });
    expect(unregRes).toEqual({ ok: true, removed: true });
    expect(stopped).toEqual(["qq"]);
    expect(registry.has("qq")).toBe(false);

    cleanup();
  });
});
