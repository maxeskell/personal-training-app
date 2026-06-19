import { listReports } from "./reports.js";
import { listPending, readPending } from "../knowledge/store.js";
import { parseResearchTopics } from "./dashboard.js";

/**
 * IO loaders for the "Set up & improve" card's time-bound groups (issue #112 Phases 2–3). These READ the
 * last persisted coach reports so the (pure, LLM-free) dashboard can surface their action items without
 * ever re-running the weekly / research flows. Every loader is best-effort: any error degrades to
 * "nothing to show" (a missing group, never a broken dashboard).
 */

/** Date (YYYY-MM-DD) of the most recently saved weekly-review report, or undefined if none exists. */
export async function latestWeeklyReviewDate(): Promise<string | undefined> {
  try {
    const r = (await listReports()).find((i) => i.name.endsWith("-weekly-review.md"));
    return r?.date || undefined;
  } catch {
    return undefined;
  }
}

/** Latest research digest (date + parsed topic headlines) from `knowledge/pending/`, or undefined. */
export async function latestResearchDigest(): Promise<{ date: string; topics: string[] } | undefined> {
  try {
    const newest = (await listPending())[0]; // listPending is newest-first
    const date = newest?.name.match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) return undefined;
    return { date, topics: parseResearchTopics(await readPending(newest.name)) };
  } catch {
    return undefined;
  }
}
