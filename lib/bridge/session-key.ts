/**
 * session-key.js — bridge sessionKey 解析工具
 *
 * 从 sessionKey 中提取平台、聊天类型、chatId。
 * 数据驱动：新增平台只需在 SESSION_PREFIX_MAP 注册前缀。
 */

// 兼容历史会话解析的默认前缀表（卸载插件后旧会话仍可识别）
const LEGACY_SESSION_PREFIX_MAP: Array<[string, string, "dm" | "group"]> = [
  ["tg_dm_",       "telegram", "dm"],
  ["tg_group_",    "telegram", "group"],
  ["fs_dm_",       "feishu",   "dm"],
  ["fs_group_",    "feishu",   "group"],
  ["dt_dm_",       "dingtalk", "dm"],
  ["dt_group_",    "dingtalk", "group"],
  ["qq_dm_",       "qq",       "dm"],
  ["qq_group_",    "qq",       "group"],
  ["wx_dm_",       "wechat",   "dm"],
];

// 运行时由已加载 Bridge 平台插件动态注册的前缀
const DYNAMIC_SESSION_PREFIXES = new Map<string, Array<[string, string, "dm" | "group"]>>();

export function registerSessionPrefixes(
  platform: string,
  prefixes: Array<{ prefix: string; chatType: "dm" | "group" }>,
) {
  const id = String(platform || "").trim().toLowerCase();
  if (!id || !Array.isArray(prefixes)) return;
  const entries: Array<[string, string, "dm" | "group"]> = [];
  for (const item of prefixes) {
    const prefix = typeof item?.prefix === "string" ? item.prefix.trim() : "";
    const chatType = item?.chatType === "group" ? "group" : "dm";
    if (prefix) entries.push([prefix, id, chatType]);
  }
  DYNAMIC_SESSION_PREFIXES.set(id, entries);
}

export function unregisterSessionPrefixes(platform: string) {
  const id = String(platform || "").trim().toLowerCase();
  if (!id) return;
  DYNAMIC_SESSION_PREFIXES.delete(id);
}

export function getActiveSessionPrefixMap(): Array<[string, string, "dm" | "group"]> {
  const combined: Array<[string, string, "dm" | "group"]> = [];
  const seen = new Set<string>();
  for (const list of DYNAMIC_SESSION_PREFIXES.values()) {
    for (const entry of list) {
      if (seen.has(entry[0])) continue;
      seen.add(entry[0]);
      combined.push(entry);
    }
  }
  for (const entry of LEGACY_SESSION_PREFIX_MAP) {
    if (seen.has(entry[0])) continue;
    seen.add(entry[0]);
    combined.push(entry);
  }
  return combined;
}

// 兼容导出
export const SESSION_PREFIX_MAP = LEGACY_SESSION_PREFIX_MAP;

/** 已知平台列表（兼容导出；运行时优先从 BridgeProviderRegistry 读取已注册插件） */
export const KNOWN_PLATFORMS = [...new Set(LEGACY_SESSION_PREFIX_MAP.map(([, p]) => p))];

/**
 * 为 sessionKey 附加工位作用域后缀（`#<workstationId>`）。
 * 无 workstationId 时保持原样（向后兼容旧模式）；已带 `#` 后缀时幂等返回。
 */
export function scopeSessionKeyToWorkstation(
  sessionKey: string,
  workstationId?: string | null,
): string {
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  const wsId = typeof workstationId === "string" ? workstationId.trim() : "";
  if (!raw || !wsId) return raw;
  if (raw.lastIndexOf("#") !== -1) return raw;
  return `${raw}#${wsId}`;
}

/**
 * 提取 sessionKey 中的 `#<workstationId>` 后缀（未携带返回 null）。
 */
export function extractWorkstationIdFromSessionKey(sessionKey: string): string | null {
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!raw) return null;
  const hashIdx = raw.lastIndexOf("#");
  if (hashIdx === -1) return null;
  const wsId = raw.slice(hashIdx + 1).trim();
  return wsId || null;
}

/** 从 sessionKey 解析平台 + 类型 + chatId + agentId（及可选 workstationId）
 *  工位格式: `qq_dm_123@hana#ws_1` → chatId="123", agentId="hana", workstationId="ws_1"
 *  新格式:   `tg_dm_123@hana`      → chatId="123", agentId="hana"
 *  旧格式:   `tg_dm_123`           → chatId="123", agentId=null
 */
export function parseSessionKey(sessionKey) {
  const raw = typeof sessionKey === "string" ? sessionKey : "";
  const hashIdx = raw.lastIndexOf("#");
  const workstationId = hashIdx !== -1 ? (raw.slice(hashIdx + 1).trim() || null) : null;
  const baseKey = hashIdx !== -1 ? raw.slice(0, hashIdx) : raw;

  for (const [prefix, platform, chatType] of getActiveSessionPrefixMap()) {
    if (baseKey.startsWith(prefix)) {
      const tail = baseKey.slice(prefix.length);
      const atIdx = tail.lastIndexOf("@");
      if (atIdx !== -1) {
        return {
          platform,
          chatType,
          chatId: tail.slice(0, atIdx),
          agentId: tail.slice(atIdx + 1),
          ...(workstationId ? { workstationId } : {}),
        };
      }
      return {
        platform,
        chatType,
        chatId: tail,
        agentId: null,
        ...(workstationId ? { workstationId } : {}),
      };
    }
  }
  return {
    platform: "unknown",
    chatType: "dm",
    chatId: baseKey,
    agentId: null,
    ...(workstationId ? { workstationId } : {}),
  };
}

