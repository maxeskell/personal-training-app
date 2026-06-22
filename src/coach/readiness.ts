import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";
import { ADVICE_RECS_SCHEMA, type AdviceRec } from "./adviceRecs.js";

export interface ReadinessVerdict {
  verdict: "green" | "amber" | "red";
  why: string;
  drivers: Array<{ signal: string; reading: string; source: string }>;
  cautions: string[];
  /** Family-tagged, actionable recommendations — surfaced as individually reactable cards (item 4-iii). */
  recommendations?: AdviceRec[];
}

export const READINESS_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["green", "amber", "red"] },
    why: { type: "string", description: "One to two sentences citing the data behind the call." },
    drivers: {
      type: "array",
      items: {
        type: "object",
        properties: {
          signal: { type: "string" },
          reading: { type: "string", description: "The value and how it compares to baseline/trend." },
          source: { type: "string", description: "ai-endurance | garmin | derived" },
        },
        required: ["signal", "reading", "source"],
        additionalProperties: false,
      },
    },
    cautions: { type: "array", items: { type: "string" } },
    recommendations: ADVICE_RECS_SCHEMA,
  },
  required: ["verdict", "why", "drivers", "cautions"],
  additionalProperties: false,
};

function fmt(n: number | null | undefined, digits = 0): string {
  return n == null ? "—" : n.toFixed(digits);
}

/** Build a compact, provenance-tagged snapshot for the model. Includes the trailing trend. */
export function summarizeForReadiness(window: AthleteState[]): string {
  const today = window[window.length - 1];
  const r = today.recovery.value;
  const tb = today.tiebreak.value;
  const sleep = today.sleep.value;

  const trend = (pick: (s: AthleteState) => number | null | undefined, digits = 0) =>
    window.map((s) => fmt(pick(s), digits)).join(" → ");

  return [
    `DATE: ${today.date}`,
    "",
    "INTERPRETABLE SIGNALS (today, with provenance):",
    `- HRV overnight: ${fmt(today.hrvOvernight.value)} ms vs 7d baseline ${fmt(today.hrv7dBaseline.value)} [${today.hrvOvernight.source}]`,
    `- Resting HR: ${fmt(today.restingHr.value)} bpm vs 7d baseline ${fmt(today.restingHr7dBaseline.value)} [${today.restingHr.source}]`,
    sleep
      ? `- Sleep: score ${fmt(sleep.score)}, ${fmt(sleep.hours, 1)} h, overnight HRV ${fmt(sleep.overnightHrvMs)} ms [${today.sleep.source}]`
      : `- Sleep: unavailable (Garmin absent)`,
    today.weightKg.value != null
      ? `- Weight: ${fmt(today.weightKg.value, 1)} kg (trend only — never a target; flag a rapid/unexplained drop as a health concern) [${today.weightKg.source}]`
      : `- Weight: unavailable`,
    "",
    "AI ENDURANCE RECOVERY MODEL [ai-endurance]:",
    r
      ? [
          `- Cardio recovery: ${fmt(r.cardioRecovery)}/100`,
          `- Orthopedic recovery — run ${fmt(r.orthopedic?.run)} / bike ${fmt(r.orthopedic?.bike)} / swim ${fmt(r.orthopedic?.swim)} (per 100)`,
          `- Today's limiter: ${r.limiterToday ?? "—"}`,
          `- rMSSD ${fmt(r.rmssdMs)} ms, resting HR ${fmt(r.restingHrBpm)} bpm (latest)`,
        ].join("\n")
      : "- unavailable",
    "",
    "GARMIN TIEBREAK ONLY (black box — use only if interpretable signals are ambiguous):",
    tb
      ? `- Body Battery: ${tb.bodyBatteryLevel ?? "—"}; Training Readiness: ${fmt(tb.trainingReadiness)} (${tb.trainingReadinessLevel ?? "—"}) [garmin]`
      : "- unavailable",
    "",
    `TRAILING TREND over last ${window.length} days (oldest → today):`,
    `- HRV (ms):        ${trend((s) => s.hrvOvernight.value)}`,
    `- Resting HR (bpm):${trend((s) => s.restingHr.value)}`,
    `- Sleep (h):       ${trend((s) => s.sleep.value?.hours, 1)}`,
    `- Cardio recovery: ${trend((s) => s.recovery.value?.cardioRecovery)}`,
    `- Run orthopedic:  ${trend((s) => s.recovery.value?.orthopedic?.run)}`,
    `- Weight (kg):     ${trend((s) => s.weightKg.value, 1)} [trend only]`,
    "",
    today.syncGaps.length ? `SYNC GAPS: ${today.syncGaps.map((g) => g.detail).join("; ")}` : "SYNC GAPS: none",
  ].join("\n");
}

