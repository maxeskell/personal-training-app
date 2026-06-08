import type { ActualActivity, SyncGap } from "./types.js";

/**
 * Sync-gap detection (Build Spec §8, acceptance §9.1).
 *
 * AI Endurance already ingests Garmin, so the two activity views *should* agree.
 * When they don't, we FLAG a gap rather than act on half a picture — we never
 * silently pick one. Trend beats single point; a gap is information, not an error.
 */

const DURATION_TOLERANCE_MIN = 10;

export interface ReconcileInput {
  /** Completed activities as AI Endurance sees them. */
  aieActivities: ActualActivity[];
  /** Completed activities as Garmin sees them (empty if Garmin absent). */
  garminActivities?: ActualActivity[];
  /** True if Garmin was expected but unavailable/stale. */
  garminStale?: boolean;
  date: string;
}

export function detectSyncGaps(input: ReconcileInput): SyncGap[] {
  const gaps: SyncGap[] = [];

  if (input.garminStale) {
    gaps.push({
      kind: "garmin-stale",
      date: input.date,
      detail: "Garmin unavailable/stale — proceeding on AI Endurance only.",
    });
    return gaps; // No cross-check possible.
  }

  const garmin = input.garminActivities;
  if (!garmin) return gaps; // Garmin not connected by design — not a gap.

  const key = (a: ActualActivity) => `${a.date}|${a.sport}`;
  const aieByKey = new Map(input.aieActivities.map((a) => [key(a), a]));
  const garminByKey = new Map(garmin.map((a) => [key(a), a]));

  for (const [k, a] of aieByKey) {
    if (!garminByKey.has(k)) {
      gaps.push({
        kind: "missing-in-garmin",
        date: a.date,
        detail: `${a.sport} on ${a.date} in AI Endurance but not Garmin.`,
      });
    }
  }
  for (const [k, g] of garminByKey) {
    if (!aieByKey.has(k)) {
      gaps.push({
        kind: "missing-in-aie",
        date: g.date,
        detail: `${g.sport} on ${g.date} in Garmin but not AI Endurance.`,
      });
      continue;
    }
    const a = aieByKey.get(k)!;
    if (
      a.durationMin != null &&
      g.durationMin != null &&
      Math.abs(a.durationMin - g.durationMin) > DURATION_TOLERANCE_MIN
    ) {
      gaps.push({
        kind: "duration-mismatch",
        date: g.date,
        detail: `${g.sport} duration differs: AIE ${a.durationMin}min vs Garmin ${g.durationMin}min.`,
      });
    }
  }

  return gaps;
}
