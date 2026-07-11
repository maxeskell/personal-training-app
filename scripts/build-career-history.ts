#!/usr/bin/env tsx
/**
 * Build data/career-history.json for the read-only /career page (race history + lifetime bests vs current
 * form + power curve). The data is a multi-year archive that does NOT live in the live coaching state, so
 * this script assembles it from your exports and writes a GITIGNORED file (see career-history.example.json
 * for the shape, SETUP.md → "Career history" for the how-to). Run it with tsx (e.g. `npm run career:build`):
 *
 *   npm run career:build -- \
 *     --tp        /abs/path/activities_tp.csv \  # TrainingPeaks archive (all-time bests, 2011+) — optional
 *     --races     /abs/path/career-races.json \  # YOUR curated race list (names/locations/optional result) — optional
 *     --fit-dir   /abs/path/archive \            # your activity-file archive (.fit/.tcx/.pwx, optionally .gz, nested)
 *     --season    2026 \                         # season year for the "Season" column (default: this year)
 *     --out       data/career-history.json       # default
 *
 * RACE PERFORMANCE + SPLITS come from YOUR OWN files, never the web (no official results are scraped): each
 * race is matched by date+sport to an activity file (finish time, distance, pace, avg power/HR, and a per-lap
 * or — for a triathlon — per-discipline split table; a multisport `.FIT` is split into its swim/bike/run
 * legs), falling back to the matching `--tp` activity for summary numbers only when none
 * exists. It reads `.FIT`, `.TCX` and `.PWX` (the three formats a TrainingPeaks WorkoutFileExport ships),
 * optionally gzipped, from data/fit-streams (recent, full samples → power curve) AND `--fit-dir` (walked
 * recursively, samples dropped). Hand-authored `--races` fields always win. Re-running preserves the
 * existing file's races when no --races is given. No network. The all-time / recent power curves are
 * computed from your `.FIT` RIDE power streams.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadActivityFits, fitStreamsDir, type ActivityFit } from "../src/insights/fit.js";
import { activityArchiveDir } from "../src/archive/activityArchive.js";
import { meanMaximalCurve, keepPlausibleRides, ftpProxyFromNp, type CurvePoint } from "../src/insights/powerCurve.js";
import { enrichRaceResults, excludeFutureDated, sportFamily, type ActivitySummary, type DatedFit, type SportFamily } from "../src/coach/raceResults.js";

const DURATIONS = [5, 15, 30, 60, 120, 300, 480, 600, 1200, 1800, 3600];

function parseArgs(): Record<string, string | true> {
  const a: Record<string, string | true> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
      a[k] = v;
    }
  }
  return a;
}

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readCsv(p: string): Record<string, string>[] {
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const head = lines[0].split(",");
  return lines.slice(1).map((ln) => {
    const cells = ln.split(",");
    const row: Record<string, string> = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

const num = (x: unknown): number | undefined => {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};
const mmss = (sec: number): string => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};

/** Normalise an activity sport label to run|ride|swim|other. */
function sportOf(s: unknown): SportFamily {
  const x = String(s ?? "").toLowerCase();
  if (x.includes("swim")) return "swim";
  if (x.includes("ride") || x.includes("bik") || x.includes("cycl") || x.includes("virtualride")) return "ride";
  if (x.includes("run")) return "run";
  return "other";
}

interface Act {
  date: string;
  sport: SportFamily;
  distKm: number;
  durSec: number;
  np?: number;
}

/** A normalised activity: {date, sport, distKm, durSec, np}. From the TrainingPeaks CSV. */
function fromTp(rows: Record<string, string>[]): Act[] {
  return rows.map((r) => ({
    date: String(r.date ?? "").slice(0, 10),
    sport: sportOf(r.sport),
    distKm: num(r.dist_km) ?? 0,
    durSec: (num(r.dur_min) ?? 0) * 60,
    np: num(r.np_w) ?? num(r.avg_w),
  }));
}

// Outlier guards (honest models — keep GPS junk + mislabeled activities + power spikes out of the bests):
const PACE_MIN = 150,
  PACE_MAX = 720; // 2:30–12:00 /km — below is a GPS spike, above isn't a race effort
