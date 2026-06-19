import { listReports, readReport } from "./reports.js";
import { listPending, readPending } from "../knowledge/store.js";
import { parseResearchItems, parseActionBullets, type ResearchTopic } from "./dashboard.js";

/**
 * IO loaders for the "Set up & improve" card's time-bound groups (issue #112 Phases 2–3). These READ the
 * last persisted coach reports so the (pure, LLM-free) dashboard can surface their action items without
 * ever re-running the weekly / research flows. Every loader is best-effort: any error degrades to
 * "nothing to show" (a missing group, never a broken dashboard).
 */

/** The most recent weekly review: its date + the action bullets parsed from its "## Next week" section. */
export async function latestWeeklyReview(): Promise<{ date: string; actions: string[] } | undefined> {
  try {
    const r = (await listReports()).find((i) => i.name.endsWith("-weekly-review.md"));
    if (!r?.date) return undefined;
    return { date: r.date, actions: parseActionBullets(await readReport(r.name), /next week|focus for next week/i) };
  } catch {
    return undefined;
  }
}

/** Latest research digest (date + file name + parsed structured items) from `knowledge/pending/`, or
 *  undefined. The file name is threaded through so the card's `approve` command is concrete. */
export async function latestResearchDigest(): Promise<{ date: string; file: string; items: ResearchTopic[] } | undefined> {
  try {
    const newest = (await listPending())[0]; // listPending is newest-first
    const date = newest?.name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) return undefined;
    return { date, file: newest.name, items: parseResearchItems(await readPending(newest.name)) };
  } catch {
    return undefined;
  }
}
