import { listReports, readReport } from "./reports.js";
import { listPending, readPending } from "../knowledge/store.js";
import { parseResearchItems, type ResearchTopic } from "./dashboard.js";
import { parseActionBullets, NEXT_WEEK_HEADING_RE } from "./setupCard.js";

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
    return { date: r.date, actions: parseActionBullets(await readReport(r.name), NEXT_WEEK_HEADING_RE) };
  } catch {
    return undefined;
  }
}

/** The most recent weekly review's FULL markdown + its date (the `/season` page renders the prose, the
 *  dashboard surfaces only its action bullets via {@link latestWeeklyReview}). Best-effort → undefined. */
export async function latestWeeklyReviewProse(): Promise<{ markdown: string; date: string } | undefined> {
  try {
    const r = (await listReports()).find((i) => i.name.endsWith("-weekly-review.md"));
    if (!r?.date) return undefined;
    return { markdown: await readReport(r.name), date: r.date };
  } catch {
    return undefined;
  }
}

/** The most recent season-narrative report's FULL markdown + its date (written by `runSeasonNarrative` /
 *  `npm run season` under the `season-arc` flow → `YYYY-MM-DD-season-arc.md`). Best-effort → undefined. */
export async function latestSeasonNarrative(): Promise<{ markdown: string; date: string } | undefined> {
  try {
    const r = (await listReports()).find((i) => i.name.endsWith("-season-arc.md"));
    if (!r?.date) return undefined;
    return { markdown: await readReport(r.name), date: r.date };
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
