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
  /** Garmin activity id when the file name carries one (joins to Garmin Connect gear = which bike). */
  activityId?: string;
  /** Bike-identifying sensors paired on this ride ("<ANT+ type>:<id>"), for inferring untagged rides' bike. */
  sensors?: string[];
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

/** Bump when the per-ride rows change so cached rows are re-parsed (2: single-sided 0s are "no data"). */
export const PEDALLING_ENGINE_VERSION = 4; // 3: rows carry activityId; 4: + bike-identifying sensors

interface CacheFile {
  version: number;
  rides: Record<string, PedallingRide | null>;
}

export function pedallingCachePath(): string {
  return join(config.dataDir, "pedalling-history.json");
}

const diff = (a: number | null | undefined, b: number | null | undefined) => (a != null && b != null ? +(a - b).toFixed(1) : null);

/** Flatten one ride's analysis into a history row. Pure. */
export function toPedallingRide(
  p: PedallingAnalysis,
  meta: { activityId?: string; sensors?: string[]; date: string; startTimeS: number | null; source: PedallingRide["source"]; indoor: boolean; avgPowerW: number | null },
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
/**
 * ANT+ device types that belong to a BIKE rather than the rider: power (11), fitness equipment / smart
 * trainer (17), e-bike (20), electronic shifting (34), lights (35/36), radar (40), aero sensor (46) and
 * speed/cadence (121–123). Heart-rate straps, footpods and the like travel with the rider, so they're left out.
 */
const BIKE_SENSOR_TYPES = new Set([11, 17, 20, 34, 35, 36, 40, 46, 121, 122, 123]);

/** A ride file's bike-identifying sensors as sorted "<type>:<id>" keys. Pure — exported for tests. */
export function bikeSensors(act: Pick<FitActivity, "devices">): string[] {
  const keys = new Set<string>();
  for (const d of act.devices ?? []) {
    const id = d.antId ?? d.serial;
    if (d.deviceType != null && BIKE_SENSOR_TYPES.has(d.deviceType) && id != null && id !== 0) keys.add(`${d.deviceType}:${id}`);
  }
  return [...keys].sort();
}

export function ridesFromFit(act: FitActivity, source: PedallingRide["source"], activityId?: string): PedallingRide[] {
  const out: PedallingRide[] = [];
  const sensors = bikeSensors(act);
  for (const leg of expandMultisportFit(act)) {
    if (!/ride/i.test(leg.sportName)) continue;
    const p = analysePedalling(leg.samples);
    if (!p) continue;
    const startTimeS = leg.samples.find((s) => s.t != null)?.t ?? null;
    const watts = leg.samples.map((s) => s.power).filter((w): w is number => typeof w === "number" && w > 0);
    out.push(
      toPedallingRide(p, {
        ...(activityId ? { activityId } : {}),
        ...(sensors.length ? { sensors } : {}),
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
    if (c.version === PEDALLING_ENGINE_VERSION && c.rides) return c;
  } catch {
    /* absent or corrupt → rebuild */
  }
  return { version: PEDALLING_ENGINE_VERSION, rides: {} };
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

  const jobs: Array<{ key: string; path: string; source: PedallingRide["source"]; activityId?: string }> = [];
  // Archive: ride (or undated/multisport "unknown") .FIT entries only; TCX/PWX carry no pedal dynamics.
  for (const e of loadManifest(archiveDir)) {
    if (e.format !== "fit" || !/ride|unknown|multi/i.test(e.sport)) continue;
    jobs.push({ key: `a:${e.contentHash}`, path: join(archiveDir, e.path), source: "archive", activityId: /^\d+$/.test(e.id) ? e.id : undefined });
  }
  if (existsSync(streamsDir)) {
    for (const name of readdirSync(streamsDir)) {
      if (!/\.fit(\.gz)?$/i.test(name)) continue;
      const path = join(streamsDir, name);
      try {
        const st = statSync(path);
        const id = /^(\d+)/.exec(name)?.[1];
        jobs.push({ key: `s:${name}:${st.size}:${Math.round(st.mtimeMs)}`, path, source: "streams", activityId: id });
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
      rows = act ? ridesFromFit(act, j.source, j.activityId) : [];
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

export interface BikeInference {
  /** activityId (or row index, for rows without one) → bike, with how it was decided. */
  bikeOf: (r: PedallingRide) => { bike: string; how: "tagged" | "inferred" | "unknown" };
  /** Sensor groups seen on untagged rides that no tagged ride shares: a bike nobody has named yet. */
  unlabelled: Array<{ sensors: string; rides: number; from: string; to: string }>;
}

/** Purity a sensor needs to vote (share of its tagged rides on one bike), and the vote share to call a ride. */
const INFER_MIN_SHARE = 0.8;
const INFER_MIN_PURITY = 0.9;

/**
 * Infer untagged rides' bike from the sensors they paired, learning each sensor's bike from the rides that
 * ARE tagged in Garmin Connect. Only decisive sensors vote: ones ≥90% tied to one bike (a speed sensor, a
 * groupset, a radar). Sensors shared across bikes (power pedals swapped between bikes) are ignored. A ride is
 * called when ≥80% of its decisive sensors agree; otherwise it stays unknown. Tagged rides always keep their
 * tag. Pure — exported for tests.
 */
export function inferBikes(rides: PedallingRide[], gearById?: Map<string, string | null>): BikeInference {
  const tagOf = (r: PedallingRide) => (r.activityId ? gearById?.get(r.activityId) ?? null : null);
  const counts = new Map<string, Map<string, number>>(); // sensor → bike → rides
  for (const r of rides) {
    const bike = tagOf(r);
    if (!bike) continue;
    for (const s of r.sensors ?? []) {
      const m = counts.get(s) ?? new Map<string, number>();
      m.set(bike, (m.get(bike) ?? 0) + 1);
      counts.set(s, m);
    }
  }
  const cache = new Map<PedallingRide, { bike: string; how: "tagged" | "inferred" | "unknown" }>();
  const decide = (r: PedallingRide): { bike: string; how: "tagged" | "inferred" | "unknown" } => {
    const tag = tagOf(r);
    if (tag) return { bike: tag, how: "tagged" };
    // Only DECISIVE sensors vote: ones ≥90% tied to a single bike in the tagged rides. Shared sensors (power
    // pedals moved between bikes) carry no information about which bike this was, so they're ignored.
    const votes = new Map<string, number>();
    for (const s of r.sensors ?? []) {
      const m = counts.get(s);
      if (!m) continue;
      const total = [...m.values()].reduce((a, b) => a + b, 0);
      const [bike, n] = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      if (n / total >= INFER_MIN_PURITY) votes.set(bike, (votes.get(bike) ?? 0) + 1);
    }
    const sum = [...votes.values()].reduce((a, b) => a + b, 0);
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] / sum >= INFER_MIN_SHARE) return { bike: best[0], how: "inferred" };
    return { bike: "unassigned", how: "unknown" };
  };
  const bikeOf = (r: PedallingRide) => {
    let v = cache.get(r);
    if (!v) cache.set(r, (v = decide(r)));
    return v;
  };
  const groups = new Map<string, { rides: number; from: string; to: string }>();
  for (const r of rides) {
    if (bikeOf(r).how !== "unknown") continue;
    const unseen = (r.sensors ?? []).filter((s) => !counts.has(s));
    if (!unseen.length) continue;
    const key = unseen.join(" + ");
    const g = groups.get(key) ?? { rides: 0, from: r.date, to: r.date };
    g.rides++;
    if (r.date < g.from) g.from = r.date;
    if (r.date > g.to) g.to = r.date;
    groups.set(key, g);
  }
  const unlabelled = [...groups.entries()].map(([sensors, g]) => ({ sensors, ...g })).sort((a, b) => b.rides - a.rides);
  return { bikeOf, unlabelled };
}

/** ANT+ device-type names for the unlabelled-sensor hint. */
const SENSOR_NAMES: Record<string, string> = { "11": "power", "17": "trainer", "20": "e-bike", "34": "shifting", "35": "light", "36": "light", "40": "radar", "46": "aero", "121": "speed/cad", "122": "cadence", "123": "speed" };
export function describeSensors(keys: string): string {
  return keys
    .split(" + ")
    .map((k) => {
      const [t, id] = k.split(":");
      return `${SENSOR_NAMES[t] ?? `type ${t}`} #${id}`;
    })
    .join(" + ");
}

/**
 * Month-by-month medians (median, not mean: one odd ride or a sensor glitch can't move a month), plus
 * indoor vs outdoor (different power sources can read differently) and an optional before/after split
 * around a date (a cleat change, a shim, a bike fit). Pure.
 */
export function summarisePedallingHistory(
  rides: PedallingRide[],
  opts: {
    from?: string;
    to?: string;
    splitAt?: string;
    indoor?: "all" | "indoor" | "outdoor";
    /** Only rides on this bike (case-insensitive substring of the Garmin Connect gear name). */
    bike?: string;
    /** activityId → Garmin Connect gear name (null = none assigned), from the activity-gear archive. */
    gearById?: Map<string, string | null>;
  } = {},
): {
  months: PedallingPeriod[];
  indoor: PedallingPeriod;
  outdoor: PedallingPeriod;
  byBike: PedallingPeriod[];
  before?: PedallingPeriod;
  after?: PedallingPeriod;
  total: number;
  bikeFilter?: string;
  gearKnown: boolean;
  bikeSources: { tagged: number; inferred: number; unknown: number };
  unlabelled: BikeInference["unlabelled"];
} {
  const inf = inferBikes(rides, opts.gearById);
  const bikeOf = (r: PedallingRide) => inf.bikeOf(r).bike;
  const rs = rides.filter(
    (r) =>
      r.pedallingMin >= MIN_RIDE_MIN &&
      (!opts.bike || bikeOf(r).toLowerCase().includes(opts.bike.toLowerCase())) &&
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
    byBike: [...new Set(rs.map(bikeOf))].sort().map((b) => period(b.slice(0, 16), rs.filter((r) => bikeOf(r) === b))),
    bikeFilter: opts.bike,
    gearKnown: !!opts.gearById?.size,
    bikeSources: {
      tagged: rs.filter((r) => inf.bikeOf(r).how === "tagged").length,
      inferred: rs.filter((r) => inf.bikeOf(r).how === "inferred").length,
      unknown: rs.filter((r) => inf.bikeOf(r).how === "unknown").length,
    },
    unlabelled: inf.unlabelled,
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
    `PEDALLING HISTORY [.FIT archive + fit-streams; rides ≥${MIN_RIDE_MIN} min with dual-sided pedal data; monthly MEDIANS]${s.bikeFilter ? ` — bike: ${s.bikeFilter}` : ""}`,
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
    "",
    s.gearKnown
      ? `  By bike${s.bikeFilter ? ` — filtered to "${s.bikeFilter}"` : ""}: ${s.bikeSources.tagged} tagged in Garmin Connect, ${s.bikeSources.inferred} inferred from paired sensors (MODEL), ${s.bikeSources.unknown} unknown`
      : "  By bike: unknown — run `npm run archive:gear` once to tag each ride with its Garmin Connect bike, then filter with --bike <name>.",
    ...(s.gearKnown ? s.byBike.map(row) : []),
    ...(s.gearKnown && s.unlabelled.length
      ? [
          "  Sensors on untagged rides that match no tagged bike (tag ONE such ride in Garmin Connect, then",
          "  `npm run archive:gear -- --recheck`, and every ride with these sensors is inferred):",
          ...s.unlabelled.slice(0, 5).map((u) => `    ${describeSensors(u.sensors)} — ${u.rides} ride(s), ${u.from} → ${u.to}`),
        ]
      : []),
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
