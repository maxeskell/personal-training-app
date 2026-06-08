import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";
import { buildInsights, type InsightReport, type ArchiveInput } from "../insights/engine.js";
import { richActivities } from "../insights/metrics.js";
import { screenNutritionPrompt } from "../guardrails/wellbeing.js";

/**
 * Free-form Q&A over the athlete's data (dashboard chat box + `ask` CLI). Answers from a CURATED
 * context (today's state + insight report + recent activities + recovery series) — not the raw
 * dump — so it's cheap and the prompt-cached persona keeps cost down. Guardrails on: the nutrition
 * restriction screen runs BEFORE the model, and the prompt forbids inventing numbers.
 */

function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}

/** Compact, readable data context for the model to answer from. */
export function buildAskContext(state: AthleteState, insights: InsightReport): string {
  const raw = state.raw ?? {};
  const r = state.recovery.value;
  const acts = richActivities(raw)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20)
    .map(
      (a) =>
        `  ${a.date} ${a.sport} ${a.movingSec ? Math.round(a.movingSec / 60) + "min" : ""} ${a.avwatts ? "P" + Math.round(a.avwatts) + "W" : ""} ${a.avhr ? "HR" + Math.round(a.avhr) : ""} ESS${fmt(a.ess)}`,
    )
    .join("\n");

  const recSeries = (raw.getRecoveryModel as { data?: Record<string, unknown[]> } | undefined)?.data;
  const tail = (k: string, n = 14) => (recSeries?.[k] ?? []).slice(-n).map((x) => (x == null ? "—" : Math.round(Number(x)))).join(",");

  const ins = insights;
  return [
    `TODAY (${state.date}) [provenance in brackets]:`,
    `- HRV ${fmt(state.hrvOvernight.value)}ms (7d base ${fmt(state.hrv7dBaseline.value)}), RHR ${fmt(state.restingHr.value)}bpm (base ${fmt(state.restingHr7dBaseline.value)}), sleep ${fmt(state.sleep.value?.hours, 1)}h/${fmt(state.sleep.value?.score)} [garmin]`,
    `- Recovery: cardio ${fmt(r?.cardioRecovery)}/100, orthopedic run/bike/swim ${fmt(r?.orthopedic?.run)}/${fmt(r?.orthopedic?.bike)}/${fmt(r?.orthopedic?.swim)}, limiter ${r?.limiterToday ?? "—"} [ai-endurance]`,
    `- Weight ${fmt(state.weightKg.value, 1)}kg (trend only), VO2max ${fmt(state.vo2max.value)} [${state.weightKg.source}/${state.vo2max.source}]`,
    "",
    `INSIGHTS:`,
    ins.load ? `- Load: CTL ${ins.load.ctl} / ATL ${ins.load.atl} / TSB ${ins.load.tsb}, ΔCTL/wk ${ins.load.rampPerWeek}` : "- Load: n/a",
    `- Run EF ${ins.ef.run.recent ?? "—"} (Δ${ins.ef.run.deltaPct ?? "—"}%), Ride EF ${ins.ef.ride.recent ?? "—"} (Δ${ins.ef.ride.deltaPct ?? "—"}%)`,
    `- Run durability ${ins.durability.run.recent ?? "—"} (closer to 0 = more durable), monotony ${ins.monotony.monotony ?? "—"}, intensity easy/tempo/hard ${ins.tid.easyPct ?? "—"}/${ins.tid.tempoPct ?? "—"}/${ins.tid.hardPct ?? "—"}%`,
    `- n=1 patterns: ${ins.correlations.map((c) => `${c.label} r=${c.r}`).join("; ") || "none strong"}`,
    `- Races: ${ins.predictions.map((p) => `${p.race} T-${p.daysTo}d`).join("; ") || "none"}`,
    ins.findings.length ? `- Active findings: ${ins.findings.map((f) => `[${f.severity}] ${f.title}`).join("; ")}` : "",
    "",
    `RECENT RECOVERY SERIES (last 14, oldest→newest) [ai-endurance]:`,
    `- HRV(rMSSD): ${tail("rMSSD")}`,
    `- Resting HR: ${tail("resting_heart_rate")}`,
    `- Daily ESS:  ${tail("external_stress_score")}`,
    "",
    `RECENT ACTIVITIES (newest first) [ai-endurance]:`,
    acts || "  none",
  ].join("\n");
}

export interface AskResult {
  answer: string;
  blocked?: boolean;
}

export async function answerQuestion(llm: CoachLLM, question: string, state: AthleteState, archive?: ArchiveInput): Promise<AskResult> {
  // Wellbeing guardrail runs first — restriction/deficit questions get redirected, not answered.
  const screen = screenNutritionPrompt(question);
  if (screen.blocked) return { answer: screen.redirect!, blocked: true };

  const insights = state.raw ? buildInsights(state, archive) : undefined;
  const context = insights ? buildAskContext(state, insights) : "(no assembled data available)";

  const prompt = [
    "Answer the athlete's question using ONLY the data below. Be direct and concise. Cite the numbers",
    "and their source. If the data doesn't contain what's needed, say so plainly and name which flow",
    "would get it (e.g. `weekly`, `race`, `deep-dive`) — do NOT invent numbers. Lead with the answer.",
    "Honour the coaching stance: trend over single point, fuel to train, weight is a trend not a target.",
    "",
    `QUESTION: ${question}`,
    "",
    "=== DATA ===",
    context,
  ].join("\n");

  const { text } = await llm.text(prompt);
  return { answer: text };
}
