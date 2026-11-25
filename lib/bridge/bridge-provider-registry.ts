/**
 * bridge-provider-registry.ts — 核心 Bridge 平台插件注册表
 *
 * 所有具体社交平台（QQ / Telegram / Feishu / WeChat / DingTalk 等）均通过
 * 统一插件契约（@hana/plugin-runtime 的 defineBridgeProvider + EventBus
 * `bridge:register-provider`）注册到此表，核心代码不硬编码任何具体平台实现。
 */

import type {
  HanaBridgeConfigField,
  HanaBridgeProviderDefinition,
} from "@hana/plugin-runtime";
import {
  registerSessionPrefixes,
  unregisterSessionPrefixes,
} from "./session-key.ts";

export interface BridgeProviderRecord {
  provider: HanaBridgeProviderDefinition;
  owner: unknown;
  registeredAt: string;
}

export interface BridgePlatformClientDescriptor {
  id: string;
  displayName: string;
  description: string;
  connectionMode: HanaBridgeProviderDefinition["connectionMode"];
  connectsAsync: boolean;
  configSchema: HanaBridgeConfigField[];
  secretFields: string[];
  actions: string[];
}

export class BridgeProviderRegistry {
  private readonly _providers = new Map<string, BridgeProviderRecord>();
  private readonly _listeners = new Set<(event: { type: "registered" | "unregistered"; platformId: string; provider?: HanaBridgeProviderDefinition }) => void>();

  register(provider: HanaBridgeProviderDefinition, meta: { owner?: unknown } = {}): BridgeProviderRecord {
    if (!provider || typeof provider !== "object") {
      throw new TypeError("Bridge provider definition must be an object");
    }
    const id = typeof provider.id === "string" ? provider.id.trim().toLowerCase() : "";
    if (!id) {
      throw new TypeError("Bridge provider definition requires a non-empty string id");
    }
    if (typeof provider.createAdapter !== "function") {
      throw new TypeError(`Bridge provider "${id}" must implement createAdapter()`);
    }
    if (typeof provider.getCredentials !== "function") {
      throw new TypeError(`Bridge provider "${id}" must implement getCredentials()`);
    }
    if (typeof provider.ownerSessionKey !== "function") {
      throw new TypeError(`Bridge provider "${id}" must implement ownerSessionKey()`);
    }

    const normalized: HanaBridgeProviderDefinition = {
      ...provider,
      id,
      displayName: typeof provider.displayName === "string" && provider.displayName.trim()
        ? provider.displayName.trim()
        : id,
      configSchema: Array.isArray(provider.configSchema) ? provider.configSchema : [],
      sessionPrefixes: Array.isArray(provider.sessionPrefixes) ? provider.sessionPrefixes : [],
    };

    const record: BridgeProviderRecord = {
      provider: normalized,
      owner: meta.owner ?? null,
      registeredAt: new Date().toISOString(),
    };
    this._providers.set(id, record);

    if (normalized.sessionPrefixes.length > 0) {
      registerSessionPrefixes(id, normalized.sessionPrefixes);
    }

    this._emit({ type: "registered", platformId: id, provider: normalized });
    return record;
  }

  unregister(platformId: string): boolean {
    const id = typeof platformId === "string" ? platformId.trim().toLowerCase() : "";
    if (!id || !this._providers.has(id)) return false;
    this._providers.delete(id);
    unregisterSessionPrefixes(id);
    this._emit({ type: "unregistered", platformId: id });
    return true;
  }

  get(platformId: string): HanaBridgeProviderDefinition | null {
    const id = typeof platformId === "string" ? platformId.trim().toLowerCase() : "";
    return this._providers.get(id)?.provider ?? null;
  }

  has(platformId: string): boolean {
    const id = typeof platformId === "string" ? platformId.trim().toLowerCase() : "";
    return this._providers.has(id);
  }

  list(): HanaBridgeProviderDefinition[] {
    return [...this._providers.values()].map((record) => record.provider);
  }

  getPlatformIds(): string[] {
    return [...this._providers.keys()];
  }

  getSecretFieldKeys(platformId: string): string[] {
    const provider = this.get(platformId);
    if (!provider) return [];
    const keys: string[] = [];
    for (const field of provider.configSchema || []) {
      if (field.type === "secret") {
        keys.push(field.key);
        if (Array.isArray(field.legacyKeys)) {
          for (const legacy of field.legacyKeys) keys.push(legacy);
        }
      }
    }
    return [...new Set(keys)];
  }

  describeForClient(): BridgePlatformClientDescriptor[] {
    return this.list().map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      description: provider.description || "",
      connectionMode: provider.connectionMode,
      connectsAsync: Boolean(provider.connectsAsync),
      configSchema: provider.configSchema || [],
      secretFields: this.getSecretFieldKeys(provider.id),
      actions: provider.actions ? Object.keys(provider.actions) : [],
    }));
  }

  subscribe(
    listener: (event: { type: "registered" | "unregistered"; platformId: string; provider?: HanaBridgeProviderDefinition }) => void,
  ): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  clear(): void {
    for (const id of [...this._providers.keys()]) {
      this.unregister(id);
    }
  }

  private _emit(event: { type: "registered" | "unregistered"; platformId: string; provider?: HanaBridgeProviderDefinition }): void {
    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Registry listeners must not break registration flow.
      }
    }
  }
}

export const bridgeProviderRegistry = new BridgeProviderRegistry();
