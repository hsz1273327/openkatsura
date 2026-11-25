/**
 * bridge-bus-handlers.ts — Bridge 平台插件 EventBus 处理器
 *
 * 与 media-gen:register-adapter 同构：full-access 插件在 onload() 中通过
 * `bus.request("bridge:register-provider", { provider })` 注册平台，
 * 卸载/停用时通过 `bus.request("bridge:unregister-provider", { platformId })` 反注册。
 */

import { bridgeProviderRegistry, type BridgeProviderRegistry } from "./bridge-provider-registry.ts";
import { createModuleLogger } from "../debug-log.ts";

const log = createModuleLogger("bridge");

export function registerBridgeBusHandlers(
  eventBus: any,
  {
    registry = bridgeProviderRegistry,
    getBridgeManager,
    getAgents,
  }: {
    registry?: BridgeProviderRegistry;
    getBridgeManager?: () => any;
    getAgents?: () => Map<string, any> | null | undefined;
  } = {},
) {
  if (!eventBus || typeof eventBus.handle !== "function") return () => {};

  const cleanups = [
    eventBus.handle("bridge:register-provider", (payload: any = {}, requestContext: any = null) => {
      try {
        const provider = payload?.provider;
        const record = registry.register(provider, { owner: requestContext?.caller || null });
        log.log(`bridge provider registered: ${record.provider.id}`);
        const bm = getBridgeManager?.();
        const agents = getAgents?.();
        if (bm && agents && typeof bm.autoStartPlatform === "function") {
          bm.autoStartPlatform(record.provider.id, agents);
        }
        return { ok: true, platformId: record.provider.id };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    }),
    eventBus.handle("bridge:unregister-provider", (payload: any = {}) => {
      try {
        const platformId = typeof payload?.platformId === "string"
          ? payload.platformId
          : (typeof payload?.id === "string" ? payload.id : "");
        if (!platformId) return { ok: false, error: "platformId is required" };
        const bm = getBridgeManager?.();
        if (bm && typeof bm.stopAllForPlatform === "function") {
          bm.stopAllForPlatform(platformId);
        }
        const removed = registry.unregister(platformId);
        if (removed) log.log(`bridge provider unregistered: ${platformId}`);
        return { ok: true, removed };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    }),
    eventBus.handle("bridge:list-providers", () => ({
      ok: true,
      providers: registry.describeForClient(),
    })),
  ];

  return () => {
    for (const cleanup of cleanups) {
      try {
        if (typeof cleanup === "function") cleanup();
      } catch {
        // ignore
      }
    }
  };
}