const MAX_KM: Record<string, number> = { run: 100, ride: 350, swim: 10 }; // single-session sanity caps (a "18.7km swim" is mislabeled)

/** Best (fastest) run covering ~a target distance: min pace over runs in [d, d*1.6], pace-sane. BestValue|null. */
function runBest(acts: Act[], dKm: number): { value: string; date: string } | null {
  let best: { pace: number; date: string; time: number } | null = null;
  for (const a of acts) {
    if (a.sport !== "run" || !(a.distKm >= dKm && a.distKm <= dKm * 1.6) || !a.durSec) continue;
    const pace = a.durSec / a.distKm;
    if (pace < PACE_MIN || pace > PACE_MAX) continue; // drop GPS spikes / walks
    if (!best || pace < best.pace) best = { pace, date: a.date, time: a.durSec * (dKm / a.distKm) };
  }
  return best ? { value: mmss(best.time), date: best.date } : null;
}
function longest(acts: Act[], sport: string): { value: string; date: string } | null {
  let best: { distKm: number; date: string } | null = null;
  for (const a of acts) if (a.sport === sport && a.distKm <= (MAX_KM[sport] ?? 1e9) && a.distKm > (best?.distKm ?? 0)) best = { distKm: a.distKm, date: a.date };
  return best ? { value: `${best.distKm.toFixed(best.distKm < 10 ? 2 : 1)} km`, date: best.date } : null;
}
/** Best sustained ride power, spike-robust: power-meter calibration glitches sit far above the bulk, so we
 *  take the best ride whose NP is within 1.25× the 90th percentile of all qualifying rides (this drops lone
 *  400W-type artifacts while keeping a genuine hard ride). See the dataQuality convention. */
function bestPower(acts: Act[]): { value: string; date: string } | null {
  const rides = acts.filter((a) => a.sport === "ride" && a.distKm >= 20 && a.np && a.np > 80 && a.np < 600);
  if (!rides.length) return null;
  const sorted = rides.map((a) => a.np!).sort((x, y) => x - y);
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
  const ceil = p90 * 1.25;
  let best: { np: number; date: string } | null = null;
  for (const a of rides) if (a.np! <= ceil && a.np! > (best?.np ?? 0)) best = { np: a.np!, date: a.date };
  return best ? { value: `${Math.round(best.np)} W`, date: best.date } : null;
}

function inWindow(date: string, fromDate: string): boolean {
  return date >= fromDate;
}

