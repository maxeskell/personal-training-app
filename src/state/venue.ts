import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * The open-water venue's latest readings — values with no public live feed that the athlete enters by
 * hand and updates often (so an env var, frozen at process start, is the wrong home: see
 * COACH_WATER_TEMP_C, which now only SEEDS a default). Lives in the gitignored data dir, read live on
 * every dashboard render, so a reading typed into the Week-ahead card takes effect on the next page load
 * — no .env edit, no service restart. The env var stays a fallback for when this file is absent.
 */

export interface VenueState {
  /** Latest manual open-water temperature reading (°C). */
  waterTempC?: number;
  /** ISO timestamp this reading was entered — drives the "as of" freshness label. */
  takenAt?: string;
}

/** Plausible open-water range; anything outside (or unparseable) is rejected rather than stored. */
const MIN_WATER_C = -2;
const MAX_WATER_C = 40;

/**
 * Parse a free-text water-temp entry into °C. Accepts a number or numeric string, clamps to a sane
 * open-water range and rounds to 0.1°C; NaN / out-of-range → undefined (the caller rejects the write).
 * Pure — the validation seam the dashboard endpoint and tests share.
 */
export function parseWaterTemp(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < MIN_WATER_C || n > MAX_WATER_C) return undefined;
  return Math.round(n * 10) / 10;
}

function file(): string {
  return join(config.dataDir, "venue.json");
}

/** Read the persisted venue state; absent/malformed → null (degrade, don't crash). */
export async function loadVenue(): Promise<VenueState | null> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as VenueState;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Record a validated reading with the time it was entered; returns the stored state. */
export async function setWaterTemp(tempC: number): Promise<VenueState> {
  const state: VenueState = { waterTempC: tempC, takenAt: new Date().toISOString() };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file(), JSON.stringify(state, null, 2));
  return state;
}

/** Forget the reading (back to "check the venue" / the COACH_WATER_TEMP_C seed if one is set). */
export async function clearWaterTemp(): Promise<void> {
  await rm(file(), { force: true });
}
