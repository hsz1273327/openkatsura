import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { createBridgeRoute } from "../server/routes/bridge.ts";
import { BridgeManager } from "../lib/bridge/bridge-manager.ts";
import { bridgeProviderRegistry } from "../lib/bridge/bridge-provider-registry.ts";
import { BridgeSessionManager } from "../core/bridge-session-manager.ts";
import { RcStateStore } from "../core/slash-commands/rc-state.ts";
import {
  extractWorkstationIdFromSessionKey,
  parseSessionKey,
  scopeSessionKeyToWorkstation,
} from "../lib/bridge/session-key.ts";

describe("bridge workstations", () => {
  const registeredIds: string[] = [];

  beforeEach(() => {
    bridgeProviderRegistry.register({
      id: "qq",
      displayName: "QQ",
      connectionMode: "websocket",
      sessionPrefixes: ["qq_dm_", "qq_group_"],
      secretFields: ["appSecret"],
      configSchema: [
        { key: "appID", label: "AppID", type: "string", required: true },
        { key: "appSecret", label: "AppSecret", type: "secret", required: true },
      ],
      getCredentials: (cfg: any) => (cfg?.enabled && cfg?.appID && cfg?.appSecret ? { appID: cfg.appID, appSecret: cfg.appSecret } : null),
      ownerSessionKey: (ownerId: string, agentId: string) => `qq_dm_${ownerId}@${agentId}`,
      createAdapter: vi.fn((_creds, _onMessage, _hooks, agentId) => ({
        agentId,
        sendReply: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn(),
      })),
      testConnection: vi.fn(async (creds: any) => ({ ok: creds?.appSecret === "secret-ok", botName: "QQBot" })),
    } as any, { owner: "test-workstation-qq" });
    registeredIds.push("qq");
  });

  afterEach(() => {
    for (const id of registeredIds.splice(0)) {
      bridgeProviderRegistry.unregister(id);
    }
  });

  function makeApp() {
    let workstations: any[] = [];
    const hanaAgent = { id: "hana", agentName: "Hana", sessionDir: os.tmpdir(), config: { bridge: {} } };
    const katsuraAgent = { id: "katsura", agentName: "Katsura", sessionDir: os.tmpdir(), config: { bridge: {} } };
    const engine: any = {
      currentAgentId: "hana",
      getAgent: vi.fn((id) => (id === "hana" ? hanaAgent : id === "katsura" ? katsuraAgent : null)),
      getBridgeIndex: vi.fn(() => ({})),
      getBridgeReadOnly: vi.fn(() => false),
      getBridgePermissionMode: vi.fn(() => "auto"),
      getBridgeReceiptEnabled: vi.fn(() => true),
      getBridgeRichStreamingEnabled: vi.fn(() => true),
      getBridgeWorkstations: vi.fn(() => workstations.map((w) => ({ ...w, credentials: { ...(w.credentials || {}) } }))),
      saveBridgeWorkstations: vi.fn((next) => {
        workstations = next.map((w: any) => ({ ...w, credentials: { ...(w.credentials || {}) } }));
        return workstations;
      }),
    };
    const bridgeManager = {
      getStatus: vi.fn(() => ({})),
      getMessages: vi.fn(() => []),
      getWorkstationStatus: vi.fn(() => ({ status: "disconnected", error: null })),
      startWorkstation: vi.fn(),
      stopWorkstation: vi.fn(),
      updateWorkstationRuntimePolicy: vi.fn(),
    };
    const app = new Hono();
    app.route("/api", createBridgeRoute(engine, bridgeManager));
    return { app, engine, bridgeManager };
  }

  it("creates multiple workstations on the same platform bound to different agents and rejects changing bindings later", async () => {
    const { app, bridgeManager } = makeApp();

    const r1 = await app.request("/api/bridge/workstations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "qq", agentId: "hana", name: "Personal QQ" }),
    });
    const d1 = await r1.json();
    expect(r1.status).toBe(201);
    expect(d1.workstation).toMatchObject({
      name: "Personal QQ",
      platform: "qq",
      agentId: "hana",
      enabled: false,
      allowGuests: false,
    });

    const r2 = await app.request("/api/bridge/workstations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "qq", agentId: "katsura", name: "Work QQ" }),
    });
    const d2 = await r2.json();
    expect(r2.status).toBe(201);
    expect(d2.workstation.id).not.toBe(d1.workstation.id);

    // Immutability check: changing platform or agentId must be rejected with 400
    const badPlatform = await app.request(`/api/bridge/workstations/${d1.workstation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "synology-chat" }),
    });
    expect(badPlatform.status).toBe(400);

    const badAgent = await app.request(`/api/bridge/workstations/${d1.workstation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "katsura" }),
    });
    expect(badAgent.status).toBe(400);

    // Credentials + enable + saved-secret test + delete
    const patchRes = await app.request(`/api/bridge/workstations/${d1.workstation.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        credentials: { appID: "app-1", appSecret: "secret-ok" },
        enabled: true,
        allowGuests: true,
        owner: "u-owner",
      }),
    });
    expect(patchRes.status).toBe(200);
    expect(bridgeManager.startWorkstation).toHaveBeenCalledWith(expect.objectContaining({
      id: d1.workstation.id,
      platform: "qq",
      agentId: "hana",
      enabled: true,
      allowGuests: true,
      owner: "u-owner",
    }));

    const testRes = await app.request(`/api/bridge/workstations/${d1.workstation.id}/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credentials: { appID: "app-1" }, useSavedCredentials: true }),
    });
    expect(await testRes.json()).toMatchObject({ ok: true, info: { name: "QQBot" } });

    const delRes = await app.request(`/api/bridge/workstations/${d1.workstation.id}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect(bridgeManager.stopWorkstation).toHaveBeenCalledWith(d1.workstation.id);
    const listRes = await app.request("/api/bridge/workstations");
    const listBody = await listRes.json();
    expect(listBody.workstations.map((w: any) => w.id)).toEqual([d2.workstation.id]);
  });

  it("isolates runtime adapters, owner policy, and allowGuests per workstation in BridgeManager", async () => {
    vi.useFakeTimers();
    try {
      const hanaAgent = { id: "hana", agentName: "Hana", sessionDir: os.tmpdir(), config: { bridge: {} } };
      const engine: any = {
        getAgent: vi.fn((id) => (id === "hana" ? hanaAgent : null)),
        getBridgeReceiptEnabled: vi.fn(() => false),
        getBridgeRichStreamingEnabled: vi.fn(() => true),
        isBridgeSessionStreaming: vi.fn(() => false),
        abortBridgeSession: vi.fn(async () => false),
        steerBridgeSession: vi.fn(() => false),
        bridgeSessionManager: { readIndex: () => ({}), writeIndex: () => {} },
        agentName: "Hana",
        hanakoHome: os.tmpdir(),
        currentAgentId: "hana",
      };
      const hub: any = {
        send: vi.fn().mockResolvedValue({ text: "ok", toolMedia: [], error: null, truncated: false }),
        eventBus: { emit: vi.fn() },
      };
      const bm = new BridgeManager({ engine, hub });
      bm.blockStreaming = false;

      bm.startWorkstation({
        id: "ws_1",
        platform: "qq",
        agentId: "hana",
        enabled: true,
        allowGuests: false,
        owner: "owner-1",
        credentials: { appID: "id1", appSecret: "sec1" },
      });
      bm.startWorkstation({
        id: "ws_2",
        platform: "qq",
        agentId: "hana",
        enabled: true,
        allowGuests: true,
        owner: "owner-2",
        credentials: { appID: "id2", appSecret: "sec2" },
      });

      const entry1 = bm._findPlatformEntry("qq", "hana", "ws_1");
      const entry2 = bm._findPlatformEntry("qq", "hana", "ws_2");
      expect(entry1?.workstationId).toBe("ws_1");
      expect(entry2?.workstationId).toBe("ws_2");
      expect(entry1?.adapter).not.toBe(entry2?.adapter);

      // Guest message on ws_1 is blocked (allowGuests: false)
      await bm._handleMessage("qq", {
        workstationId: "ws_1",
        agentId: "hana",
        sessionKey: "qq_dm_guestA@hana",
        text: "hi from guest on ws_1",
        userId: "guestA",
        chatId: "guestA",
        isGroup: false,
      });
      await vi.advanceTimersByTimeAsync(2500);
      expect(hub.send).not.toHaveBeenCalled();

      // Guest message on ws_2 is allowed (allowGuests: true)
      await bm._handleMessage("qq", {
        workstationId: "ws_2",
        agentId: "hana",
        sessionKey: "qq_dm_guestB@hana",
        text: "hi from guest on ws_2",
        userId: "guestB",
        chatId: "guestB",
        isGroup: false,
      });
      await vi.advanceTimersByTimeAsync(2500);
      expect(hub.send).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes and parses workstation suffixes cleanly while preserving legacy sessionKey shape", () => {
    expect(scopeSessionKeyToWorkstation("qq_dm_owner@hana", "ws_1")).toBe("qq_dm_owner@hana#ws_1");
    expect(scopeSessionKeyToWorkstation("qq_dm_owner@hana#ws_1", "ws_2")).toBe("qq_dm_owner@hana#ws_1");
    expect(scopeSessionKeyToWorkstation("qq_dm_owner@hana", null)).toBe("qq_dm_owner@hana");

    expect(extractWorkstationIdFromSessionKey("qq_dm_owner@hana#ws_1")).toBe("ws_1");
    expect(extractWorkstationIdFromSessionKey("qq_dm_owner@hana")).toBeNull();

    expect(parseSessionKey("qq_dm_owner@hana#ws_1")).toEqual({
      platform: "qq",
      chatType: "dm",
      chatId: "owner",
      agentId: "hana",
      workstationId: "ws_1",
    });
    expect(parseSessionKey("qq_dm_owner@hana")).toEqual({
      platform: "qq",
      chatType: "dm",
      chatId: "owner",
      agentId: "hana",
    });
    expect(parseSessionKey("qq_dm_owner")).toEqual({
      platform: "qq",
      chatType: "dm",
      chatId: "owner",
      agentId: null,
    });
  });

  it("binds independent session pointers and rc mirror targets for 3 QQ workstations on the same agent", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "katsura-ws-pointers-"));
    const sessionDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    vi.useFakeTimers();
    try {
      const s1 = path.join(sessionDir, "session-1.jsonl");
      const s2 = path.join(sessionDir, "session-2.jsonl");
      const s3 = path.join(sessionDir, "session-3.jsonl");
      const s4 = path.join(sessionDir, "session-4.jsonl");
      for (const fp of [s1, s2, s3, s4]) {
        fs.writeFileSync(fp, '{"type":"session","id":"s"}\n');
      }

      const hanaAgent = { id: "hana", agentName: "Hana", sessionDir, config: { bridge: {} } };
      const bsm = new BridgeSessionManager({
        getAgentById: (id: string) => (id === "hana" ? hanaAgent : null),
      });
      const rcState = new RcStateStore();
      const createdQueue = [s1, s2, s3];
      const hub: any = {
        send: vi.fn().mockResolvedValue({ text: "ok", toolMedia: [], error: null, truncated: false }),
        eventBus: { emit: vi.fn() },
        subscribe: vi.fn(() => () => {}),
      };
      const engine: any = {
        rcState,
        agentName: "Hana",
        hanakoHome: tmpRoot,
        currentAgentId: "hana",
        bridgeSessionManager: bsm,
        getAgent: vi.fn((id) => (id === "hana" ? hanaAgent : null)),
        getBridgeReceiptEnabled: vi.fn(() => false),
        getBridgeRichStreamingEnabled: vi.fn(() => true),
        isSessionStreaming: vi.fn(() => false),
        getSessionByPath: vi.fn(() => ({})),
        resolveBridgeDesktopSessionPath: vi.fn((sessionKey: string, agentId: string) => {
          const attached = rcState.getAttachment(sessionKey)?.desktopSessionPath;
          if (attached) return attached;
          return agentId === "hana" ? bsm.resolveSessionPathForSessionKey(sessionKey, hanaAgent) : null;
        }),
        switchBridgeSession: vi.fn((sessionKey: string, sessionPath: string, agentId: string, meta: any = {}) => {
          const res = bsm.switchSessionForSessionKey({
            sessionKey,
            sessionPath,
            agentId,
            meta: meta?.indexMeta || null,
          });
          const workstationId = meta.workstationId || parseSessionKey(sessionKey).workstationId || null;
          rcState.attach(sessionKey, res.sessionPath, {
            platform: meta.platform || "qq",
            chatId: meta.chatId || null,
            agentId,
            workstationId,
          });
          return res;
        }),
        ensureBridgeOwnerSession: vi.fn(async (sessionKey: string, agentId: string, opts: any = {}) => {
          const existing = engine.resolveBridgeDesktopSessionPath(sessionKey, agentId);
          if (existing) return { sessionPath: existing, created: false };
          const target = createdQueue.shift();
          if (!target) return null;
          const workstationId = opts.workstationId || parseSessionKey(sessionKey).workstationId || null;
          engine.switchBridgeSession(sessionKey, target, agentId, {
            platform: opts.platform || "qq",
            chatId: opts.chatId || null,
            workstationId,
            indexMeta: {
              platform: opts.platform || "qq",
              chatType: "dm",
              role: "owner",
              chatId: opts.chatId || "owner-1",
              ...(workstationId ? { workstationId } : {}),
            },
          });
          return { sessionPath: target, created: true };
        }),
        executeAttachedDesktopSessionTurn: vi.fn(async () => ({ text: "reply ok", attachments: [], toolMedia: [] })),
        emitEvent: vi.fn(),
      };

      const capturedOnMessage: Array<(msg: any) => Promise<void> | void> = [];
      const spec = bridgeProviderRegistry.get("qq")!;
      vi.spyOn(spec, "createAdapter").mockImplementation((_creds, onMessage, _hooks, agentId) => {
        capturedOnMessage.push(onMessage);
        return {
          agentId,
          sendReply: vi.fn().mockResolvedValue(undefined),
          stop: vi.fn(),
        } as any;
      });

      const bm = new BridgeManager({ engine, hub });
      bm.blockStreaming = false;
      for (const id of ["ws_1", "ws_2", "ws_3"]) {
        bm.startWorkstation({
          id,
          platform: "qq",
          agentId: "hana",
          enabled: true,
          allowGuests: false,
          owner: "owner-1",
          credentials: { appID: `app-${id}`, appSecret: "sec" },
        });
      }
      expect(capturedOnMessage).toHaveLength(3);

      // Same owner sends a DM through each of the 3 QQ workstations targeting the same agent
      for (let i = 0; i < 3; i++) {
        await capturedOnMessage[i]({
          sessionKey: "qq_dm_owner-1@hana",
          text: `hello bot ${i + 1}`,
          userId: "owner-1",
          chatId: `chat-${i + 1}`,
          isGroup: false,
        });
      }
      await vi.advanceTimersByTimeAsync(2500);

      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_1", hanaAgent)).toBe(s1);
      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_2", hanaAgent)).toBe(s2);
      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_3", hanaAgent)).toBe(s3);

      // Each session path mirrors back to its own workstation's adapter
      const adapter1 = bm._findPlatformEntry("qq", "hana", "ws_1")?.adapter;
      const adapter2 = bm._findPlatformEntry("qq", "hana", "ws_2")?.adapter;
      const adapter3 = bm._findPlatformEntry("qq", "hana", "ws_3")?.adapter;
      expect(bm._resolveRcMirrorTarget(s1)?.adapter).toBe(adapter1);
      expect(bm._resolveRcMirrorTarget(s2)?.adapter).toBe(adapter2);
      expect(bm._resolveRcMirrorTarget(s3)?.adapter).toBe(adapter3);

      // Switching ws_1 to session-4 leaves ws_2 and ws_3 pointers & mirror targets intact
      engine.switchBridgeSession("qq_dm_owner-1@hana#ws_1", s4, "hana", {
        platform: "qq",
        chatId: "chat-1",
        workstationId: "ws_1",
      });
      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_1", hanaAgent)).toBe(s4);
      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_2", hanaAgent)).toBe(s2);
      expect(bsm.resolveSessionPathForSessionKey("qq_dm_owner-1@hana#ws_3", hanaAgent)).toBe(s3);
      expect(bm._resolveRcMirrorTarget(s4)?.adapter).toBe(adapter1);
      expect(bm._resolveRcMirrorTarget(s2)?.adapter).toBe(adapter2);
      expect(bm._resolveRcMirrorTarget(s3)?.adapter).toBe(adapter3);
    } finally {
      vi.useRealTimers();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