/**
 * Deterministic count of interpretable signals materially out of line TODAY, plus whether there's a
 * multi-day deterioration. Used by the trend floor so the "a red needs a pattern" rule (criterion #5) is
 * enforced in code, not just hoped for in the prompt. Counts HRV/RHR/sleep AND the AI Endurance recovery
 * model (cardio + per-sport orthopedic), so a model-driven red stays red.
 */
export function adverseSignalCount(window: AthleteState[]): { count: number; multiDay: boolean } {
  const today = window[window.length - 1];
  let count = 0;
  const hrv = today.hrvOvernight.value, hrvBase = today.hrv7dBaseline.value;
  if (hrv != null && hrvBase != null && hrvBase > 0 && hrv < hrvBase * 0.9) count++;
  const rhr = today.restingHr.value, rhrBase = today.restingHr7dBaseline.value;
  if (rhr != null && rhrBase != null && rhrBase > 0 && rhr > rhrBase + 5) count++;
  const sleepH = today.sleep.value?.hours;
  if (sleepH != null && sleepH < 6.5) count++;
  const cardio = today.recovery.value?.cardioRecovery;
  if (cardio != null && cardio < 50) count++;
  const orth = today.recovery.value?.orthopedic;
  if (orth && [orth.run, orth.bike, orth.swim].some((v) => v != null && v < 50)) count++;

  // Multi-day deterioration: ≥2 of the last 3 days were themselves adverse (HRV suppressed or RHR elevated
  // vs that day's own baseline). Counting sustained adverse DAYS — not a 2-point slope, which a single
  // off night would trip — is what distinguishes a real pattern from a one-day blip.
  let adverseDays = 0;
  for (const s of window.slice(-3)) {
    const h = s.hrvOvernight.value, hb = s.hrv7dBaseline.value;
    const r = s.restingHr.value, rb = s.restingHr7dBaseline.value;
    const hOff = h != null && hb != null && hb > 0 && h < hb * 0.9;
    const rOff = r != null && rb != null && rb > 0 && r > rb + 5;
    if (hOff || rOff) adverseDays++;
  }
  return { count, multiDay: adverseDays >= 2 };
}

/**
 * High-specificity single signals that are individually meaningful enough to KEEP a red even without a
 * second corroborating signal: an isolated large resting-HR spike (classic illness signal), an HRV
 * collapse, an orthopedic-recovery crash (injury), or a very low cardio recovery. The generic "needs a
 * pattern" floor must not wave these through. Returns a short reason, or null.
 */
export function highSpecificityAlarm(today: AthleteState): string | null {
  const rhr = today.restingHr.value, rhrBase = today.restingHr7dBaseline.value;
  if (rhr != null && rhrBase != null && rhrBase > 0 && rhr > rhrBase + 10) return `resting HR ${rhr} ≫ baseline ${rhrBase.toFixed(0)} (+${(rhr - rhrBase).toFixed(0)})`;
  const hrv = today.hrvOvernight.value, hrvBase = today.hrv7dBaseline.value;
  if (hrv != null && hrvBase != null && hrvBase > 0 && hrv < hrvBase * 0.75) return `HRV ${hrv} collapsed vs baseline ${hrvBase.toFixed(0)}`;
  const orth = today.recovery.value?.orthopedic;
  if (orth && [orth.run, orth.bike, orth.swim].some((v) => v != null && v < 30)) return `orthopedic recovery crashed (<30)`;
  const cardio = today.recovery.value?.cardioRecovery;
  if (cardio != null && cardio < 30) return `cardio recovery very low (${cardio}/100)`;
  return null;
}

