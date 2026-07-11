/**
 * Spec 07, closing item — the post-race hook: log `model vs official result` per race so the
 * race-splits model's own error is tracked over time (the model must earn trust the same way every
 * other estimator here does).
 *
 * Two halves, both pure (disk lives in state/raceModelLog.ts):
 *  - PREDICTIONS: freeze the latest PRE-race splits plan per race (`predictionFromPlan` +
 *    `upsertPredictions`). Only complete plans qualify — a plan with `missingLegs` is not a full-race
 *    time (the Birmingham 2026 lesson), so reviewing its total would be dishonest. And only plans
 *    computed on-or-before race day: recomputing after the race would leak post-race inputs (an
 *    updated FTP) into the "prediction".
 *  - REVIEWS: once the official result lands in career history, join it to the frozen prediction
 *    (`newReviews`) — total + per-leg deltas, and whether the official time fell inside the model's
 *    [best, worst] band. One immutable row per race.
 */

import type { RaceSplitPlan } from "./splits.js";
import { parseTargetSeconds } from "./raceTargetGate.js";

/** The frozen pre-race snapshot of a splits plan — the number the model is later judged against. */
export interface RacePredictionRecord {
  /** `${date}|${normalised race name}` — stable join key for upserts and reviews. */
  key: string;
  race: string;
  /** Race date, YYYY-MM-DD. */
  date: string;
  /** As-of date of the inputs (the state the plan was computed from) — always ≤ `date`. */
  stateDate: string;
  savedAt: string;
  predictedSec: number;
  bestSec?: number;
  worstSec?: number;
  legs: Array<{ label: string; splitSec: number }>;
  targetLabel?: string;
  targetVerdict?: string;
}

/** One completed race, judged: the frozen prediction vs the official result. Append-only. */
export interface RaceReviewRecord {
  key: string;
  race: string;
  date: string;
  /** When the reviewed prediction was frozen (its inputs' as-of date). */
  stateDate: string;
  predictedSec: number;
  bestSec?: number;
  worstSec?: number;
  officialSec: number;
  /** predicted − official: positive = the model predicted slower than the athlete raced. */
  errorSec: number;
  errorPct: number;
  /** Official time inside the model's [best, worst] band — null when the plan carried no band. */
  withinBand: boolean | null;
  legs: Array<{ label: string; predictedSec: number; officialSec: number | null; deltaSec: number | null }>;
  reviewedAt: string;
}

/** The slice of a career-history race the review needs (structurally typed — stays decoupled). */
export interface CareerRaceLike {
  date?: string;
  event?: string;
  result?: { time?: string; splits?: Array<{ label?: string; time?: string }> };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function raceKey(date: string, race: string): string {
  return `${date.slice(0, 10)}|${norm(race)}`;
}

/**
 * Seconds from a pre-formatted result clock ("2:39:12", "46:32"). Two-token times are H:MM-vs-MM:SS
 * ambiguous, resolved log-distance against `referenceSec` — the same tolerant parse the target gate
 * uses (reused, not reimplemented). Null when nothing time-like is present.
 */
export function parseResultSeconds(time: string | undefined, referenceSec?: number): number | null {
  if (!time) return null;
  return parseTargetSeconds(time, referenceSec).maxSec;
}

/**
 * Freeze a plan into a prediction record — or nothing, when the plan can't honestly be reviewed:
 * no race date to key on, a non-positive total, legs missing from the model (its total is not a
 * full-race time), or inputs dated AFTER the race (post-race leakage, see module doc).
 */
export function predictionFromPlan(plan: RaceSplitPlan, stateDate: string, savedAt: string): RacePredictionRecord | null {
  const date = plan.date?.slice(0, 10);
  if (!date || !(plan.predictedSec > 0) || plan.missingLegs?.length) return null;
  if (stateDate.slice(0, 10) > date) return null;
  return {
    key: raceKey(date, plan.race),
    race: plan.race,
    date,
    stateDate: stateDate.slice(0, 10),
    savedAt,
    predictedSec: Math.round(plan.predictedSec),
    bestSec: plan.bestSec != null ? Math.round(plan.bestSec) : undefined,
    worstSec: plan.worstSec != null ? Math.round(plan.worstSec) : undefined,
    legs: plan.segments.map((s) => ({ label: s.label, splitSec: Math.round(s.splitSec) })),
    targetLabel: plan.targetCheck?.targetLabel,
    targetVerdict: plan.targetCheck?.verdict,
  };
}

/**
 * Merge freshly computed prediction records into the stored set: per race key, the LATEST pre-race
 * snapshot wins (each incoming record is already guaranteed ≤ race day by `predictionFromPlan`, so
 * "latest stateDate" means "closest to the start line" — race-morning inputs are the truest test).
 */
export function upsertPredictions(existing: RacePredictionRecord[], incoming: Array<RacePredictionRecord | null>): RacePredictionRecord[] {
  const byKey = new Map(existing.map((p) => [p.key, p]));
  for (const inc of incoming) {
    if (!inc) continue;
    const cur = byKey.get(inc.key);
    if (!cur || inc.stateDate >= cur.stateDate) byKey.set(inc.key, inc);
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Join one frozen prediction to its official result. Null when the result carries no parseable time. */
export function buildReview(pred: RacePredictionRecord, race: CareerRaceLike, reviewedAt: string): RaceReviewRecord | null {
  const officialSec = parseResultSeconds(race.result?.time, pred.predictedSec);
  if (officialSec == null || officialSec <= 0) return null;
  const officialSplits = race.result?.splits ?? [];
  const legs = pred.legs.map((leg) => {
    const match = officialSplits.find((s) => norm(s.label ?? "") === norm(leg.label));
    const sec = match ? parseResultSeconds(match.time, leg.splitSec) : null;
    return { label: leg.label, predictedSec: leg.splitSec, officialSec: sec, deltaSec: sec != null ? leg.splitSec - sec : null };
  });
  const errorSec = pred.predictedSec - officialSec;
  return {
    key: pred.key,
    race: pred.race,
    date: pred.date,
    stateDate: pred.stateDate,
    predictedSec: pred.predictedSec,
    bestSec: pred.bestSec,
    worstSec: pred.worstSec,
    officialSec,
    errorSec,
    errorPct: +((errorSec / officialSec) * 100).toFixed(1),
    withinBand: pred.bestSec != null && pred.worstSec != null ? officialSec >= pred.bestSec && officialSec <= pred.worstSec : null,
    legs,
    reviewedAt,
  };
}

/**
 * Reviews that are newly possible: a frozen prediction whose race now has an official time in career
 * history and no review row yet. Races are matched by exact date (one race per day holds for this
 * athlete; names drift between sources — "Birmingham Triahtlon" — so the date IS the identity).
 */
export function newReviews(
  preds: RacePredictionRecord[],
  races: CareerRaceLike[],
  existingKeys: ReadonlySet<string>,
  reviewedAt: string,
): RaceReviewRecord[] {
  const out: RaceReviewRecord[] = [];
  for (const pred of preds) {
    if (existingKeys.has(pred.key)) continue;
    const race = races.find((r) => r.date?.slice(0, 10) === pred.date && r.result?.time);
    if (!race) continue;
    const review = buildReview(pred, race, reviewedAt);
    if (review) out.push(review);
  }
  return out;
}