const PLACEHOLDER_NAMES = new Set(["user"]);

function cleanDisplayName(name) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value) return null;
  if (PLACEHOLDER_NAMES.has(value.toLowerCase())) return null;
  return value;
}

function shortId(id) {
  const value = String(id || "");
  if (value.length <= 8) return value;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function addAlias(aliases, value) {
  const alias = typeof value === "string" ? value.trim() : "";
  if (!alias || aliases.includes(alias)) return;
  aliases.push(alias);
}

function qqPrincipalFromEntry(entry, parsed) {
  const principal = entry.qqPrincipal && typeof entry.qqPrincipal === "object"
    ? entry.qqPrincipal
    : {};
  const principalId = cleanString(principal.principalId) || cleanString(entry.principalId) || cleanString(entry.userId);
  if (!principalId) return null;

  const aliases = [];
  addAlias(aliases, principalId);
  if (Array.isArray(principal.aliases)) {
    for (const alias of principal.aliases) addAlias(aliases, alias);
  }
  if (parsed.chatType === "dm") {
    addAlias(aliases, entry.chatId);
    addAlias(aliases, parsed.chatId);
  }

  const displayName = cleanDisplayName(principal.displayName) || cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name);
  const avatarUrl = cleanString(principal.avatarUrl) || cleanString(entry.avatarUrl);
  return {
    principalId,
    aliases,
    displayName,
    avatarUrl,
    fallbackName: `QQ ${shortId(principalId)}`,
  };
}

function cleanString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

/**
 * 解析 bridge index entry 的平台身份。UI 与 route 只读这个结果，不从 chatId 猜展示名。
 */
export function resolveBridgeSessionIdentity(raw, { sessionKey = null, parsed = null } = {}) {
  const entry: any = typeof raw === "string" ? { file: raw } : raw || {};
  const parsedKey = parsed || (sessionKey ? parseSessionKey(sessionKey) : { platform: "unknown", chatType: "dm", chatId: entry.chatId || null });
  const userId = cleanString(entry.userId) || (parsedKey.platform === "wechat" && parsedKey.chatType === "dm" ? cleanString(parsedKey.chatId) : null);

  if (parsedKey.platform === "qq") {
    const principal = qqPrincipalFromEntry(entry, parsedKey);
    if (principal) {
      return {
        userId: principal.principalId,
        principalId: principal.principalId,
        aliases: principal.aliases,
        displayName: principal.displayName || cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name) || principal.fallbackName,
        avatarUrl: principal.avatarUrl || null,
      };
    }
  }

  const displayName = cleanDisplayName(entry.displayName) || cleanDisplayName(entry.name);
  return {
    userId,
    principalId: cleanString(entry.principalId) || userId,
    aliases: [],
    displayName,
    avatarUrl: cleanString(entry.avatarUrl),
  };
}

/**
 * 从 bridge index 中按 userId 去重收集已知用户
 * @param {object} index - bridge-index.json 的内容
 * @returns {Record<string, Array<{userId: string, name: string|null}>>}
 */
export function collectKnownUsers(index) {
  const byPlatform: Record<string, any> = {};

  for (const [sessionKey, raw] of Object.entries(index)) {
    const entry: any = typeof raw === "string" ? { file: raw } : raw;
    const parsed = parseSessionKey(sessionKey);
    const { platform } = parsed;
    if (platform === "unknown") continue;

    if (platform === "qq") {
      const principal = qqPrincipalFromEntry(entry, parsed);
      if (!principal) continue;
      if (!byPlatform[platform]) byPlatform[platform] = new Map();
      const map = byPlatform[platform];
      const existing = map.get(principal.principalId);
      if (existing) {
        for (const alias of principal.aliases) addAlias(existing.aliases, alias);
        if (!existing.name && principal.displayName) {
          existing.name = principal.displayName;
          existing.displayName = principal.displayName;
        }
        if (!existing.avatarUrl && principal.avatarUrl) existing.avatarUrl = principal.avatarUrl;
        continue;
      }
      const user: any = {
        userId: principal.principalId,
        principalId: principal.principalId,
        aliases: principal.aliases,
        name: principal.displayName,
        displayName: principal.displayName,
        fallbackName: principal.fallbackName,
      };
      if (principal.avatarUrl) user.avatarUrl = principal.avatarUrl;
      map.set(principal.principalId, user);
      continue;
    }

    const identity = resolveBridgeSessionIdentity(entry, { sessionKey, parsed });
    if (!identity.userId) continue;
    if (!byPlatform[platform]) byPlatform[platform] = new Map();
    const map = byPlatform[platform];
    const existing = map.get(identity.userId);
    if (!existing || (!existing.name && identity.displayName)) {
      const user: any = {
        userId: identity.userId,
        name: identity.displayName || null,
      };
      if (identity.avatarUrl || existing?.avatarUrl) user.avatarUrl = identity.avatarUrl || existing.avatarUrl;
      map.set(identity.userId, user);
    } else if (existing && !existing.avatarUrl && identity.avatarUrl) {
      existing.avatarUrl = identity.avatarUrl;
    }
  }

  const result: Record<string, any> = {};
  for (const [platform, map] of Object.entries(byPlatform)) {
    result[platform] = [...map.values()];
  }
  return result;
}
