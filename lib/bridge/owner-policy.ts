import { parseSessionKey } from "./session-key.ts";

export function getConfiguredBridgeOwner(agent, platform) {
  const owner = agent?.config?.bridge?.[platform]?.owner;
  return typeof owner === "string" && owner ? owner : null;
}

export function isBridgeOwner({ platform, chatType = "dm", userId, aliases, agent, configuredOwner }: any) {
  if (!userId) return false;
  if (platform === "wechat") return chatType === "dm";

  const owner = configuredOwner !== undefined
    ? (typeof configuredOwner === "string" && configuredOwner ? configuredOwner : null)
    : getConfiguredBridgeOwner(agent, platform);
  if (!owner) return false;
  if (owner === userId) return true;
  if (platform !== "qq") return false;
  return normalizeStringList(aliases).includes(owner);
}

export function resolveBridgeOwnerUserId({ platform, agent, index, configuredOwner }: any) {
  const configured = configuredOwner !== undefined
    ? cleanString(configuredOwner)
    : getConfiguredBridgeOwner(agent, platform);
  if (configured) return configured;
  if (platform !== "wechat") return null;
  return inferUniqueWechatOwnerFromIndex(index);
}

export function resolveBridgeOwnerDeliveryTarget({ platform, agent, index, configuredOwner, workstationId = null }: any) {
  const userId = resolveBridgeOwnerUserId({ platform, agent, index, configuredOwner });
  if (!userId) return null;

  if (platform === "feishu") {
    return resolveFeishuDeliveryTarget(index, userId, workstationId);
  }
  if (platform === "qq") {
    return resolveQQDeliveryTarget(index, userId, workstationId) || { userId, chatId: userId, sessionKey: null };
  }

  return { userId, chatId: userId, sessionKey: null };
}

function resolveQQDeliveryTarget(index, ownerId, workstationId = null) {
  let fallback: { userId: string; chatId: any; sessionKey: string } | null = null;
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const parsed = parseSessionKey(sessionKey);
    const { platform, chatType, chatId: sessionChatId } = parsed;
    if (platform !== "qq" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    const principal = qqPrincipalFromEntry(entry, sessionChatId);
    if (!principal) continue;
    if (principal.principalId !== ownerId && !principal.aliases.includes(ownerId)) continue;

    const match = {
      userId: principal.principalId,
      chatId: entry.chatId || sessionChatId,
      sessionKey,
    };
    const keyWsId = entry.workstationId || (parsed as any).workstationId || null;
    if (workstationId && keyWsId === workstationId) return match;
    if (!fallback && !keyWsId) fallback = match;
  }
  return fallback;
}

function resolveFeishuDeliveryTarget(index, ownerId, workstationId = null) {
  let fallback: { userId: string; chatId: any; sessionKey: string } | null = null;
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const parsed = parseSessionKey(sessionKey);
    const { platform, chatType, chatId: sessionUserId } = parsed;
    if (platform !== "feishu" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    if (entry.userId !== ownerId && sessionUserId !== ownerId) continue;
    if (!entry.chatId) continue;

    const match = { userId: ownerId, chatId: entry.chatId, sessionKey };
    const keyWsId = entry.workstationId || (parsed as any).workstationId || null;
    if (workstationId && keyWsId === workstationId) return match;
    if (!fallback && !keyWsId) fallback = match;
  }
  return fallback;
}

function inferUniqueWechatOwnerFromIndex(index) {
  const ids = new Set();
  for (const [sessionKey, raw] of Object.entries(index || {})) {
    const { platform, chatType, chatId } = parseSessionKey(sessionKey);
    if (platform !== "wechat" || chatType !== "dm") continue;

    const entry: Record<string, any> = typeof raw === "string" ? {} : (raw as Record<string, any>) || {};
    const userId = entry.userId || chatId;
    if (userId) ids.add(userId);
  }
  return ids.size === 1 ? [...ids][0] : null;
}

function cleanString(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s || null;
}

function normalizeStringList(values) {
  const result = [];
  if (!Array.isArray(values)) return result;
  for (const value of values) {
    const s = cleanString(value);
    if (s && !result.includes(s)) result.push(s);
  }
  return result;
}

function qqPrincipalFromEntry(entry, sessionChatId) {
  const principal = entry.qqPrincipal && typeof entry.qqPrincipal === "object"
    ? entry.qqPrincipal
    : {};
  const principalId = cleanString(principal.principalId) || cleanString(entry.principalId) || cleanString(entry.userId);
  if (!principalId) return null;
  const aliases = normalizeStringList([
    principalId,
    ...(Array.isArray(principal.aliases) ? principal.aliases : []),
    entry.chatId,
    sessionChatId,
  ]);
  return { principalId, aliases };
}
