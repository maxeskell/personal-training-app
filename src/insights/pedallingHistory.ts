/**
 * Pedalling-mechanics HISTORY: every ride with dual-sided pedal data, back through the whole archive.
 *
 * `analysePedalling` (fit.ts) reads one ride. The shim / cleat question needs the long view: is a L/R
 * offset fixed over months (structural), did it move after a cleat change or a fit, does platform centre
 * offset differ indoors vs out. This walks the cold activity archive (`data/activity-archive/`, filled by
 * `archive:backfill` / `archive:import` / auto-archive on sync) plus the hot `data/fit-streams/`, runs
 * `analysePedalling` on each ride, and keeps a compact per-ride row.
 *
 * Parsing thousands of .FITs is slow, so results are cached in `data/pedalling-history.json`, keyed by the
 * archive content hash (or name+size+mtime for a streams file). A re-run only parses new files; rides with
 * no pedal dynamics are cached as `null` so they're skipped too. Deterministic, no network, no LLM.
 * Degrade, don't crash: an unreadable file is skipped, a missing archive yields an empty history.
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { parseFit, type FitActivity } from "./fitParser.js";
import { analysePedalling, expandMultisportFit, fitStreamsDir, type PedallingAnalysis } from "./fit.js";
import { activityArchiveDir, loadManifest } from "../archive/activityArchive.js";

/** One ride's pedalling summary, small enough to keep for the whole history. */
export interface PedallingRide {
  date: string; // YYYY-MM-DD
  startTimeS: number | null; // dedups the same ride found in both the archive and fit-streams
  source: "archive" | "streams";
  /** Indoor trainer / virtual ride (FIT sub_sport 6 or 58): often a different power source to the pedals. */
  indoor: boolean;
  pedallingMin: number;
  avgPowerW: number | null;
  balanceLeftPct: number | null;
  /** High-power-tercile minus low-power-tercile left share: + = left takes more as load rises. */
  balanceLoadShiftPct: number | null;
  /** Last-quarter minus first-quarter left share: drift as the ride goes on. */
  balanceDriftPct: number | null;
  teLeft: number | null;
  teRight: number | null;
  psLeft: number | null;
  psRight: number | null;
  pcoLeftMm: number | null;
  pcoRightMm: number | null;
  phaseStartLeftDeg: number | null;
  phaseStartRightDeg: number | null;
  phaseArcLeftDeg: number | null;
  phaseArcRightDeg: number | null;
}

interface CacheFile {
  version: 1;
  rides: Record<string, PedallingRide | null>;
}

export function pedallingCachePath(): string {
  return join(config.dataDir, "pedalling-history.json");
}

const diff = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? +(a - b).toFixed(1) : null);

/** Flatten one ride's analysis into a history row. Pure. */
export function toPedallingRide(
  p: PedallingAnalysis,
  meta: { date: string; startTimeS: number | null; source: PedallingRide["source"]; indoor: boolean; avgPowerW: number | null },
): PedallingRide {
  const q = p.balanceByQuarter;
  return {
    ...meta,
    pedallingMin: p.pedallingMin,
    balanceLeftPct: p.balanceLeftPct,
    balanceLoadShiftPct: diff(p.balanceByPower[2]?.leftPct, p.balanceByPower[0]?.leftPct),
    balanceDriftPct: diff(q[3], q[0]),
    teLeft: p.torqueEffectivenessPct.left,
    teRight: p.torqueEffectivenessPct.right,
    psLeft: p.pedalSmoothnessPct.left,
    psRight: p.pedalSmoothnessPct.right,
    pcoLeftMm: p.platformCentreOffsetMm.left,
    pcoRightMm: p.platformCentreOffsetMm.right,
    phaseStartLeftDeg: p.powerPhase.left?.startDeg ?? null,
    phaseStartRightDeg: p.powerPhase.right?.startDeg ?? null,
    phaseArcLeftDeg: p.powerPhase.left?.arcDeg ?? null,
    phaseArcRightDeg: p.powerPhase.right?.arcDeg ?? null,
  };
}

/** Ride legs of a parsed file (a multisport race file yields its bike leg) → history rows. */
export function ridesFromFit(act: FitActivity, source: PedallingRide["source"]): PedallingRide[] {
  const out: PedallingRide[] = [];
  for (const leg of expandMultisportFit(act)) {
    if (!/ride/i.test(leg.sportName)) continue;
    const p = analysePedalling(leg.samples);
    if (!p) continue;
    const startTimeS = leg.samples.find((s) => s.t != null)?.t ?? null;
    const watts = leg.samples.map((s) => s.power).filter((w): w is number => typeof w === "number" && w > 0);
    out.push(
      toPedallingRide(p, {
        date: startTimeS != null ? new Date(startTimeS * 1000).toISOString().slice(0, 10) : "",
        startTimeS,
        source,
        indoor: leg.subSport === 6 || leg.subSport === 58,
        avgPowerW: watts.length ? Math.round(watts.reduce((a, b) => a + b, 0) / watts.length) : null,
      }),
    );
  }
  return out;
}

