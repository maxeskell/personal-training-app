/**
 * Garmin health-model detectors (Phase 2 — health/injury slice).
 *
 * These consume Garmin's own native models (verified shapes from the probe):
 *  - Acute:chronic workload ratio + training-status label (get_training_status): the most evidence-
 *    backed overtraining/injury flag in the dataset (brief Q2). Garmin computes the ratio for us.
 *  - HRV status vs the device's personal baseline band (get_hrv_data): the recovery/autonomic signal.
 *
 * Both are MODEL estimates → directional: we surface the state + the numbers, with the caveat attached.
 */

import type { TrainingStatusSignals, HrvStatusSignals, EnduranceScoreSignals, PowerCurveSignals } from "../state/types.js";
import type { Finding } from "./metrics.js";

/** Acute:chronic load + training status → overtraining / injury-risk finding. */
export function trainingStatusFinding(ts: TrainingStatusSignals | null | undefined): Finding | null {
  if (!ts) return null;
  const ratio = ts.loadRatio;
  const high = ts.acwrStatus?.toUpperCase() === "HIGH" || (ratio != null && ratio >= 1.5);
  const label = (ts.label ?? "").toUpperCase();
  const overreaching = /OVERREACH|UNPRODUCTIVE|STRAINED/.test(label);
  if (!high && !overreaching) {
    // Nothing concerning — only worth an info note if we have the ratio.
    if (ratio == null) return null;
    return {
      family: "Load & injury risk",
      title: "Training load in range",
      severity: "info",
      detail: `Garmin acute:chronic load ratio ${ratio} (${ts.acwrStatus ?? "—"}); status ${prettyLabel(ts.label)}. Acute ${ts.acuteLoad ?? "—"} / chronic ${ts.chronicLoad ?? "—"}.`,
      evidence: `get_training_status [garmin MODEL — directional]`,
      confidence: 0.55,
    };
  }
  return {
    family: "Load & injury risk",
    title: high && overreaching ? "Overreaching — acute load spike" : overreaching ? `Training status: ${prettyLabel(ts.label)}` : "Acute load spike (ACWR high)",
    severity: high ? "flag" : "watch",
    detail:
      `Garmin acute:chronic load ratio is ${ratio ?? "—"}${ts.acwrStatus ? ` (${ts.acwrStatus})` : ""}` +
      `${overreaching ? `, status ${prettyLabel(ts.label)}` : ""} — acute ${ts.acuteLoad ?? "—"} vs chronic ${ts.chronicLoad ?? "—"}` +
      `${ts.optimalChronicLoadMax != null ? ` (optimal chronic ${Math.round(ts.optimalChronicLoadMin ?? 0)}–${Math.round(ts.optimalChronicLoadMax)})` : ""}. ` +
      `A ratio above ~1.5 is the most evidence-backed overreach/injury flag — especially in your marathon-off-tri window.`,
    evidence: `get_training_status: ratio ${ratio}, ${ts.acwrStatus ?? ""} [garmin MODEL — directional]`,
    recommendation: "Pull back acute load toward the chronic baseline this week — drop a hard session or cut volume; let the ratio settle under ~1.3.",
    confidence: high && overreaching ? 0.8 : 0.7,
  };
}

/** HRV status vs personal baseline band → recovery/autonomic finding (only surfaced when not balanced). */
export function hrvStatusFinding(h: HrvStatusSignals | null | undefined): Finding | null {
  if (!h || !h.status) return null;
  const s = h.status.toUpperCase();
  if (s === "BALANCED") return null; // green — nothing to surface
  const band = h.baselineLowMs != null && h.baselineUpperMs != null ? ` (baseline ${h.baselineLowMs}–${h.baselineUpperMs} ms)` : "";
  const low = s === "LOW" || s === "POOR";
  return {
    family: "Recovery (HRV status)",
    title: `HRV status: ${prettyLabel(h.status)}`,
    severity: low ? "watch" : "info",
    detail:
      `Overnight HRV is ${prettyLabel(h.status)} — last night ${h.lastNightMs ?? "—"} ms, 7-day ${h.weeklyMs ?? "—"} ms${band}. ` +
      `${low ? "A drop below your balanced band is your best early warning of under-recovery or illness — treat today as amber." : "Worth watching alongside RHR and how you feel."}`,
    evidence: `get_hrv_data: status ${h.status} [garmin]`,
    recommendation: low ? "Favour easy/aerobic today; gate any hard session on HRV returning to baseline." : undefined,
    confidence: low ? 0.7 : 0.5,
  };
}

