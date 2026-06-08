/**
 * Taper-response finder (data-scientist brief Q6): what form (TSB) coincided with the athlete's best
 * past races/benchmarks, to set a personalised taper target for July (tri) and September (marathon).
 *
 * We read TSB straight off the local CTL/ATL/TSB series (metrics.loadModel) on each PAST race date from
 * getRaceGoalEvent, and — where the model exposes a predicted vs target time for that race — rank races
 * by how well they went (smaller predicted−target gap = better). The recommended taper band is the TSB
 * that accompanied the best outcomes. With few past races this is suggestive, not settled, and says so.
 */

import type { LoadModel } from "./metrics.js";
import type { Finding } from "./metrics.js";
import { mean } from "./stats.js";

export interface RaceTaperPoint {
  race: string;
  date: string;
  tsbOnDay: number | null;
  ctlOnDay: number | null;
  outcomeGapSec: number | null; // model PREDICTION − target (not an actual result); shown for context only
}

export interface TaperAnalysis {
  past: RaceTaperPoint[];
  recommendedTsbLow: number | null;
  recommendedTsbHigh: number | null;
  basis: string;
}

interface Goal {
  event_name?: unknown;
  event_date?: unknown;
  discipline_prediction?: unknown;
  target_completion_time_in_seconds?: unknown;
}

function num(x: unknown): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

export function analyseTaper(load: LoadModel | null, goalsRaw: unknown, todayIso: string): TaperAnalysis {
  const empty: TaperAnalysis = { past: [], recommendedTsbLow: null, recommendedTsbHigh: null, basis: "no past races in the load window yet" };
  if (!load) return empty;
  const goals = ((goalsRaw as { goals?: Goal[] } | undefined)?.goals) ?? [];
  const tsbByDate = new Map(load.series.map((p) => [p.date, p]));

  const past: RaceTaperPoint[] = [];
  for (const g of goals) {
    const date = String(g.event_date ?? "").slice(0, 10);
    if (!date || date >= todayIso) continue; // past races only
    const day = tsbByDate.get(date);
    if (!day) continue;
    const pred = num(g.discipline_prediction);
    const target = num(g.target_completion_time_in_seconds);
    past.push({
      race: String(g.event_name ?? "—"),
      date,
      tsbOnDay: day.tsb,
      ctlOnDay: day.ctl,
      outcomeGapSec: pred != null && target != null ? pred - target : null,
    });
  }
  past.sort((a, b) => a.date.localeCompare(b.date));
  if (past.length === 0) return empty;

  // DESCRIPTIVE only: we don't have ACTUAL finish times in the feed (only the model's prediction vs
  // the goal), and prediction−target is not a performance measure — so we report the race-day TSB band
  // the athlete has historically raced at, rather than pretending to rank races by outcome.
  const band = past.filter((p) => p.tsbOnDay != null).map((p) => p.tsbOnDay!);
  const basis = `race-day TSB across ${band.length} past race day(s) — descriptive (no actual finish times available to rank by)`;
  const m = mean(band);
  if (m == null) return { ...empty, past };
  const spread = band.length > 1 ? Math.max(3, (Math.max(...band) - Math.min(...band)) / 2) : 5;
  return {
    past,
    recommendedTsbLow: +(m - spread).toFixed(0),
    recommendedTsbHigh: +(m + spread).toFixed(0),
    basis,
  };
}

export function taperFinding(t: TaperAnalysis): Finding | null {
  if (t.recommendedTsbLow == null || t.recommendedTsbHigh == null) return null;
  return {
    family: "Taper target (n=1)",
    title: `You've historically raced at form (TSB) ~${t.recommendedTsbLow} to ${t.recommendedTsbHigh}`,
    severity: "info",
    detail:
      `Your past races clustered in this form band — a descriptive starting point for the July tri and September marathon taper, ` +
      `more personal than the generic "just go positive". (Descriptive only: we don't have actual finish times to confirm which TSB raced best.) ` +
      `Time the taper so TSB rises into this range on race day, then refine once real results are in.`,
    evidence: `${t.basis}; ${t.past.map((p) => `${p.race} ${p.date} TSB ${p.tsbOnDay}`).join("; ")} [derived]`,
    recommendation: "Back-plan the last 10–14 days so load sheds you into this TSB band by race morning.",
    confidence: Math.min(0.7, 0.4 + t.past.length * 0.1),
  };
}
