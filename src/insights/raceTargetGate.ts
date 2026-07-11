/**
 * Spec 07 — the race-target plausibility gate.
 *
 * Birmingham 2026: the athlete's profile target ("sub 2:00") was ~30 minutes beyond anything his own
 * numbers supported, and NOTHING in the pipeline ever compared the two — the race-splits model proved
 * 28 seconds accurate on the legs it modelled while every race-prep report paced toward the fantasy.
 * This module is the missing comparison: parse the athlete-authored target string, find the target
 * that belongs to a race-splits plan, and return a verdict that the dashboard card renders and the
 * race-prep prompt must LEAD with.
 *
 * Deterministic + pure (no LLM, no disk): callers own profile loading (BuildOptions.profileRaces /
 * runRacePrep's param), so the engine stays hermetic in tests. Targets are athlete-authored STRINGS
 * ("sub 2:00", "4:55-5:10", "season opener — no target") — parsing is tolerant and an unparseable or
 * absent target simply yields no check (degrade, don't crash).
 */

import type { AthleteState } from "../state/types.js";
import type { RaceSplitPlan, TargetCheck, TriPerformance } from "./splits.js";

/** The slice of a profile race the gate needs (mirrors profile schema `races[]` — structurally typed). */
export interface ProfileRaceTarget {
  name?: string | null;
  date?: string | null;
  target_time?: string | null;
}

function clock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

/**
 * Parse the time bounds out of an athlete-authored target string. "sub/under X" and a single bare
 * time both read as an upper bound (the time to beat); "A-B" reads as a range. `H:MM` vs `MM:SS` is
 * genuinely ambiguous ("sub 2:00" = 2 h for a tri, "sub 20:00" = 20 min for a 5k), so a bare `A:BB`
 * token is resolved by whichever reading sits closer (log-scale) to `referenceSec` — the plan's own
 * predicted time. `H:MM:SS` is unambiguous. No time-like token → nulls (nothing to check).
 */
