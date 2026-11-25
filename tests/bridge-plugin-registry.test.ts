import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { defineBridgeProvider } from "@hana/plugin-runtime";
import { BridgeProviderRegistry } from "../lib/bridge/bridge-provider-registry.ts";
import { registerBridgeBusHandlers } from "../lib/bridge/bridge-bus-handlers.ts";
import { parseSessionKey } from "../lib/bridge/session-key.ts";

function createMockProvider(id: string, prefix: string) {
  return defineBridgeProvider({
    id,
    displayName: id.toUpperCase(),
    description: `Mock ${id} bridge plugin`,
    connectionMode: "websocket",
    sessionPrefixes: [
      { prefix: `${prefix}_dm_`, chatType: "dm" },
      { prefix: `${prefix}_group_`, chatType: "group" },
    ],
    configSchema: [
      { key: "appId", label: "App ID", type: "string", required: true },
      { key: "appSecret", label: "App Secret", type: "secret", required: true },
    ],
    getCredentials: (cfg: Record<string, any>) =>
      cfg?.enabled && cfg?.appId && cfg?.appSecret
        ? { appId: cfg.appId, appSecret: cfg.appSecret }
        : null,
    ownerSessionKey: (userId: string, agentId: string) => `${prefix}_dm_${userId}@${agentId}`,
    createAdapter: () => ({}),
    actions: {
      ping: async () => ({ ok: true }),
    },
  });
}

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
    expect(registry.has("mock-im")).toBe(false);
  });

  it("registers, describes secret fields/actions, and unregisters plugins cleanly", () => {
    const p1 = createMockProvider("alpha", "al");
    const p2 = createMockProvider("beta", "bt");
    registry.register(p1);
    registry.register(p2);

    expect(registry.getPlatformIds().sort()).toEqual(["alpha", "beta"]);
    expect(registry.getSecretFieldKeys("alpha")).toEqual(["appSecret"]);
    expect(registry.describeForClient().find((p) => p.id === "alpha")?.actions).toEqual(["ping"]);

    expect(registry.unregister("beta")).toBe(true);
    expect(registry.has("beta")).toBe(false);
    expect(registry.has("alpha")).toBe(true);
  });

  it("registers custom third-party session prefixes dynamically", () => {
    registry.register(createMockProvider("discord", "dc"));

    const parsed = parseSessionKey("dc_dm_user42@katsura");
    expect(parsed).toEqual({
      platform: "discord",
      chatType: "dm",
      chatId: "user42",
      agentId: "katsura",
    });
  });

  it("wires EventBus register/unregister handlers identically to media-gen plugins", () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const fakeBus = {
      handle: (type: string, fn: (...args: any[]) => any) => {
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

    const mockProvider = createMockProvider("alpha", "al");
    const regRes = handlers.get("bridge:register-provider")?.({ provider: mockProvider });
    expect(regRes).toEqual({ ok: true, platformId: "alpha" });
    expect(started).toEqual(["alpha"]);
    expect(registry.has("alpha")).toBe(true);

    const listRes = handlers.get("bridge:list-providers")?.();
    expect(listRes.ok).toBe(true);
    expect(listRes.providers.map((p: any) => p.id)).toEqual(["alpha"]);

    const unregRes = handlers.get("bridge:unregister-provider")?.({ platformId: "alpha" });
    expect(unregRes).toEqual({ ok: true, removed: true });
    expect(stopped).toEqual(["alpha"]);
    expect(registry.has("alpha")).toBe(false);

    cleanup();
  });
});
