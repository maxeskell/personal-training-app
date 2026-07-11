/**
 * Derive each race's recorded PERFORMANCE + per-interval SPLITS for the read-only /career page, from the
 * athlete's OWN files — never the web (no official results are scraped; that's a standing design choice
 * stated in the script and the page UI).
 *
 * Two sources, in preference order, with hand-authored values ALWAYS winning per field:
 *   1. a matched raw `.FIT` (by date + sport) → finish time, distance, pace, avg power/HR, AND per-lap/length
 *      splits for a single-sport race, or one summary row per discipline (swim/bike/run legs) for a triathlon;
 *   2. the activity export the career build already loads (a TrainingPeaks CSV) → summary numbers
 *      only (no splits), the fallback when no `.FIT` was exported for that race.
 *
 * PURE + deterministic: the build script does the file I/O (parsing `.FIT`s, reading the activity export)
 * and passes the parsed inputs in. It fills only the fields a race left blank — a curated result is never
 * overwritten — and tags any derived summary with its provenance (`via`) so the page can show where a
 * number came from. Reuses the verified `.FIT` lap/length decoder (sessionSplits) — no second parser.
 */

import type { FitActivity } from "../insights/fitParser.js";
import { lapSplits, lengthSplits } from "../insights/sessionSplits.js";
import type { Race, RaceResult, RaceSplit } from "./careerHistory.js";

export type SportFamily = "run" | "ride" | "swim" | "other";

/** A parsed `.FIT` tagged with the date + sport the build read from it (structurally an `ActivityFit`). */
export interface DatedFit {
  date: string; // YYYY-MM-DD
  sport: string; // FIT sportName ("Run" | "Ride" | "Swim" | ...)
  fit: FitActivity;
}

/** A normalised activity from the TrainingPeaks export — the no-FIT summary fallback. */
export interface ActivitySummary {
  date: string; // YYYY-MM-DD
  sport: SportFamily; // already normalised by the build
  distKm: number;
  durSec: number;
  np?: number; // avg / normalised power (W)
}

export interface EnrichStats {
  total: number;
  fromFit: number; // races whose summary was filled from a matched .FIT
  fromActivity: number; // races whose summary fell back to an activity export
  withSplits: number; // races that gained a splits table
}

/** Normalise any sport label (race.sport, or a FIT's sportName) to a family. */
export function sportFamily(s: string): SportFamily {
  const x = String(s ?? "").toLowerCase();
  if (x.includes("swim")) return "swim";
  if (x.includes("rid") || x.includes("bik") || x.includes("cycl") || x.includes("virtual") || x.includes("sportive")) return "ride";
  if (x.includes("run")) return "run";
  return "other";
}

const MULTISPORT = /tri(athlon)?|duathlon|aquathlon|aquabike|swimrun|multisport/i;
/** True for multi-discipline races, whose splits are per-leg summaries rather than per-lap rows. */
export function isMultisport(raceSport: string, raceType: string): boolean {
  return MULTISPORT.test(raceSport) || MULTISPORT.test(raceType);
}

/** Latest date (YYYY-MM-DD) an activity may claim and still be believed: tomorrow, allowing device
 *  clock skew across timezones. Later than that is a corrupt timestamp, not a workout from the future. */
export function maxPlausibleDate(now = new Date()): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Drop activities dated implausibly in the future — a corrupt timestamp (e.g. a bad FIT epoch decoding
 * to 2106-02-26) otherwise sits inside every "Last 90 days"/"Season" window forever, because those
 * windows only bound the past (`date >= start`). An activity that can't be dated can't be windowed, so
 * it is excluded from bests/power-curve/race-matching entirely rather than re-dated (honest models:
 * inventing a date would be a silent lie). Undated items (`date: ""`) pass through unchanged — they
 * already match no window and no race.
 */
export function excludeFutureDated<T extends { date: string }>(items: T[], now = new Date()): T[] {
  const max = maxPlausibleDate(now);
  return items.filter((i) => !i.date || i.date <= max);
}

// ---------- formatting (the generator owns units/rounding; the page just prints) ----------

