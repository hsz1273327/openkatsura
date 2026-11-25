/**
 * EventBus handlers for the unified `judge` capability.
 *
 * Exposes:
 *   - `judge:list-models`
 *   - `judge:classify`
 *   - `judge:logs`
 */
import type { JudgeClient } from "../../core/judge-client.ts";

export function registerJudgeBusHandlers(
  bus: any,
  deps: { getJudgeClient: () => JudgeClient | null },
): () => void {
  if (!bus || typeof bus.handle !== "function") return () => {};

  const unsubs: Array<() => void> = [];

  const register = (channel: string, handler: (payload: any) => any) => {
    const unsub = bus.handle(channel, handler);
    if (typeof unsub === "function") unsubs.push(unsub);
  };

  register("judge:list-models", (payload: any = {}) => {
    const client = deps.getJudgeClient();
    if (!client) return { models: [] };
    return { models: client.listModels({ provider: payload?.provider }) };
  });

  register("judge:classify", async (payload: any = {}) => {
    const client = deps.getJudgeClient();
    if (!client) {
      return {
        ok: false,
        code: "NO_JUDGE_MODEL",
        error: "Judge client is not initialized.",
        durationMs: 0,
      };
    }
    return await client.classify(payload);
  });

  register("judge:logs", (payload: any = {}) => {
    const client = deps.getJudgeClient();
    if (!client) return { logs: [] };
    return { logs: client.logStore.list(payload?.limit) };
  });

  return () => {
    for (const unsub of unsubs) {
      try { unsub(); } catch { /* ignore */ }
    }
  };
}
