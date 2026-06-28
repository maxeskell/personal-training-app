/**
 * The next-session coach note — a deterministic, coach-voice line on how to EXECUTE the imminent planned
 * session ("settle into a controlled hard effort", "truly easy — this is recovery"), modulated by today's
 * readiness/form. It's the prospective sibling of reviewBridge's retrospective session signal: that reacts
 * to a session just done; this primes the session about to be done.
 *
 * No LLM (dashboard-render discipline). AI Endurance exposes no structured workout (intervals/targets) on a
 * planned session — only a free-text title — so the execution intent is INFERRED from the title (reusing
 * fuelPlan's inferIntensity) and labelled honestly as such in `basis`. The readiness modifier only ever
 * gates effort DOWN (matching the repo's conservative "smallest change" ethos): it never tells the athlete
 * to go harder than the plan, only to ease a hard day when the form is poor. Returns null for sports with
 * no execution note (Strength/Other), so the caller renders nothing — degrade-don't-crash.
 */

import type { PlannedSession, AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import { inferIntensity } from "./fuelPlan.js";
import { tsbBand, rampBand } from "../insights/headline.js";

export interface SessionNote {
  sport: string;
  date: string;
  /** The coach-voice one/two-liner = execution prior + (optional) readiness modifier. A MODEL/estimate. */
  note: string;
  /** Why — the honest basis (title-inferred intensity, the form numbers that drove any modifier). */
  basis: string[];
}

/** Titles that read as rep-based work (deserve the "contrast is the workout" framing, not steady-state). */
const INTERVALS_RE = /(interval|vo2|hill repeat|fartlek|sprint|crit|\b\d+\s?x\b)/i;
/** Titles that are explicitly recovery (so a short untyped easy run isn't mislabelled). */
const RECOVERY_RE = /(recovery|shakeout|easy spin|technique|drills|mobility)/i;

/**
 * Build the coach note for one planned session against today's state + insights. Pure. Returns null when
 * the sport carries no execution intent (Strength/Other).
 */
export function nextSessionNote(session: PlannedSession, report: InsightReport | undefined, state: AthleteState): SessionNote | null {
  const sport = session.sport ?? "Other";
  if (sport === "Strength" || sport === "Other") return null;

  const title = (session.title ?? "").trim();
  const intensity = inferIntensity(title, sport);
  const dur = session.durationMin ?? 0;
  const basis: string[] = [];

  // STEP 1 — session-type execution prior (the "how to execute this kind of session" base sentence).
  let prior: string;
  let isHard = false;
  if (title && INTERVALS_RE.test(title)) {
    prior = "Hit your targets on the hard reps and let the recoveries be genuinely easy — the contrast is the workout.";
    basis.push("title → intervals");
    isHard = true;
  } else if (intensity === "hard") {
    prior = "Settle into a controlled, comfortably-hard effort you could just hold — nail a steady pace rather than surging.";
    basis.push("title → threshold/hard");
    isHard = true;
  } else if (intensity === "endurance" && dur >= 90) {
    prior = "Keep it conversational and let it run long — durability is the point; fuel early and hold form when it gets late.";
    basis.push(`endurance · ${Math.round(dur)} min (long)`);
  } else if (intensity === "endurance") {
    prior = "Aerobic steady — keep it in Z2 and resist the urge to push the pace.";
    basis.push("endurance");
  } else if (RECOVERY_RE.test(title)) {
    prior = "Truly easy — this is recovery, so keep it short and gentle; if anything, do less.";
    basis.push("title → recovery");
  } else {
    // Easy *aerobic* volume (not a recovery session) — keep it easy, but it's base, not "do less".
    prior = "Keep it genuinely easy — conversational, aerobic base, not a tempo. Resist nudging the pace up.";
    basis.push("easy aerobic");
  }
  basis.unshift(title ? "intensity inferred from title" : "no title — intensity assumed");

  // STEP 2 — readiness / TSB modifier. Gates DOWN only (never "go harder than planned").
  const verdict = state.readinessVerdict;
  const tsb = report?.load?.tsb ?? null;
  const band = tsbBand(tsb);
  const ramp = rampBand(report?.load?.rampPerWeek);
  const limiter = state.recovery.value?.limiterToday ?? null;
  const tsbStr = tsb != null ? `TSB ${Math.round(tsb)}` : null;
  let modifier = "";

  if (isHard) {
    if (verdict === "red" || band?.tone === "bad" || !!limiter) {
      modifier = ` — but you're carrying fatigue${tsbStr ? ` (${tsbStr}${limiter ? `, limiter ${limiter}` : ""})` : limiter ? ` (limiter ${limiter})` : ""}, so today cut the reps, drop it to steady aerobic, or move it. Quality won't stick on this much fatigue.`;
      if (tsbStr) basis.push(`${tsbStr}${band ? ` (${band.label})` : ""}`);
      if (limiter) basis.push(`limiter ${limiter}`);
    } else if (verdict === "amber" || band?.tone === "warn") {
      modifier = ` — form's a touch low${tsbStr ? ` (${tsbStr})` : ""}, so bias to the easy end of the targets and bail if the legs aren't there.`;
      if (tsbStr) basis.push(tsbStr);
    } else if (ramp?.tone === "warn") {
      modifier = " (ramp is steep — do the session, but don't add extra on top).";
      basis.push("ramp steep");
    }
  } else if (intensity === "endurance" && (verdict === "red" || band?.tone === "bad")) {
    modifier = ` — and since you're fatigued${tsbStr ? ` (${tsbStr})` : ""}, keep it strictly easy; don't let it drift into tempo.`;
    if (tsbStr) basis.push(`${tsbStr}${band ? ` (${band.label})` : ""}`);
  }
  // Recovery/easy priors are never modified by fatigue — easy IS the recovery.

  return { sport, date: session.date.slice(0, 10), note: prior + modifier, basis };
}
