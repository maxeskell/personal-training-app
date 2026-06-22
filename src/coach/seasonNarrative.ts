import { CoachLLM } from "../llm/client.js";
import { liveCoachingContext } from "./seasonContext.js";
import { seasonReportText, type SeasonArcReport } from "./seasonArc.js";
import type { AthleteState } from "../state/types.js";
import type { CareerHistory } from "./careerHistory.js";

/**
 * The LLM **strategic narrative** behind `npm run season` (and the `season` MCP tool) — a multi-SEASON
 * coach write-up grounded in the DETERMINISTIC {@link SeasonArcReport} (the numbers it must cite) plus the
 * live coaching context. This is the deep, multi-year layer over the daily/weekly tactical flows: it leads
 * on the single biggest multi-season lever, ranks the structural levers, and lays out a season-by-season
 * arc to 70.3 → Ironman. Costs one high-effort LLM call (cost-logged by {@link CoachLLM}); the `/season`
 * page and the no-key fallback stay deterministic (free). The grounding text is built by the pure
 * `seasonReportText`, so what the model is given is fully testable without a network.
 */

/** A compact career line (lifetime PBs) so the narrative can anchor "vs your best" honestly. */
function careerLine(career: CareerHistory | null | undefined): string {
  if (!career) return "";
  const bests = (career.bests ?? [])
    .map((b) => `${b.sport}: ${b.rows.map((r) => `${r.label} ${r.allTime?.value ?? "—"}`).join(", ")}`)
    .join(" | ");
  return bests ? `LIFETIME BESTS (your benchmarks): ${bests}` : "";
}

export async function runSeasonNarrative(
  llm: CoachLLM,
  report: SeasonArcReport,
  career: CareerHistory | null | undefined,
  state: AthleteState,
): Promise<{ markdown: string; cacheRead: number; costUsd: number }> {
  const grounding = [seasonReportText(report), "", careerLine(career)].filter(Boolean).join("\n");

  const prompt = [
    "You are writing a MULTI-SEASON strategic review for one endurance athlete rebuilding toward 70.3 then",
    "Ironman over the next 1–3 years. This is the strategic layer ABOVE the daily/weekly plan — think in",
    "seasons, not weeks.",
    "",
    "LEAD with the single biggest multi-season lever for THIS athlete (not a generic list). Then give a",
    "RANKED set of structural levers (most leverage first), each tied to the athlete's own numbers below.",
    "Be honest about trade-offs — especially: a GLP-1 helps short-term W/kg by dropping weight but risks",
    "muscle/bone if strength + fuelling slip; stale bloods mean managing that blind. Distinguish the patient,",
    "compounding levers (chronic load, swim technique, strength) from quick fixes. Close with a concrete",
    "SEASON-BY-SEASON ARC (this year → next → the year after) showing how the phases sequence to the goal.",
    "",
    "Honour the athlete's plan and cite the computed numbers (CTL now/target/trend, the peak-year benchmark,",
    "the lever statuses, the flags). Anything you estimate, label it. Don't invent numbers not given.",
    "",
    liveCoachingContext(state),
    "",
    grounding,
  ].join("\n");

  const { text, cacheRead, costUsd } = await llm.text(prompt);
  const markdown = `# Season arc — ${report.horizonGoal ?? "multi-season review"} (${new Date().toISOString().slice(0, 10)})\n\n${text}`;
  return { markdown, cacheRead, costUsd };
}
