import type { Profile } from "./schema.js";

/**
 * Equipment helpers read from the STABLE profile (equipment.bikes.<name>). The one live input a
 * tyre-pressure decision needs — the rider's bodyweight — is deliberately NOT here: it's a live number
 * pulled from AI Endurance/Garmin (state.weightKg) and the no-live-numbers guard rejects it from the
 * profile. So storage is split: the bike's own mass is stable kit data and lives here; the rider's mass
 * stays live, and the two are combined at compute time by `systemWeightKg`.
 */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

export interface BikeRaceWeight {
  /** Bike key exactly as written in the profile (e.g. "felt", "road", "tt"). */
  name: string;
  /** As-raced weight in GRAMS — bike plus whatever the athlete weighed it with (e.g. one bottle). */
  raceWeightG: number;
  /** Same value in kg, rounded to 0.1 for display. */
  raceWeightKg: number;
}

/**
 * Per-bike "race weight" (the bike as-raced, including the bottle(s)/kit the athlete weighed it with),
 * read from `equipment.bikes.<name>.race_weight_g`. Stored in GRAMS on purpose: the no-live-numbers
 * guard rejects a bare `weight`/`weight_kg` key (rider bodyweight is live), but allows equipment `*_g`
 * — so grams is the guard-safe convention the schema already documents. Defensive: a partially-filled
 * or malformed bikes map can't throw, and a missing/non-positive value is skipped. Returns [] when
 * nothing is logged.
 */
export function bikeRaceWeights(profile: Profile | null | undefined): BikeRaceWeight[] {
  const equip = profile?.equipment;
  if (!isObj(equip) || !isObj(equip.bikes)) return [];
  const out: BikeRaceWeight[] = [];
  for (const [name, spec] of Object.entries(equip.bikes)) {
    const g = isObj(spec) ? posNum(spec.race_weight_g) : null;
    if (g != null) out.push({ name, raceWeightG: g, raceWeightKg: Math.round(g / 100) / 10 });
  }
  return out;
}

/**
 * Total system weight (kg) a tyre-pressure model needs: the LIVE rider weight plus the bike as-raced.
 * Pure — the caller supplies the live rider weight (kg, from get_state; never stored in the profile)
 * and the bike's logged race weight (grams, from `bikeRaceWeights`). Rounds to 0.1 kg. Returns null
 * when either input is missing/invalid, so a caller degrades to a note rather than a misleading number.
 */
export function systemWeightKg(riderKg: number | null | undefined, bikeRaceWeightG: number | null | undefined): number | null {
  const r = posNum(riderKg);
  const b = posNum(bikeRaceWeightG);
  if (r == null || b == null) return null;
  return Math.round((r + b / 1000) * 10) / 10;
}
