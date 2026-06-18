import { CoachLLM } from "../llm/client.js";
import { liveCoachingContext } from "./seasonContext.js";
import { findingScore, type Finding } from "../insights/metrics.js";
import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";

/**
 * "Marginal gains" tune-up — the smaller, easier-to-action findings, as opposed to the big
 * "train more / be more consistent" calls that dominate the severity-ranked Top insights. Deliberately
 * surfaces low-severity findings that carry a concrete recommendation, from the *tuning* families
 * (efficiency, durability, fuelling, pacing, biomechanics…) rather than the macro load/injury ones.
 *
 * Deterministic selection (this file) + an optional cheap LLM phrasing pass (runTuneUp).
 */

/** Macro families that ARE the "just train more/consistently" story — excluded from marginal gains. */
const MACRO_FAMILIES = new Set([
  "Injury risk",
  "Load & injury risk",
  "Load & form",
  "Follow-through", // engagement nudges, surfaced elsewhere
]);

/**
 * Pick the small, actionable findings: not a flag (those are the big stuff, already led on), carries a
 * recommendation, and isn't a macro load/injury family. Ranked by signal strength, capped.
 */
export function selectMarginalGains(ins: InsightReport, limit = 6): Finding[] {
  return ins.findings
    .filter((f) => f.severity !== "flag" && !!f.recommendation && !MACRO_FAMILIES.has(f.family))
    .sort((a, b) => findingScore(b) - findingScore(a))
    .slice(0, limit);
}

/** Format the selected marginal gains for the LLM (or a no-LLM listing). Deterministic. */
export function tuneUpDigest(gains: Finding[]): string {
  if (!gains.length) return "No small-but-actionable tweaks stand out right now — the basics are carrying you.";
  return [
    "CANDIDATE MARGINAL GAINS (small, specific, low-effort; cite these):",
    ...gains.map((f) => `- [${f.family}] ${f.title}: ${f.detail} → suggested: ${f.recommendation} (${f.evidence})`),
  ].join("\n");
}

/**
 * Turn the selected marginal gains into 2–4 concrete, low-effort tweaks the athlete can apply this week.
 * One LLM call (cost-logged). Falls back to the deterministic digest if there's nothing to say.
 */
export async function runTuneUp(
  llm: CoachLLM,
  state: AthleteState,
  ins: InsightReport,
): Promise<{ markdown: string; gains: Finding[]; cacheRead: number; costUsd: number }> {
  const gains = selectMarginalGains(ins);
  if (!gains.length) {
    return { markdown: `# Tune-up — ${ins.date}\n\nNo small-but-actionable tweaks stand out right now — the basics are carrying you. Keep going.`, gains, cacheRead: 0, costUsd: 0 };
  }
  const prompt = [
    "From the candidate marginal gains below, give the athlete the 2–4 SMALLEST, most concrete tweaks",
    "they can apply THIS WEEK — the easy wins, not 'train more' or 'be more consistent'. For each: the",
    "specific change, why it helps (cite the number), and how to do it in one session. Keep it tight and",
    "practical. Honour the athlete's live calendar and the wellbeing rules (fuel to train; no restriction).",
    "",
    liveCoachingContext(state),
    "",
    tuneUpDigest(gains),
  ].join("\n");
  const { text, cacheRead, costUsd } = await llm.text(prompt);
  return { markdown: `# Tune-up — ${ins.date}\n\n${text}`, gains, cacheRead, costUsd };
}
