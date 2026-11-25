/**
 * Judge / Classifier Model Client & Log Store
 *
 * Provides a lightweight, structured classification capability (`judge`) alongside
 * `chat` and `media`. Discovers judge models from:
 *   1. Programmatically registered judge models (plugins / runtime)
 *   2. ProviderRegistry provider definitions declaring `capabilities.judge`
 *   3. ProviderCatalog user-configured `capabilities.judge`
 *   4. Pi SDK 1.6.0 native `classifier` models (`modelRegistry.getModelsOfType("classifier")`)
 *
 * When zero judge models are registered, the host continues running normally and
 * explicit calls return a structured `NO_JUDGE_MODEL` error (never silent null).
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { callText } from "./llm-client.ts";
import { callTextConfigFromResolvedModel } from "./model-execution-config.ts";
import { parseModelRef } from "../shared/model-ref.ts";

export const DEFAULT_JUDGE_LABELS = Object.freeze(["pass", "fail"] as const);
export const DEFAULT_JUDGE_THRESHOLD = 0.5;
export const DEFAULT_JUDGE_MAX_INPUT_CHARS = 16_000;
export const DEFAULT_JUDGE_TIMEOUT_MS = 15_000;

export interface JudgeModelDescriptor {
  id: string;
  name: string;
  provider: string;
  capability: "judge";
  labels: string[];
  defaultThreshold: number;
  maxInputChars: number;
  input: string[];
  source: "plugin" | "provider" | "catalog" | "pi_classifier";
  /** Optional custom classifier handler (used by plugins or tests). */
  handler?: JudgeCustomHandler;
  /** Underlying Pi SDK classifier model object when source === "pi_classifier". */
  _piModel?: any;
}

export type JudgeCustomHandler = (
  req: {
    input: string;
    labels: string[];
    threshold: number;
    instructions?: string;
    signal: AbortSignal;
    model: JudgeModelDescriptor;
  },
) => Promise<{ label: string; score: number; scores?: Record<string, number>; raw?: unknown }>;

export interface JudgeClassifyRequest {
  input: string | { text?: string; prompt?: string; context?: string };
  model?: string;
  provider?: string;
  labels?: string[];
  threshold?: number;
  timeoutMs?: number;
  instructions?: string;
  pluginId?: string;
}

export interface JudgeClassifySuccess {
  ok: true;
  label: string;
  score: number;
  scores: Record<string, number>;
  threshold: number;
  passed: boolean;
  model: string;
  provider: string;
  durationMs: number;
  raw?: unknown;
}

export interface JudgeClassifyFailure {
  ok: false;
  code:
    | "NO_JUDGE_MODEL"
    | "MODEL_NOT_FOUND"
    | "INVALID_INPUT"
    | "TIMEOUT"
    | "PROVIDER_ERROR"
    | "PARSE_ERROR";
  error: string;
  model?: string;
  provider?: string;
  durationMs: number;
}

export type JudgeClassifyResult = JudgeClassifySuccess | JudgeClassifyFailure;

export interface JudgeLogEntry {
  id: string;
  timestamp: string;
  status: "ok" | "error";
  model?: string;
  provider?: string;
  label?: string;
  score?: number;
  threshold?: number;
  passed?: boolean;
  durationMs: number;
  inputLength: number;
  errorCode?: string;
  error?: string;
  callerPluginId?: string;
}

export class JudgeLogStore {
  private readonly _entries: JudgeLogEntry[] = [];
  private readonly _maxEntries: number;
  private readonly _logFilePath: string | null;

  constructor(opts: { maxEntries?: number; hanakoHome?: string | null } = {}) {
    this._maxEntries = Math.max(10, opts.maxEntries ?? 200);
    this._logFilePath = opts.hanakoHome
      ? path.join(opts.hanakoHome, "logs", "judge-calls.jsonl")
      : null;
  }

