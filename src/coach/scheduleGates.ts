/**
 * Scheduling gates for the unattended jobs — pure date/report arithmetic, no I/O, so the
 * "should this run today?" decision is testable without a live archive or an LLM.
 *
 * Both gates exist because a same-day trigger is not the same thing as a cadence. The Sunday
 * weekly brief used to fire on `isSunday(today)` alone: if the Mac was off on Sunday morning the
 * ping never ran, the branch was never evaluated, and the week's review was lost silently with no
 * catch-up (this is exactly what happened on 2026-07-12, the Birmingham race weekend). A cadence
 * gate instead asks "is the artefact for the week that just ended missing?", which self-heals on
 * the next ping that does run.
 */
import { listReports } from "./reports.js";
import type { ActualActivity } from "../state/types.js";

function parseUtcDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00Z`);
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The most recent Sunday on or before `dateStr` — i.e. the day the last complete week ended. */
export function lastSunday(dateStr: string): string {
  const d = parseUtcDate(dateStr);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay()); // getUTCDay(): Sunday === 0, so this is a no-op on Sunday
  return isoOf(d);
}

/** Whole days between two YYYY-MM-DD dates (b - a). */
function daysBetween(a: string, b: string): number {
  return Math.round((parseUtcDate(b).getTime() - parseUtcDate(a).getTime()) / 86_400_000);
}

/**
 * How late a missed Sunday may still be caught up. Beyond this the week under review is so far
 * behind the athlete that the report is noise — and the analysis window has smeared too many days
 * of the *new* week into it to honestly be called a review of the old one. Mon/Tue/Wed catch up;
 * Thu onward we skip the week and wait for the next Sunday.
 */
export const WEEKLY_CATCHUP_DAYS = 3;

export interface WeeklyBriefDecision {
  due: boolean;
  /** The Sunday the review is *for* — its report date and snapshot week. Not necessarily today. */
  reviewDate: string;
  reason: string;
}

/**
 * Decide whether the weekly brief should run, given today and the dates of the weekly-review
 * reports already on disk.
 *
 * The artefact is dated to the Sunday that closed the week, never to the day we happened to run —
 * so a Monday catch-up still writes `<lastSunday>-weekly-review.md` and freezes the snapshot
 * against the correct Monday. Dating it "today" would file a review of last week under this week
 * and corrupt the week-over-week delta.
 *
 * A review already dated on/after that Sunday (including one written by a manual `npm run weekly`)
 * counts as done, so a caught-up week never double-spends the LLM budget.
 */
export function weeklyBriefDue(today: string, reviewDates: readonly string[]): WeeklyBriefDecision {
  const sunday = lastSunday(today);
  const lateBy = daysBetween(sunday, today);

  if (reviewDates.some((d) => d >= sunday)) {
    return { due: false, reviewDate: sunday, reason: `weekly review for week ending ${sunday} already written` };
  }
  if (lateBy > WEEKLY_CATCHUP_DAYS) {
    return {
      due: false,
      reviewDate: sunday,
      reason: `week ending ${sunday} is ${lateBy}d stale (>${WEEKLY_CATCHUP_DAYS}d) — skipping to next Sunday rather than reviewing a week you're already through`,
    };
  }
  return {
    due: true,
    reviewDate: sunday,
    reason: lateBy === 0 ? `Sunday cadence for week ending ${sunday}` : `catching up missed Sunday ${sunday} (${lateBy}d late)`,
  };
}

/** Weekly-review report dates currently on disk, newest first. */
export async function weeklyReviewDates(): Promise<string[]> {
  const reports = await listReports();
  return reports.filter((r) => r.name.endsWith("-weekly-review.md") && r.date).map((r) => r.date);
}

export interface PostSwimDecision {
  due: boolean;
  reason: string;
}

/**
 * Decide whether the post-swim deep dive should run today: a swim landed today and we haven't
 * already written today's deep dive.
 *
 * Reads `state.actualActivities` (live from AI Endurance at assemble time) — deliberately NOT the
 * local archive. The archive is populated by the periodic backfill and lags by days, so an
 * archive-backed gate would sit there quietly never firing on the evening you actually swam.
 *
 * Idempotent on the report, not on a heartbeat file — the deep dive is the artefact, so its
 * presence *is* the record that the job ran. That also means a manual `npm run deep-dive` earlier
 * in the day correctly suppresses the evening job instead of paying for the same analysis twice.
 */
export function postSwimDue(
  today: string,
  activities: readonly Pick<ActualActivity, "sport" | "date">[],
  deepDiveDates: readonly string[],
): PostSwimDecision {
  const swamToday = activities.some((a) => a.date === today && a.sport === "Swim");
  if (!swamToday) return { due: false, reason: `no swim logged for ${today}` };
  if (deepDiveDates.includes(today)) return { due: false, reason: `deep dive for ${today} already written` };
  return { due: true, reason: `swim logged ${today} — running the post-swim deep dive` };
}

/** Deep-dive report dates currently on disk. */
export async function deepDiveDates(): Promise<string[]> {
  const reports = await listReports();
  return reports.filter((r) => r.name.endsWith("-deep-dive.md") && r.date).map((r) => r.date);
}
