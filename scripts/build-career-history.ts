#!/usr/bin/env tsx
/**
 * Build data/career-history.json for the read-only /career page (race history + lifetime bests vs current
 * form + power curve). The data is a multi-year archive that does NOT live in the live coaching state, so
 * this script assembles it from your exports and writes a GITIGNORED file (see career-history.example.json
 * for the shape, SETUP.md → "Career history" for the how-to). Run it with tsx (e.g. `npm run career:build`):
 *
 *   npm run career:build -- \
 *     --intervals /abs/path/activities.json \   # intervals.icu activities (last-90d + season bests + no-FIT race fallback)
 *     --tp        /abs/path/activities_tp.csv \  # TrainingPeaks archive (all-time bests, 2011+)
 *     --power     /abs/path/power_curve.json \   # intervals power-curve export (mean-maximal watts)
 *     --races     /abs/path/career-races.json \  # YOUR curated race list (names/locations/optional result) — optional
 *     --fit-dir   /abs/path/fit-streams \        # raw .FIT exports for per-race performance + splits (default: data/fit-streams)
 *     --season    2026 \                         # season year for the "Season" column (default: this year)
 *     --out       data/career-history.json       # default
 *
 * RACE PERFORMANCE + SPLITS come from YOUR OWN files, never the web (no official results are scraped): each
 * race is matched by date+sport to a raw `.FIT` (finish time, distance, pace, avg power/HR, and a per-lap
 * or — for a triathlon — per-discipline split table), falling back to the matching `--intervals`/`--tp`
 * activity for summary numbers only when no `.FIT` exists. Anything you hand-author in `--races` always wins.
 * Re-running preserves the existing file's races when no --races is given. No network.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { loadActivityFits } from "../src/insights/fit.js";
import { meanMaximalCurve, type CurvePoint } from "../src/insights/powerCurve.js";
import { enrichRaceResults, sportFamily, type ActivitySummary, type DatedFit, type SportFamily } from "../src/coach/raceResults.js";

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

/** A normalised activity: {date, sport, distKm, durSec, np}. From intervals JSON or the TP CSV. */
function fromIntervals(acts: any): Act[] {
  if (!Array.isArray(acts)) return [];
  return acts.map((a) => ({
    date: String(a.start_date_local ?? a.start_date ?? "").slice(0, 10),
    sport: sportOf(a.type ?? a.sport),
    distKm: (num(a.distance) ?? 0) / 1000,
    durSec: num(a.moving_time) ?? num(a.elapsed_time) ?? 0,
    np: num(a.icu_weighted_avg_watts) ?? num(a.average_watts),
  }));
}
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