function clock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}
function paceClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
function fmtKm(km: number): string {
  return `${km.toFixed(km < 10 ? 2 : 1)} km`;
}
function fmtDistM(m: number): string {
  return m >= 1000 ? fmtKm(m / 1000) : `${Math.round(m)} m`;
}
/** Pace string by family, or undefined for rides (shown by power/speed, not pace) and bad inputs. */
function paceFor(fam: SportFamily, durSec: number, distKm: number): string | undefined {
  if (!(durSec > 0) || !(distKm > 0)) return undefined;
  if (fam === "swim") return `${paceClock((durSec / (distKm * 1000)) * 100)}/100m`;
  if (fam === "run") return `${paceClock(durSec / distKm)}/km`;
  return undefined;
}

interface DerivedSummary {
  distanceKm?: number;
  time?: string;
  pace?: string;
  avgW?: number;
  avgHr?: number;
  via: "fit" | "activity";
}

function summaryFromFit(fit: FitActivity): DerivedSummary {
  const s = fit.session;
  const fam = sportFamily(fit.sportName);
  const dist = s.distanceKm;
  return {
    distanceKm: dist != null ? +dist.toFixed(2) : undefined,
    time: s.durationSec != null ? clock(s.durationSec) : undefined,
    pace: dist != null && s.durationSec != null ? paceFor(fam, s.durationSec, dist) : undefined,
    avgW: s.avgPower != null ? Math.round(s.avgPower) : undefined,
    avgHr: s.avgHr != null ? Math.round(s.avgHr) : undefined,
    via: "fit",
  };
}

function summaryFromActivity(a: ActivitySummary): DerivedSummary {
  return {
    distanceKm: a.distKm > 0 ? +a.distKm.toFixed(2) : undefined,
    time: a.durSec > 0 ? clock(a.durSec) : undefined,
    pace: paceFor(a.sport, a.durSec, a.distKm),
    avgW: a.np != null && a.np > 0 ? Math.round(a.np) : undefined,
    via: "activity",
  };
}

/** Cap on emitted split rows — a long pool swim can be 60+ lengths; keep the page sane. */
const MAX_SPLIT_ROWS = 60;

/** Per-lap (or per-length, pure pool swim) splits for a single-sport race, from its `.FIT`. */
function fitLapSplits(fit: FitActivity, fam: SportFamily): RaceSplit[] {
  const ivs = fit.laps.length ? lapSplits(fit) : fam === "swim" ? lengthSplits(fit) : [];
  return ivs
    .filter((s) => s.timeS != null || s.distanceM != null)
    .slice(0, MAX_SPLIT_ROWS)
    .map((s): RaceSplit => {
      const pace = fam === "swim" ? s.paceSecPer100m : s.paceSecPerKm;
      return {
        label: `#${s.index}`,
        dist: s.distanceM != null ? fmtDistM(s.distanceM) : undefined,
        time: s.timeS != null ? clock(s.timeS) : undefined,
        pace: pace != null ? `${paceClock(pace)}${fam === "swim" ? "/100m" : "/km"}` : undefined,
        hr: s.avgHr ?? undefined,
        watts: s.avgPowerW ?? undefined,
      };
    });
}

function startTimeOf(fit: FitActivity): number {
  return fit.samples.find((s) => s.t != null)?.t ?? fit.laps.find((l) => l.startTimeS != null)?.startTimeS ?? 0;
}

interface Leg {
  start: number;
  sportName: string;
  distanceKm?: number;
  time?: string;
  pace?: string;
  avgW?: number;
  avgHr?: number;
}

/**
 * Discipline legs from a day's files: a MULTISPORT `.FIT` carries one `session` per leg (swim/bike/run),
 * so we expand its sessions; a single-discipline file (or a .TCX/.PWX, which have no sessions) contributes
 * one leg from its overall summary. Either way the race day's swim/bike/run are recovered.
 */
function legsOf(df: DatedFit): Leg[] {
  const sessions = df.fit.sessions ?? [];
  if (sessions.length > 1) {
    return sessions.map((s): Leg => {
      const fam = sportFamily(s.sportName);
      return {
        start: s.startTimeS ?? 0,
        sportName: s.sportName,
        distanceKm: s.distanceKm,
        time: s.durationSec != null ? clock(s.durationSec) : undefined,
        pace: s.distanceKm != null && s.durationSec != null ? paceFor(fam, s.durationSec, s.distanceKm) : undefined,
        avgW: fam === "ride" && s.avgPower != null ? Math.round(s.avgPower) : undefined,
        avgHr: s.avgHr,
      };
    });
  }
  const fam = sportFamily(df.sport);
  const sum = summaryFromFit(df.fit);
  return [{ start: startTimeOf(df.fit), sportName: df.fit.sportName, distanceKm: sum.distanceKm, time: sum.time, pace: sum.pace, avgW: fam === "ride" ? sum.avgW : undefined, avgHr: sum.avgHr }];
}

