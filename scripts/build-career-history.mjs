#!/usr/bin/env node
/**
 * Build data/career-history.json for the read-only /career page (race history + lifetime bests vs current
 * form + power curve). The data is a multi-year archive that does NOT live in the live coaching state, so
 * this script assembles it from your exports and writes a GITIGNORED file (see career-history.example.json
 * for the shape, SETUP.md → "Career history" for the how-to).
 *
 *   node scripts/build-career-history.mjs \
 *     --intervals /abs/path/activities.json \   # intervals.icu activities (last-90d + season bests)
 *     --tp        /abs/path/activities_tp.csv \  # TrainingPeaks archive (all-time bests, 2011+)
 *     --power     /abs/path/power_curve.json \   # intervals power-curve export (mean-maximal watts)
 *     --races     /abs/path/career-races.json \  # YOUR curated race list (names/locations) — optional
 *     --season    2026 \                         # season year for the "Season" column (default: this year)
 *     --out       data/career-history.json       # default
 *
 * Every input is optional and best-effort: a missing file just leaves that section empty. Races are
 * pass-through (this script does NOT scrape official results) — author them in --races (or hand-edit the
 * output / a copy of career-history.example.json). Re-running preserves the existing file's races when no
 * --races is given. Pure data shuffling; no network.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

const DURATIONS = [5, 15, 30, 60, 120, 300, 480, 600, 1200, 1800, 3600];

function parseArgs() {
  const a = {};
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

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function readCsv(p) {
  let text;
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
    const row = {};
    head.forEach((h, i) => (row[h] = cells[i]));
    return row;
  });
}

const num = (x) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};
const mmss = (sec) => {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
};
const paceStr = (secPerKm) => {
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${String(s).padStart(2, "0")}/km`;
};

/** Normalise an activity sport label to run|ride|swim|other. */
function sportOf(s) {
  s = String(s ?? "").toLowerCase();
  if (s.includes("swim")) return "swim";
  if (s.includes("ride") || s.includes("bik") || s.includes("cycl") || s.includes("virtualride")) return "ride";
  if (s.includes("run")) return "run";
  return "other";
}

/** A normalised activity: {date, sport, distKm, durSec, np}. From intervals JSON or the TP CSV. */
function fromIntervals(acts) {
  if (!Array.isArray(acts)) return [];
  return acts.map((a) => ({
    date: String(a.start_date_local ?? a.start_date ?? "").slice(0, 10),
    sport: sportOf(a.type ?? a.sport),
    distKm: (num(a.distance) ?? 0) / 1000,
    durSec: num(a.moving_time) ?? num(a.elapsed_time) ?? 0,
    np: num(a.icu_weighted_avg_watts) ?? num(a.average_watts),
  }));
}
function fromTp(rows) {
  return rows.map((r) => ({
    date: String(r.date ?? "").slice(0, 10),
    sport: sportOf(r.sport),
    distKm: num(r.dist_km) ?? 0,
    durSec: (num(r.dur_min) ?? 0) * 60,
    np: num(r.np_w) ?? num(r.avg_w),
  }));
}

// Outlier guards (honest models — keep GPS junk + mislabeled activities + power spikes out of the bests):
const PACE_MIN = 150, PACE_MAX = 720; // 2:30–12:00 /km — below is a GPS spike, above isn't a race effort
const MAX_KM = { run: 100, ride: 350, swim: 10 }; // single-session sanity caps (a "18.7km swim" is mislabeled)

/** Best (fastest) run covering ~a target distance: min pace over runs in [d, d*1.6], pace-sane. BestValue|null. */
function runBest(acts, dKm) {
  let best = null;
  for (const a of acts) {
    if (a.sport !== "run" || !(a.distKm >= dKm && a.distKm <= dKm * 1.6) || !a.durSec) continue;
    const pace = a.durSec / a.distKm;
    if (pace < PACE_MIN || pace > PACE_MAX) continue; // drop GPS spikes / walks
    if (!best || pace < best.pace) best = { pace, date: a.date, time: a.durSec * (dKm / a.distKm) };
  }
  return best ? { value: mmss(best.time), date: best.date } : null;
}
function longest(acts, sport) {
  let best = null;
  for (const a of acts) if (a.sport === sport && a.distKm <= (MAX_KM[sport] ?? 1e9) && a.distKm > (best?.distKm ?? 0)) best = { distKm: a.distKm, date: a.date };
  return best ? { value: `${best.distKm.toFixed(best.distKm < 10 ? 2 : 1)} km`, date: best.date } : null;
}
/** Best sustained ride power, spike-robust: power-meter calibration glitches sit far above the bulk, so we
 *  take the best ride whose NP is within 1.25× the 90th percentile of all qualifying rides (this drops lone
 *  400W-type artifacts while keeping a genuine hard ride). See the dataQuality convention. */
function bestPower(acts) {
  const rides = acts.filter((a) => a.sport === "ride" && a.distKm >= 20 && a.np && a.np > 80 && a.np < 600);
  if (!rides.length) return null;
  const sorted = rides.map((a) => a.np).sort((x, y) => x - y);
  const p90 = sorted[Math.floor(0.9 * (sorted.length - 1))];
  const ceil = p90 * 1.25;
  let best = null;
  for (const a of rides) if (a.np <= ceil && a.np > (best?.np ?? 0)) best = { np: a.np, date: a.date };
  return best ? { value: `${Math.round(best.np)} W`, date: best.date } : null;
}

