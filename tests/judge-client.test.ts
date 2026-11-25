import { describe, it, expect, vi } from "vitest";
import { JudgeClient } from "../core/judge-client.ts";
import { registerJudgeBusHandlers } from "../lib/judge/judge-bus-handlers.ts";

describe("JudgeClient", () => {
  it("runs cleanly with zero registered judge models and fails explicitly on classify", async () => {
    const client = new JudgeClient({});
    expect(client.listModels()).toEqual([]);

    const res = await client.classify({ input: "hello world" });
    expect(res.ok).toBe(false);
    expect((res as any).code).toBe("NO_JUDGE_MODEL");
    expect((res as any).error).toMatch(/No judge/i);

    const logs = client.logStore.list();
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("error");
    expect(logs[0].errorCode).toBe("NO_JUDGE_MODEL");
  });

  it("registers a judge model and returns structured label, score, threshold, passed, and logs", async () => {
    const client = new JudgeClient({});
    const unregister = client.registerModel({
      id: "safety-guard-v1",
      provider: "local-judge",
      name: "Safety Guard v1",
      labels: ["safe", "unsafe"],
      defaultThreshold: 0.7,
      handler: async ({ input }) => ({
        label: input.includes("danger") ? "unsafe" : "safe",
        score: input.includes("danger") ? 0.92 : 0.95,
        scores: input.includes("danger")
          ? { safe: 0.08, unsafe: 0.92 }
          : { safe: 0.95, unsafe: 0.05 },
      }),
    });

    const models = client.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "safety-guard-v1",
      provider: "local-judge",
      capability: "judge",
      labels: ["safe", "unsafe"],
      defaultThreshold: 0.7,
    });

    const res = await client.classify({ input: "all good here" });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.label).toBe("safe");
      expect(res.score).toBe(0.95);
      expect(res.threshold).toBe(0.7);
      expect(res.passed).toBe(true);
      expect(res.model).toBe("safety-guard-v1");
      expect(res.provider).toBe("local-judge");
    }

    const logs = client.logStore.list();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      status: "ok",
      label: "safe",
      score: 0.95,
      passed: true,
    });

    unregister();
    expect(client.listModels()).toEqual([]);
  });

  it("discovers judge models from ProviderRegistry capabilities.judge and Pi 1.6.0 classifier models", async () => {
    const piClassify = vi.fn(async () => ({
      label: "relevant",
      score: 0.84,
      predictions: [
        { label: "relevant", score: 0.84 },
        { label: "irrelevant", score: 0.16 },
      ],
    }));

    const client = new JudgeClient({
      getProviderRegistry: () => ({
        getAll: () => [
          {
            id: "openai",
            capabilities: {
              judge: {
                models: [
                  {
                    id: "gpt-4o-mini-judge",
                    labels: ["pass", "fail"],
                    defaultThreshold: 0.6,
                  },
                ],
              },
            },
          },
        ],
      }),
      getModelRegistry: () => ({
        getModelsOfType: (type: string) =>
          type === "classifier"
            ? [{ id: "bge-reranker", provider: "local-pi", name: "BGE Reranker" }]
            : [],
        classify: piClassify,
      }),
    });

    const models = client.listModels();
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai/gpt-4o-mini-judge",
      "local-pi/bge-reranker",
    ]);

    const res = await client.classify({
      model: "local-pi/bge-reranker",
      input: "check relevance",
      labels: ["relevant", "irrelevant"],
      threshold: 0.8,
    });
    expect(piClassify).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.label).toBe("relevant");
      expect(res.score).toBe(0.84);
      expect(res.passed).toBe(true);
    }
  });

  it("fails explicitly on timeout or provider error and records error logs", async () => {
    const client = new JudgeClient({});
    client.registerModel({
      id: "slow-judge",
      provider: "test",
      handler: async ({ signal }) =>
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    client.registerModel({
      id: "broken-judge",
      provider: "test",
      handler: async () => {
        throw new Error("upstream 503");
      },
    });

    const timeoutRes = await client.classify({
      model: "test/slow-judge",
      input: "test timeout",
      timeoutMs: 60,
    });
    expect(timeoutRes.ok).toBe(false);
    expect((timeoutRes as any).code).toBe("TIMEOUT");

    const errRes = await client.classify({
      model: "test/broken-judge",
      input: "test error",
    });
    expect(errRes.ok).toBe(false);
    expect((errRes as any).code).toBe("PROVIDER_ERROR");
    expect((errRes as any).error).toContain("upstream 503");

    const logs = client.logStore.list();
    expect(logs).toHaveLength(2);
    expect(logs[0].errorCode).toBe("PROVIDER_ERROR");
    expect(logs[1].errorCode).toBe("TIMEOUT");
  });

  it("wires EventBus channels judge:list-models, judge:classify, judge:logs", async () => {
    const handlers = new Map<string, (payload: any) => any>();
    const bus = {
      handle: (ch: string, fn: (payload: any) => any) => {
        handlers.set(ch, fn);
        return () => handlers.delete(ch);
      },
    };
    const client = new JudgeClient({});
    client.registerModel({
      id: "bus-judge",
      provider: "bus-provider",
      handler: async () => ({ label: "pass", score: 0.9 }),
    });

    const cleanup = registerJudgeBusHandlers(bus, { getJudgeClient: () => client });
    const listRes = await handlers.get("judge:list-models")!({});
    expect(listRes.models).toHaveLength(1);

    const classifyRes = await handlers.get("judge:classify")!({ input: "ping" });
    expect(classifyRes.ok).toBe(true);
    expect(classifyRes.label).toBe("pass");

    const logsRes = await handlers.get("judge:logs")!({});
    expect(logsRes.logs).toHaveLength(1);

    cleanup();
    expect(handlers.size).toBe(0);
  });
});
