/**
 * Per-Turn Incremental Compaction (Opt-In Experiment)
 *
 * When `session.incremental_compaction` is enabled (default OFF), evaluates
 * session context size at the end of a completed non-aborted assistant turn.
 * If the estimated context exceeds a soft threshold, reuses the existing
 * `runLossyLocalCompactionForSession` (`lossy_local`, zero LLM calls) to trim
 * older tool/history bloat incrementally.
 *
 * When disabled, returns immediately with zero state mutation or side effects.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { estimateTokens } from "../lib/pi-sdk/index.ts";
import { getResolvedIncrementalCompactionEnabled } from "../shared/compaction-mode.ts";
import { runLossyLocalCompactionForSession } from "./session-compactor.ts";

export const DEFAULT_INCREMENTAL_SOFT_TOKEN_THRESHOLD = 24_000;
export const DEFAULT_INCREMENTAL_SOFT_CONTEXT_RATIO = 0.45;
export const DEFAULT_INCREMENTAL_MIN_BRANCH_ENTRIES = 12;

export type IncrementalCompactionDecision =
  | "skipped_disabled"
  | "skipped_aborted"
  | "skipped_busy"
  | "skipped_below_threshold"
  | "skipped_nothing_to_compact"
  | "compacted"
  | "error";

export interface IncrementalCompactionLogEntry {
  id: string;
  timestamp: string;
  sessionPath: string | null;
  sessionId: string | null;
  enabled: boolean;
  decision: IncrementalCompactionDecision;
  reason: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
  tokensSaved: number | null;
  thresholdTokens: number | null;
  branchEntriesBefore: number | null;
  durationMs: number;
  error?: string;
}

export interface IncrementalCompactionOptions {
  softTokenThreshold?: number;
  softContextRatio?: number;
  minBranchEntries?: number;
  compactionSettings?: any;
  compactFn?: typeof runLossyLocalCompactionForSession;
}

export interface IncrementalCompactionResult {
  triggered: boolean;
  decision: IncrementalCompactionDecision;
  reason: string;
  tokensBefore: number | null;
  tokensAfter: number | null;
  tokensSaved: number | null;
  durationMs: number;
  logEntry?: IncrementalCompactionLogEntry;
}

export class IncrementalCompactionLogStore {
  private readonly _entries: IncrementalCompactionLogEntry[] = [];
  private readonly _maxEntries: number;
  private readonly _logFilePath: string | null;

  constructor(opts: { maxEntries?: number; hanakoHome?: string | null } = {}) {
    this._maxEntries = Math.max(10, opts.maxEntries ?? 200);
    this._logFilePath = opts.hanakoHome
      ? path.join(opts.hanakoHome, "logs", "incremental-compaction.jsonl")
      : null;
  }

  record(entry: Omit<IncrementalCompactionLogEntry, "id" | "timestamp">): IncrementalCompactionLogEntry {
    const full: IncrementalCompactionLogEntry = {
      id: `ic_${crypto.randomBytes(6).toString("hex")}`,
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
        // Disk logging must never break session lifecycle
      }
    }
    return full;
  }

  list(limit = 50): IncrementalCompactionLogEntry[] {
    const n = Math.max(1, Math.min(this._maxEntries, Number(limit) || 50));
    return this._entries.slice(-n).reverse();
  }

  clear(): void {
    this._entries.length = 0;
  }
}

export function estimateSessionBranchTokens(session: any): { tokens: number; entryCount: number } {
  const branchEntries = session?.sessionManager?.getBranch?.() || [];
  const entryCount = Array.isArray(branchEntries) ? branchEntries.length : 0;

  // Prefer active context estimate from messages after the latest compaction entry
  let lastCompactionIdx = -1;
  for (let i = entryCount - 1; i >= 0; i--) {
    if (branchEntries[i]?.type === "compaction") {
      lastCompactionIdx = i;
      break;
    }
  }
  const activeEntries = lastCompactionIdx >= 0
    ? branchEntries.slice(lastCompactionIdx)
    : branchEntries;

  let total = 0;
  for (const entry of activeEntries) {
    if (!entry) continue;
    if (entry.type === "message" && entry.message) {
      try {
        total += Math.max(0, Number(estimateTokens(entry.message)) || 0);
      } catch {
        total += Math.ceil(JSON.stringify(entry.message).length / 4);
      }
    } else if (entry.type === "compaction" && typeof entry.summary === "string") {
      total += Math.ceil(entry.summary.length / 4);
    }
  }
  return { tokens: total, entryCount };
}

function resolveSoftTokenThreshold(session: any, options: IncrementalCompactionOptions): number {
  if (typeof options.softTokenThreshold === "number" && Number.isFinite(options.softTokenThreshold)) {
    return Math.max(1, Math.floor(options.softTokenThreshold));
  }
  const ratio = typeof options.softContextRatio === "number" && Number.isFinite(options.softContextRatio)
    ? Math.max(0.1, Math.min(0.9, options.softContextRatio))
    : DEFAULT_INCREMENTAL_SOFT_CONTEXT_RATIO;
  const contextWindow = Number(session?.model?.contextWindow);
  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    return Math.min(Math.floor(contextWindow * ratio), DEFAULT_INCREMENTAL_SOFT_TOKEN_THRESHOLD);
  }
  return DEFAULT_INCREMENTAL_SOFT_TOKEN_THRESHOLD;
}

export async function evaluateIncrementalCompactionForSession(params: {
  session: any;
  sessionPath?: string | null;
  sessionId?: string | null;
  preferencesManager: unknown;
  aborted?: boolean;
  logStore?: IncrementalCompactionLogStore | null;
  options?: IncrementalCompactionOptions;
}): Promise<IncrementalCompactionResult> {
  const startedAt = Date.now();
  const options = params.options || {};
  const sessionPath = params.sessionPath ?? null;
  const sessionId = params.sessionId ?? null;

  // 1. Strictly opt-in: when OFF, immediate zero-overhead no-op with no residue.
  const enabled = getResolvedIncrementalCompactionEnabled(params.preferencesManager);
  if (!enabled) {
    return {
      triggered: false,
      decision: "skipped_disabled",
      reason: "Incremental compaction experiment is disabled.",
      tokensBefore: null,
      tokensAfter: null,
      tokensSaved: null,
      durationMs: Date.now() - startedAt,
    };
  }

  const recordAndReturn = (
    decision: IncrementalCompactionDecision,
    reason: string,
    extra: {
      triggered?: boolean;
      tokensBefore?: number | null;
      tokensAfter?: number | null;
      thresholdTokens?: number | null;
      branchEntriesBefore?: number | null;
      error?: string;
    } = {},
  ): IncrementalCompactionResult => {
    const durationMs = Date.now() - startedAt;
    const tokensBefore = extra.tokensBefore ?? null;
    const tokensAfter = extra.tokensAfter ?? null;
    const tokensSaved = tokensBefore !== null && tokensAfter !== null
      ? tokensBefore - tokensAfter
      : null;
    const logEntry = params.logStore?.record({
      sessionPath,
      sessionId,
      enabled: true,
      decision,
      reason,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      thresholdTokens: extra.thresholdTokens ?? null,
      branchEntriesBefore: extra.branchEntriesBefore ?? null,
      durationMs,
      ...(extra.error ? { error: extra.error } : {}),
    });
    return {
      triggered: extra.triggered === true,
      decision,
      reason,
      tokensBefore,
      tokensAfter,
      tokensSaved,
      durationMs,
      ...(logEntry ? { logEntry } : {}),
    };
  };

  // 2. Skip aborted or busy sessions
  if (params.aborted === true) {
    return recordAndReturn("skipped_aborted", "Turn was aborted; skipping incremental compaction.");
  }

  const session = params.session;
  if (!session?.sessionManager || !session?.agent) {
    return recordAndReturn("skipped_busy", "Session runtime is not ready.");
  }
  if (session.isCompacting === true || session.isStreaming === true) {
    return recordAndReturn("skipped_busy", "Session is currently streaming or compacting.");
  }

  // 3. Measure current active branch tokens & entry count
  const { tokens: tokensBefore, entryCount: branchEntriesBefore } = estimateSessionBranchTokens(session);
  const thresholdTokens = resolveSoftTokenThreshold(session, options);
  const minBranchEntries = Math.max(
    2,
    Number(options.minBranchEntries) || DEFAULT_INCREMENTAL_MIN_BRANCH_ENTRIES,
  );

  if (branchEntriesBefore < minBranchEntries) {
    return recordAndReturn(
      "skipped_below_threshold",
      `Branch entry count (${branchEntriesBefore}) is below minimum (${minBranchEntries}).`,
      { tokensBefore, tokensAfter: tokensBefore, thresholdTokens, branchEntriesBefore },
    );
  }

  if (tokensBefore < thresholdTokens) {
    return recordAndReturn(
      "skipped_below_threshold",
      `Estimated tokens (${tokensBefore}) is below soft threshold (${thresholdTokens}).`,
      { tokensBefore, tokensAfter: tokensBefore, thresholdTokens, branchEntriesBefore },
    );
  }

  // 4. Execute local lossy compaction (no LLM call)
  const compactFn = options.compactFn || runLossyLocalCompactionForSession;
  try {
    await compactFn(session, {
      settings: options.compactionSettings,
      emitLifecycle: false,
      lifecycleReason: "incremental",
    });
    const { tokens: tokensAfter } = estimateSessionBranchTokens(session);
    return recordAndReturn(
      "compacted",
      `Incremental local compaction ran (${tokensBefore} -> ${tokensAfter} tokens, threshold ${thresholdTokens}).`,
      {
        triggered: true,
        tokensBefore,
        tokensAfter,
        thresholdTokens,
        branchEntriesBefore,
      },
    );
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err || "Unknown error");
    if (
      message.includes("Already compacted")
      || message.includes("Nothing to compact")
    ) {
      return recordAndReturn(
        "skipped_nothing_to_compact",
        message,
        { tokensBefore, tokensAfter: tokensBefore, thresholdTokens, branchEntriesBefore },
      );
    }
    return recordAndReturn(
      "error",
      `Incremental compaction failed: ${message}`,
      {
        tokensBefore,
        tokensAfter: tokensBefore,
        thresholdTokens,
        branchEntriesBefore,
        error: message,
      },
    );
  }
}
