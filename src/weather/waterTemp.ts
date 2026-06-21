import type { WaterReading } from "../state/venue.js";

/**
 * Open-water temperature forecaster (a MODEL — honest-models NFR). There is no public feed, so the athlete
 * confirms readings by hand. Water lags air with thermal inertia, so once a confirmed reading goes stale we
 * estimate today's temp as that reading DRIFTED by the change in air temperature since it was taken, damped
 * (water swings roughly half as much as air). The estimate is shown labelled MODEL with a Confirm/Correct
 * prompt; confirming re-anchors it. Pure + deterministic — `now` and the air temp are injected.
 */

/** Older than this (days) → ask the athlete to confirm rather than trusting the reading silently. */
export const STALE_DAYS = 7;
/** Damping: water moves ~half as much as air. The MODEL coefficient, stated in the UI/docs. */
export const DRIFT_K = 0.5;

const MIN_WATER_C = -2;
const MAX_WATER_C = 40;
const DAY_MS = 86_400_000;

const clampWater = (t: number): number => Math.min(MAX_WATER_C, Math.max(MIN_WATER_C, Math.round(t * 10) / 10));

export interface WaterTempCard {
  /** Effective temperature to use (a confirmed reading, a drifted estimate, or the seed). */
  tempC: number;
  /** Anchor reading time (ISO) — absent for the seed. */
  asOf?: string;
  /** Age of the anchor reading in days (Infinity for the seed, which has no date). */
  ageDays: number;
  /** True → `tempC` is a drifted MODEL estimate, not a measured reading. */
  estimated: boolean;
  /** True → prompt the athlete to confirm (anchor older than STALE_DAYS). */
  stale: boolean;
  confidence?: "high" | "medium" | "low";
  /** The last confirmed reading the estimate is anchored to (for the "anchored to your X°C" label). */
  anchorTempC?: number;
  /** Human, MODEL-labelled explanation of where `tempC` came from. */
  basis?: string;
}

/**
 * Resolve the open-water temp for display + swim verdicts. Precedence: a fresh confirmed reading →
 * a drifted estimate of a stale reading → the COACH_WATER_TEMP_C seed → nothing ("check the venue").
 */
export function effectiveWaterTemp(
  latest: WaterReading | undefined,
  airNowC: number | undefined,
  now: Date,
  seedC?: number,
): WaterTempCard | undefined {
  if (!latest) {
    if (seedC == null) return undefined;
    return { tempC: clampWater(seedC), ageDays: Infinity, estimated: false, stale: false, basis: "from the COACH_WATER_TEMP_C seed (confirm a reading to improve it)" };
  }
  const ageDays = Math.max(0, (now.getTime() - new Date(latest.takenAt).getTime()) / DAY_MS);
  if (ageDays <= STALE_DAYS) {
    return { tempC: clampWater(latest.tempC), asOf: latest.takenAt, ageDays, estimated: false, stale: false, confidence: "high" };
  }
  // Stale: drift it on the air-temp change since it was taken, if we have both anchors.
  if (airNowC != null && latest.airTempC != null) {
    const tempC = clampWater(latest.tempC + DRIFT_K * (airNowC - latest.airTempC));
    return {
      tempC,
      asOf: latest.takenAt,
      ageDays,
      estimated: true,
      stale: true,
      confidence: ageDays > 21 ? "low" : "medium",
      anchorTempC: latest.tempC,
      basis: `MODEL — water trails air (×${DRIFT_K}); anchored to your ${latest.tempC}°C reading`,
    };
  }
  // No air anchor to drift from: carry the last reading forward, but flag it for re-confirmation.
  return {
    tempC: clampWater(latest.tempC),
    asOf: latest.takenAt,
    ageDays,
    estimated: false,
    stale: true,
    confidence: "low",
    anchorTempC: latest.tempC,
    basis: `your last reading, ${Math.round(ageDays)}d old — no air-temp anchor to estimate from`,
  };
}
