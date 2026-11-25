/**
 * Judge / Classifier Model REST 路由
 *
 *   GET  /api/judge/models   — 列出已注册的 judge/classifier 模型
 *   POST /api/judge/classify — 调用 judge 模型进行结构化分类打分
 *   GET  /api/judge/logs     — 查询最近的 judge 调用日志
 */
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.ts";

function statusForJudgeError(code: string): number {
  switch (code) {
    case "INVALID_INPUT":
      return 400;
    case "NO_JUDGE_MODEL":
    case "MODEL_NOT_FOUND":
      return 404;
    case "TIMEOUT":
      return 504;
    case "PARSE_ERROR":
    case "PROVIDER_ERROR":
    default:
      return 502;
  }
}

export function createJudgeRoute(engine: any) {
  const route = new Hono();

  route.get("/judge/models", (c) => {
    const provider = c.req.query("provider") || undefined;
    const models = engine.judgeClient?.listModels?.({ provider }) || [];
    return c.json({ models, count: models.length });
  });

  route.post("/judge/classify", async (c) => {
    const body = await safeJson(c);
    if (!engine.judgeClient) {
      return c.json(
        { ok: false, code: "NO_JUDGE_MODEL", error: "Judge client is not initialized.", durationMs: 0 },
        503,
      );
    }
    const result = await engine.judgeClient.classify(body || {});
    if (result.ok) {
      return c.json(result, 200);
    }
    return c.json(result, statusForJudgeError(result.code) as any);
  });

  route.get("/judge/logs", (c) => {
    const limit = Number(c.req.query("limit")) || 50;
    const logs = engine.judgeClient?.logStore?.list?.(limit) || [];
    return c.json({ logs, count: logs.length });
  });

  return route;
}
