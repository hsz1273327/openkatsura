/**
 * bridge.ts — 外部平台接入 REST API（插件化通用路由）
 *
 * 所有具体社交平台由已注册的 Bridge 平台插件（bridgeProviderRegistry）提供，
 * 本文件仅负责平台无关的配置托管、状态投影、连通性测试代理、动作代理与会话管理。
 */

import fs from "fs";
import path from "path";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";
import { createModuleLogger, debugLog } from "../../lib/debug-log.ts";
import { parseSessionKey, collectKnownUsers, resolveBridgeSessionIdentity } from "../../lib/bridge/session-key.ts";
import { isBridgeOwner, resolveBridgeOwnerUserId } from "../../lib/bridge/owner-policy.ts";
import { collectBridgeMediaAllowedRoots, isInsideBridgeMediaRoot } from "../../lib/bridge/media-roots.ts";
import { bridgeProviderRegistry } from "../../lib/bridge/bridge-provider-registry.ts";
import { resolveBridgeSessionFilePath } from "../../core/bridge-session-manager.ts";
import { createBridgeOutboundHttp } from "../../lib/bridge/outbound-http.ts";
import { webSocketOptionsForUrl } from "../../lib/net/outbound-proxy.ts";
import { sanitizeBridgeVisibleText } from "../../shared/bridge-visible-text.ts";
import { t } from "../../lib/i18n.ts";
import { AgentNotFoundError, resolveAgentStrict } from "../utils/resolve-agent.ts";
import {
  collectSecretPatchPaths,
  isMaskedSecretValue,
  maskSecretValue,
  resolveSecretPatch,
} from "../../shared/secret-custody.ts";
import { denySecretMutationWithoutScope, denyWithoutScope } from "../http/capability-guard.ts";
import { recordSecurityAuditEvent } from "../http/security-audit.ts";
import { normalizeBridgePermissionMode, SESSION_PERMISSION_MODES } from "../../core/session-permission-mode.ts";

const MAX_BRIDGE_MEDIA_SIZE = 50 * 1024 * 1024;

function createRouteHostServices(engine: any, platform: string) {
  const platformLog = createModuleLogger(platform || "bridge");
  return {
    hanakoHome: engine?.hanakoHome || "",
    createOutboundHttp: createBridgeOutboundHttp,
    webSocketOptionsForUrl,
    log: {
      info: (...args: any[]) => (platformLog.log as any)(...args),
      warn: (...args: any[]) => (platformLog.warn as any)(...args),
      error: (...args: any[]) => (platformLog.error as any)(...args),
      debug: (...args: any[]) => (platformLog.log as any)(...args),
    },
  };
}

function normalizeBridgeManagerRef(ref: any) {
  if (ref && typeof ref.get === "function") {
    return {
      get: ref.get,
      ensureReady: ref.ensureReady || ref.get,
      getState: ref.getState || (() => ({ ready: !!ref.get(), initializing: false, error: null })),
    };
  }
  if (typeof ref === "function") {
    return {
      get: ref,
      ensureReady: ref,
      getState: () => ({ ready: !!ref(), initializing: false, error: null }),
    };
  }
  return {
    get: () => ref || null,
    ensureReady: async () => ref || null,
    getState: () => ({ ready: !!ref, initializing: false, error: null }),
  };
}

function bridgeUnavailable(c: any, state: { error?: any; initializing?: any } = {}) {
  const error = state.error
    ? `bridge manager unavailable: ${state.error}`
    : "bridge manager is still starting";
  return c.json({
    ok: false,
    error,
    bridge: {
      ready: false,
      initializing: state.initializing !== false,
      error: state.error || null,
    },
  }, 503);
}

