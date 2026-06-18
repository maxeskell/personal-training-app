import type { AthleteState } from "../state/types.js";
import { InsightLog } from "../state/insightLog.js";
import { DecisionLog } from "../state/decisionLog.js";
import { analyseListening, buildEngagementContext } from "./listening.js";
import type { EngagementContext } from "../insights/engagement.js";

/**
 * Load the engagement context fed into buildInsights: read the surfaced-insight history + decision log,
 * run the (pure) engagement model over the supplied daily-state window, and hand back the compact context
 * (ranking weights + follow-through signals). Best-effort: any read failure degrades to an empty context,
 * so the insight engine behaves exactly as it did before the loop existed.
 */
export async function loadEngagementContext(states: AthleteState[]): Promise<EngagementContext> {
  try {
    const [snapshots, decisions] = await Promise.all([new InsightLog().all(), new DecisionLog().all()]);
    return buildEngagementContext(analyseListening({ snapshots, decisions, states }));
  } catch {
    return {}; // degrade: no engagement context → unchanged surfacing
  }
}
