import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";

/**
 * Local token-cost accounting. Every LLM call appends one record here; `cost` aggregates it.
 * Append-only JSONL in dataDir, same discipline as the decision log / archive — and deliberately
 * spare: token counts, operation label, and computed dollar cost only. No prompt text, no PII.
 */

export const COST_LOG_SCHEMA_VERSION = 1;

/** The four billable token buckets from `usage` on a messages.create response. */
export interface LlmUsage {
  input: number; // uncached input tokens (full price)
  output: number; // output + thinking tokens
  cacheWrite: number; // cache_creation_input_tokens (1.25× input)
  cacheRead: number; // cache_read_input_tokens (0.1× input)
}

export interface CostRecord extends LlmUsage {
  ts: string; // ISO timestamp
  operation: string; // which flow (readiness | weekly | racePrep | propose | act | ask | session | …)
  model: string;
  costUsd: number;
  schemaVersion: number;
}

/**
 * Dollar cost of one call from the configured per-MTok price table. Model-aware: cheap side-task calls
 * on Haiku are priced from the Haiku table, everything else from the (Opus) default — so the cost log
 * doesn't bill a Haiku intent micro-call at Opus rates.
 */
export function costUsd(u: LlmUsage, model = "claude-opus-4-8"): number {
  const p = /haiku/i.test(model) ? config.pricingHaiku : config.pricing;
  const usd =
    (u.input * p.inputPerMTok +
      u.output * p.outputPerMTok +
      u.cacheWrite * p.cacheWritePerMTok +
      u.cacheRead * p.cacheReadPerMTok) /
    1_000_000;
  return +usd.toFixed(6);
}

/**
 * A model is "local" (Ollama via local-llm-server) when it isn't an Anthropic model. We label these rows
 * in the cost report and they carry $0 — the call runs on your own machine, so there's no API spend, only
 * token volume worth seeing. Anthropic model ids all contain a family name ("claude" / opus / sonnet / haiku).
 */
export function isLocalModel(model: string): boolean {
  return !/claude|opus|sonnet|haiku/i.test(model);
}

function logPath(): string {
  return join(config.dataDir, "cost-log.jsonl");
}

/**
 * Record a LOCAL (Ollama) call. No API dollars — `costUsd` is a hard 0 (NOT priced through the table, which
 * would wrongly bill an unknown model at Opus rates) — but we log the model + token volume so `npm run cost`
 * shows the activity. Best-effort, inheriting appendCostRecord's swallow-and-continue.
 */
export async function appendLocalCostRecord(opts: {
  operation: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
}): Promise<void> {
  await appendCostRecord({
    ts: new Date().toISOString(),
    operation: opts.operation,
    model: opts.model,
    input: opts.promptTokens ?? 0,
    output: opts.completionTokens ?? 0,
    cacheWrite: 0,
    cacheRead: 0,
    costUsd: 0,
  });
}

/** Append one usage record. Best-effort: a logging failure must never break the LLM flow. */
export async function appendCostRecord(rec: Omit<CostRecord, "schemaVersion">): Promise<void> {
  try {
    const path = logPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify({ ...rec, schemaVersion: COST_LOG_SCHEMA_VERSION }) + "\n");
  } catch {
    /* never let cost logging break a coaching flow */
  }
}

export async function readCostRecords(): Promise<CostRecord[]> {
  let text: string;
  try {
    text = await readFile(logPath(), "utf8");
  } catch {
    return [];
  }
  const out: CostRecord[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as CostRecord);
    } catch {
      /* skip a malformed line rather than fail the whole report */
    }
  }
  return out;
}

export interface CostBucket {
  calls: number;
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  costUsd: number;
}
export interface CostSummary {
  total: CostBucket;
  byOperation: Array<{ operation: string } & CostBucket>;
  windowDays: number | null; // null = all-time
}

function empty(): CostBucket {
  return { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 };
}
function add(b: CostBucket, r: CostRecord): void {
  b.calls += 1;
  b.input += r.input;
  b.output += r.output;
  b.cacheWrite += r.cacheWrite;
  b.cacheRead += r.cacheRead;
  b.costUsd = +(b.costUsd + r.costUsd).toFixed(6);
}

/** Aggregate records over an optional trailing window (days), with a per-operation breakdown. */
export function summarizeCost(records: CostRecord[], windowDays?: number): CostSummary {
  const cutoff = windowDays != null ? Date.now() - windowDays * 86_400_000 : null;
  const inWindow = cutoff == null ? records : records.filter((r) => Date.parse(r.ts) >= cutoff);

  const total = empty();
  const byOp = new Map<string, CostBucket>();
  for (const r of inWindow) {
    add(total, r);
    const b = byOp.get(r.operation) ?? empty();
    add(b, r);
    byOp.set(r.operation, b);
  }
  const byOperation = [...byOp.entries()]
    .map(([operation, b]) => ({ operation, ...b }))
    .sort((a, b) => b.costUsd - a.costUsd);
  return { total, byOperation, windowDays: windowDays ?? null };
}