function buildBests(all: Act[], intervals: Act[], season: number) {
  const today = new Date();
  const d90 = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const seasonStart = `${season}-01-01`;
  const last90 = intervals.filter((a) => inWindow(a.date, d90));
  const seasonActs = intervals.filter((a) => a.date >= seasonStart);
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

/** Sample a single intervals power-curve list-item (parallel secs[]/values[]) at the standard durations. */
function sampleCurve(item: any): Array<{ durationSec: number; watts: number }> {
  const secs = item?.secs,
    vals = item?.values;
  if (!Array.isArray(secs) || !Array.isArray(vals)) return [];
  const out: Array<{ durationSec: number; watts: number }> = [];
  for (const d of DURATIONS) {
    let idx = secs.indexOf(d);
    if (idx < 0) {
      idx = secs.findIndex((s: number) => s >= d); // nearest at-or-above
    }
    const w = idx >= 0 ? vals[idx] : undefined;
    if (Number.isFinite(w) && w > 0) out.push({ durationSec: d, watts: Math.round(w) });
  }
  return out;
}

function buildPower(powerJson: any, season: number) {
  const list = powerJson?.list;
  if (!Array.isArray(list) || !list.length) return undefined;
  const pick = (re: RegExp) => list.find((it: any) => re.test(String(it.label ?? it.id ?? "").toLowerCase()));
  const allItem = pick(/all|ever|4000|10y|5y/) ?? pick(/year/) ?? list[0];
  const allTime = sampleCurve(allItem);
  if (!allTime.length) return undefined;
  const last90 = sampleCurve(pick(/90|6 ?w|42|month/) ?? {});
  const seasonItem = pick(new RegExp(String(season))) ?? pick(/season|ytd/);
  const seasonCurve = sampleCurve(seasonItem ?? {});
  const pc: { allTime: any; last90?: any; season?: any } = { allTime };
  if (last90.length) pc.last90 = last90;
  if (seasonCurve.length) pc.season = seasonCurve;
  return pc;
}

/**
 * Power curve for the /career page. All-time comes from the intervals `--power` export (or, if absent, your
 * .FIT rides). The "recent" Last-90-days + Season windows are computed from your raw .FIT RIDE power streams
 * (robust — no dependence on the export's labels), falling back to the export's windows when no .FITs cover
 * them. Returns undefined when there's no usable all-time curve.
 */
function buildPowerCurve(powerJson: any, fits: DatedFit[], season: number) {
  const exportPc = powerJson ? buildPower(powerJson, season) : undefined;
  const rides = fits
    .filter((f) => sportFamily(f.sport) === "ride")
    .map((f) => ({ date: f.date, watts: f.fit.samples.map((s) => s.power) }))
    .filter((a) => a.watts.some((w) => w != null));
  const d90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  const seasonStart = `${season}-01-01`;
  const fitLast90 = meanMaximalCurve(rides.filter((a) => a.date >= d90), DURATIONS);
  const fitSeason = meanMaximalCurve(rides.filter((a) => a.date >= seasonStart), DURATIONS);

  const allTime: CurvePoint[] | undefined =
    exportPc?.allTime?.length ? exportPc.allTime : rides.length ? meanMaximalCurve(rides, DURATIONS) : undefined;
  if (!allTime || !allTime.length) return undefined;

  const last90 = fitLast90.length ? fitLast90 : exportPc?.last90;
  const seasonCurve = fitSeason.length ? fitSeason : exportPc?.season;
  const pc: { allTime: CurvePoint[]; last90?: CurvePoint[]; season?: CurvePoint[] } = { allTime };
  if (last90?.length) pc.last90 = last90;
  if (seasonCurve?.length) pc.season = seasonCurve;
  return pc;
}

function main() {
  const args = parseArgs();
  const season = Number(args.season ?? new Date().getFullYear());
  const out = resolve(typeof args.out === "string" ? args.out : "data/career-history.json");

  const intervals = typeof args.intervals === "string" ? fromIntervals(readJson(args.intervals)) : [];
  const tp = typeof args.tp === "string" ? fromTp(readCsv(args.tp)) : [];
  const all = [...tp, ...intervals].filter((a) => a.date);

  // races: --races file wins; else preserve races already in the output; else empty.
  let races: any[] = [];
  if (typeof args.races === "string") {
    const r = readJson(args.races);
    races = Array.isArray(r) ? r : Array.isArray(r?.races) ? r.races : [];
  } else if (existsSync(out)) {
    races = readJson(out)?.races ?? [];
  }

  // Race performance + splits from YOUR files (no scraping): match each race to a raw .FIT (preferred) or
  // the activity export (summary fallback); hand-authored result fields always win.
  const fitDir = typeof args["fit-dir"] === "string" ? (args["fit-dir"] as string) : undefined;
  const datedFits: DatedFit[] = loadActivityFits(fitDir).map((f) => ({ date: f.date, sport: f.sport, fit: f.fit }));
  const activities: ActivitySummary[] = all.map((a) => ({ date: a.date, sport: a.sport, distKm: a.distKm, durSec: a.durSec, np: a.np }));
  const enriched = enrichRaceResults(races, datedFits, activities);
  races = enriched.races;

  const bests = all.length ? buildBests(all, intervals.length ? intervals : all, season) : [];
  const powerCurve = buildPowerCurve(typeof args.power === "string" ? readJson(args.power) : null, datedFits, season);

  const result: Record<string, unknown> = { generatedAt: new Date().toISOString().slice(0, 10), seasonYear: season, races, bests };
  if (powerCurve) result.powerCurve = powerCurve;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  const e = enriched.stats;
  const pcStr = powerCurve
    ? `allTime ${powerCurve.allTime.length}, last90 ${powerCurve.last90?.length ?? 0}, season ${powerCurve.season?.length ?? 0} pts`
    : "none";
  console.log(
    `wrote ${out}\n  races: ${races.length} | bests: ${bests.map((b) => `${b.sport}(${b.rows.length})`).join(", ") || "none"} | power: ${pcStr}\n` +
      `  race performance: ${e.fromFit} from .FIT, ${e.fromActivity} from activity export, ${e.withSplits} with splits (of ${e.total}; ${datedFits.length} .FIT files scanned${fitDir ? ` in ${fitDir}` : ""})`,
  );
}

main();
