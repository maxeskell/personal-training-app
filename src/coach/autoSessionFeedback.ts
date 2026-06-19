import { CoachLLM } from "../llm/client.js";
import { config } from "../config.js";
import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import { richActivities } from "../insights/metrics.js";
import { loadSessionDecays } from "../insights/fit.js";
import { ArchiveStore } from "../archive/store.js";
import { loadSystemPrompt } from "./persona.js";
import { runSessionFeedback } from "./session.js";
import { loadSessionFeedbacks, latestByDate, saveSessionFeedback } from "./sessionFeedbackStore.js";
import { shiftIso } from "../util/today.js";

/**
 * Auto deep-feedback: at sync, generate + persist a session deep-dive for every recent session that
 * doesn't have one yet, so the dashboard can surface it inline (no button, no LLM on render) and the
 * history is kept for analysis. Best-effort and cost-aware:
 *  - gated on an API key (no key → no-op);
 *  - only generates for a session whose raw .FIT is present (a real deep dive). A session without the
 *    stream is left UNSTORED so a later sync — once `fit-sync` has downloaded it — picks it up; the skip
 *    costs no tokens (runSessionFeedback returns the no-FIT note without calling the model);
 *  - capped per run so a first sync over a long history can't fire a burst of calls.
 */

export interface AutoFeedbackOpts {
  lookbackDays?: number;
  limit?: number;
}

/** How many sessions a sync may generate, given the COACH_AUTO_SESSION_FEEDBACK mode. `off` → 0. Pure. */
export function feedbackLimitForMode(mode: "off" | "latest" | "on", base = 5): number {
  return mode === "off" ? 0 : mode === "latest" ? 1 : base;
}

/**
 * The recent session dates that still need feedback: within `lookbackDays` of `today`, not already
 * stored, newest first, capped at `limit`. Pure — the testable core of the generation loop.
 */
export function sessionsNeedingFeedback(
  activityDates: string[],
  stored: Set<string>,
  today: string,
  lookbackDays: number,
  limit: number,
): string[] {
  const cutoff = shiftIso(today, -lookbackDays);
  const uniq = [...new Set(activityDates)].filter((d) => d >= cutoff && d <= today && !stored.has(d));
  uniq.sort((a, b) => b.localeCompare(a)); // newest first
  return uniq.slice(0, limit);
}

/**
 * Generate + persist deep feedback for recent sessions lacking it. Returns the count generated.
 * Best-effort throughout: any per-session failure is swallowed so a sync never breaks.
 */
export async function backfillSessionFeedback(
  state: AthleteState,
  insights: InsightReport | undefined,
  opts: AutoFeedbackOpts = {},
): Promise<number> {
  if (!CoachLLM.hasApiKey()) return 0;
  const limit = feedbackLimitForMode(config.autoSessionFeedback, opts.limit ?? 5);
  if (limit === 0) return 0; // COACH_AUTO_SESSION_FEEDBACK=off → on-demand only
  const lookbackDays = opts.lookbackDays ?? 10;

  const stored = new Set(latestByDate(await loadSessionFeedbacks()).keys());
  const dates = sessionsNeedingFeedback(
    richActivities(state.raw).map((a) => a.date),
    stored,
    state.date,
    lookbackDays,
    limit,
  );
  if (!dates.length) return 0;

  const decays = loadSessionDecays();
  const fitSummaries = await new ArchiveStore().loadFitSummaries();
  const prompt = await loadSystemPrompt();
  let generated = 0;
  for (const date of dates) {
    try {
      const fb = await runSessionFeedback(new CoachLLM(prompt, "session", "medium"), state, insights, { date, decays, fitSummaries });
      // No .FIT yet → leave unstored (no tokens were spent); a later sync retries once it's downloaded.
      if (!fb || fb.skippedNoFit) continue;
      await saveSessionFeedback({
        date: fb.detail.date,
        sport: String(fb.detail.sport),
        deep: !!fb.detail.decay,
        generatedAt: new Date().toISOString(),
        costUsd: fb.costUsd,
        markdown: fb.markdown,
      });
      generated += 1;
    } catch {
      /* best-effort per session — a single failure must not stop the rest or the sync */
    }
  }
  return generated;
}