/** One summary row per discipline leg for a multisport race, in chronological order (transitions dropped). */
function legSplits(fits: DatedFit[]): RaceSplit[] {
  return fits
    .flatMap(legsOf)
    .filter((l) => sportFamily(l.sportName) !== "other") // drop T1/T2 and unknown-sport segments
    .sort((a, b) => a.start - b.start)
    .map((l): RaceSplit => ({
      label: l.sportName,
      dist: l.distanceKm != null ? fmtKm(l.distanceKm) : undefined,
      time: l.time,
      pace: l.pace,
      hr: l.avgHr,
      watts: l.avgW,
    }));
}

function pickLongestFit(fits: DatedFit[]): DatedFit | undefined {
  if (!fits.length) return undefined;
  return fits.reduce((best, f) => ((f.fit.session.distanceKm ?? 0) > (best.fit.session.distanceKm ?? 0) ? f : best));
}
function pickLongestActivity(acts: ActivitySummary[]): ActivitySummary | undefined {
  if (!acts.length) return undefined;
  return acts.reduce((best, a) => (a.distKm > best.distKm ? a : best));
}

/** Merge a derived summary + splits UNDER the hand-authored result (author wins every field). */
function fillResult(
  authored: RaceResult | undefined,
  derived: DerivedSummary | undefined,
  splits: RaceSplit[] | undefined,
): { result: RaceResult | undefined; usedVia?: "fit" | "activity"; usedSplits: boolean } {
  const r: RaceResult = { ...(authored ?? {}) };
  let usedDerived = false;
  if (derived) {
    for (const k of ["distanceKm", "time", "pace", "avgW", "avgHr"] as const) {
      if (r[k] == null && derived[k] != null) {
        (r as Record<string, unknown>)[k] = derived[k];
        usedDerived = true;
      }
    }
  }
  let usedSplits = false;
  if (splits && splits.length && (!r.splits || !r.splits.length)) {
    r.splits = splits;
    usedSplits = true;
  }
  if (usedDerived && derived) r.via = derived.via;
  return { result: Object.keys(r).length ? r : undefined, usedVia: usedDerived ? derived?.via : undefined, usedSplits };
}

/**
 * Fill each race's performance + splits from the athlete's `.FIT`s (preferred) and activity export
 * (fallback), without overwriting anything hand-authored. Pure: returns new race objects only where
 * something was added, plus a small report for the build's console summary.
 */
export function enrichRaceResults(
  races: Race[],
  fits: DatedFit[],
  activities: ActivitySummary[],
): { races: Race[]; stats: EnrichStats } {
  const stats: EnrichStats = { total: races.length, fromFit: 0, fromActivity: 0, withSplits: 0 };
  const out = races.map((race) => {
    const fam = sportFamily(race.sport);
    const multisport = isMultisport(race.sport, race.type);
    const onDate = fits.filter((f) => f.date === race.date);

    let derived: DerivedSummary | undefined;
    let splits: RaceSplit[] | undefined;

    if (multisport) {
      // Legs come from race-day files: a multisport .FIT expands into its swim/bike/run sessions, separate
      // per-discipline files each become a leg. The overall summary stays author-owned (transitions make
      // summing legs unreliable, and the activity export can't represent a whole multisport race).
      const legs = legSplits(onDate);
      if (legs.length) splits = legs;
    } else if (fam !== "other") {
      const best = pickLongestFit(onDate.filter((f) => sportFamily(f.sport) === fam));
      if (best) {
        derived = summaryFromFit(best.fit);
        const s = fitLapSplits(best.fit, fam);
        if (s.length) splits = s;
      }
      // No FIT → fall back to the matching activity export (summary only).
      if (!derived) {
        const act = pickLongestActivity(activities.filter((a) => a.date === race.date && a.sport === fam));
        if (act) derived = summaryFromActivity(act);
      }
    }

    const { result, usedVia, usedSplits } = fillResult(race.result, derived, splits);
    if (!usedVia && !usedSplits) return race; // nothing to add — leave the race untouched
    if (usedVia === "fit") stats.fromFit++;
    else if (usedVia === "activity") stats.fromActivity++;
    if (usedSplits) stats.withSplits++;
    return { ...race, result };
  });
  return { races: out, stats };
}