/** How many interpretable inputs are actually present today — so a red isn't downgraded on thin data. */
export function presentInterpretableCount(today: AthleteState): number {
  let n = 0;
  if (today.hrvOvernight.value != null && today.hrv7dBaseline.value != null) n++;
  if (today.restingHr.value != null && today.restingHr7dBaseline.value != null) n++;
  if (today.sleep.value?.hours != null) n++;
  if (today.recovery.value?.cardioRecovery != null) n++;
  const orth = today.recovery.value?.orthopedic;
  if (orth && [orth.run, orth.bike, orth.swim].some((v) => v != null)) n++;
  return n;
}

/**
 * Trend floor (criterion #5): a RED verdict requires a PATTERN. If the model returns red but only one
 * interpretable signal is out of line and there's no multi-day deterioration, downgrade to amber —
 * EXCEPT (a) a lone high-specificity signal (illness/injury) stays red, and (b) when too few interpretable
 * inputs are present we DON'T downgrade (less data must not make the call more permissive — we hold the
 * model's red with a limited-data caution). Never upgrades, never touches amber/green.
 */
export function applyTrendFloor(verdict: ReadinessVerdict, window: AthleteState[]): ReadinessVerdict {
  if (verdict.verdict !== "red") return verdict;
  const today = window[window.length - 1];
  const { count, multiDay } = adverseSignalCount(window);
  if (count >= 2 || multiDay) return verdict; // a real pattern — leave it red

  const alarm = highSpecificityAlarm(today);
  if (alarm) {
    return {
      ...verdict,
      cautions: [...verdict.cautions, `Kept red on a single high-specificity signal (${alarm}) — individually meaningful enough not to wave through on the "needs a pattern" rule.`],
    };
  }
  if (presentInterpretableCount(today) < 2) {
    return {
      ...verdict,
      cautions: [...verdict.cautions, "Held the model's red despite only one in-range signal: too little interpretable data (HRV/RHR/sleep/recovery mostly missing) to confirm a one-off. Limited-data caution — don't read 'fine' into missing data; re-check with more signal."],
    };
  }
  return {
    ...verdict,
    verdict: "amber",
    cautions: [
      ...verdict.cautions,
      "Auto-adjusted red→amber: only one interpretable signal is out of line and there's no multi-day " +
        "deterioration, so a single off-reading shouldn't read red (trend over point). Re-check tomorrow.",
    ],
  };
}

export async function assessReadiness(
  llm: CoachLLM,
  window: AthleteState[],
): Promise<{ verdict: ReadinessVerdict; cacheRead: number; costUsd: number }> {
  const summary = summarizeForReadiness(window);
  const prompt =
    "Assess today's training readiness from this snapshot. Apply the operating rules. " +
    "Remember: trend beats single point, one metric out of line is not red, Garmin scores are tiebreak only. " +
    "Also distil the FEWEST genuinely distinct, actionable `recommendations` (each a single imperative line " +
    "tagged with its insight family) — what to actually DO today given the call. Merge anything that is the same " +
    "underlying action into one line and prefer one strong recommendation over restating it several ways; " +
    "omit if nothing is genuinely actionable.\n\n" +
    summary;
  const { value, cacheRead, costUsd } = await llm.structured<ReadinessVerdict>(prompt, READINESS_SCHEMA);
  // Deterministic backstop so the trend-over-point rule can't be drifted from by the model.
  const verdict = applyTrendFloor(value, window);
  return { verdict, cacheRead, costUsd };
}