  record(entry: Omit<JudgeLogEntry, "id" | "timestamp">): JudgeLogEntry {
    const full: JudgeLogEntry = {
      id: `jdg_${crypto.randomBytes(6).toString("hex")}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    this._entries.push(full);
    if (this._entries.length > this._maxEntries) {
      this._entries.splice(0, this._entries.length - this._maxEntries);
    }
    if (this._logFilePath) {
      try {
        fs.mkdirSync(path.dirname(this._logFilePath), { recursive: true });
        fs.appendFileSync(this._logFilePath, JSON.stringify(full) + "\n", "utf-8");
      } catch {
        // Disk logging must never fail classification
      }
    }
    return full;
  }

  list(limit = 50): JudgeLogEntry[] {
    const n = Math.max(1, Math.min(this._maxEntries, Number(limit) || 50));
    return this._entries.slice(-n).reverse();
  }

  clear(): void {
    this._entries.length = 0;
  }
}

function normalizeLabels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_JUDGE_LABELS];
  const cleaned = raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return cleaned.length > 0 ? [...new Set(cleaned)] : [...DEFAULT_JUDGE_LABELS];
}

function normalizeThreshold(raw: unknown, fallback = DEFAULT_JUDGE_THRESHOLD): number {
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function extractInputText(input: JudgeClassifyRequest["input"]): string {
  if (typeof input === "string") return input.trim();
  if (input && typeof input === "object") {
    const parts: string[] = [];
    if (typeof input.context === "string" && input.context.trim()) {
      parts.push(`Context:\n${input.context.trim()}`);
    }
    if (typeof input.prompt === "string" && input.prompt.trim()) {
      parts.push(`Prompt:\n${input.prompt.trim()}`);
    }
    if (typeof input.text === "string" && input.text.trim()) {
      parts.push(input.text.trim());
    }
    return parts.join("\n\n").trim();
  }
  return "";
}

function modelKey(provider: string, id: string): string {
  return `${provider}\0${id}`;
}

function buildJudgePrompt(input: string, labels: string[], instructions?: string): string {
  const labelList = labels.map((l) => JSON.stringify(l)).join(", ");
  const extra = instructions?.trim() ? `\nAdditional criteria:\n${instructions.trim()}\n` : "";
  return [
    "You are a strict classifier/judge model.",
    `Allowed labels: [${labelList}].`,
    extra,
    "Evaluate the input below and respond with ONLY a single JSON object matching:",
    `{"label": "<one of the allowed labels>", "score": <number between 0 and 1>, "scores": {"<label>": <number between 0 and 1>}}`,
    "Do not include markdown fences or any extra commentary.",
    "",
    "Input:",
    input,
  ].join("\n");
}

function parseJudgeJsonOutput(
  text: string,
  labels: string[],
): { label: string; score: number; scores: Record<string, number>; raw: unknown } | null {
  const trimmed = (text || "").trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;

  const rawLabel = typeof parsed.label === "string" ? parsed.label.trim() : "";
  if (!rawLabel) return null;
  const matchedLabel = labels.find((l) => l.toLowerCase() === rawLabel.toLowerCase()) || rawLabel;

  const rawScore = Number(parsed.score);
  const scores: Record<string, number> = {};
  if (parsed.scores && typeof parsed.scores === "object" && !Array.isArray(parsed.scores)) {
    for (const [k, v] of Object.entries(parsed.scores)) {
      const n = Number(v);
      if (Number.isFinite(n)) {
        scores[k] = Math.max(0, Math.min(1, n));
      }
    }
  }

  let score: number;
  if (Number.isFinite(rawScore)) {
    score = Math.max(0, Math.min(1, rawScore));
  } else if (typeof scores[matchedLabel] === "number") {
    score = scores[matchedLabel];
  } else {
    return null;
  }

  if (scores[matchedLabel] === undefined) {
    scores[matchedLabel] = score;
  }

  return { label: matchedLabel, score, scores, raw: parsed };
}

export interface JudgeClientDeps {
  getProviderRegistry?: () => any;
  getModelRegistry?: () => any;
  resolveModelWithCredentialsFresh?: (ref: { id: string; provider: string }) => Promise<any>;
  getUsageLedger?: () => any;
  hanakoHome?: string | null;
  callTextFn?: typeof callText;
}

export class JudgeClient {
  private readonly _deps: JudgeClientDeps;
  private readonly _registered = new Map<string, JudgeModelDescriptor>();
  readonly logStore: JudgeLogStore;

  constructor(deps: JudgeClientDeps = {}) {
    this._deps = deps;
    this.logStore = new JudgeLogStore({ hanakoHome: deps.hanakoHome ?? null });
  }

  registerModel(
    def: {
      id: string;
      provider: string;
      name?: string;
      labels?: string[];
      defaultThreshold?: number;
      maxInputChars?: number;
      input?: string[];
      handler?: JudgeCustomHandler;
    },
  ): () => void {
    const id = typeof def?.id === "string" ? def.id.trim() : "";
    const provider = typeof def?.provider === "string" ? def.provider.trim() : "";
    if (!id || !provider) {
      throw new Error("Judge model registration requires non-empty id and provider");
    }
    const key = modelKey(provider, id);
    this._registered.set(key, {
      id,
      name: (typeof def.name === "string" && def.name.trim()) || id,
      provider,
      capability: "judge",
      labels: normalizeLabels(def.labels),
      defaultThreshold: normalizeThreshold(def.defaultThreshold),
      maxInputChars: Math.max(256, Number(def.maxInputChars) || DEFAULT_JUDGE_MAX_INPUT_CHARS),
      input: Array.isArray(def.input) && def.input.length > 0 ? def.input : ["text"],
      source: "plugin",
      ...(typeof def.handler === "function" ? { handler: def.handler } : {}),
    });
    return () => {
      this._registered.delete(key);
    };
  }

  unregisterModel(provider: string, id: string): boolean {
    return this._registered.delete(modelKey(provider, id));
  }

  listModels(filter: { provider?: string } = {}): Omit<JudgeModelDescriptor, "handler" | "_piModel">[] {
    return this._collectAllModels(filter).map(({ handler: _h, _piModel: _p, ...publicMeta }) => publicMeta);
  }

  private _collectAllModels(filter: { provider?: string } = {}): JudgeModelDescriptor[] {
    const byKey = new Map<string, JudgeModelDescriptor>();
    const providerFilter = typeof filter?.provider === "string" ? filter.provider.trim() : "";

    const add = (desc: JudgeModelDescriptor) => {
      if (providerFilter && desc.provider !== providerFilter) return;
      const key = modelKey(desc.provider, desc.id);
      if (!byKey.has(key)) byKey.set(key, desc);
    };

    // 1. Programmatically registered judge models (highest precedence)
    for (const desc of this._registered.values()) {
      add(desc);
    }

    // 2. ProviderRegistry definitions declaring capabilities.judge
    const providerRegistry = this._deps.getProviderRegistry?.();
    if (providerRegistry) {
      const entries = typeof providerRegistry.getAll === "function"
        ? providerRegistry.getAll()
        : (providerRegistry._plugins ? [...providerRegistry._plugins.values()] : []);
      for (const entry of entries) {
        const providerId = entry?.id;
        const judgeCap = entry?.capabilities?.judge;
        if (!providerId || !judgeCap || !Array.isArray(judgeCap.models)) continue;
        for (const m of judgeCap.models) {
          const id = typeof m === "string" ? m.trim() : (typeof m?.id === "string" ? m.id.trim() : "");
          if (!id) continue;
          add({
            id,
            name: (typeof m === "object" && typeof m?.name === "string" && m.name.trim()) || id,
            provider: providerId,
            capability: "judge",
            labels: normalizeLabels(typeof m === "object" ? m.labels : undefined),
            defaultThreshold: normalizeThreshold(typeof m === "object" ? m.defaultThreshold : undefined),
            maxInputChars: Math.max(
              256,
              Number(typeof m === "object" ? m.maxInputChars : undefined) || DEFAULT_JUDGE_MAX_INPUT_CHARS,
            ),
            input: Array.isArray(m?.input) && m.input.length > 0 ? m.input : ["text"],
            source: "provider",
          });
        }
      }

      // 3. ProviderCatalog user-configured capabilities.judge
      const catalog = typeof providerRegistry.getCatalog === "function"
        ? providerRegistry.getCatalog()
        : providerRegistry._catalog;
      const catalogJudgeModels = catalog?.capabilities?.judge?.models;
      if (Array.isArray(catalogJudgeModels)) {
        for (const m of catalogJudgeModels) {
          const id = typeof m?.id === "string" ? m.id.trim() : "";
          const providerId = typeof m?.provider === "string" ? m.provider.trim() : "";
          if (!id || !providerId) continue;
          add({
            id,
            name: (typeof m.name === "string" && m.name.trim()) || id,
            provider: providerId,
            capability: "judge",
            labels: normalizeLabels(m.labels),
            defaultThreshold: normalizeThreshold(m.defaultThreshold),
            maxInputChars: Math.max(256, Number(m.maxInputChars) || DEFAULT_JUDGE_MAX_INPUT_CHARS),
            input: Array.isArray(m.input) && m.input.length > 0 ? m.input : ["text"],
            source: "catalog",
          });
        }
      }
    }

    // 4. Pi SDK 1.6.0 native classifier models
    const modelRegistry = this._deps.getModelRegistry?.();
    if (modelRegistry && typeof modelRegistry.getModelsOfType === "function") {
      try {
        const classifiers = modelRegistry.getModelsOfType("classifier", providerFilter || undefined) || [];
        for (const cm of classifiers) {
          if (!cm?.id || !cm?.provider) continue;
          add({
            id: cm.id,
            name: cm.name || cm.id,
            provider: cm.provider,
            capability: "judge",
            labels: normalizeLabels(cm.labels),
            defaultThreshold: normalizeThreshold(cm.defaultThreshold),
            maxInputChars: Math.max(256, Number(cm.maxInputChars) || DEFAULT_JUDGE_MAX_INPUT_CHARS),
            input: Array.isArray(cm.input) && cm.input.length > 0 ? cm.input : ["text"],
            source: "pi_classifier",
            _piModel: cm,
          });
        }
      } catch {
        // Ignore if Pi model registry is not initialized yet
      }
    }

    return [...byKey.values()];
  }

  private _resolveTargetModel(request: JudgeClassifyRequest): {
    model?: JudgeModelDescriptor;
    errorCode?: "NO_JUDGE_MODEL" | "MODEL_NOT_FOUND";
    errorMessage?: string;
  } {
    const all = this._collectAllModels();
    if (all.length === 0) {
      return {
        errorCode: "NO_JUDGE_MODEL",
        errorMessage: "No judge/classifier model is registered.",
      };
    }

    const parsed = parseModelRef(request.model);
    const reqProvider = (typeof request.provider === "string" ? request.provider.trim() : "")
      || parsed?.provider
      || "";
    const reqModelId = parsed?.id || (typeof request.model === "string" ? request.model.trim() : "");

    if (!reqModelId && !reqProvider) {
      return { model: all[0] };
    }

    const match = all.find((m) => {
      if (reqProvider && m.provider !== reqProvider) return false;
      if (reqModelId && m.id !== reqModelId) return false;
      return true;
    });

    if (!match) {
      return {
        errorCode: "MODEL_NOT_FOUND",
        errorMessage: `Judge model not found: ${reqProvider ? `${reqProvider}/` : ""}${reqModelId || "*"}`,
      };
    }
    return { model: match };
  }

  async classify(request: JudgeClassifyRequest): Promise<JudgeClassifyResult> {
    const startedAt = Date.now();
    const inputText = extractInputText(request?.input);

    if (!inputText) {
      const durationMs = Date.now() - startedAt;
      const err: JudgeClassifyFailure = {
        ok: false,
        code: "INVALID_INPUT",
        error: "Judge classification requires non-empty input text.",
        durationMs,
      };
      this.logStore.record({
        status: "error",
        durationMs,
        inputLength: 0,
        errorCode: err.code,
        error: err.error,
        callerPluginId: request?.pluginId,
      });
      return err;
    }

    const resolved = this._resolveTargetModel(request);
    if (!resolved.model) {
      const durationMs = Date.now() - startedAt;
      const err: JudgeClassifyFailure = {
        ok: false,
        code: resolved.errorCode || "NO_JUDGE_MODEL",
        error: resolved.errorMessage || "No judge model available.",
        model: request.model,
        provider: request.provider,
        durationMs,
      };
      this.logStore.record({
        status: "error",
        model: request.model,
        provider: request.provider,
        durationMs,
        inputLength: inputText.length,
        errorCode: err.code,
        error: err.error,
        callerPluginId: request?.pluginId,
      });
      return err;
    }

    const target = resolved.model;
    if (inputText.length > target.maxInputChars) {
      const durationMs = Date.now() - startedAt;
      const err: JudgeClassifyFailure = {
        ok: false,
        code: "INVALID_INPUT",
        error: `Input length (${inputText.length}) exceeds judge model maxInputChars (${target.maxInputChars}).`,
        model: target.id,
        provider: target.provider,
        durationMs,
      };
      this.logStore.record({
        status: "error",
        model: target.id,
        provider: target.provider,
        durationMs,
        inputLength: inputText.length,
        errorCode: err.code,
        error: err.error,
        callerPluginId: request?.pluginId,
      });
      return err;
    }

    const labels = request.labels && request.labels.length > 0
      ? normalizeLabels(request.labels)
      : target.labels;
    const threshold = normalizeThreshold(request.threshold, target.defaultThreshold);
    const timeoutMs = Math.max(50, Number(request.timeoutMs) || DEFAULT_JUDGE_TIMEOUT_MS);

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const err: any = new Error(`Judge classification timed out after ${timeoutMs}ms`);
        err.code = "TIMEOUT";
        reject(err);
      }, timeoutMs);
    });

    try {
      const outcome = await Promise.race([
        this._executeJudge(target, {
          input: inputText,
          labels,
          threshold,
          instructions: request.instructions,
          timeoutMs,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);

      const durationMs = Date.now() - startedAt;
      const scores = outcome.scores && Object.keys(outcome.scores).length > 0
        ? outcome.scores
        : { [outcome.label]: outcome.score };
      const passed = outcome.score >= threshold;

      const result: JudgeClassifySuccess = {
        ok: true,
        label: outcome.label,
        score: outcome.score,
        scores,
        threshold,
        passed,
        model: target.id,
        provider: target.provider,
        durationMs,
        ...(outcome.raw !== undefined ? { raw: outcome.raw } : {}),
      };

      this.logStore.record({
        status: "ok",
        model: target.id,
        provider: target.provider,
        label: result.label,
        score: result.score,
        threshold,
        passed,
        durationMs,
        inputLength: inputText.length,
        callerPluginId: request?.pluginId,
      });

      return result;
    } catch (err: any) {
      const durationMs = Date.now() - startedAt;
      const isTimeout = err?.code === "TIMEOUT" || err?.name === "AbortError" || controller.signal.aborted;
      const code: JudgeClassifyFailure["code"] = isTimeout
        ? "TIMEOUT"
        : (err?.code === "PARSE_ERROR" ? "PARSE_ERROR" : "PROVIDER_ERROR");
      const message = err instanceof Error ? err.message : String(err || "Judge classification failed");

      const failure: JudgeClassifyFailure = {
        ok: false,
        code,
        error: message,
        model: target.id,
        provider: target.provider,
        durationMs,
      };

      this.logStore.record({
        status: "error",
        model: target.id,
        provider: target.provider,
        durationMs,
        inputLength: inputText.length,
        errorCode: code,
        error: message,
        callerPluginId: request?.pluginId,
      });

      return failure;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async _executeJudge(
    target: JudgeModelDescriptor,
    params: {
      input: string;
      labels: string[];
      threshold: number;
      instructions?: string;
      timeoutMs: number;
      signal: AbortSignal;
    },
  ): Promise<{ label: string; score: number; scores?: Record<string, number>; raw?: unknown }> {
    // 1. Custom handler (plugin or test)
    if (typeof target.handler === "function") {
      const res = await target.handler({
        input: params.input,
        labels: params.labels,
        threshold: params.threshold,
        instructions: params.instructions,
        signal: params.signal,
        model: target,
      });
      if (!res || typeof res.label !== "string" || !Number.isFinite(Number(res.score))) {
        const err: any = new Error("Judge handler returned malformed classification result");
        err.code = "PARSE_ERROR";
        throw err;
      }
      return {
        label: res.label,
        score: Math.max(0, Math.min(1, Number(res.score))),
        scores: res.scores,
        raw: res.raw,
      };
    }

    // 2. Pi SDK 1.6.0 native classifier
    const modelRegistry = this._deps.getModelRegistry?.();
    if (target.source === "pi_classifier" && target._piModel && typeof modelRegistry?.classify === "function") {
      const res = await modelRegistry.classify(
        target._piModel,
        {
          input: params.input,
          labels: params.labels,
          ...(params.instructions ? { instructions: params.instructions } : {}),
        },
        { signal: params.signal },
      );
      const label = typeof res?.label === "string"
        ? res.label
        : (Array.isArray(res?.predictions) && typeof res.predictions[0]?.label === "string"
          ? res.predictions[0].label
          : "");
      const score = Number(
        res?.score ?? (Array.isArray(res?.predictions) ? res.predictions[0]?.score : NaN),
      );
      if (!label || !Number.isFinite(score)) {
        const err: any = new Error("Pi classifier returned malformed classification result");
        err.code = "PARSE_ERROR";
        throw err;
      }
      const scores: Record<string, number> = {};
      if (Array.isArray(res?.predictions)) {
        for (const p of res.predictions) {
          if (typeof p?.label === "string" && Number.isFinite(Number(p?.score))) {
            scores[p.label] = Math.max(0, Math.min(1, Number(p.score)));
          }
        }
      }
      return { label, score: Math.max(0, Math.min(1, score)), scores, raw: res };
    }

    // 3. Structured LLM fallback via callText
    if (typeof this._deps.resolveModelWithCredentialsFresh !== "function") {
      throw new Error(`Judge model "${target.provider}/${target.id}" has no executable backend.`);
    }
    const resolved = await this._deps.resolveModelWithCredentialsFresh({
      id: target.id,
      provider: target.provider,
    });
    const callTextImpl = this._deps.callTextFn || callText;
    const response = await callTextImpl({
      ...callTextConfigFromResolvedModel(resolved),
      messages: [
        {
          role: "user",
          content: buildJudgePrompt(params.input, params.labels, params.instructions),
        },
      ],
      maxTokens: 256,
      temperature: 0,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      usageLedger: this._deps.getUsageLedger?.(),
      usageContext: {
        source: {
          subsystem: "utility",
          operation: "judge_classify",
          surface: "internal",
          trigger: "system",
        },
        attribution: {
          kind: "utility",
        },
      },
    } as any);

    const text = typeof response === "string"
      ? response
      : (typeof (response as any)?.text === "string" ? (response as any).text : "");
    const parsed = parseJudgeJsonOutput(text, params.labels);
    if (!parsed) {
      const err: any = new Error(`Judge model returned unparseable output: ${text.slice(0, 160)}`);
      err.code = "PARSE_ERROR";
      throw err;
    }
    return parsed;
  }
}