function buildBests(all: Act[], season: number) {
  const today = new Date();
  const d90 = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const seasonStart = `${season}-01-01`;
  const last90 = all.filter((a) => inWindow(a.date, d90));
  const seasonActs = all.filter((a) => a.date >= seasonStart);
  const cols = (fn: (x: Act[]) => any) => ({ allTime: fn(all), last90: fn(last90), season: fn(seasonActs) });
  const row = (label: string, fn: (x: Act[]) => any) => {
    const c = cols(fn);
    return c.allTime || c.last90 || c.season ? { label, ...clean(c) } : null;
  };
  const runRows = [
    row("5k", (x) => runBest(x, 5)),
    row("10k", (x) => runBest(x, 10)),
    row("Half-mar", (x) => runBest(x, 21.1)),
    row("Longest", (x) => longest(x, "run")),
  ].filter(Boolean);
  const bikeRows = [
    row("Best power (≥20km)", (x) => bestPower(x)),
    row("Longest", (x) => longest(x, "ride")),
  ].filter(Boolean);
  const swimRows = [row("Longest", (x) => longest(x, "swim"))].filter(Boolean);
  const out: Array<{ sport: string; rows: any[] }> = [];
  if (runRows.length) out.push({ sport: "Run", rows: runRows });
  if (bikeRows.length) out.push({ sport: "Bike", rows: bikeRows });
  if (swimRows.length) out.push({ sport: "Swim", rows: swimRows });
  return out;
}
const clean = (o: Record<string, any>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

/**
 * Power curve for the /career page — computed entirely from your raw .FIT RIDE power streams (mean-maximal
 * power at each standard duration). All-time is over EVERY ride with power — the recent streams dir plus the
 * whole durable archive (the caller keeps ride samples across the corpus for exactly this) — so it reflects
 * years of history, not just the last few weeks; the "recent" Last-90-days + Season windows filter those same
 * rides by date. Returns undefined when there's no usable ride power data.
 *
 * A plausibility guard (keepPlausibleRides) drops any ride whose sustained power is physiologically
 * impossible for `ftpW` (a robust FTP proxy), so one miscalibrated power file can't set the whole all-time
 * line — the mean-maximal curve is a max across rides, so without this a single ~2×-inflated ride wins every
 * point (the real 2023-12-17 / TrainingPeaks "574019" case). `ftpW` undefined ⇒ curve left unguarded.
 */
function buildPowerCurve(fits: DatedFit[], season: number, ftpW?: number) {
  const allRides = fits
    .filter((f) => sportFamily(f.sport) === "ride")
    .map((f) => ({ date: f.date, watts: f.fit.samples.map((s) => s.power) }))
    .filter((a) => a.watts.some((w) => w != null));
  const rides = keepPlausibleRides(allRides, ftpW ?? null);
  const dropped = allRides.length - rides.length;
  if (dropped) {
    console.log(`  power-curve guard: dropped ${dropped} ride(s) with implausible power (> envelope for FTP≈${Math.round(ftpW!)}W)`);
  }
  if (!rides.length) return undefined;
  const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const seasonStart = `${season}-01-01`;

  const allTime: CurvePoint[] = meanMaximalCurve(rides, DURATIONS);
  if (!allTime.length) return undefined;
  const last90 = meanMaximalCurve(rides.filter((a) => a.date >= d90), DURATIONS);
  const seasonCurve = meanMaximalCurve(rides.filter((a) => a.date >= seasonStart), DURATIONS);
  const pc: { allTime: CurvePoint[]; last90?: CurvePoint[]; season?: CurvePoint[] } = { allTime };
  if (last90.length) pc.last90 = last90;
  if (seasonCurve.length) pc.season = seasonCurve;
  return pc;
}

/** Drop duplicate activities across the streams + archive dirs (same date/sport/duration), keeping the copy
 *  that still has per-second samples (so a recent race in both dirs doesn't lose its power-curve data). */
function dedupFits(fits: ActivityFit[]): ActivityFit[] {
  const by = new Map<string, ActivityFit>();
  for (const f of fits) {
    const key = `${f.date}|${f.fit.sportName}|${Math.round(f.fit.session.durationSec ?? 0)}`;
    const cur = by.get(key);
    if (!cur || (cur.fit.samples.length === 0 && f.fit.samples.length > 0)) by.set(key, f);
  }
  return [...by.values()];
}

function main() {
  const args = parseArgs();
  const season = Number(args.season ?? new Date().getFullYear());
  const out = resolve(typeof args.out === "string" ? args.out : "data/career-history.json");

  // Future-dated activities are corrupt timestamps (a bad FIT epoch decodes to e.g. 2106-02-26) and would
  // sit inside every Last-90/Season window forever — excluded from both inlets (TP rows here, files below).
  const tp = typeof args.tp === "string" ? fromTp(readCsv(args.tp)) : [];
  const all = excludeFutureDated(tp.filter((a) => a.date));

  // races: --races file wins; else preserve races already in the output; else empty.
  let races: any[] = [];
  if (typeof args.races === "string") {
    const r = readJson(args.races);
    races = Array.isArray(r) ? r : Array.isArray(r?.races) ? r.races : [];
  } else if (existsSync(out)) {
    races = readJson(out)?.races ?? [];
  }

  // Race performance + splits from YOUR files (no scraping): match each race to a raw activity file
  // (preferred) or the activity export (summary fallback); hand-authored result fields always win. Sources:
  //  - recentFits: the streams dir (recent .FIT, full per-second samples);
  //  - corpusFits: the DURABLE activity archive (data/activity-archive/, .fit/.tcx/.pwx, gz, nested) — the
  //    permanent corpus `archive:import` + sync build up; scanned recursively with samples dropped EXCEPT for
  //    rides, whose power we keep so the ALL-TIME power curve spans the whole archive (not just recent rides).
  //    Bounded memory: only ride files hold samples (runs/swims/etc. are dropped as before);
  //  - archiveFits: an extra one-off --fit-dir (e.g. an export not yet imported), same treatment.
  const keepRidePower = (sportName: string) => sportFamily(sportName) === "ride";
  const fitDir = typeof args["fit-dir"] === "string" ? (args["fit-dir"] as string) : undefined;
  const streamsDir = fitStreamsDir();
  const corpusDir = activityArchiveDir();
  const recentFits = loadActivityFits(streamsDir);
  const corpusFits = existsSync(corpusDir)
    ? loadActivityFits(corpusDir, { recursive: true, dropSamples: true, keepSamplesFor: keepRidePower })
    : [];
  const archiveFits =
    fitDir && resolve(fitDir) !== resolve(streamsDir) && resolve(fitDir) !== resolve(corpusDir)
      ? loadActivityFits(fitDir, { recursive: true, dropSamples: true, keepSamplesFor: keepRidePower })
      : [];
  const datedFits: DatedFit[] = excludeFutureDated(
    dedupFits([...recentFits, ...corpusFits, ...archiveFits]).map((f) => ({ date: f.date, sport: f.sport, fit: f.fit })),
  );
  const activities: ActivitySummary[] = all.map((a) => ({ date: a.date, sport: a.sport, distKm: a.distKm, durSec: a.durSec, np: a.np }));
  const enriched = enrichRaceResults(races, datedFits, activities);
  races = enriched.races;

  const bests = all.length ? buildBests(all, season) : [];
  // A robust FTP proxy from the athlete's own ride-NP distribution anchors the power-curve plausibility
  // guard (a MODEL). Percentile-based, so the very corrupt files it exists to catch can't inflate it; needs
  // the TP archive (`--tp`), so a curve-only rebuild without it is simply left unguarded.
  const ftpProxy = ftpProxyFromNp(all.filter((a) => a.sport === "ride" && a.np).map((a) => a.np!)) ?? undefined;
  const powerCurve = buildPowerCurve(datedFits, season, ftpProxy);

  // Year-by-year volume from the TrainingPeaks archive, so the Season page can benchmark "where am I now"
  // against the all-time peak and the detraining troughs.
  const byYear: Record<string, { hours: number; km: number }> = {};
  for (const a of tp) {
    const y = (a.date || "").slice(0, 4);
    if (!/^\d{4}$/.test(y)) continue;
    const d = (byYear[y] ??= { hours: 0, km: 0 });
    if (a.durSec && a.durSec < 1200 * 60) d.hours += a.durSec / 3600;
    if (a.distKm && a.distKm < 2000) d.km += a.distKm;
  }
  const trajectory = Object.entries(byYear)
    .map(([y, d]) => ({ year: Number(y), hours: Math.round(d.hours), km: Math.round(d.km) }))
    .filter((t) => t.year >= 2000 && t.year <= season + 1)
    .sort((a, b) => a.year - b.year);

  const result: Record<string, unknown> = { generatedAt: new Date().toISOString().slice(0, 10), seasonYear: season, races, bests };
  if (powerCurve) result.powerCurve = powerCurve;
  if (trajectory.length) result.trajectory = trajectory;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const e = enriched.stats;
  const pcStr = powerCurve
    ? `allTime ${powerCurve.allTime.length}, last90 ${powerCurve.last90?.length ?? 0}, season ${powerCurve.season?.length ?? 0} pts`
    : "none";
  console.log(
    `wrote ${out}\n  races: ${races.length} | bests: ${bests.map((b) => `${b.sport}(${b.rows.length})`).join(", ") || "none"} | power: ${pcStr} | trajectory: ${trajectory.length ? trajectory.length + "yrs" : "none"}\n` +
      `  race performance: ${e.fromFit} from file, ${e.fromActivity} from activity export, ${e.withSplits} with splits (of ${e.total}; ${recentFits.length} recent + ${corpusFits.length} archived${archiveFits.length ? ` + ${archiveFits.length} from ${fitDir}` : ""} activity files)`,
  );
}

main();