function buildDefaultPlatformStatusFields(provider: any, cfg: Record<string, any> = {}) {
  const fields: Record<string, any> = {};
  for (const field of provider.configSchema || []) {
    const raw = cfg?.[field.key];
    if (field.type === "secret") {
      const value = typeof raw === "string" ? raw : "";
      fields[field.key] = maskSecretValue(value);
      const cap = field.key.charAt(0).toUpperCase() + field.key.slice(1);
      fields[`has${cap}`] = !!value;
    } else {
      fields[field.key] = raw ?? field.default ?? "";
    }
  }
  let configured = false;
  let configError: string | null = null;
  try {
    configured = Boolean(provider.getCredentials({ ...cfg, enabled: true }));
  } catch (err: any) {
    configError = err?.message || String(err);
  }
  return { configured, configError, ...fields };
}

export function buildBridgeStatus(engine: any, manager: any, agent: any) {
  const live = manager?.getStatus?.(agent.id) || {};
  const bridge = agent.config?.bridge || {};
  const index = engine.getBridgeIndex?.(agent.id) || {};

  const platformStatus = (plat: string, cfg: any, extraFields: any) => {
    const enabled = !!cfg?.enabled;
    const configError = extraFields?.configError || null;
    return {
      ...extraFields,
      enabled,
      status: enabled && configError ? "error" : live[plat]?.status || "disconnected",
      error: enabled && configError ? configError : live[plat]?.error || configError,
      agentId: agent.id,
    };
  };

  const registeredProviders = bridgeProviderRegistry.list();
  const dynamicPlatforms: Record<string, any> = {};
  const ownerDict: Record<string, any> = {};

  for (const provider of registeredProviders) {
    const plat = provider.id;
    const cfg = bridge[plat] || {};
    const extraFields = typeof provider.extractStatusMeta === "function"
      ? provider.extractStatusMeta(cfg)
      : buildDefaultPlatformStatusFields(provider, cfg);
    dynamicPlatforms[plat] = platformStatus(plat, cfg, extraFields);
    const o = resolveBridgeOwnerUserId({ platform: plat, agent, index });
    if (o) ownerDict[plat] = o;
  }

  const readOnly = engine.getBridgeReadOnly?.() === true;
  const permissionMode = engine.getBridgePermissionMode?.()
    || normalizeBridgePermissionMode({ readOnly });
  const receiptEnabled = engine.getBridgeReceiptEnabled?.() !== false;
  const richStreamingEnabled = engine.getBridgeRichStreamingEnabled?.() !== false;

  return {
    agentId: agent.id,
    ...dynamicPlatforms,
    platforms: bridgeProviderRegistry.describeForClient(),
    permissionMode,
    readOnly,
    receiptEnabled,
    richStreamingEnabled,
    knownUsers: collectKnownUsers(index),
    owner: ownerDict,
  };
}

