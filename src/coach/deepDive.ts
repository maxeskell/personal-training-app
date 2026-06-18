import { CoachLLM } from "../llm/client.js";
import { liveCoachingContext } from "./seasonContext.js";
import { findingKey } from "../insights/metrics.js";
import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import type { InsightReaction } from "../state/decisionLog.js";

/** Per-finding context for the MCP surface: how old each insight is + the saved like/dislike. */
export interface FindingContext {
  firstSeen?: Map<string, string>;
  reactions?: Map<string, InsightReaction>;
}

/** "[key=… · NEW|Nd old · your call: 👍/👎]" annotation so an MCP agent can see freshness + react by key. */
function annotateFinding(f: InsightReport["topFindings"][number], ctx: FindingContext | undefined, now: number): string {
  if (!ctx) return "";
  const key = findingKey(f);
  const fs = ctx.firstSeen?.get(key);
  const ageDays = fs ? Math.floor((now - new Date(fs).getTime()) / 86_400_000) : null;
  const age = ageDays == null || ageDays < 1 ? "NEW" : `${ageDays}d old`;
  const r = ctx.reactions?.get(key);
  const call = r === "agree" ? " · your call: 👍 liked" : r === "disagree" ? " · your call: 👎 disliked" : "";
  return ` [key=${key} · ${age}${call}]`;
}

/**
 * Deep-dive analysis. The locally-computed insight metrics are formatted into a digest the LLM
 * turns into a coach-style write-up. Extracted so the CLI, the MCP server and any future face share
 * one summary format — the deterministic `insightMetricsSummary` / `insightFindings` are reused by
 * the MCP `insights` tool (no LLM) and the prose `runDeepDive` (LLM) alike.
 */

/** The computed-metric block — every number the coach should cite. Deterministic, no LLM. */
export function insightMetricsSummary(ins: InsightReport): string {
  const ev = (t: { recent: number | null; prior: number | null; deltaPct: number | null; n: number }) =>
    `recent ${t.recent ?? "—"} vs prior ${t.prior ?? "—"} (Δ ${t.deltaPct ?? "—"}%, n=${t.n})`;
  return [
    `INSIGHT METRICS for ${ins.date} (computed locally; cite these):`,
    ins.load ? `- Load: CTL ${ins.load.ctl} / ATL ${ins.load.atl} / TSB ${ins.load.tsb}, ΔCTL/wk ${ins.load.rampPerWeek} [derived from daily ESS]` : "- Load: insufficient ESS history",
    `- Run-load ramp: this week ${ins.runRamp.thisWeekEss} ESS vs baseline ${ins.runRamp.baselineEss} (jump ${ins.runRamp.jumpPct ?? "—"}%) [ai-endurance]`,
    `- Run EF: ${ev(ins.ef.run)} | Ride EF: ${ev(ins.ef.ride)} [derived, steady ≥40min]`,
    `- Run durability %: ${ev(ins.durability.run)} [ai-endurance DFA-α1]`,
    `- Run aerobic threshold HR: ${ev(ins.threshold.run)} [ai-endurance DFA-α1, artifact-filtered]`,
    `- Predictions vs goals: ${ins.predictions.map((p) => `${p.race} T-${p.daysTo}d pred ${p.predictedSec ?? "?"}s vs target ${p.targetSec ?? "?"}s`).join("; ") || "none"}`,
    `- Monotony ${ins.monotony.monotony ?? "—"} (strain ${ins.monotony.strain ?? "—"}); intensity split easy/tempo/hard ${ins.tid.easyPct ?? "—"}/${ins.tid.tempoPct ?? "—"}/${ins.tid.hardPct ?? "—"}%`,
    `- n=1 patterns (lagged, autocorr-aware CIs): ${ins.correlations.map((c) => `${c.label} r=${c.r} [${c.ciLow},${c.ciHigh}] lag ${c.lagDays}d, effN ${c.effN}${c.significant ? "" : " (CI spans 0)"}`).join("; ") || "none strong enough yet"}`,
    `- Anomalies today: ${ins.anomalies.map((a) => a.detail).join("; ") || "none"}`,
    `- Monitoring rule (n=1, ${ins.monitoring.validated ? "validated out-of-sample" : "exploratory"}; outcome ${ins.monitoring.outcomeName}${ins.monitoring.outcomeIndependent ? "" : ", dependent"}): ${ins.monitoring.best ? `${ins.monitoring.best.name} → lead ${ins.monitoring.best.lead}d, hit ${Math.round(ins.monitoring.best.hitRate * 100)}% / false-alarm ${Math.round(ins.monitoring.best.falseAlarmRate * 100)}%${ins.monitoring.best.pValue != null ? `, perm p=${ins.monitoring.best.pValue}` : ""} (${ins.monitoring.method}, ${ins.monitoring.days}d)` : `none validated yet (${ins.monitoring.days}d history)`}`,
    `- Regime shifts (change-points): ${ins.changePoints.flatMap((s) => s.points.slice(-1).map((p) => p.date ? `${s.metric} ${p.before}→${p.after} @ ${p.date}` : null)).filter(Boolean).join("; ") || "none dated"}`,
    `- Brick decoupling (Q4): ${ins.brick.decouplingPct != null ? `run EF off-bike ${ins.brick.decouplingPct}% vs fresh (${ins.brick.brickDays} brick days)` : "insufficient power-equipped runs"}`,
    `- Taper target (Q6): ${ins.taper.recommendedTsbLow != null ? `race-day TSB ~${ins.taper.recommendedTsbLow}..${ins.taper.recommendedTsbHigh} (${ins.taper.basis})` : "no past race-day TSB yet"}`,
    `- Economy vs fitness (Q5): ${ins.efficiency.residualSlopePer30d != null ? `fitness-removed EF residual ${ins.efficiency.residualSlopePer30d}/30d (${ins.efficiency.fitnessExplains ? "gains are fitness, not economy" : "independent economy gain"})` : "insufficient steady runs"}`,
    `- Race split plans: ${ins.splits.map((p) => `${p.race} ${Math.round(p.predictedSec / 60)}min over ${p.distanceKm}km — ${p.strategy}`).join(" | ") || "no upcoming races with enough data for a plan"}`,
  ].join("\n");
}

