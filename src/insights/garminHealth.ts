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

import type { TrainingStatusSignals, HrvStatusSignals } from "../state/types.js";
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

function prettyLabel(s: string | undefined): string {
  if (!s) return "—";
  // "OVERREACHING_5" → "Overreaching"
  return s
    .replace(/_\d+$/, "")
    .toLowerCase()
    .replace(/(^|_)(\w)/g, (_, p, c) => (p ? " " : "") + c.toUpperCase());
}
