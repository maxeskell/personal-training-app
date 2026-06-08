/**
 * Coach headline + reference bands (dashboard "Today" synthesis, brief: lead with the decision).
 *
 * The engine surfaces many signals; an athlete needs ONE call. coachHeadline() synthesises the gated
 * findings + load/recovery state into a single severity, a plain-English line, and the single most
 * important action — shared by the dashboard header, `ask`, and reports so they never disagree.
 * Deterministic (no LLM); the LLM readiness narrative complements it, it doesn't replace it.
 */

import type { InsightReport } from "./engine.js";
import type { AthleteState } from "../state/types.js";

export type Tone = "good" | "neutral" | "warn" | "bad";

export interface Band {
  label: string;
  tone: Tone;
}

/** Training Stress Balance (form) reference band — context for an otherwise unitless number. */
export function tsbBand(tsb: number | null | undefined): Band | null {
  if (tsb == null) return null;
  if (tsb > 15) return { label: "very fresh (detraining risk if held)", tone: "neutral" };
  if (tsb >= 5) return { label: "fresh / race-ready", tone: "good" };
  if (tsb >= -10) return { label: "productive training load", tone: "good" };
  if (tsb >= -20) return { label: "fatigued — monitor", tone: "warn" };
  return { label: "deep fatigue / overreached", tone: "bad" };
}

/** CTL ramp (fitness gain rate) band — >~7/wk is the classic injury-risk ramp. */
export function rampBand(rampPerWeek: number | null | undefined): Band | null {
  if (rampPerWeek == null) return null;
  if (rampPerWeek > 7) return { label: "steep — injury-risk ramp", tone: "warn" };
  if (rampPerWeek >= 2) return { label: "building", tone: "good" };
  if (rampPerWeek >= -2) return { label: "maintaining", tone: "neutral" };
  return { label: "detraining", tone: "warn" };
}

export interface Headline {
  severity: "red" | "amber" | "green";
  line: string; // the synthesised one-liner
  action?: string; // the single most important thing to do
  drivers: string[]; // short supporting bullets (the corroborating signals)
}

/**
 * One coherent call from the gated findings + load/recovery. Leads with the highest-severity surfaced
 * finding, corroborated by load (TSB) and recovery limiter, and carries that finding's recommendation
 * as the action — so "what do I do today" is answered without the athlete assembling it themselves.
 */
export function coachHeadline(report: InsightReport, state: AthleteState): Headline {
  const top = report.topFindings;
  const flags = top.filter((f) => f.severity === "flag");
  const watches = top.filter((f) => f.severity === "watch");
  const tsb = report.load?.tsb ?? null;
  const band = tsbBand(tsb);
  const limiter = state.recovery.value?.limiterToday ?? null;
  const ts = state.trainingStatus.value;

  const drivers: string[] = [];
  if (tsb != null && band) drivers.push(`Form (TSB) ${tsb} — ${band.label}`);
  if (ts?.loadRatio != null) drivers.push(`Acute:chronic ${ts.loadRatio}${ts.acwrStatus ? ` (${ts.acwrStatus})` : ""}`);
  if (limiter) drivers.push(`Recovery limiter: ${limiter}`);
  if (state.hrvStatus.value?.status && state.hrvStatus.value.status.toUpperCase() !== "BALANCED") {
    drivers.push(`HRV status ${state.hrvStatus.value.status}`);
  }

  if (flags.length) {
    const lead = flags[0];
    // Red when the body is clearly under load (overreached/fatigued) alongside the flag; else amber.
    const fatigued = band?.tone === "bad" || ts?.acwrStatus?.toUpperCase() === "HIGH";
    return {
      severity: fatigued ? "red" : "amber",
      line: `${lead.title}${band ? ` — and your form is ${band.label}` : ""}. ${flags.length > 1 ? `(${flags.length} flags today.)` : ""}`.trim(),
      action: lead.recommendation ?? "Ease intensity today and re-check tomorrow's signals.",
      drivers,
    };
  }
  if (watches.length) {
    const lead = watches[0];
    return {
      severity: "amber",
      line: `${lead.title}. Nothing alarming, but worth a lighter touch.`,
      action: lead.recommendation,
      drivers,
    };
  }
  return {
    severity: "green",
    line: band && band.tone !== "good" ? `Signals at baseline; form is ${band.label}.` : "Signals at baseline — clear to train as planned.",
    action: undefined,
    drivers,
  };
}