export function createBridgeRoute(engine: any, bridgeManagerRef: any) {
  const route = new Hono();
  const bridgeRef = normalizeBridgeManagerRef(bridgeManagerRef);

  function resolveBridgeManager() {
    return bridgeRef.get?.() || null;
  }

  async function ensureBridgeManager() {
    const existing = resolveBridgeManager();
    if (existing) return existing;
    try {
      return await bridgeRef.ensureReady?.() || null;
    } catch {
      return null;
    }
  }

  /**
   * Bridge reads answer for exactly one agent, so the request has to name it.
   * There is no server-wide "current" agent that is the right answer for every
   * connected client, so a request without an agentId gets a 404 rather than
   * whichever agent the server happens to be focused on.
   */
  function withReadAgent(handler: (c: any, agent: any) => any) {
    return async (c: any) => {
      let agent;
      try {
        agent = resolveAgentStrict(engine, c);
      } catch (err) {
        if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
        throw err;
      }
      return handler(c, agent);
    };
  }

  /** 获取所有平台连接状态（从 agent.config.bridge 读取） */
  route.get("/bridge/status", withReadAgent(async (c, agent) => {
    const manager = resolveBridgeManager();
    const bridgeState = bridgeRef.getState?.() || { ready: !!manager, initializing: false, error: null };
    return c.json({
      ...buildBridgeStatus(engine, manager, agent),
      bridgeReady: !!manager,
      bridgeInitializing: !!bridgeState.initializing,
      bridgeError: bridgeState.error || null,
    });
  }));

  /** 设置 owner（哪个账号是你）— 写入 agent.config.bridge */
  route.post("/bridge/owner", async (c) => {
    const body = await safeJson(c);
    const { platform, userId } = body;
    if (!platform || !bridgeProviderRegistry.has(platform)) {
      return c.json({ ok: false, error: "invalid or uninstalled platform plugin" });
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const agent = resolveAgentStrict(engine, c);
    agent.updateConfig({ bridge: { [platform]: { owner: userId || null } } });
    debugLog()?.log("api", `POST /api/bridge/owner agent=${agent.id} platform=${platform} owner=${userId ? "[set]" : "[cleared]"}`);
    return c.json({ ok: true, status: buildBridgeStatus(engine, resolveBridgeManager(), agent) });
  });

  /** 列出当前已注册的 Bridge 平台插件及其配置 Schema */
  route.get("/bridge/platforms", (c) => {
    return c.json({ platforms: bridgeProviderRegistry.describeForClient() });
  });

  /** 保存凭证 + 启停平台（写入 agent.config.bridge） */
  route.post("/bridge/config", async (c) => {
    const body = await safeJson(c);
    const { platform, credentials, enabled } = body;
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const secretKeys = bridgeSecretKeys(platform);
    const fallbackSecretKeys = secretKeys.length > 0
      ? secretKeys
      : ["token", "botToken", "appSecret", "clientSecret", "secret"];
    const secretFields = credentials
      ? collectSecretPatchPaths({ credentials }, fallbackSecretKeys)
      : [];
    const secretDenied = denySecretMutationWithoutScope(c, secretFields);
    if (secretDenied) return secretDenied;
    const provider = platform ? bridgeProviderRegistry.get(platform) : null;
    if (!provider) {
      return c.json({ error: "invalid or uninstalled platform plugin" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;

    const bridgeCfg = agent.config?.bridge?.[platform] || {};
    let patch: Record<string, any> = { ...bridgeCfg };

    if (credentials) {
      try {
        if (typeof provider.normalizeConfig === "function") {
          patch = provider.normalizeConfig(credentials, bridgeCfg);
        } else {
          patch = { ...patch, ...resolveBridgeCredentials(platform, credentials, bridgeCfg) };
        }
      } catch (err: any) {
        return c.json({ ok: false, error: err?.message || String(err) }, 400);
      }
    }
    if (typeof enabled === "boolean") patch.enabled = enabled;
    if (typeof provider.normalizeConfig === "function") {
      try {
        patch = provider.normalizeConfig(patch, bridgeCfg);
      } catch (err: any) {
        return c.json({ ok: false, error: err?.message || String(err) }, 400);
      }
    }

    agent.updateConfig({ bridge: { [platform]: patch } });

    const persistedPatch = agent.config?.bridge?.[platform] || patch;

    // Start/stop
    if (persistedPatch.enabled) {
      const manager = await ensureBridgeManager();
      if (!manager) return bridgeUnavailable(c, bridgeRef.getState?.() || {});
      manager.startPlatformFromConfig(platform, persistedPatch, agentId);
    } else {
      resolveBridgeManager()?.stopPlatform(platform, agentId);
    }

    debugLog()?.log("api", `POST /api/bridge/config agent=${agentId} platform=${platform} enabled=${!!patch.enabled}`);
    recordSecurityAuditEvent(c, engine, {
      action: "settings.bridge.config.update",
      target: `bridge.${platform}`,
      secretFields,
      metadata: { agentId, platform, enabled: typeof enabled === "boolean" ? enabled : null },
    } as any);
    return c.json({ ok: true });
  });

  /** 更新 bridge 总设置（permissionMode / legacy readOnly / receiptEnabled / richStreamingEnabled）— global preferences */
  route.post("/bridge/settings", async (c) => {
    const body = await safeJson(c);
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const { permissionMode, readOnly, receiptEnabled, richStreamingEnabled } = body;
    if (typeof permissionMode === "string") {
      const normalized = normalizeBridgePermissionMode({ permissionMode });
      if (normalized !== permissionMode) {
        return c.json({ ok: false, error: "invalid bridge permission mode" }, 400);
      }
      engine.setBridgePermissionMode?.(normalized);
    } else if (typeof readOnly === "boolean") {
      engine.setBridgeReadOnly(readOnly);
      engine.setBridgePermissionMode?.(
        readOnly ? SESSION_PERMISSION_MODES.READ_ONLY : SESSION_PERMISSION_MODES.AUTO,
      );
    }
    if (typeof receiptEnabled === "boolean") {
      engine.setBridgeReceiptEnabled(receiptEnabled);
    }
    if (typeof richStreamingEnabled === "boolean") {
      engine.setBridgeRichStreamingEnabled?.(richStreamingEnabled);
    }
    debugLog()?.log(
      "api",
      `POST /api/bridge/settings permissionMode=${permissionMode} readOnly=${readOnly} receiptEnabled=${receiptEnabled} richStreamingEnabled=${richStreamingEnabled}`,
    );
    const savedPermissionMode = engine.getBridgePermissionMode?.()
      || normalizeBridgePermissionMode({ readOnly: engine.getBridgeReadOnly() });
    return c.json({
      ok: true,
      permissionMode: savedPermissionMode,
      readOnly: engine.getBridgeReadOnly(),
      receiptEnabled: engine.getBridgeReceiptEnabled(),
      richStreamingEnabled: engine.getBridgeRichStreamingEnabled?.() !== false,
    });
  });

  /** 停止指定平台 */
  route.post("/bridge/stop", async (c) => {
    const body = await safeJson(c);
    const { platform } = body;
    if (!platform) {
      return c.json({ error: "platform required" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;

    const agent = resolveAgentStrict(engine, c);
    resolveBridgeManager()?.stopPlatform(platform, agent.id);
    agent.updateConfig({ bridge: { [platform]: { enabled: false } } });

    debugLog()?.log("api", `POST /api/bridge/stop agent=${agent.id} platform=${platform}`);
    return c.json({ ok: true });
  });

  /** 获取最近消息日志（实时内存缓冲） */
  route.get("/bridge/messages", withReadAgent(async (c, agent) => {
    const limit = parseInt(c.req.query("limit"), 10) || 50;
    return c.json({ messages: resolveBridgeManager()?.getMessages(limit, agent.id) || [] });
  }));

  /** 获取 bridge session 列表 */
  route.get("/bridge/sessions", withReadAgent(async (c, agent) => {
    const platform = c.req.query("platform"); // optional filter
    const index = engine.getBridgeIndex(agent.id);
    const sessions = [];

    for (const [sessionKey, raw] of Object.entries(index) as [string, any][]) {
      // 兼容旧格式（字符串）和新格式（对象）
      const entry = typeof raw === "string" ? { file: raw } : raw;
      const file = entry.file;
      if (!file) continue;

      // 优先使用绑定表显式元数据，历史条目兜底解析 sessionKey
      const parsed = parseSessionKey(sessionKey);
      const plat = entry.platform || parsed.platform;
      const chatType = entry.chatType || parsed.chatType;
      const chatId = entry.chatId || parsed.chatId;

      // 按平台过滤
      if (platform && plat !== platform) continue;

      // 统一解析会话路径（兼容标准 agent.sessionDir 与历史 sessions/bridge/）
      const fp = resolveBridgeSessionFilePath(agent.sessionDir, file);
      if (!fp) continue;
      let lastActive = null;
      try {
        const stat = fs.statSync(fp);
        lastActive = stat.mtimeMs;
      } catch {}

      const identity = resolveBridgeSessionIdentity(entry, { sessionKey, parsed: { platform: plat, chatType, chatId } });
      const userId = identity.userId || (chatType === "dm" ? chatId : null);
      const aliases = identity.aliases;
      const isOwner = isBridgeOwner({ platform: plat, chatType, userId, aliases, agent });

      sessions.push({
        sessionKey, platform: plat, chatType, chatId, file, sessionPath: fp, lastActive,
        displayName: identity.displayName || null,
        avatarUrl: identity.avatarUrl || null,
        isOwner,
      });
    }

    // 按最后活跃时间排序
    sessions.sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
    return c.json({ sessions });
  }));

  /** 读取指定 bridge session 的消息 */
  route.get("/bridge/sessions/:sessionKey/messages", withReadAgent(async (c, agent) => {
    const sessionKey = c.req.param("sessionKey");
    const index = engine.getBridgeIndex(agent.id);
    const raw = index[sessionKey];
    const file = typeof raw === "string" ? raw : raw?.file;
    if (!file) return c.json({ error: "session not found", messages: [] });

    const fp = resolveBridgeSessionFilePath(agent.sessionDir, file);
    if (!fp) {
      return c.json({ error: "invalid session path", messages: [] });
    }

    try {
      const rawContent = fs.readFileSync(fp, "utf-8");
      const lines = rawContent.trim().split("\n").map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);

      const messages = [];
      for (const line of lines) {
        if (line.type !== "message") continue;
        const msg = line.message;
        if (!msg || (msg.role !== "user" && msg.role !== "assistant")) continue;

        let textContent = "";
        let mediaCount = 0;
        if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === "text" && b.text) textContent += b.text;
            if (b.type === "image") mediaCount++;
          }
        } else if (typeof msg.content === "string") {
          textContent = msg.content;
        }

        const hasMedia = mediaCount > 0;
        if (!textContent && !hasMedia) continue;
        const visibleContent = sanitizeBridgeVisibleText(textContent) || (hasMedia ? `[图片 x${mediaCount}]` : "");
        messages.push({
          role: msg.role,
          content: visibleContent,
          hasMedia,
          mediaCount,
          ts: line.timestamp || null,
        });
      }

      return c.json({ messages });
    } catch (err) {
      return c.json({ error: err.message, messages: [] });
    }
  }));

  /** 重置 bridge session（清除上下文，下次消息新建 session） */
  route.post("/bridge/sessions/:sessionKey/reset", async (c) => {
    const sessionKey = c.req.param("sessionKey");
    const agent = resolveAgentStrict(engine, c);
    const agentId = agent.id;
    const index = engine.getBridgeIndex(agentId);
    const raw = index[sessionKey];
    if (!raw) return c.json({ ok: false, error: "session not found" });

    // 保留元数据（name, avatarUrl），只删 file 引用
    const entry = typeof raw === "string" ? {} : { ...raw };
    delete entry.file;
    index[sessionKey] = entry;
    engine.saveBridgeIndex(index, agentId);

    return c.json({ ok: true });
  });

  /** 切换 bridge 通道绑定的当前会话指针（可指向任意同 Agent 标准会话，含桌面/CLI 会话） */
  route.post("/bridge/sessions/:sessionKey/switch", async (c) => {
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const sessionKey = c.req.param("sessionKey");
    const body = await safeJson(c);
    const target = typeof body?.sessionPath === "string" && body.sessionPath.trim()
      ? body.sessionPath.trim()
      : (typeof body?.file === "string" && body.file.trim() ? body.file.trim() : "");
    if (!target) {
      return c.json({ ok: false, error: "sessionPath or file is required" }, 400);
    }
    const agent = resolveAgentStrict(engine, c);
    try {
      const result = engine.switchBridgeSession(sessionKey, target, agent.id);
      return c.json(result);
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || String(err) }, 400);
    }
  });

  /** 公开给外部平台拉取的临时媒体 URL（由 MediaPublisher token 控制） */
  route.get("/bridge/media/:token", async (c) => {
    const token = c.req.param("token");
    const entry = resolveBridgeManager()?.mediaPublisher?.resolve?.(token);
    if (!entry) return c.text("media not found", 404);

    let stat;
    try {
      stat = fs.statSync(entry.realPath);
      if (!stat.isFile()) return c.text("media not found", 404);
    } catch {
      return c.text("media not found", 404);
    }
    if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
      return c.text("media too large", 413);
    }

    const filename = entry.filename || path.basename(entry.realPath);
    const disposition = isInlineBridgeMediaMime(entry.mime) ? "inline" : "attachment";
    const headers = new Headers({
      "content-type": entry.mime || "application/octet-stream",
      "content-length": String(stat.size),
      "content-disposition": `${disposition}; filename*=UTF-8''${encodeRfc5987ValueChars(filename)}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    return new Response(fs.readFileSync(entry.realPath), { headers });
  });

  /** 发送媒体到 bridge 平台（桌面端推送文件） */
  route.post("/bridge/send-media", async (c) => {
    const body = await safeJson(c);
    const { platform, chatId, filePath } = body;
    if (!platform || !chatId || !filePath) {
      return c.json({ error: "platform, chatId, filePath required" }, 400);
    }

    const agent = resolveAgentStrict(engine, c);

    // 路径安全检查：对齐 Bridge runtime 的媒体发送白名单。
    const allowedRoots = collectBridgeMediaAllowedRoots(engine, { agentId: agent.id, agent });

    // 先检查文件是否存在
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      return c.json({ error: "file not found" }, 404);
    }

    // 用 realpathSync 解析 symlink，防止 symlink 绕过白名单
    let realPath;
    try { realPath = fs.realpathSync(resolved); }
    catch { return c.json({ error: "file not found" }, 404); }

    const isSafe = isInsideBridgeMediaRoot(realPath, allowedRoots);
    if (!isSafe) {
      return c.json({ error: "path outside allowed roots" }, 403);
    }

    // Fix 3: 文件大小保护（50MB 上限，避免同步读大文件卡事件循环）
    try {
      const stat = fs.statSync(realPath);
      if (stat.size > MAX_BRIDGE_MEDIA_SIZE) {
        return c.json({ error: `file too large: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max 50MB)` }, 413);
      }
    } catch { return c.json({ error: "file not found" }, 404); }

    try {
      const manager = await ensureBridgeManager();
      if (!manager) return bridgeUnavailable(c, bridgeRef.getState?.() || {});
      if (typeof engine.registerSessionFile !== "function") {
        return c.json({ ok: false, error: "session file registry unavailable" }, 500);
      }
      if (typeof manager.sendMediaItem !== "function") {
        return c.json({ ok: false, error: "bridge media delivery unavailable" }, 500);
      }

      const sessionPath = typeof body.sessionPath === "string" && body.sessionPath.trim()
        ? body.sessionPath.trim()
        : buildBridgeManualSendSessionPath(agent.id, platform, chatId);
      const sessionFile = engine.registerSessionFile({
        sessionPath,
        filePath: realPath,
        label: typeof body.label === "string" && body.label.trim() ? body.label.trim() : path.basename(realPath),
        origin: "bridge_manual_send",
      });
      await manager.sendMediaItem(
        platform,
        chatId,
        {
          type: "session_file",
          fileId: sessionFile.id,
          ...(sessionFile.sessionId ? { sessionId: sessionFile.sessionId } : {}),
          sessionPath,
        },
        agent.id,
      );
      return c.json({ ok: true, fileId: sessionFile.id });
    } catch (err) {
      return c.json(
        { ok: false, error: err.message },
        isUnsupportedMediaDeliveryError(err) ? 422 : 500,
      );
    }
  });

  /** 测试凭证（由已注册平台插件执行） */
  route.post("/bridge/test", async (c) => {
    const body = await safeJson(c);
    const { platform, useSavedCredentials } = body;
    if (useSavedCredentials !== undefined && typeof useSavedCredentials !== "boolean") {
      return c.json({ error: "useSavedCredentials must be a boolean" }, 400);
    }
    const credentials = body.credentials && typeof body.credentials === "object"
      ? body.credentials
      : null;
    if (!platform || (!credentials && useSavedCredentials !== true)) {
      return c.json({ error: "platform and credentials required" }, 400);
    }

    const provider = bridgeProviderRegistry.get(platform);
    if (!provider) {
      return c.json({ error: "unknown or uninstalled platform plugin" }, 400);
    }
    const scopeDenied = denyWithoutScope(c, "bridge.manage");
    if (scopeDenied) return scopeDenied;
    const providedCredentials = credentials || {};
    const secretFields = collectSecretPatchPaths({ credentials: providedCredentials }, bridgeSecretKeys(platform));
    const secretDenied = denySecretMutationWithoutScope(c, secretFields);
    if (secretDenied) return secretDenied;

    try {
      const usesMaskedCredentials = hasMaskedBridgeCredentials(platform, providedCredentials);
      if (useSavedCredentials !== true && usesMaskedCredentials) {
        return c.json({ error: "masked credentials require useSavedCredentials=true" }, 400);
      }
      const shouldUseSavedCredentials = useSavedCredentials === true;
      if (shouldUseSavedCredentials && !hasExplicitAgentId(c)) {
        return c.json({ error: "agentId is required when testing saved or masked bridge credentials" }, 400);
      }
      const saved = shouldUseSavedCredentials
        ? resolveAgentStrict(engine, c).config?.bridge?.[platform] || {}
        : {};
      const effectiveCredentials = typeof provider.normalizeConfig === "function"
        ? provider.normalizeConfig(providedCredentials, shouldUseSavedCredentials ? saved : {})
        : { ...(shouldUseSavedCredentials ? saved : {}), ...resolveBridgeCredentials(platform, providedCredentials, saved) };

      if (typeof provider.testConnection !== "function") {
        return c.json({ ok: false, error: t("error.platformTestUnsupported") });
      }
      const result = await provider.testConnection(effectiveCredentials, createRouteHostServices(engine, platform));
      return c.json({
        ok: Boolean(result?.ok),
        ...(result?.error ? { error: result.error } : {}),
        info: {
          ...(result?.message ? { msg: result.message } : {}),
          ...(result?.botName ? { name: result.botName } : {}),
          ...(result?.details || {}),
        },
      });
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || String(err) });
    }
  });

  /** 通用平台插件动作代理（例如扫码登录等） */
  route.post("/bridge/platforms/:platform/action/:action", async (c) => {
    const platform = c.req.param("platform");
    const action = c.req.param("action");
    const provider = bridgeProviderRegistry.get(platform);
    if (!provider) {
      return c.json({ ok: false, error: `platform plugin not installed: ${platform}` }, 404);
    }
    const handler = provider.actions?.[action];
    if (typeof handler !== "function") {
      return c.json({ ok: false, error: `action not supported: ${platform}/${action}` }, 404);
    }
    const body = await safeJson(c);
    try {
      return c.json(await handler(body || {}, createRouteHostServices(engine, platform)));
    } catch (err: any) {
      return c.json({ ok: false, error: err?.message || String(err) }, 500);
    }
  });

  return route;
}

function resolveBridgeCredentials(platform: any, credentials: any, existing: any): any {
  return resolveSecretPatch({
    patch: credentials,
    existing,
    secretKeys: bridgeSecretKeys(platform),
  });
}

function hasMaskedBridgeCredentials(platform: any, credentials: any) {
  const secretKeys = bridgeSecretKeys(platform);
  return secretKeys.some((key) => isMaskedSecretValue(credentials?.[key]));
}

function hasExplicitAgentId(c: any) {
  return Boolean(c.req.query("agentId") || c.req.param("agentId"));
}

function bridgeSecretKeys(platform: any): string[] {
  return bridgeProviderRegistry.getSecretFieldKeys(String(platform || ""));
}

function buildBridgeManualSendSessionPath(agentId: any, platform: any, chatId: any) {
  return `bridge:${agentId}:${platform}:${chatId}`;
}

function isUnsupportedMediaDeliveryError(err: any) {
  const message = String(err?.message || err || "");
  return /暂不支持|不支持|unsupported|不能直接消费|public_url fallback|cannot deliver|does not support media input mode/i.test(message);
}

function encodeRfc5987ValueChars(value: any) {
  return encodeURIComponent(value)
    .replace(/['()]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(/\*/g, "%2A");
}

function isInlineBridgeMediaMime(mime: any) {
  const value = String(mime || "").toLowerCase();
  return value.startsWith("image/") || value.startsWith("video/");
}
