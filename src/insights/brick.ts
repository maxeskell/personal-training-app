/**
 * Triathlon-specific execution (data-scientist brief Q4): brick-run decoupling.
 *
 * The headline tri signal is how much the run falls apart OFF THE BIKE versus fresh, and how that
 * relates to the preceding bike leg's intensity — the "bike intensity ceiling" above which the run
 * collapses. True transition (T1/T2) timing and within-leg decoupling need per-second .FIT streams
 * and start timestamps the summary feed doesn't carry, so this is an HONEST same-day proxy:
 *   - a "brick day" = a Run and a Ride logged on the same date (run assumed off the bike),
 *   - run efficiency (EF = avg power ÷ avg HR) on brick days vs fresh-run days,
 *   - related to that day's ride load (ESS) as an intensity stand-in.
 * It populates only when enough power-equipped runs exist; otherwise it stays silent.
 */

import type { RichActivity, Finding } from "./metrics.js";
import { mean } from "./stats.js";

export interface BrickAnalysis {
  brickDays: number;
  freshRuns: number;
  brickEf: number | null;
  freshEf: number | null;
  decouplingPct: number | null; // (freshEF − brickEF)/freshEF: how much EF drops off the bike
  rideEssOnBrickDays: number | null;
}

function runEf(a: RichActivity): number | null {
  return a.sport === "Run" && a.avwatts && a.avhr && (a.movingSec ?? 0) >= 1200 ? a.avwatts / a.avhr : null;
}

export function analyseBricks(acts: RichActivity[]): BrickAnalysis {
  const rideDates = new Set(acts.filter((a) => a.sport === "Ride").map((a) => a.date));
  const rideEssByDate = new Map<string, number>();
  for (const a of acts) {
    if (a.sport === "Ride") rideEssByDate.set(a.date, (rideEssByDate.get(a.date) ?? 0) + (a.ess ?? 0));
  }

  const brickEfs: number[] = [];
  const freshEfs: number[] = [];
  const brickRideEss: number[] = [];
  const brickDateSet = new Set<string>();

  for (const a of acts) {
    const ef = runEf(a);
    if (ef == null) continue;
    if (rideDates.has(a.date)) {
      brickEfs.push(ef);
      brickDateSet.add(a.date);
      brickRideEss.push(rideEssByDate.get(a.date) ?? 0);
    } else {
      freshEfs.push(ef);
    }
  }

  const brickEf = mean(brickEfs);
  const freshEf = mean(freshEfs);
  const decouplingPct = brickEf != null && freshEf != null && freshEf !== 0 ? +(((freshEf - brickEf) / freshEf) * 100).toFixed(1) : null;

  return {
    brickDays: brickDateSet.size,
    freshRuns: freshEfs.length,
    brickEf: brickEf == null ? null : +brickEf.toFixed(3),
    freshEf: freshEf == null ? null : +freshEf.toFixed(3),
    decouplingPct,
    rideEssOnBrickDays: mean(brickRideEss) == null ? null : +mean(brickRideEss)!.toFixed(0),
  };
}

export function brickFinding(b: BrickAnalysis): Finding | null {
  if (b.decouplingPct == null || b.brickDays < 3 || b.freshRuns < 3) return null;
  const big = b.decouplingPct >= 5;
  return {
    family: "Triathlon execution",
    title: big ? "Run decouples off the bike" : "Run holds up off the bike",
    severity: big ? "watch" : "info",
    detail:
      `Run efficiency off the bike is ${b.decouplingPct >= 0 ? "down" : "up"} ${Math.abs(b.decouplingPct)}% vs fresh runs ` +
      `(brick EF ${b.brickEf} vs fresh ${b.freshEf}, ride load ~${b.rideEssOnBrickDays} ESS those days). ` +
      `${big ? "That gap points to bike pacing too aggressive or run-off-bike adaptation lacking — rehearse race-effort bricks and hold the bike ceiling." : "Encouraging durability into T2 — keep the brick rehearsals going."}`,
    evidence: `${b.brickDays} brick days vs ${b.freshRuns} fresh runs (same-day Ride+Run proxy) [derived]`,
    recommendation: big ? "Cap the bike leg's intensity and practise the first 2 km off the bike at goal effort." : undefined,
    confidence: Math.min(0.75, 0.45 + b.brickDays * 0.04),
  };
}