/** Endurance score — sustained-effort capacity. Rising = the marathon-relevant adaptation (E5). */
export function enduranceScoreFinding(e: EnduranceScoreSignals | null | undefined): Finding | null {
  if (!e || e.current == null) return null;
  const vsAvg = e.periodAvg != null ? e.current - e.periodAvg : null;
  const dir = vsAvg == null ? "" : vsAvg >= 0 ? "up" : "down";
  return {
    family: "Endurance score",
    title: vsAvg != null && vsAvg < -50 ? "Endurance score slipping" : "Endurance score",
    severity: vsAvg != null && vsAvg < -50 ? "watch" : "info",
    detail:
      `Garmin endurance score ${e.current}${e.classification ? ` (${e.classification})` : ""}` +
      `${vsAvg != null ? `, ${dir} ${Math.abs(vsAvg)} vs your recent average` : ""}` +
      `${e.nextThresholdLabel != null ? ` — ${e.nextThresholdGap} from "${e.nextThresholdLabel.replace(/_/g, " ")}"` : ""}. ` +
      `Rising endurance score (especially while VO2max plateaus) is exactly the sustained-effort adaptation the marathon build is after.`,
    evidence: `get_endurance_score [garmin MODEL — trend over absolute]`,
    confidence: 0.5,
  };
}

/** Power-duration curve → FTP estimate + the athlete's relative strength across durations. */
export function powerCurveFinding(p: PowerCurveSignals | null | undefined): Finding | null {
  if (!p || !p.bests.length || p.ftpEstimateW == null || p.ftpEstimateW <= 0) return null;
  // Classify the strongest duration band relative to FTP (sprint/anaerobic vs VO2 vs threshold/endurance).
  const pick = (d: string) => p.bests.find((b) => b.duration === d)?.watts;
  const short = pick("1min") ?? pick("30s") ?? pick("5s");
  const mid = pick("5min");
  const long = pick("20min") ?? pick("60min");
  const ratios: Array<[string, number]> = [];
  if (short) ratios.push(["anaerobic/sprint (1-min)", short / p.ftpEstimateW]);
  if (mid) ratios.push(["VO2 (5-min)", mid / p.ftpEstimateW]);
  if (long) ratios.push(["threshold/endurance (20-60min)", long / p.ftpEstimateW]);
  if (ratios.length < 2) return null;
  const strongest = ratios.sort((a, b) => b[1] - a[1])[0];
  return {
    family: "Power-duration curve",
    title: `Power profile leans ${strongest[0].split(" ")[0]}`,
    severity: "info",
    detail:
      `Estimated FTP ${p.ftpEstimateW} W (from ${p.activitiesAnalyzed ?? "?"} activities). Relative to FTP your strongest band is ${strongest[0]} — ` +
      `improvements at 1/5-min point to anaerobic/VO2 gains, at 20–60-min to threshold gains. Pull more power-equipped sessions (fit-sync) to sharpen this.`,
    evidence: `get_power_duration_curve season bests [garmin]`,
    confidence: 0.45,
  };
}

function prettyLabel(s: string | undefined): string {
  if (!s) return "—";
  // "OVERREACHING_5" → "Overreaching"
  return s
    .replace(/_\d+$/, "")
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_, p, c) => (p ? " " : "") + c.toUpperCase());
}