/**
 * The triaged findings — top surfaced (gated) then the full detector list. Deterministic, no LLM.
 * Pass `ctx` (MCP surface) to annotate each top finding with its key, age and your saved reaction, so an
 * agent can see what's NEW / already-rated and react to it by key (`react_to_insight`). Omit it for the
 * deep-dive LLM prompt, which doesn't need the plumbing.
 */
export function insightFindings(ins: InsightReport, ctx?: FindingContext): string {
  const now = Date.now();
  return [
    `TOP SURFACED INSIGHTS (good-signal, ranked; snoozed removed):`,
    ...ins.topFindings.slice(0, 5).map((f) => `- [${f.severity}, ${Math.round((f.confidence ?? 0.6) * 100)}%] ${f.title}: ${f.detail} (${f.evidence})${annotateFinding(f, ctx, now)}`),
    "",
    `ALL DETECTOR FINDINGS (triaged by severity):`,
    ...ins.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail} (${f.evidence})`),
  ].join("\n");
}

/** Synthesise the coach-style deep-dive prose from the computed metrics. Costs one LLM call. */
export async function runDeepDive(
  llm: CoachLLM,
  state: AthleteState,
  ins: InsightReport,
): Promise<{ markdown: string; cacheRead: number; costUsd: number }> {
  const summary = [insightMetricsSummary(ins), "", insightFindings(ins)].join("\n");

  const prompt = [
    "Write a deep-dive analysis as markdown — the trends/issues a sharp coach would pull out of these",
    "metrics over time. LEAD with the single most important finding. Group by theme (load & form,",
    "efficiency & durability, injury risk, goal tracking). Be specific, cite the numbers, distinguish",
    "trend from noise (call out where n is small). Where relevant, note ACWR is intentionally not used.",
    "Honour the athlete's LIVE race calendar and the season shape derived from it below. End with 2–4 concrete actions.",
    "",
    liveCoachingContext(state),
    "",
    summary,
  ].join("\n");

  const { text, cacheRead, costUsd } = await llm.text(prompt);
  const markdown = `# Deep dive — ${ins.date}\n\n${text}`;
  return { markdown, cacheRead, costUsd };
}
