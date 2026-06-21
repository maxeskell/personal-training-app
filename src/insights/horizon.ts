/**
 * The live-analysis horizon for PHYSIO readings (weight, HRV, resting HR, sleep, body-comp, …).
 *
 * Rule (athlete's ask): anything older than six months is ignored by the insight layer — a reading that
 * stale no longer reflects current state, so no warning, trend or baseline should lean on it (and a
 * long-dead backfilled glitch must never surface as a current finding). Applied at the data feed
 * (orchestrator.loadArchive) so EVERY consumer sees the same floored series, and again inside the
 * data-quality detector as defence-in-depth.
 *
 * EXEMPT: the race-time predictor, which deliberately models a ~6-month trajectory through its own
 * StateStore series (see loadPredictionTrajectory) — it never reads this archive feed.
 */

/** Six months. */
export const PHYSIO_HORIZON_DAYS = 180;

/** Whole days from a→b (UTC, date-only). */
export function daysBetweenUTC(aIso: string, bIso: string): number {
  const ms = new Date(`${bIso.slice(0, 10)}T00:00:00Z`).getTime() - new Date(`${aIso.slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

/**
 * Keep only dated readings within PHYSIO_HORIZON_DAYS of the MOST RECENT reading (relative to the data,
 * not the wall clock) — so a fresh series is floored to the last six months, while a fully-backfilled but
 * stale series still yields its active cluster instead of going empty. Pure; preserves input order.
 */
export function withinPhysioHorizon<T extends { date: string }>(days: T[]): T[] {
  if (days.length < 2) return days;
  let latest = days[0].date;
  for (const d of days) if (d.date > latest) latest = d.date;
  return days.filter((d) => daysBetweenUTC(d.date, latest) <= PHYSIO_HORIZON_DAYS);
}