export function parseTargetSeconds(label: string, referenceSec?: number): { minSec: number | null; maxSec: number | null } {
  const tokens = [...label.matchAll(/(\d{1,2}):(\d{2})(?::(\d{2}))?/g)].map((m) => {
    const a = +m[1];
    const b = +m[2];
    if (m[3] != null) return a * 3600 + b * 60 + +m[3];
    const asHours = a * 3600 + b * 60;
    const asMinutes = a * 60 + b;
    if (!referenceSec || referenceSec <= 0) return asHours;
    return Math.abs(Math.log(asHours / referenceSec)) <= Math.abs(Math.log(asMinutes / referenceSec)) ? asHours : asMinutes;
  });
  if (!tokens.length) return { minSec: null, maxSec: null };
  if (tokens.length === 1) return { minSec: null, maxSec: tokens[0] };
  return { minSec: Math.min(...tokens), maxSec: Math.max(...tokens) };
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The athlete's own target for a plan's race. Exact DATE match wins — race names drift between
 * sources (AI Endurance's goal was literally "Birmingham Triahtlon" while the profile said
 * "Birmingham Triathlon", so name matching alone would have missed the A-race). Fallbacks: name
 * containment either way, then a shared leading word (≥5 chars, so "Alderford"-style one-worders match).
 */
export function targetForPlan(plan: RaceSplitPlan, races: ProfileRaceTarget[]): string | undefined {
  const withTargets = races.filter((r) => r.target_time);
  const planDate = plan.date?.slice(0, 10);
  if (planDate) {
    const byDate = withTargets.find((r) => r.date && String(r.date).slice(0, 10) === planDate);
    if (byDate) return byDate.target_time!;
  }
  const pn = norm(plan.race);
  const byName = withTargets.find((r) => {
    const rn = norm(r.name ?? "");
    return rn && (pn.includes(rn) || rn.includes(pn));
  });
  if (byName) return byName.target_time!;
  const lead = pn.split(" ")[0] ?? "";
  if (lead.length >= 5) {
    const byLead = withTargets.find((r) => norm(r.name ?? "").split(" ")[0] === lead);
    if (byLead) return byLead.target_time!;
  }
  return undefined;
}

/**
 * The gate itself: the athlete's target vs the plan's modelled band [best case, race-it-today].
 * Returns null when the target string carries no parseable time (e.g. "season opener — no target") —
 * that's a choice, not an error. A plan with missing legs can't be judged fairly (its total is not a
 * full-race time), so the verdict says exactly that instead of comparing apples to a partial race.
 */
export function checkTargetAgainstPlan(targetLabel: string, plan: RaceSplitPlan): TargetCheck | null {
  const best = plan.bestSec ?? plan.predictedSec; // fastest the model will grant (race-day best)
  const worst = plan.worstSec ?? plan.predictedSec; // race it today
  if (plan.missingLegs?.length) {
    return {
      targetLabel,
      targetSec: null,
      verdict: "model-incomplete",
      gapPct: null,
      note: `Can't check the "${targetLabel}" target — the model has no estimate for ${plan.missingLegs.join(", ")}, so its total is not a full-race time.`,
    };
  }
  const { maxSec } = parseTargetSeconds(targetLabel, worst);
  if (maxSec == null || !(best > 0)) return null;
  const gapPct = +(((maxSec - best) / best) * 100).toFixed(1);
  if (maxSec < best * 0.95) {
    return {
      targetLabel,
      targetSec: maxSec,
      verdict: "implausible",
      gapPct,
      note:
        `Target ${targetLabel} (${clock(maxSec)}) is ${Math.abs(gapPct)}% faster than even the model's best case ` +
        `(${clock(best)}). Recalibrate the target or fix the model's inputs (CSS / FTP) — and pace the race off the model, not the target.`,
    };
  }
  if (maxSec < best) {
    return {
      targetLabel,
      targetSec: maxSec,
      verdict: "stretch",
      gapPct,
      note: `Target ${targetLabel} (${clock(maxSec)}) sits just beyond the model's best case (${clock(best)}) — a stretch; it has to be earned in the build.`,
    };
  }
  if (maxSec <= worst) {
    return {
      targetLabel,
      targetSec: maxSec,
      verdict: "in-range",
      gapPct,
      note: `Target ${targetLabel} (${clock(maxSec)}) sits inside the model's range (${clock(best)}–${clock(worst)}).`,
    };
  }
  return {
    targetLabel,
    targetSec: maxSec,
    verdict: "conservative",
    gapPct,
    note: `Target ${targetLabel} (${clock(maxSec)}) is slower than racing at today's level (${clock(worst)}) — you can aim higher.`,
  };
}

/** The recent-swim + run-prediction inputs a tri plan needs, assembled from state (+ session decays). */
export function triPerformanceFromState(
  state: AthleteState,
  sessionDecays: Array<{ date: string; sport: string; swim: { paceSecPer100m: number | null; openWater: boolean | null } | null }>,
  lookbackDays = 90,
): TriPerformance {
  const runPredictions: TriPerformance["runPredictions"] = {};
  for (const rp of state.racePredictions.value?.predictions ?? []) {
    if (rp.label === "5K" || rp.label === "10K" || rp.label === "Half" || rp.label === "Marathon") runPredictions[rp.label] = rp.timeSeconds;
  }
  // Swim fallback when CSS is unset: median observed open-water pace from recent streams (pool swims
  // carry no GPS pace, so they exclude themselves). Rough MODEL — but it beats silently omitting a leg.
  const cutoff = new Date(`${state.date}T00:00:00Z`).getTime() - lookbackDays * 86_400_000;
  const owPaces = sessionDecays
    .filter(
      (d) =>
        /swim/i.test(d.sport) &&
        d.date <= state.date &&
        new Date(`${d.date}T00:00:00Z`).getTime() >= cutoff &&
        d.swim?.paceSecPer100m != null &&
        d.swim.openWater !== false,
    )
    .map((d) => d.swim!.paceSecPer100m!)
    .sort((a, b) => a - b);
  const thresholds = state.thresholds.value;
  return {
    cssSecPer100: thresholds?.swimCssSecPer100,
    recentOpenWaterPaceSecPer100: owPaces.length ? owPaces[Math.floor(owPaces.length / 2)] : undefined,
    ftpW: thresholds?.bikeFtpW,
    runThresholdPaceSecPerKm: thresholds?.runThresholdPaceSecPerKm,
    runPredictions,
    riderWeightKg: state.weightKg.value ?? undefined,
  };
}

/**
 * The deterministic block the race-prep prompt receives — model splits + target verdict — so the LLM
 * report opens from the numbers instead of the aspiration. Empty string when there's no plan (not a
 * modellable tri): the flow degrades to its old shape rather than inventing a gate.
 */
export function gatePromptBlock(plan: RaceSplitPlan | null, targetLabel: string | undefined): string {
  if (!plan) return "";
  const legs = plan.segments.map((s) => `${s.label} ${clock(s.splitSec)}${s.target ? ` (${s.target})` : ""}`).join(" · ");
  const lines = [
    "RACE-TIME MODEL vs TARGET (deterministic race-splits model — a MODEL, not a promise):",
    `- Model race-it-today: ${clock(plan.predictedSec)} over ${plan.distanceKm} km — ${legs}`,
  ];
  if (plan.missingLegs?.length) {
    lines.push(`- ⚠ The model has NO estimate for ${plan.missingLegs.join(", ")} — its total is NOT a full-race time. Say so wherever a finish time is discussed.`);
  }
  const check = targetLabel ? checkTargetAgainstPlan(targetLabel, plan) : null;
  if (check) {
    lines.push(`- TARGET CHECK [${check.verdict.toUpperCase()}]: ${check.note}`);
    if (check.verdict === "implausible") {
      lines.push(
        "- LEAD the report with this discrepancy — state the target vs the model, what would have to be true to close the gap, and build ALL pacing advice off the model's numbers, never the target's.",
      );
    }
  } else if (targetLabel) {
    lines.push(`- Athlete target "${targetLabel}" carries no parseable time — treat it as intent, not a number.`);
  } else {
    lines.push("- No athlete target found for this race (profile races[].target_time / AI Endurance goal) — note that, and suggest setting one calibrated off the model.");
  }
  return lines.join("\n");
}
