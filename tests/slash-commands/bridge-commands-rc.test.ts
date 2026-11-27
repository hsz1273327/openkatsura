import { describe, it, expect, vi } from "vitest";
import { bridgeCommands } from "../../core/slash-commands/bridge-commands.ts";
import { RcStateStore } from "../../core/slash-commands/rc-state.ts";

function cmd(name) { return bridgeCommands.find(c => c.name === name); }

function makeEngine({ sessions = [], rcState }: any = {}) {
  return {
    rcState: rcState || new RcStateStore(),
    listSessions: vi.fn(async () => sessions),
    getAgent: vi.fn(() => ({ id: "a1", config: { models: { chat: { id: "gpt-5", provider: "openai" } } } })),
    emitEvent: vi.fn(),
  };
}

function ctxBridge({ engine, rcAttached = false }) {
  const ef = engine || makeEngine();
  if (rcAttached) ef.rcState.attach("tg_dm_x@a1", "/fake.jsonl");
  return {
    engine: ef,
    sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_dm_x@a1" },
  };
}

describe("/rc command", () => {
  const c = cmd("rc");

  it("declares owner permission, core source, and generic switch alias", () => {
    expect(c).toBeTruthy();
    expect(c.permission).toBe("owner");
    expect(c.source).toBe("core");
    expect(c.aliases).toContain("switch");
  });

  it("rejects when sessionRef.kind is not bridge", async () => {
    const r: any = await c.handler({
      engine: makeEngine(),
      sessionRef: { kind: "desktop", agentId: "a1", sessionPath: "/x" },
    });
    expect(r.reply).toMatch(/只能在 bridge/);
  });

  it("returns error when rcState missing (defensive)", async () => {
    const engine = { listSessions: async () => [], getAgent: () => null, rcState: null };
    const r: any = await c.handler({
      engine,
      sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "k" },
    });
    expect(r.error).toMatch(/rc 状态/);
  });

  it("rejects in group chats and does not create pending state", async () => {
    const engine = makeEngine({
      sessions: [{ path: "/a/s1.jsonl", agentId: "a1", modified: new Date(), title: "架构讨论", messageCount: 12 }],
    });
    const r: any = await c.handler({
      engine,
      isGroup: true,
      sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_group_x@a1" },
    });
    expect(r.reply).toMatch(/私聊.*群聊里不能/);
    expect(engine.listSessions).not.toHaveBeenCalled();
    expect(engine.rcState.isPending("tg_group_x@a1")).toBe(false);
  });

  it("allows direct switching when already attached and marks the current session", async () => {
    const sessions = [
      { path: "/fake.jsonl", agentId: "a1", modified: new Date(), title: "当前会话", messageCount: 5 },
      { path: "/other.jsonl", agentId: "a1", modified: new Date(), title: "另一个会话", messageCount: 2 },
    ];
    const engine = makeEngine({ sessions });
    const ctx = ctxBridge({ engine, rcAttached: true } as any);
    const r: any = await c.handler(ctx);
    expect(r.reply).toMatch(/选择要切换的会话/);
    expect(r.reply).toContain("1. 当前会话 [当前]");
    expect(r.reply).toContain("2. 另一个会话");
    expect(engine.rcState.isPending("tg_dm_x@a1")).toBe(true);
  });

  it("replies 'no sessions' when agent has none", async () => {
    const engine = makeEngine({ sessions: [] });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/没有可切换的会话/);
    expect(engine.rcState.isPending("tg_dm_x@a1")).toBe(false);
  });

  it("lists sessions, sets pending, returns menu as reply", async () => {
    const sessions = [
      { path: "/a/s1.jsonl", agentId: "a1", modified: new Date(), title: "架构讨论", messageCount: 12 },
      { path: "/a/s2.jsonl", agentId: "a1", modified: new Date(), title: "周报写作", messageCount: 3 },
    ];
    const engine = makeEngine({ sessions });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/选择要切换的会话/);
    expect(r.reply).toContain("1. 架构讨论");
    expect(r.reply).toContain("2. 周报写作");
    expect(r.reply).toMatch(/\/exitrc/);
    expect(engine.rcState.isPending("tg_dm_x@a1")).toBe(true);
    const p = engine.rcState.getPending("tg_dm_x@a1");
    expect(p.type).toBe("rc-select");
    expect(p.options).toHaveLength(2);
    expect(p.options[0].path).toBe("/a/s1.jsonl");
  });

  it("titleless session uses '未命名 (date)' fallback", async () => {
    const engine = makeEngine({
      sessions: [{ path: "/a/s.jsonl", agentId: "a1", modified: new Date(), title: null, messageCount: 1 }],
    });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/未命名/);
  });

  it("filters to agentId (other agent's sessions not shown)", async () => {
    const engine = makeEngine({
      sessions: [
        { path: "/mine.jsonl", agentId: "a1", modified: new Date(), title: "mine", messageCount: 0 },
        { path: "/theirs.jsonl", agentId: "other", modified: new Date(), title: "theirs", messageCount: 0 },
      ],
    });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toContain("mine");
    expect(r.reply).not.toContain("theirs");
  });

  it("filters out desktop sessions already attached by another bridge session", async () => {
    const rcState = new RcStateStore();
    rcState.attach("tg_dm_other@a1", "/busy.jsonl");
    const engine = makeEngine({
      rcState,
      sessions: [
        { path: "/busy.jsonl", agentId: "a1", modified: new Date(), title: "busy", messageCount: 0 },
        { path: "/free.jsonl", agentId: "a1", modified: new Date(), title: "free", messageCount: 0 },
      ],
    });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toContain("1. free");
    expect(r.reply).not.toContain("busy");
    expect(engine.rcState.getPending("tg_dm_x@a1")?.options).toEqual([
      { path: "/free.jsonl", title: "free" },
    ]);
  });

  it("caps at 10 sessions", async () => {
    const sessions = Array.from({ length: 15 }, (_, i) =>
      ({ path: `/s${i}.jsonl`, agentId: "a1", modified: new Date(Date.now() - i * 1000), title: `T${i}`, messageCount: 0 }));
    const engine = makeEngine({ sessions });
    const r: any = await c.handler(ctxBridge({ engine }));
    const matches = r.reply.match(/^\d+\./gm) || [];
    expect(matches.length).toBe(10);
    expect(r.reply).toContain("10. T9");
    expect(r.reply).not.toMatch(/^11\./m);
  });
});

