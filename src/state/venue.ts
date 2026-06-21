import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/**
 * The open-water venue's readings — values with no public live feed that the athlete enters by hand and
 * updates often (so an env var, frozen at process start, is the wrong home: see COACH_WATER_TEMP_C, which
 * now only SEEDS a default). Lives in the gitignored data dir, read live on every dashboard render. We
 * keep a short HISTORY of confirmed readings (not just the latest), each stamped with the air temp at the
 * time it was taken, so the forecaster (weather/waterTemp.ts) can drift a stale reading on air temperature
 * and ask the athlete to confirm the estimate.
 */

export interface WaterReading {
  /** Confirmed open-water temperature (°C). */
  tempC: number;
  /** ISO timestamp this reading was entered/confirmed — the freshness + drift anchor. */
  takenAt: string;
  /** Rolling air temp (°C) at confirm time — lets the MODEL drift the reading as the air changes. */
  airTempC?: number;
}

export interface VenueState {
  /** Confirmed readings, oldest first. */
  readings: WaterReading[];
}

/** Plausible open-water range; anything outside (or unparseable) is rejected rather than stored. */
const MIN_WATER_C = -2;
const MAX_WATER_C = 40;
/** Bound the history — only the recent readings matter for freshness/drift. */
const MAX_READINGS = 24;

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

function isReading(r: unknown): r is WaterReading {
  return !!r && typeof r === "object" && typeof (r as WaterReading).tempC === "number" && typeof (r as WaterReading).takenAt === "string";
}

/** Tolerate both the {readings:[…]} shape and the original single-reading {waterTempC,takenAt} file. */
function normaliseVenue(parsed: unknown): VenueState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (Array.isArray(o.readings)) {
    const readings = o.readings.filter(isReading);
    return readings.length ? { readings } : null;
  }
  if (typeof o.waterTempC === "number") {
    return { readings: [{ tempC: o.waterTempC, takenAt: typeof o.takenAt === "string" ? o.takenAt : new Date(0).toISOString() }] };
  }
  return null;
}

/** Read the persisted venue state; absent/malformed → null (degrade, don't crash). */
export async function loadVenue(): Promise<VenueState | null> {
  try {
    return normaliseVenue(JSON.parse(await readFile(file(), "utf8")));
  } catch {
    return null;
  }
}

/** The freshest confirmed reading (by takenAt), or undefined when there's no history. */
export function latestReading(state: VenueState | null | undefined): WaterReading | undefined {
  if (!state?.readings?.length) return undefined;
  return state.readings.reduce((a, b) => (a.takenAt >= b.takenAt ? a : b));
}

/** Append a confirmed reading (with the air-temp anchor when known); returns the stored reading. */
export async function setWaterTemp(tempC: number, airTempC?: number): Promise<WaterReading> {
  const existing = (await loadVenue())?.readings ?? [];
  const reading: WaterReading = { tempC, takenAt: new Date().toISOString(), ...(airTempC != null ? { airTempC } : {}) };
  const state: VenueState = { readings: [...existing, reading].slice(-MAX_READINGS) };
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file(), JSON.stringify(state, null, 2));
  return reading;
}

/** Forget all readings (back to "check the venue" / the COACH_WATER_TEMP_C seed if one is set). */
export async function clearWaterTemp(): Promise<void> {
  await rm(file(), { force: true });
}
