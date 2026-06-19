import { findingScore, type Finding } from "./metrics.js";
import type { InsightReport } from "./engine.js";

/**
 * "Marginal gains" selection — the smaller, easier-to-action findings, as opposed to the big
 * "train more / be more consistent" calls that dominate the severity-ranked Top insights. Deliberately
 * surfaces low-severity findings that carry a concrete recommendation, from the *tuning* families
 * (efficiency, durability, fuelling, pacing, biomechanics…) rather than the macro load/injury ones.
 *
 * Pure + LLM-free: this is the deterministic core the `tune` flow phrases up, and the same selection the
 * dashboard's "Set up & improve → This week" group surfaces directly (no LLM call, always current).
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