describe("/exitrc command", () => {
  const c = cmd("exitrc");

  it("declares owner permission, core source, and generic detach alias", () => {
    expect(c).toBeTruthy();
    expect(c.permission).toBe("owner");
    expect(c.source).toBe("core");
    expect(c.aliases).toContain("detach");
  });

  it("rejects when sessionRef.kind is not bridge", async () => {
    const r: any = await c.handler({
      engine: makeEngine(),
      sessionRef: { kind: "desktop", agentId: "a1", sessionPath: "/x" },
    });
    expect(r.reply).toMatch(/只能在 bridge/);
  });

  it("replies 'not attached' when nothing to exit", async () => {
    const engine = makeEngine();
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/未处于接管状态/);
  });

  it("clears attachment and confirms exit", async () => {
    const engine = makeEngine();
    engine.rcState.attach("tg_dm_x@a1", "/some.jsonl");
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/已退出接管/);
    expect(engine.rcState.isAttached("tg_dm_x@a1")).toBe(false);
  });

  it("emits bridge_rc_detached event when exiting an attached state (Phase 2-D)", async () => {
    const engine = makeEngine();
    engine.rcState.attach("tg_dm_x@a1", "/desktop.jsonl");
    await c.handler(ctxBridge({ engine }));
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bridge_rc_detached",
        sessionKey: "tg_dm_x@a1",
        sessionPath: "/desktop.jsonl",
      }),
      "/desktop.jsonl",
    );
  });

  it("does NOT emit detached event if there was no attachment (only pending)", async () => {
    // 只清 pending、没真正 attached 过 → 没必要发事件（桌面本来也没挂横幅）
    const engine = makeEngine();
    engine.rcState.setPending("tg_dm_x@a1", { type: "rc-select", promptText: "p", options: [] });
    await c.handler(ctxBridge({ engine }));
    expect(engine.emitEvent).not.toHaveBeenCalled();
  });

  it("clears pending-selection too when user exits during selection", async () => {
    const engine = makeEngine();
    engine.rcState.setPending("tg_dm_x@a1", { type: "rc-select", promptText: "p", options: [] });
    const r: any = await c.handler(ctxBridge({ engine }));
    expect(r.reply).toMatch(/已退出接管/);
    expect(engine.rcState.isPending("tg_dm_x@a1")).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Phase 2-E: 接管态下的命令语义改写（守卫 + redirect）
// ────────────────────────────────────────────────────────────

function ctxWithAttachedAndOps({ desktopPath = "/attached/s.jsonl", sessionOpsOverrides = {} } = {}) {
  const engine = makeEngine();
  engine.rcState.attach("tg_dm_x@a1", desktopPath);
  return {
    engine,
    desktopPath,
    ctx: {
      engine,
      sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_dm_x@a1" },
      reply: vi.fn(async () => {}),
      sessionOps: {
        isStreaming: vi.fn(() => false),
        abort: vi.fn(async () => true),
        rotate: vi.fn(async () => ({ status: "rotated" })),
        delete: vi.fn(async () => ({ status: "deleted" })),
        compact: vi.fn(async () => ({ tokensBefore: 9000, tokensAfter: 3200, contextWindow: 128000 })),
        ...sessionOpsOverrides,
      },
    },
  };
}

describe("/new detaches cleanly and /reset stays guarded during attachment", () => {
  it("/new 绑定桌面会话时安全解绑并开启新会话，不破坏原会话", async () => {
    const { ctx, engine, desktopPath } = ctxWithAttachedAndOps();
    (engine as any).unbindBridgeSessionPointer = vi.fn();
    const r: any = await cmd("new").handler(ctx);
    expect(r.reply).toMatch(/已开启新会话.*保留/);
    expect(engine.rcState.isAttached("tg_dm_x@a1")).toBe(false);
    expect(engine.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "bridge_rc_detached",
        sessionKey: "tg_dm_x@a1",
        sessionPath: desktopPath,
      }),
      desktopPath,
    );
    expect((engine as any).unbindBridgeSessionPointer).toHaveBeenCalledWith("tg_dm_x@a1", "a1", desktopPath);
    expect(ctx.sessionOps.rotate).not.toHaveBeenCalled();
  });

  it("/reset 绑定桌面会话时拒绝并提示 /new 或 /exitrc", async () => {
    const { ctx } = ctxWithAttachedAndOps();
    const r: any = await cmd("reset").handler(ctx);
    expect(r.reply).toMatch(/禁止使用 \/reset.*\/exitrc/);
    expect(ctx.sessionOps.delete).not.toHaveBeenCalled();
  });

  it("/loop 绑定桌面会话时重定向到当前桌面会话", async () => {
    const { ctx, engine, desktopPath } = ctxWithAttachedAndOps();
    const targetFromSessionRef = vi.fn(async () => ({ kind: "desktop", sessionId: "sid-desk" }));
    const start = vi.fn(async () => ({ status: "running" }));
    (engine as any).loopController = { targetFromSessionRef, start };
    (engine as any).getSessionIdForPath = vi.fn(() => "sid-desk");

    const r: any = await cmd("loop").handler({ ...ctx, args: "持续巡检" });
    expect(targetFromSessionRef).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "desktop",
        agentId: "a1",
        sessionPath: desktopPath,
        sessionId: "sid-desk",
      }),
      { ensure: true },
    );
    expect(start).toHaveBeenCalledWith({ kind: "desktop", sessionId: "sid-desk" }, "持续巡检");
    expect(r.reply).toMatch(/循环已启动/);
  });

  it("/new 未接管时正常执行", async () => {
    // 回归 sanity：没有 attachment 时语义未变
    const engine = makeEngine();
    const ctx = {
      engine,
      sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_dm_x@a1" },
      sessionOps: { rotate: vi.fn(async () => ({ status: "rotated" })) },
    };
    const r: any = await cmd("new").handler(ctx);
    expect(r.reply).toMatch(/已开启新会话/);
    expect(ctx.sessionOps.rotate).toHaveBeenCalledOnce();
  });
});

