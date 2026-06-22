/**
 * Quarterly season-review cadence — the pure decision behind the `cmdPing` nudge. The strategic review
 * (`/season` + `npm run season`) is only useful if it's actually revisited; the daily ping checks whether
 * it's due (~every 90 days) and, if so, fires one desktop nudge, then records it so it won't re-fire daily.
 * Pure + side-effect-free so it's unit-tested without touching the clock or disk (the marker IO lives in
 * cli.ts, mirroring the existing last-ping marker). No nudge without a `season_plan` (nothing to review).
 */

function daysBetween(from: string, to: string): number | undefined {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

export interface SeasonNudgeInput {
  today: string; // YYYY-MM-DD
  hasPlan: boolean; // a season_plan exists (else nothing to review)
  lastReviewDate?: string; // newest season-arc report date, if any
  lastNudgeDate?: string; // last time we nudged, if any
  everyDays?: number; // cadence (default 90 — a quarter)
}

/**
 * Due when a plan exists AND it's been ≥ `everyDays` since the most recent of (last review, last nudge),
 * or neither has ever happened (first prompt). Pure.
 */
export function seasonNudgeDue(input: SeasonNudgeInput): boolean {
  if (!input.hasPlan) return false;
  const every = input.everyDays ?? 90;
  const ref = [input.lastReviewDate, input.lastNudgeDate].filter((d): d is string => !!d).sort().pop();
  if (!ref) return true; // never reviewed or nudged → prompt the first one
  const days = daysBetween(ref, input.today);
  return days != null && days >= every;
}