function inWindow(date, fromDate) {
  return date >= fromDate;
}

function buildBests(all, intervals, season) {
  const today = new Date();
  const d90 = new Date(today.getTime() - 90 * 86400000).toISOString().slice(0, 10);
  const seasonStart = `${season}-01-01`;
  const last90 = intervals.filter((a) => inWindow(a.date, d90));
  const seasonActs = intervals.filter((a) => a.date >= seasonStart);
  const cols = (fn) => ({ allTime: fn(all), last90: fn(last90), season: fn(seasonActs) });
  const row = (label, fn) => {
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
  const out = [];
  if (runRows.length) out.push({ sport: "Run", rows: runRows });
  if (bikeRows.length) out.push({ sport: "Bike", rows: bikeRows });
  if (swimRows.length) out.push({ sport: "Swim", rows: swimRows });
  return out;
}
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v));

/** Sample a single intervals power-curve list-item (parallel secs[]/values[]) at the standard durations. */
function sampleCurve(item) {
  const secs = item?.secs, vals = item?.values;
  if (!Array.isArray(secs) || !Array.isArray(vals)) return [];
  const out = [];
  for (const d of DURATIONS) {
    let idx = secs.indexOf(d);
    if (idx < 0) {
      idx = secs.findIndex((s) => s >= d); // nearest at-or-above
    }
    const w = idx >= 0 ? vals[idx] : undefined;
    if (Number.isFinite(w) && w > 0) out.push({ durationSec: d, watts: Math.round(w) });
  }
  return out;
}

function buildPower(powerJson, season) {
  const list = powerJson?.list;
  if (!Array.isArray(list) || !list.length) return undefined;
  const pick = (re) => list.find((it) => re.test(String(it.label ?? it.id ?? "").toLowerCase()));
  const allItem = pick(/all|ever|4000|10y|5y/) ?? pick(/year/) ?? list[0];
  const allTime = sampleCurve(allItem);
  if (!allTime.length) return undefined;
  const last90 = sampleCurve(pick(/90|6 ?w|42|month/) ?? {});
  const seasonItem = pick(new RegExp(String(season))) ?? pick(/season|ytd/);
  const seasonCurve = sampleCurve(seasonItem ?? {});
  const pc = { allTime };
  if (last90.length) pc.last90 = last90;
  if (seasonCurve.length) pc.season = seasonCurve;
  return pc;
}

function main() {
  const args = parseArgs();
  const season = Number(args.season ?? new Date().getFullYear());
  const out = resolve(typeof args.out === "string" ? args.out : "data/career-history.json");

  const intervals = args.intervals ? fromIntervals(readJson(args.intervals)) : [];
  const tp = args.tp ? fromTp(readCsv(args.tp)) : [];
  const all = [...tp, ...intervals].filter((a) => a.date);

  // races: --races file wins; else preserve races already in the output; else empty.
  let races = [];
  if (typeof args.races === "string") {
    const r = readJson(args.races);
    races = Array.isArray(r) ? r : Array.isArray(r?.races) ? r.races : [];
  } else if (existsSync(out)) {
    races = readJson(out)?.races ?? [];
  }

  const bests = all.length ? buildBests(all, intervals.length ? intervals : all, season) : [];
  const powerCurve = args.power ? buildPower(readJson(args.power), season) : undefined;

  // Year-by-year volume — prefer the longer-history source per year (TP for 2011-2014, intervals later),
  // so the Season page can benchmark "where am I now" against the all-time peak and the detraining troughs.
  const byYear = {};
  for (const src of [tp, intervals]) {
    const seen = {};
    for (const a of src) {
      const y = (a.date || "").slice(0, 4);
      if (!/^\d{4}$/.test(y)) continue;
      const d = (seen[y] ??= { hours: 0, km: 0 });
      if (a.durSec && a.durSec < 1200 * 60) d.hours += a.durSec / 3600;
      if (a.distKm && a.distKm < 2000) d.km += a.distKm;
    }
    for (const [y, d] of Object.entries(seen)) {
      // a source "wins" a year if it logged more hours there (deeper history for that year)
      if (!byYear[y] || d.hours > byYear[y].hours) byYear[y] = d;
    }
  }
  const trajectory = Object.entries(byYear)
    .map(([y, d]) => ({ year: Number(y), hours: Math.round(d.hours), km: Math.round(d.km) }))
    .filter((t) => t.year >= 2000 && t.year <= season + 1)
    .sort((a, b) => a.year - b.year);

  const result = { generatedAt: new Date().toISOString().slice(0, 10), seasonYear: season, races, bests };
  if (powerCurve) result.powerCurve = powerCurve;
  if (trajectory.length) result.trajectory = trajectory;

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(
    `wrote ${out}\n  races: ${races.length} | bests: ${bests.map((b) => `${b.sport}(${b.rows.length})`).join(", ") || "none"} | power: ${powerCurve ? powerCurve.allTime.length + "pts" : "none"} | trajectory: ${trajectory.length ? trajectory.length + "yrs" : "none"}`,
  );
}

main();