describe("/stop redirects to attached desktop session", () => {
  it("接管态下 /stop 调 abort({kind:'desktop', sessionPath})，不是 bridge", async () => {
    const { ctx, desktopPath } = ctxWithAttachedAndOps();
    await cmd("stop").handler(ctx);
    expect(ctx.sessionOps.abort).toHaveBeenCalledWith(expect.objectContaining({
      kind: "desktop",
      agentId: "a1",
      sessionPath: desktopPath,
    }));
  });

  it("未接管时 /stop 保持原 bridge ref", async () => {
    const engine = makeEngine();
    const ctx = {
      engine,
      sessionRef: { kind: "bridge", agentId: "a1", sessionKey: "tg_dm_x@a1" },
      sessionOps: { abort: vi.fn(async () => true) },
    };
    await cmd("stop").handler(ctx);
    expect(ctx.sessionOps.abort).toHaveBeenCalledWith(expect.objectContaining({
      kind: "bridge",
      sessionKey: "tg_dm_x@a1",
    }));
  });
});

describe("/compact redirects to attached desktop session", () => {
  it("接管态下 /compact 调 compact({kind:'desktop'})", async () => {
    const { ctx, desktopPath } = ctxWithAttachedAndOps();
    await cmd("compact").handler(ctx);
    expect(ctx.sessionOps.compact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "desktop",
      sessionPath: desktopPath,
    }));
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect((ctx.reply.mock.calls as any)[0][0]).toMatch(/正在压缩/);
    expect((ctx.reply.mock.calls as any)[1][0]).toMatch(/9000.*3200/);
  });

  it("绑定桌面会话时 /fresh-compact 与桌面端统一行为，调 freshCompact({kind:'desktop'})", async () => {
    const freshCompact = vi.fn(async () => ({ tokensBefore: 8000, tokensAfter: 2400, contextWindow: 128000, fresh: true }));
    const { ctx, desktopPath } = ctxWithAttachedAndOps({
      sessionOpsOverrides: { freshCompact },
    });
    const r: any = await cmd("fresh-compact").handler(ctx);
    expect(r).toEqual({ silent: true });
    expect(freshCompact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "desktop",
      agentId: "a1",
      sessionPath: desktopPath,
    }));
    expect(ctx.reply).toHaveBeenCalledTimes(2);
    expect((ctx.reply.mock.calls as any)[0][0]).toMatch(/正在 fresh-compact/);
    expect((ctx.reply.mock.calls as any)[1][0]).toMatch(/8000.*2400/);
  });
});
