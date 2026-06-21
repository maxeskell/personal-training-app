import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { config } from "../config.js";

/**
 * Career history data model + best-effort loader for the read-only `/career` page.
 *
 * The data is HISTORICAL and lives OUTSIDE the live coaching state (it comes from a multi-year
 * TrainingPeaks/intervals.icu archive, not AI Endurance), so — per the repo's gitignored-user-data
 * convention — it sits in a gitignored file (`data/career-history.json`, see {@link config}.career.path)
 * produced by `scripts/build-career-history.mjs`. A committed `career-history.example.json` documents the
 * shape, and SETUP.md explains how to fill it. Everything here is PURE except {@link loadCareerHistory},
 * which wraps the one file read; a missing/garbled file degrades to `null` (the page shows an empty state)
 * — never an error (degrade-don't-crash).
 *
 * Values in `bests`/`powerCurve` are PRE-FORMATTED strings/numbers from the generator so the page stays a
 * dumb renderer (the generator owns units + rounding). Nothing here is a live estimate — it's your own
 * recorded bests — so no MODEL labelling is needed; the page does note when "current" windows are empty.
 */

export interface RaceResult {
  distanceKm?: number;
  /** Pre-formatted finish/effort time, e.g. "43:12" or "10:51:30". */
  time?: string;
  /** Pre-formatted run pace, e.g. "4:19/km". */
  pace?: string;
  avgW?: number;
}

export interface Race {
  date: string; // YYYY-MM-DD
  sport: string; // run | ride | swim | triathlon | duathlon | sportive | swim-event
  type: string; // "Half-marathon", "70.3 triathlon", "Marathon", "Sportive 169 km", ...
  event?: string; // "Vienna City Half Marathon" — from overrides; may be absent (derived-only)
  location?: string; // "Vienna, Austria" — confirmed or nearest-city approximation
  confidence?: "confirmed" | "strong" | "probable";
  source?: string; // "geo+web", "S+B+R", "record", ...
  result?: RaceResult;
}

/** One value in a best-vs-current cell (pre-formatted string + when it was set). */
export interface BestValue {
  value: string; // "43:12", "966 W", "169.4 km"
  date?: string;
}

/** A single metric row compared across windows (all-time vs last-90d vs season). */
export interface BestRow {
  label: string; // "10k", "Longest", "20 min power", ...
  allTime?: BestValue;
  last90?: BestValue;
  season?: BestValue;
}

export interface SportBests {
  sport: string; // "Run", "Bike", "Swim"
  rows: BestRow[];
}

export interface PowerPoint {
  durationSec: number;
  watts: number;
  date?: string;
}

export interface PowerCurves {
  allTime: PowerPoint[];
  last90?: PowerPoint[];
  season?: PowerPoint[];
}

export interface CareerHistory {
  /** ISO date the file was generated — shown as a freshness line. */
  generatedAt?: string;
  /** Calendar year the `season` window refers to (e.g. 2026), for column headers. */
  seasonYear?: number;
  races: Race[];
  bests: SportBests[];
  powerCurve?: PowerCurves;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function parseBestValue(v: unknown): BestValue | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const value = asString(o.value);
  if (!value) return undefined;
  return { value, date: asString(o.date) };
}

function parsePowerPoints(v: unknown): PowerPoint[] {
  if (!Array.isArray(v)) return [];
  const out: PowerPoint[] = [];
  for (const p of v) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const durationSec = asNumber(o.durationSec);
    const watts = asNumber(o.watts);
    if (durationSec == null || watts == null) continue;
    out.push({ durationSec, watts, date: asString(o.date) });
  }
  return out.sort((a, b) => a.durationSec - b.durationSec);
}

/**
 * Validate + normalise a parsed JSON blob into a {@link CareerHistory}, dropping anything malformed.
 * Returns `null` if there isn't at least one usable race or best (so the page shows its empty state
 * rather than an empty skeleton). Pure — exported for tests.
 */
export function parseCareerHistory(raw: string): CareerHistory | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const o = data as Record<string, unknown>;

  const races: Race[] = Array.isArray(o.races)
    ? o.races.flatMap((r): Race[] => {
        if (!r || typeof r !== "object") return [];
        const x = r as Record<string, unknown>;
        const date = asString(x.date);
        const type = asString(x.type);
        if (!date || !type) return [];
        const resultRaw = x.result && typeof x.result === "object" ? (x.result as Record<string, unknown>) : undefined;
        const result: RaceResult | undefined = resultRaw
          ? {
              distanceKm: asNumber(resultRaw.distanceKm),
              time: asString(resultRaw.time),
              pace: asString(resultRaw.pace),
              avgW: asNumber(resultRaw.avgW),
            }
          : undefined;
        const conf = asString(x.confidence);
        return [
          {
            date,
            sport: asString(x.sport) ?? "other",
            type,
            event: asString(x.event),
            location: asString(x.location),
            confidence: conf === "confirmed" || conf === "strong" || conf === "probable" ? conf : undefined,
            source: asString(x.source),
            result,
          },
        ];
      })
    : [];

  const bests: SportBests[] = Array.isArray(o.bests)
    ? o.bests.flatMap((b): SportBests[] => {
        if (!b || typeof b !== "object") return [];
        const x = b as Record<string, unknown>;
        const sport = asString(x.sport);
        if (!sport || !Array.isArray(x.rows)) return [];
        const rows: BestRow[] = x.rows.flatMap((r): BestRow[] => {
          if (!r || typeof r !== "object") return [];
          const y = r as Record<string, unknown>;
          const label = asString(y.label);
          if (!label) return [];
          return [{ label, allTime: parseBestValue(y.allTime), last90: parseBestValue(y.last90), season: parseBestValue(y.season) }];
        });
        return rows.length ? [{ sport, rows }] : [];
      })
    : [];

  let powerCurve: PowerCurves | undefined;
  if (o.powerCurve && typeof o.powerCurve === "object") {
    const pc = o.powerCurve as Record<string, unknown>;
    const allTime = parsePowerPoints(pc.allTime);
    if (allTime.length) {
      powerCurve = {
        allTime,
        last90: parsePowerPoints(pc.last90),
        season: parsePowerPoints(pc.season),
      };
    }
  }

  if (!races.length && !bests.length && !powerCurve) return null;
  races.sort((a, b) => a.date.localeCompare(b.date));
  return {
    generatedAt: asString(o.generatedAt),
    seasonYear: asNumber(o.seasonYear),
    races,
    bests,
    powerCurve,
  };
}

/** Absolute path to the career-history file (COACH_CAREER_PATH or data/career-history.json). */
export function careerHistoryPath(): string {
  const p = config.career.path;
  return isAbsolute(p) ? p : join(process.cwd(), p);
}

/** Best-effort load: missing/unreadable/garbled file → `null` (page shows empty state). Never throws. */
export function loadCareerHistory(): CareerHistory | null {
  try {
    return parseCareerHistory(readFileSync(careerHistoryPath(), "utf8"));
  } catch {
    return null;
  }
}