function loadCache(path: string): CacheFile {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (c.version === 1 && c.rides) return c;
  } catch {
    /* absent or corrupt → rebuild */
  }
  return { version: 1, rides: {} };
}

function saveCache(path: string, c: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, path); // atomic: a crash mid-write never leaves a half file
}

function parseFile(path: string): FitActivity | null {
  let buf = readFileSync(path);
  if (path.toLowerCase().endsWith(".gz")) buf = gunzipSync(buf);
  return parseFit(buf);
}

export interface HistoryBuild {
  rides: PedallingRide[];
  parsed: number; // files parsed this run (the rest came from the cache)
  scanned: number; // ride .FIT files considered
}

/**
 * Build (or refresh) the pedalling history. Multi-leg results are cached under `key#legN`. Rides found in
 * both stores are kept once (archive wins). Sorted by date ascending.
 */
export function buildPedallingHistory(
  opts: { archiveDir?: string; streamsDir?: string; cachePath?: string; onProgress?: (done: number, total: number) => void } = {},
): HistoryBuild {
  const archiveDir = opts.archiveDir ?? activityArchiveDir();
  const streamsDir = opts.streamsDir ?? fitStreamsDir();
  const cachePath = opts.cachePath ?? pedallingCachePath();
  const cache = loadCache(cachePath);

  const jobs: Array<{ key: string; path: string; source: PedallingRide["source"] }> = [];
  // Archive: ride (or undated/multisport "unknown") .FIT entries only; TCX/PWX carry no pedal dynamics.
  for (const e of loadManifest(archiveDir)) {
    if (e.format !== "fit" || !/ride|unknown|multi/i.test(e.sport)) continue;
    jobs.push({ key: `a:${e.contentHash}`, path: join(archiveDir, e.path), source: "archive" });
  }
  if (existsSync(streamsDir)) {
    for (const name of readdirSync(streamsDir)) {
      if (!/\.fit(\.gz)?$/i.test(name)) continue;
      const path = join(streamsDir, name);
      try {
        const st = statSync(path);
        jobs.push({ key: `s:${name}:${st.size}:${Math.round(st.mtimeMs)}`, path, source: "streams" });
      } catch {
        /* vanished mid-scan */
      }
    }
  }

  let parsed = 0;
  let sinceSave = 0;
  jobs.forEach((j, i) => {
    opts.onProgress?.(i + 1, jobs.length);
    if (j.key in cache.rides || `${j.key}#leg0` in cache.rides) return;
    let rows: PedallingRide[] = [];
    try {
      const act = parseFile(j.path);
      rows = act ? ridesFromFit(act, j.source) : [];
    } catch {
      rows = []; // unreadable → cached as "nothing here" so it isn't retried every run
    }
    parsed++;
    if (rows.length <= 1) cache.rides[j.key] = rows[0] ?? null;
    else rows.forEach((r, n) => (cache.rides[`${j.key}#leg${n}`] = r));
    if (++sinceSave >= 200) {
      saveCache(cachePath, cache); // checkpoint so a long first run can be interrupted and resumed
      sinceSave = 0;
    }
  });
  if (parsed) saveCache(cachePath, cache);

  // Only keys still present (a deleted streams file drops out), deduped on start time, archive first.
  const live = new Set(jobs.map((j) => j.key));
  const seen = new Set<number>();
  const rides: PedallingRide[] = [];
  const entries = Object.entries(cache.rides)
    .filter(([k, r]) => r != null && live.has(k.replace(/#leg\d+$/, "")))
    .map(([, r]) => r!)
    .sort((a, b) => (a.source === b.source ? 0 : a.source === "archive" ? -1 : 1));
  for (const r of entries) {
    if (r.startTimeS != null) {
      if (seen.has(r.startTimeS)) continue;
      seen.add(r.startTimeS);
    }
    rides.push(r);
  }
  rides.sort((a, b) => a.date.localeCompare(b.date));
  return { rides, parsed, scanned: jobs.length };
}

function median(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return +(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2).toFixed(1);
}

export interface PedallingPeriod {
  label: string; // "2026-03" or a window name
  rides: number;
  balanceLeftPct: number | null;
  balanceLoadShiftPct: number | null;
  balanceDriftPct: number | null;
  teLeft: number | null;
  teRight: number | null;
  pcoLeftMm: number | null;
  pcoRightMm: number | null;
  phaseArcLeftDeg: number | null;
  phaseArcRightDeg: number | null;
}

function period(label: string, rs: PedallingRide[]): PedallingPeriod {
  return {
    label,
    rides: rs.length,
    balanceLeftPct: median(rs.map((r) => r.balanceLeftPct)),
    balanceLoadShiftPct: median(rs.map((r) => r.balanceLoadShiftPct)),
    balanceDriftPct: median(rs.map((r) => r.balanceDriftPct)),
    teLeft: median(rs.map((r) => r.teLeft)),
    teRight: median(rs.map((r) => r.teRight)),
    pcoLeftMm: median(rs.map((r) => r.pcoLeftMm)),
    pcoRightMm: median(rs.map((r) => r.pcoRightMm)),
    phaseArcLeftDeg: median(rs.map((r) => r.phaseArcLeftDeg)),
    phaseArcRightDeg: median(rs.map((r) => r.phaseArcRightDeg)),
  };
}

/** Rides shorter than this are too noisy to read mechanics from (a spin-up, a commute). */
export const MIN_RIDE_MIN = 20;

/**
 * Month-by-month medians (median, not mean: one odd ride or a sensor glitch can't move a month), plus
 * indoor vs outdoor (different power sources can read differently) and an optional before/after split
 * around a date (a cleat change, a shim, a bike fit). Pure.
 */
export function summarisePedallingHistory(
  rides: PedallingRide[],
  opts: { from?: string; to?: string; splitAt?: string; indoor?: "all" | "indoor" | "outdoor" } = {},
): { months: PedallingPeriod[]; indoor: PedallingPeriod; outdoor: PedallingPeriod; before?: PedallingPeriod; after?: PedallingPeriod; total: number } {
  const rs = rides.filter(
    (r) =>
      r.pedallingMin >= MIN_RIDE_MIN &&
      (!opts.from || r.date >= opts.from) &&
      (!opts.to || r.date <= opts.to) &&
      (!opts.indoor || opts.indoor === "all" || (opts.indoor === "indoor") === r.indoor),
  );
  const byMonth = new Map<string, PedallingRide[]>();
  for (const r of rs) {
    const m = r.date.slice(0, 7) || "undated";
    byMonth.set(m, [...(byMonth.get(m) ?? []), r]);
  }
  return {
    months: [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([m, x]) => period(m, x)),
    indoor: period("indoor", rs.filter((r) => r.indoor)),
    outdoor: period("outdoor", rs.filter((r) => !r.indoor)),
    ...(opts.splitAt
      ? { before: period(`before ${opts.splitAt}`, rs.filter((r) => r.date < opts.splitAt!)), after: period(`from ${opts.splitAt}`, rs.filter((r) => r.date >= opts.splitAt!)) }
      : {}),
    total: rs.length,
  };
}

const f = (v: number | null, unit = "") => (v == null ? "—" : `${v}${unit}`);
const pair = (l: number | null, r: number | null, unit = "") => (l == null && r == null ? "—" : `${f(l, unit)}/${f(r, unit)}`);

function row(p: PedallingPeriod): string {
  return `  ${p.label.padEnd(16)} ${String(p.rides).padStart(4)}  bal ${f(p.balanceLeftPct, "%").padEnd(6)} load ${f(p.balanceLoadShiftPct).padEnd(5)} drift ${f(p.balanceDriftPct).padEnd(5)} TE ${pair(p.teLeft, p.teRight).padEnd(10)} PCO ${pair(p.pcoLeftMm, p.pcoRightMm, "mm").padEnd(13)} arc ${pair(p.phaseArcLeftDeg, p.phaseArcRightDeg, "°")}`;
}

/** Human/LLM-readable report of the history summary. */
export function formatPedallingHistory(s: ReturnType<typeof summarisePedallingHistory>, build?: Pick<HistoryBuild, "parsed" | "scanned">): string[] {
  const out = [
    `PEDALLING HISTORY [.FIT archive + fit-streams; rides ≥${MIN_RIDE_MIN} min with dual-sided pedal data; monthly MEDIANS]`,
    ...(build ? [`  ${build.scanned} ride files scanned, ${build.parsed} parsed this run (the rest cached)`] : []),
  ];
  if (!s.total) {
    out.push(
      "  No rides with pedal dynamics found. Single-sided meters and most trainers don't record them; if your history",
      "  isn't archived yet, run `npm run archive:backfill` to pull your Garmin .FITs into data/activity-archive/.",
    );
    return out;
  }
  out.push(
    "  Key: bal = left share (50 = even) · load = high-power minus low-power left share · drift = last quarter minus first",
    "       TE = torque effectiveness L/R % · PCO = platform centre offset L/R (+ outboard) · arc = power-phase arc L/R",
    "",
    ...s.months.map(row),
    "",
    row(s.outdoor),
    row(s.indoor),
  );
  if (s.before && s.after) out.push("", row(s.before), row(s.after));
  out.push(
    "",
    "  Reading it: a balance offset that holds month after month, at every load, is structural (leg length / strength:",
    "  the shim question). One that moves with load or drifts late is fitness or fatigue. PCO is the cleat-position",
    "  signal. Indoor and outdoor can use different power sources, so compare like with like. A MODEL summary: medians",
    "  of per-ride averages, not a calibrated measurement.",
  );
  return out;
}
