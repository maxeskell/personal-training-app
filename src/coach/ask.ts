import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";
import { buildInsights, type InsightReport, type ArchiveInput } from "../insights/engine.js";
import { richActivities } from "../insights/metrics.js";
import { paceStr } from "../insights/zones.js";
import { DecisionLog, suppressedInsightKeys } from "../state/decisionLog.js";
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

/** One-line threshold/FTP summary for the Q&A context (empty when nothing is configured). */
function thresholdLine(state: AthleteState): string {
  const t = state.thresholds.value;
  if (!t) return "";
  const parts = [
    t.bikeFtpW != null ? `bike FTP ${t.bikeFtpW}W${t.bikeFtpWkg != null ? ` (${t.bikeFtpWkg} W/kg)` : ""}` : "",
    t.runThresholdPowerW != null ? `run FTP ${t.runThresholdPowerW}W` : "",
    t.runThresholdPaceSecPerKm != null ? `run threshold ${paceStr(t.runThresholdPaceSecPerKm)}/km` : "",
    t.runThresholdHr != null ? `run LTHR ${t.runThresholdHr}bpm` : "",
    t.swimCssSecPer100 != null ? `swim CSS ${paceStr(t.swimCssSecPer100)}/100m` : "",
  ].filter(Boolean);
  return parts.length ? `- Thresholds: ${parts.join(", ")} [${state.thresholds.source}]` : "";
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
    state.trainingStatus.value ? `- Garmin training status: ${state.trainingStatus.value.label ?? "—"}, acute:chronic ${state.trainingStatus.value.loadRatio ?? "—"} (${state.trainingStatus.value.acwrStatus ?? "—"}), acute ${state.trainingStatus.value.acuteLoad ?? "—"}/chronic ${state.trainingStatus.value.chronicLoad ?? "—"} [garmin MODEL]` : "",
    state.hrvStatus.value ? `- Garmin HRV status: ${state.hrvStatus.value.status ?? "—"} (last night ${state.hrvStatus.value.lastNightMs ?? "—"}ms, baseline ${state.hrvStatus.value.baselineLowMs ?? "—"}-${state.hrvStatus.value.baselineUpperMs ?? "—"}ms) [garmin]` : "",
    `- Weight ${fmt(state.weightKg.value, 1)}kg (trend only), VO2max ${fmt(state.vo2max.value)} [${state.weightKg.source}/${state.vo2max.source}]`,
    "",
    `INSIGHTS:`,
    ins.load ? `- Load: CTL ${ins.load.ctl} / ATL ${ins.load.atl} / TSB ${ins.load.tsb}, ΔCTL/wk ${ins.load.rampPerWeek}` : "- Load: n/a",
    `- Run EF ${ins.ef.run.recent ?? "—"} (Δ${ins.ef.run.deltaPct ?? "—"}%), Ride EF ${ins.ef.ride.recent ?? "—"} (Δ${ins.ef.ride.deltaPct ?? "—"}%)`,
    `- Run durability ${ins.durability.run.recent ?? "—"} (closer to 0 = more durable), monotony ${ins.monotony.monotony ?? "—"}, intensity easy/tempo/hard ${ins.tid.easyPct ?? "—"}/${ins.tid.tempoPct ?? "—"}/${ins.tid.hardPct ?? "—"}%`,
    `- n=1 patterns (lagged, autocorr-aware): ${ins.correlations.map((c) => `${c.label} r=${c.r} [${c.ciLow},${c.ciHigh}] lag${c.lagDays}d${c.significant ? "" : " (CI spans 0)"}`).join("; ") || "none strong"}`,
    `- Monitoring rule (${ins.monitoring.validated ? "validated out-of-sample" : "exploratory, not yet held-out"}; outcome=${ins.monitoring.outcomeName}${ins.monitoring.outcomeIndependent ? "" : ", dependent on HRV/RHR"}): ${ins.monitoring.best ? `${ins.monitoring.best.name}, lead ${ins.monitoring.best.lead}d, hit ${Math.round(ins.monitoring.best.hitRate * 100)}%/false-alarm ${Math.round(ins.monitoring.best.falseAlarmRate * 100)}%` : "none validated yet"}`,
    `- Regime shifts: ${ins.changePoints.flatMap((s) => s.points.slice(-1).map((p) => (p.date ? `${s.metric} ${p.before}→${p.after}@${p.date}` : null))).filter(Boolean).join("; ") || "none"}`,
    `- Brick decoupling: ${ins.brick.decouplingPct != null ? `${ins.brick.decouplingPct}% off-bike (${ins.brick.brickDays}d)` : "n/a"}; taper target TSB ${ins.taper.recommendedTsbLow ?? "?"}..${ins.taper.recommendedTsbHigh ?? "?"}`,
    `- Races: ${ins.predictions.map((p) => `${p.race} T-${p.daysTo}d`).join("; ") || "none"}`,
    thresholdLine(state),
    ins.splits.length ? `- Race split plans: ${ins.splits.map((p) => `${p.race} ${p.strategy}`).join(" | ")}` : "",
    ins.topFindings.length ? `- Top surfaced insights (good signal, not dismissed): ${ins.topFindings.slice(0, 5).map((f) => `[${f.severity}] ${f.title}`).join("; ")}` : "",
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

  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const insights = state.raw ? buildInsights(state, archive, { suppressed }) : undefined;
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
