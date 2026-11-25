import { describe, it, expect, vi } from "vitest";
import {
  evaluateIncrementalCompactionForSession,
  IncrementalCompactionLogStore,
} from "../core/incremental-compaction.ts";
import {
  getResolvedIncrementalCompactionEnabled,
  INCREMENTAL_COMPACTION_EXPERIMENT_ID,
} from "../shared/compaction-mode.ts";
import { getExperimentDefinition } from "../lib/experiments/registry.ts";

function makePrefs(initialValue?: unknown) {
  let value = initialValue;
  return {
    getExperimentValue: (id: string) =>
      id === INCREMENTAL_COMPACTION_EXPERIMENT_ID ? value : undefined,
    setValue: (next: unknown) => {
      value = next;
    },
  };
}

function makeFakeSession(messageCount: number, charPerMsg = 400) {
  let branch: any[] = [];
  for (let i = 0; i < messageCount; i++) {
    branch.push({
      id: `m_${i}`,
      type: "message",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `msg-${i}: ` + "x".repeat(charPerMsg) }],
      },
    });
  }
  return {
    isCompacting: false,
    isStreaming: false,
    model: { contextWindow: 128_000 },
    agent: {},
    sessionManager: {
      getBranch: () => branch,
    },
    _replaceBranch: (next: any[]) => {
      branch = next;
    },
  };
}

describe("Per-turn incremental compaction toggle", () => {
  it("is registered in experiments registry with default OFF", () => {
    const def = getExperimentDefinition(INCREMENTAL_COMPACTION_EXPERIMENT_ID);
    expect(def).toBeTruthy();
    expect(def.defaultValue).toBe(false);
    expect(getResolvedIncrementalCompactionEnabled(makePrefs(undefined))).toBe(false);
    expect(getResolvedIncrementalCompactionEnabled(makePrefs(false))).toBe(false);
    expect(getResolvedIncrementalCompactionEnabled(makePrefs(true))).toBe(true);
  });

  it("is a strict no-op when disabled and leaves no logs or state residue", async () => {
    const prefs = makePrefs(false);
    const logStore = new IncrementalCompactionLogStore();
    const session = makeFakeSession(20, 800);
    const compactFn = vi.fn();

    const res = await evaluateIncrementalCompactionForSession({
      session,
      sessionPath: "/tmp/s1.jsonl",
      sessionId: "s1",
      preferencesManager: prefs,
      logStore,
      options: { softTokenThreshold: 500, minBranchEntries: 4, compactFn: compactFn as any },
    });

    expect(res.triggered).toBe(false);
    expect(res.decision).toBe("skipped_disabled");
    expect(compactFn).not.toHaveBeenCalled();
    expect(logStore.list()).toHaveLength(0);
  });

  it("triggers local compaction when enabled and above threshold, reduces tokens, and logs decision", async () => {
    const prefs = makePrefs(true);
    const logStore = new IncrementalCompactionLogStore();
    const session = makeFakeSession(20, 800);

    const compactFn = vi.fn(async (sess: any) => {
      // Simulate lossy_local compaction replacing old entries with a compact summary + tail
      const oldBranch = sess.sessionManager.getBranch();
      sess._replaceBranch([
        { id: "c_1", type: "compaction", summary: "Compacted summary of earlier turns." },
        ...oldBranch.slice(-4),
      ]);
      return { summary: "Compacted summary of earlier turns." };
    });

    const res = await evaluateIncrementalCompactionForSession({
      session,
      sessionPath: "/tmp/s2.jsonl",
      sessionId: "s2",
      preferencesManager: prefs,
      logStore,
      options: { softTokenThreshold: 500, minBranchEntries: 4, compactFn: compactFn as any },
    });

    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(res.triggered).toBe(true);
    expect(res.decision).toBe("compacted");
    expect(res.tokensBefore).toBeGreaterThan(500);
    expect(res.tokensAfter).toBeLessThan(res.tokensBefore!);
    expect(res.tokensSaved).toBeGreaterThan(0);

    const logs = logStore.list();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      sessionId: "s2",
      decision: "compacted",
      enabled: true,
    });
    expect(logs[0].tokensSaved).toBeGreaterThan(0);

    // Turning the toggle OFF immediately restores original no-op behavior
    prefs.setValue(false);
    const afterOff = await evaluateIncrementalCompactionForSession({
      session,
      sessionPath: "/tmp/s2.jsonl",
      sessionId: "s2",
      preferencesManager: prefs,
      logStore,
      options: { softTokenThreshold: 1, minBranchEntries: 1, compactFn: compactFn as any },
    });
    expect(afterOff.triggered).toBe(false);
    expect(afterOff.decision).toBe("skipped_disabled");
    expect(compactFn).toHaveBeenCalledTimes(1);
    expect(logStore.list()).toHaveLength(1);
  });

  it("logs skipped_below_threshold and skipped_aborted when enabled", async () => {
    const prefs = makePrefs(true);
    const logStore = new IncrementalCompactionLogStore();
    const session = makeFakeSession(4, 100);
    const compactFn = vi.fn();

    const belowRes = await evaluateIncrementalCompactionForSession({
      session,
      sessionId: "s3",
      preferencesManager: prefs,
      logStore,
      options: { softTokenThreshold: 50_000, minBranchEntries: 12, compactFn: compactFn as any },
    });
    expect(belowRes.triggered).toBe(false);
    expect(belowRes.decision).toBe("skipped_below_threshold");

    const abortedRes = await evaluateIncrementalCompactionForSession({
      session,
      sessionId: "s3",
      preferencesManager: prefs,
      aborted: true,
      logStore,
      options: { softTokenThreshold: 1, minBranchEntries: 1, compactFn: compactFn as any },
    });
    expect(abortedRes.triggered).toBe(false);
    expect(abortedRes.decision).toBe("skipped_aborted");

    expect(compactFn).not.toHaveBeenCalled();
    expect(logStore.list()).toHaveLength(2);
  });
});
