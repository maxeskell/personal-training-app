import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * Append-only fuelling log — the near-zero-effort capture that powers "improve over time". The athlete
 * taps 👍 / 👎 on a session's fuel plan (dashboard) or calls the `log_fuel` MCP tool; one line lands here.
 * The learning review (fuelReview.ts) reads it back to tune the per-athlete model (carb/hr tolerance,
 * caffeine, what sits well per sport). Gitignored (lives in dataDir), same discipline as the cost log /
 * decision log / session-feedback log. Best-effort: a logging failure must never break a render or sync.
 */

export const FUEL_LOG_SCHEMA_VERSION = 1;

/** How the session's fuelling actually went — the one-tap outcome (plus optional free-text note). */
export type FuelOutcome = "good" | "rough" | "bonked" | "skipped";

export interface FuelLogRecord {
  schemaVersion: number;
  /** Session date (YYYY-MM-DD) the feedback is about. */
  date: string;
  sport: string;
  /** One-line summary of what the plan recommended (so the review can compare planned vs outcome). */
  planned?: string;
  /** Carb/hr the plan targeted, if any — lets the review track the tolerated rate empirically. */
  carbTargetGPerHour?: number;
  outcome: FuelOutcome;
  /** Optional free-text (screened for wellbeing before it ever reaches the LLM review). */
  note?: string;
  loggedAt: string; // ISO
}

const VALID_OUTCOMES: ReadonlySet<string> = new Set<FuelOutcome>(["good", "rough", "bonked", "skipped"]);
export const isFuelOutcome = (v: unknown): v is FuelOutcome => typeof v === "string" && VALID_OUTCOMES.has(v);

function file(): string {
  return join(config.dataDir, "fuel-log.jsonl");
}

/** Append one fuel-log record. Best-effort — never throws. */
export async function saveFuelLog(rec: Omit<FuelLogRecord, "schemaVersion">): Promise<void> {
  try {
    await mkdir(config.dataDir, { recursive: true });
    await appendFile(file(), JSON.stringify({ ...rec, schemaVersion: FUEL_LOG_SCHEMA_VERSION }) + "\n");
  } catch {
    /* never let fuel-log persistence break the flow */
  }
}

/** All stored records (file order). Empty when the log is absent; a malformed line is skipped, not fatal. */
export async function loadFuelLog(): Promise<FuelLogRecord[]> {
  let text: string;
  try {
    text = await readFile(file(), "utf8");
  } catch {
    return [];
  }
  const out: FuelLogRecord[] = [];
  for (const l of text.split("\n")) {
    const t = l.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as FuelLogRecord);
    } catch {
      /* skip a torn line rather than blank the whole history */
    }
  }
  return out;
}

/** Composite session key — `${date}|${sport}` — one outcome per session even on a multi-sport day. */
export function fuelLogKey(date: string, sport: string): string {
  return `${date}|${sport}`;
}

/** Latest record per (date, sport) — most recent `loggedAt` wins; collapses the append-only history. Pure. */
export function latestFuelByDateSport(records: FuelLogRecord[]): Map<string, FuelLogRecord> {
  const m = new Map<string, FuelLogRecord>();
  for (const r of records) {
    const k = fuelLogKey(r.date, r.sport);
    const prev = m.get(k);
    if (!prev || r.loggedAt > prev.loggedAt) m.set(k, r);
  }
  return m;
}

export interface FuelLogStats {
  total: number;
  good: number;
  rough: number;
  bonked: number;
  skipped: number;
  /** Highest carb/hr that was tolerated WELL (outcome "good") — the empirical ceiling, when present. */
  bestToleratedCarbGPerHour?: number;
  /** Lowest carb/hr that went badly ("rough"/"bonked") — a caution line. */
  worstCarbGPerHour?: number;
}

/**
 * Deterministic roll-up of the log for the learning review (so the LLM phrases real numbers, not vibes).
 * Pure. The "best tolerated" / "worst" carb rates are descriptive n=1 signals, not prescriptions.
 */
export function summariseFuelLog(records: FuelLogRecord[]): FuelLogStats {
  const collapsed = [...latestFuelByDateSport(records).values()];
  const stats: FuelLogStats = { total: collapsed.length, good: 0, rough: 0, bonked: 0, skipped: 0 };
  for (const r of collapsed) {
    stats[r.outcome] += 1;
    if (r.carbTargetGPerHour != null) {
      if (r.outcome === "good") stats.bestToleratedCarbGPerHour = Math.max(stats.bestToleratedCarbGPerHour ?? 0, r.carbTargetGPerHour);
      if (r.outcome === "rough" || r.outcome === "bonked") stats.worstCarbGPerHour = Math.min(stats.worstCarbGPerHour ?? Infinity, r.carbTargetGPerHour);
    }
  }
  if (stats.worstCarbGPerHour === Infinity) delete stats.worstCarbGPerHour;
  return stats;
}
