import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";

export interface ReadinessVerdict {
  verdict: "green" | "amber" | "red";
  why: string;
  drivers: Array<{ signal: string; reading: string; source: string }>;
  cautions: string[];
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
    "",
    today.syncGaps.length ? `SYNC GAPS: ${today.syncGaps.map((g) => g.detail).join("; ")}` : "SYNC GAPS: none",
  ].join("\n");
}

export async function assessReadiness(
  llm: CoachLLM,
  window: AthleteState[],
): Promise<{ verdict: ReadinessVerdict; cacheRead: number; costUsd: number }> {
  const summary = summarizeForReadiness(window);
  const prompt =
    "Assess today's training readiness from this snapshot. Apply the operating rules. " +
    "Remember: trend beats single point, one metric out of line is not red, Garmin scores are tiebreak only.\n\n" +
    summary;
  const { value, cacheRead, costUsd } = await llm.structured<ReadinessVerdict>(prompt, READINESS_SCHEMA);
  return { verdict: value, cacheRead, costUsd };
}
