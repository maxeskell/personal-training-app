/**
 * Efficiency & performance HISTORY: walks the activity archive + fit-streams (like pedallingHistory.ts),
 * runs `analysePerformance` on every ride and run, caches one small row per file, and summarises:
 *
 *  - **Output at a fixed HR** — bike watts / run grade-adjusted pace at a reference HR, per session, with a
 *    trend, a heat correction when (and only when) your own data shows a heat effect, and indoor/outdoor
 *    kept apart (different power sources).
 *  - **Critical power** — from the last 90 days' best 3–20 min efforts (work–time model), with a check for
 *    whether those efforts look maximal.
 *  - **Durability** — best 5 / 20-min power after 1500 / 2500 kJ vs fresh.
 *  - **Aerobic threshold (DFA-α1)** — HR and output where α1 crosses 0.75, per session, trended.
 *
 * Every metric carries a confidence grade and the specific things that would raise it: the page shows
 * both. Deterministic, no network, no LLM. Cache: `data/performance-history.json` (versioned, so a change
 * to the maths re-parses rather than mixing old and new rows).
 */

import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { parseFit } from "./fitParser.js";
import { expandMultisportFit, fitStreamsDir } from "./fit.js";
import { analysePerformance, fitLine, MMP_DURATIONS, FATIGUE_KJ, type SessionPerformance } from "./performance.js";
import { activityArchiveDir, loadManifest } from "../archive/activityArchive.js";
import { mean, mlr2 } from "./stats.js";

/** Bump when the per-session maths changes: old cached rows are then ignored and files re-parsed. */
export const PERFORMANCE_ENGINE_VERSION = 1;

interface CacheFile {
  version: number;
  rows: Record<string, SessionPerformance[]>; // file key → its sessions (0, 1, or several legs)
}

export function performanceCachePath(): string {
  return join(config.dataDir, "performance-history.json");
}

function loadCache(path: string): CacheFile {
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    if (c.version === PERFORMANCE_ENGINE_VERSION && c.rows) return c;
  } catch {
    /* absent / corrupt → rebuild */
  }
  return { version: PERFORMANCE_ENGINE_VERSION, rows: {} };
}

function saveCache(path: string, c: CacheFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c));
  renameSync(tmp, path);
}

export interface PerformanceBuild {
  sessions: SessionPerformance[];
  parsed: number;
  scanned: number;
  /** Files still waiting to be parsed (only when `maxParse` capped this run). */
  pending: number;
}

/**
 * Build or refresh the history. `maxParse` caps how many NEW files this call parses (the dashboard page
 * passes a small number so a request never blocks on a whole-archive parse; the CLI passes none).
 */
export function buildPerformanceHistory(
  opts: { archiveDir?: string; streamsDir?: string; cachePath?: string; maxParse?: number; onProgress?: (done: number, total: number) => void } = {},
): PerformanceBuild {
  const archiveDir = opts.archiveDir ?? activityArchiveDir();
  const streamsDir = opts.streamsDir ?? fitStreamsDir();
  const cachePath = opts.cachePath ?? performanceCachePath();
  const cache = loadCache(cachePath);
  const jobs: Array<{ key: string; path: string }> = [];
  for (const e of loadManifest(archiveDir)) {
    if (e.format !== "fit" || !/ride|run|unknown|multi/i.test(e.sport)) continue;
    jobs.push({ key: `a:${e.contentHash}`, path: join(archiveDir, e.path) });
  }
  if (existsSync(streamsDir)) {
    for (const name of readdirSync(streamsDir)) {
      if (!/\.fit(\.gz)?$/i.test(name)) continue;
      const path = join(streamsDir, name);
      try {
        const st = statSync(path);
        jobs.push({ key: `s:${name}:${st.size}:${Math.round(st.mtimeMs)}`, path });
      } catch {
        /* vanished */
      }
    }
  }
  let parsed = 0;
  let pending = 0;
  let sinceSave = 0;
  jobs.forEach((j, i) => {
    opts.onProgress?.(i + 1, jobs.length);
    if (j.key in cache.rows) return;
    if (opts.maxParse != null && parsed >= opts.maxParse) {
      pending++;
      return;
    }
    let rows: SessionPerformance[] = [];
    try {
      let buf = readFileSync(j.path);
      if (j.path.toLowerCase().endsWith(".gz")) buf = gunzipSync(buf);
      const act = parseFit(buf);
      if (act) {
        const legs = expandMultisportFit(act);
        // A multisport race leg loses its RR stream in the split; the race still gives steady + MMP reads.
        rows = legs.map((l) => analysePerformance(legs.length === 1 ? act : l)).filter((r): r is SessionPerformance => r != null);
      }
    } catch {
      rows = [];
    }
    cache.rows[j.key] = rows;
    parsed++;
    if (++sinceSave >= 200) {
      saveCache(cachePath, cache);
      sinceSave = 0;
    }
  });
  if (parsed) saveCache(cachePath, cache);
  const live = new Set(jobs.map((j) => j.key));
  const seen = new Set<string>();
  const sessions: SessionPerformance[] = [];
  // Archive keys first, so a ride present in both stores keeps the archive copy.
  const keys = Object.keys(cache.rows).filter((k) => live.has(k)).sort((a, b) => (a[0] === b[0] ? 0 : a[0] === "a" ? -1 : 1));
  for (const k of keys) {
    for (const r of cache.rows[k]) {
      const id = `${r.kind}:${r.startTimeS ?? `${k}:${r.date}`}`;
      if (seen.has(id)) continue;
      seen.add(id);
      sessions.push(r);
    }
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { sessions, parsed, scanned: jobs.length, pending };
}

/* ───────────────────────── summaries ───────────────────────── */

export type Confidence = "none" | "low" | "moderate" | "high";

export interface SeriesPoint {
  date: string;
  value: number;
  tempC: number | null;
}

export interface FixedHrSummary {
  key: "bike-outdoor" | "bike-indoor" | "run";
  label: string;
  unit: "W" | "min/km";
  refHr: number | null;
  refHrSource: "setting" | "your typical steady HR" | null;
  /** Per-session values at refHr (heat-corrected when heatAdjusted). Runs are stored as m/s; the page formats pace. */
  points: SeriesPoint[];
  sessionsWithFit: number; // sessions that had a steady fit at all (some don't cover refHr)
  heatAdjusted: boolean;
  heatPerDegPct: number | null; // % change in output per +1°C, when detected
  /** Trend, % per 30 days, holding temperature constant when heat-adjusted; with a 95% CI. */
  trendPctPer30d: number | null;
  trendCiPct: number | null;
  recent: number | null; // median of the last 28 days' sessions
  confidence: Confidence;
  why: string[];
  improve: string[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const daysBetween = (a: string, b: string) => (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000;

/** Simple OLS slope with its standard error (for the trend when no heat term is used). */
function slopeSe(xs: number[], ys: number[]): { b: number; se: number } | null {
  const n = xs.length;
  if (n < 4) return null;
  const mx = mean(xs)!, my = mean(ys)!;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  const a = my - b * mx;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (ys[i] - (a + b * xs[i])) ** 2;
  return { b, se: Math.sqrt(sse / (n - 2) / sxx) };
}

/**
 * Output-at-fixed-HR series for one stream of sessions. The reference HR is the setting if given, else the
 * median midpoint of your own steady HR ranges (so most sessions cover it). A session only contributes when
 * the reference HR sits inside the HR range it actually rode/ran (±3 bpm): no extrapolation.
 */
export function fixedHrSeries(
  sessions: SessionPerformance[],
  key: FixedHrSummary["key"],
  opts: { refHr?: number; today: string; windowDays?: number },
): FixedHrSummary {
  const label = key === "bike-outdoor" ? "Bike power at a fixed HR (outdoor)" : key === "bike-indoor" ? "Bike power at a fixed HR (indoor)" : "Run grade-adjusted pace at a fixed HR";
  const unit = key === "run" ? "min/km" : "W";
  const from = opts.windowDays ? new Date(Date.parse(`${opts.today}T00:00:00Z`) - opts.windowDays * 86400000).toISOString().slice(0, 10) : "";
  const pool = sessions.filter(
    (s) => s.steady && s.date >= from && (key === "run" ? s.kind === "run" : s.kind === "ride" && s.indoor === (key === "bike-indoor")),
  );
  const mids = pool.map((s) => (s.steady!.fit.xLo + s.steady!.fit.xHi) / 2);
  const refHr = opts.refHr ?? (mids.length ? Math.round(median(mids)!) : null);
  const refHrSource: FixedHrSummary["refHrSource"] = opts.refHr != null ? "setting" : refHr != null ? "your typical steady HR" : null;
  const raw: SeriesPoint[] = [];
  if (refHr != null) {
    for (const s of pool) {
      const f = s.steady!.fit;
      if (refHr < f.xLo - 3 || refHr > f.xHi + 3) continue;
      const v = f.intercept + f.slope * refHr;
      if (v > 0) raw.push({ date: s.date, value: v, tempC: s.avgTempC });
    }
  }
  // Heat: fit value ~ temperature + time on the sessions that logged temperature. Correct for heat only if
  // the temperature coefficient's 95% CI excludes zero; otherwise leave values raw and say so.
  const t0 = raw[0]?.date ?? opts.today;
  const withT = raw.filter((p) => p.tempC != null);
  const heat = withT.length >= 10 ? mlr2(withT.map((p) => p.value), withT.map((p) => p.tempC!), withT.map((p) => daysBetween(t0, p.date))) : null;
  const heatDetected = !!heat && Math.abs(heat.b1) > 1.96 * heat.seB1;
  const medT = median(withT.map((p) => p.tempC!)) ?? 0;
  const points = raw.map((p) => (heatDetected && p.tempC != null ? { ...p, value: p.value - heat!.b1 * (p.tempC - medT) } : p));
  const meanV = mean(points.map((p) => p.value)) ?? 0;
  let trend: { b: number; se: number } | null = null;
  if (heatDetected) trend = { b: heat!.b2, se: heat!.seB2 };
  else trend = slopeSe(points.map((p) => daysBetween(t0, p.date)), points.map((p) => p.value));
  const toPct = (v: number) => (meanV ? (v / meanV) * 100 : 0);
  const trendPctPer30d = trend ? +toPct(trend.b * 30).toFixed(1) : null;
  const trendCiPct = trend ? +toPct(1.96 * trend.se * 30).toFixed(1) : null;
  const recentFrom = new Date(Date.parse(`${opts.today}T00:00:00Z`) - 28 * 86400000).toISOString().slice(0, 10);
  const recentVals = points.filter((p) => p.date >= recentFrom).map((p) => p.value);
  const span = points.length >= 2 ? daysBetween(points[0].date, points[points.length - 1].date) : 0;
  const ciExcludesZero = trendPctPer30d != null && trendCiPct != null && Math.abs(trendPctPer30d) > trendCiPct;

  const why: string[] = [];
  const improve: string[] = [];
  let confidence: Confidence;
  if (points.length < 4) {
    confidence = "none";
    why.push(`${points.length} session(s) with a usable steady section at ${refHr ?? "—"} bpm (need at least 4 for a value, 8+ for a trend).`);
  } else if (points.length < 8 || span < 28) {
    confidence = "low";
    why.push(`Only ${points.length} sessions over ${Math.round(span)} days.`);
  } else if (points.length >= 20 && span >= 56 && ciExcludesZero) {
    confidence = "high";
    why.push(`${points.length} sessions over ${Math.round(span)} days and the trend's uncertainty range excludes zero.`);
  } else {
    confidence = "moderate";
    why.push(`${points.length} sessions over ${Math.round(span)} days${ciExcludesZero ? "" : "; the trend is within its noise (could be flat)"}.`);
  }
  why.push(heatDetected ? `Heat-corrected: your data shows ${toPct(heat!.b1).toFixed(1)}% output per +1°C.` : withT.length >= 10 ? "No heat effect detectable in your data, so values are uncorrected." : "Too few sessions with temperature to test for a heat effect; values are uncorrected.");
  if (key !== "run") why.push("Only like-for-like power: indoor and outdoor are separate series (different power meters can read a few % apart).");
  if (key === "run") why.push("Pace is grade-adjusted with Minetti's running-cost curve (a MODEL); trail/technical ground and wind still add noise.");
  if (points.length < 20) improve.push(`More steady sessions at ${refHr ?? "your usual"} bpm: hold one effort for 20+ min after a 10-min warm-up, no surges. Target 20+ sessions over 8+ weeks.`);
  if (pool.length > points.length + 2) improve.push(`${pool.length - points.length} sessions had steady sections but didn't reach ${refHr} bpm; ride/run some steady time right at that HR, or set COACH_EFF_REF_HR_${key === "run" ? "RUN" : "BIKE"} to the HR you usually hold.`);
  improve.push("Same conditions each time: a repeatable route or the trainer, similar time of day, fed and rested.");
  if (key !== "run") improve.push("Use the same power meter for this series. Do the Rally-on-Atom offset test to compare indoor and outdoor directly.");
  if (!heatDetected) improve.push("Make sure the watch records temperature so heat can be tested and corrected.");
  if (key === "run") improve.push("Flat, road or track routes reduce the grade-adjustment error.");
  return {
    key,
    label,
    unit,
    refHr,
    refHrSource,
    points: points.map((p) => ({ ...p, value: +p.value.toFixed(key === "run" ? 3 : 1) })),
    sessionsWithFit: pool.length,
    heatAdjusted: heatDetected,
    heatPerDegPct: heatDetected ? +toPct(heat!.b1).toFixed(2) : null,
    trendPctPer30d,
    trendCiPct,
    recent: recentVals.length ? +median(recentVals)!.toFixed(key === "run" ? 3 : 0) : null,
    confidence,
    why,
    improve,
  };
}

export interface CpSummary {
  cpW: number | null;
  wPrimeKj: number | null;
  r2: number | null;
  points: Array<{ durationS: number; watts: number; date: string }>;
  /** Best 3-min ÷ best 20-min power: true maximal efforts usually sit ~1.15–1.4; below 1.1 = likely submaximal. */
  p3OverP20: number | null;
  confidence: Confidence;
  why: string[];
  improve: string[];
}

/** Critical power from the window's best 3/5/10/20-min efforts: work = CP·t + W′ (linear work–time model). */
export function criticalPower(sessions: SessionPerformance[], opts: { today: string; windowDays?: number }): CpSummary {
  const days = opts.windowDays ?? 90;
  const from = new Date(Date.parse(`${opts.today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const rides = sessions.filter((s) => s.kind === "ride" && s.mmp && s.date >= from);
  const points: CpSummary["points"] = [];
  for (const d of MMP_DURATIONS) {
    let best: { watts: number; date: string } | null = null;
    for (const r of rides) {
      const w = r.mmp!.fresh[d];
      if (w != null && (!best || w > best.watts)) best = { watts: w, date: r.date };
    }
    if (best) points.push({ durationS: d, ...best });
  }
  const why: string[] = [];
  const improve: string[] = [];
  const p3 = points.find((p) => p.durationS === 180)?.watts;
  const p20 = points.find((p) => p.durationS === 1200)?.watts;
  const ratio = p3 && p20 ? +(p3 / p20).toFixed(2) : null;
  if (points.length < 3) {
    return {
      cpW: null, wPrimeKj: null, r2: null, points, p3OverP20: ratio, confidence: "none",
      why: [`Not enough rides with power in the last ${days} days.`],
      improve: ["Ride with a power meter; include hard efforts of 3, 5, 10 and 20 minutes within a 90-day window."],
    };
  }
  const fit = fitLine(points.map((p) => p.durationS), points.map((p) => p.watts * p.durationS));
  const cpW = fit ? Math.round(fit.slope) : null;
  const wPrimeKj = fit ? +(fit.intercept / 1000).toFixed(1) : null;
  const sources = new Set(points.map((p) => p.date)).size;
  let confidence: Confidence = "moderate";
  if (ratio != null && ratio < 1.1) {
    confidence = "low";
    why.push(`Your best 3-min is only ${ratio}× your best 20-min, which suggests these weren't all-out efforts (normal for a base phase). CP is likely UNDERESTIMATED.`);
  }
  if (wPrimeKj != null && (wPrimeKj < 5 || wPrimeKj > 40)) {
    confidence = "low";
    why.push(`W′ of ${wPrimeKj} kJ is outside the usual 5–40 kJ range, another sign the efforts weren't maximal.`);
  }
  if (sources < 2) why.push("All the best efforts come from one ride.");
  if (confidence === "moderate" && fit && fit.r2 > 0.995 && sources >= 3) {
    confidence = "high";
    why.push(`Clean fit (R² ${fit.r2.toFixed(3)}) from ${sources} different rides.`);
  } else if (confidence === "moderate") {
    why.push(`Fit R² ${fit?.r2.toFixed(3) ?? "—"} from ${sources} ride(s).`);
  }
  why.push("CP is a MODEL estimate of threshold, usually close to (often a little above) a 60-min FTP. Not a replacement for a lab test.");
  improve.push("Do genuinely maximal efforts at 3 and 12–20 minutes on fresh legs, ideally on different days, within the same 90 days (e.g. a 3-min and a 12-min test a few days apart).");
  improve.push("Use the same power meter for all test efforts.");
  return { cpW, wPrimeKj, r2: fit ? +fit.r2.toFixed(4) : null, points, p3OverP20: ratio, confidence, why, improve };
}

export interface DurabilitySummary {
  rows: Array<{ kj: number; rides: number; p300: number | null; p1200: number | null; p300Pct: number | null; p1200Pct: number | null }>;
  fresh300: number | null;
  fresh1200: number | null;
  confidence: Confidence;
  why: string[];
  improve: string[];
}

/** Best 5 / 20-min power after 1500 and 2500 kJ, as a % of the window's fresh best. */
export function durability(sessions: SessionPerformance[], opts: { today: string; windowDays?: number }): DurabilitySummary {
  const days = opts.windowDays ?? 90;
  const from = new Date(Date.parse(`${opts.today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  const rides = sessions.filter((s) => s.kind === "ride" && s.mmp && s.date >= from);
  const best = (vals: Array<number | null | undefined>) => {
    const v = vals.filter((x): x is number => x != null);
    return v.length ? Math.max(...v) : null;
  };
  const fresh300 = best(rides.map((r) => r.mmp!.fresh[300]));
  const fresh1200 = best(rides.map((r) => r.mmp!.fresh[1200]));
  const pct = (a: number | null, b: number | null) => (a != null && b ? +((a / b) * 100).toFixed(0) : null);
  const rows = FATIGUE_KJ.map((kj) => {
    const reached = rides.filter((r) => r.mmp!.totalKj >= kj);
    const p300 = best(reached.map((r) => r.mmp!.afterKj[kj]?.p300));
    const p1200 = best(reached.map((r) => r.mmp!.afterKj[kj]?.p1200));
    return { kj, rides: reached.length, p300, p1200, p300Pct: pct(p300, fresh300), p1200Pct: pct(p1200, fresh1200) };
  });
  const why: string[] = [];
  const improve: string[] = [];
  const longRides = rows[0].rides;
  const confidence: Confidence = longRides === 0 ? "none" : longRides < 3 ? "low" : rows.some((r) => r.p1200Pct == null) ? "moderate" : longRides >= 6 ? "high" : "moderate";
  why.push(`${longRides} ride(s) in the last ${days} days passed 1500 kJ (≈2.5–3 h at endurance pace); ${rows[1].rides} passed 2500 kJ.`);
  why.push("A low % can mean you faded, or simply that you never rode hard late on. It only shows what you did, not what you could do.");
  improve.push("Put a deliberate hard block late in long rides: e.g. 2×10–20 min at race effort after 2.5–3 h. That turns this from 'what happened' into a real durability test.");
  improve.push("Repeat the same long-ride format every few weeks so the numbers compare like with like.");
  return { rows, fresh300, fresh1200, confidence, why, improve };
}

export interface AetSummary {
  kind: "ride" | "run";
  points: Array<{ date: string; hr: number; output: number | null; windows: number; artefactPct: number }>;
  recentHr: number | null;
  recentOutput: number | null;
  confidence: Confidence;
  why: string[];
  improve: string[];
}

/** DFA-α1 aerobic-threshold estimates over time for one sport. */
export function aerobicThreshold(sessions: SessionPerformance[], kind: "ride" | "run", opts: { today: string }): AetSummary {
  const pts = sessions
    .filter((s) => s.kind === kind && s.dfa)
    .map((s) => ({ date: s.date, hr: s.dfa!.aetHr, output: s.dfa!.aetOutput, windows: s.dfa!.windows, artefactPct: s.dfa!.artefactPct }));
  const recentFrom = new Date(Date.parse(`${opts.today}T00:00:00Z`) - 60 * 86400000).toISOString().slice(0, 10);
  const recent = pts.filter((p) => p.date >= recentFrom);
  const hrs = recent.map((p) => p.hr);
  const spread = hrs.length >= 2 ? Math.max(...hrs) - Math.min(...hrs) : null;
  const why: string[] = [];
  const improve: string[] = [];
  let confidence: Confidence = recent.length === 0 ? "none" : recent.length < 3 ? "low" : spread != null && spread > 10 ? "low" : recent.length >= 5 ? "high" : "moderate";
  if (recent.length === 0) why.push(pts.length ? "No sessions in the last 60 days crossed the threshold with clean beat-to-beat data." : "No sessions with usable beat-to-beat HR found.");
  else why.push(`${recent.length} session(s) in the last 60 days${spread != null ? `, estimates spread over ${spread} bpm` : ""}.`);
  if (spread != null && spread > 10) why.push("Estimates disagree by more than 10 bpm, so treat the median as rough.");
  why.push("DFA-α1 = 0.75 is a published proxy for the first ventilatory (aerobic) threshold. It needs a chest strap; wrist HR can't do it. A MODEL, validated in groups, not for you specifically yet.");
  improve.push("Wear the chest strap with beat-to-beat (HRV) logging on for every session.");
  improve.push(`Once a month, do a gradual ramp: e.g. ${kind === "ride" ? "+15 W" : "+0.3 km/h"} every 3 min from easy to moderately hard, steady and seated, so α1 crosses 0.75 cleanly.`);
  improve.push("Avoid sessions with lots of stops and surges for this reading; moisten the strap, and replace its battery if artefacts are high.");
  improve.push("Check it against the February lab test: if the two agree, this becomes a trusted monthly marker.");
  if (confidence === "high" && recent.some((p) => p.artefactPct > 3)) confidence = "moderate";
  return {
    kind,
    points: pts,
    recentHr: hrs.length ? Math.round(median(hrs)!) : null,
    recentOutput: recent.filter((p) => p.output != null).length ? +median(recent.filter((p) => p.output != null).map((p) => p.output!))!.toFixed(kind === "ride" ? 0 : 2) : null,
    confidence,
    why,
    improve,
  };
}

export interface PerformanceReport {
  today: string;
  sessions: number;
  build?: Pick<PerformanceBuild, "parsed" | "scanned" | "pending">;
  fixedHr: FixedHrSummary[];
  cp: CpSummary;
  durability: DurabilitySummary;
  aet: AetSummary[];
}

/** Assemble the whole report. Pure given the sessions. */
export function summarisePerformance(
  sessions: SessionPerformance[],
  opts: { today: string; refHrBike?: number; refHrRun?: number; build?: PerformanceReport["build"] },
): PerformanceReport {
  return {
    today: opts.today,
    sessions: sessions.length,
    build: opts.build,
    fixedHr: [
      fixedHrSeries(sessions, "bike-outdoor", { refHr: opts.refHrBike, today: opts.today, windowDays: 365 }),
      fixedHrSeries(sessions, "bike-indoor", { refHr: opts.refHrBike, today: opts.today, windowDays: 365 }),
      fixedHrSeries(sessions, "run", { refHr: opts.refHrRun, today: opts.today, windowDays: 365 }),
    ],
    cp: criticalPower(sessions, { today: opts.today }),
    durability: durability(sessions, { today: opts.today }),
    aet: [aerobicThreshold(sessions, "ride", { today: opts.today }), aerobicThreshold(sessions, "run", { today: opts.today })],
  };
}

/** m/s → "m:ss" per km. */
export function paceLabel(ms: number | null): string {
  if (ms == null || !(ms > 0)) return "—";
  const s = Math.round(1000 / ms);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Plain-text report for the CLI and the MCP tool. */
export function formatPerformanceReport(r: PerformanceReport): string[] {
  const out = [`EFFICIENCY & PERFORMANCE [.FIT archive + fit-streams, ${r.sessions} sessions; MODEL estimates, confidence per metric]`];
  if (r.build) out.push(`  ${r.build.scanned} files scanned, ${r.build.parsed} parsed this run${r.build.pending ? `, ${r.build.pending} still to parse (run \`npm run efficiency\`)` : ""}`);
  for (const f of r.fixedHr) {
    const v = (x: number | null) => (f.unit === "W" ? (x == null ? "—" : `${Math.round(x)} W`) : `${paceLabel(x)}/km`);
    out.push(
      "",
      `${f.label} @ ${f.refHr ?? "—"} bpm (${f.refHrSource ?? "no data"}): last 28 days ${v(f.recent)} · trend ${f.trendPctPer30d == null ? "—" : `${f.trendPctPer30d > 0 ? "+" : ""}${f.trendPctPer30d}% per 30 days ±${f.trendCiPct}`} · ${f.points.length} sessions · confidence ${f.confidence.toUpperCase()}`,
      ...f.why.map((w) => `  · ${w}`),
    );
  }
  out.push(
    "",
    `Critical power (90 days): ${r.cp.cpW ?? "—"} W, W′ ${r.cp.wPrimeKj ?? "—"} kJ · confidence ${r.cp.confidence.toUpperCase()}`,
    ...r.cp.why.map((w) => `  · ${w}`),
    "",
    `Durability (90 days): ${r.durability.rows.map((d) => `after ${d.kj} kJ: 5-min ${d.p300Pct ?? "—"}% / 20-min ${d.p1200Pct ?? "—"}% of fresh (${d.rides} rides)`).join(" · ")} · confidence ${r.durability.confidence.toUpperCase()}`,
    ...r.durability.why.map((w) => `  · ${w}`),
  );
  for (const a of r.aet) {
    out.push(
      "",
      `Aerobic threshold, ${a.kind} (DFA-α1, 60 days): ${a.recentHr ?? "—"} bpm${a.recentOutput != null ? ` ≈ ${a.kind === "ride" ? `${a.recentOutput} W` : `${paceLabel(a.recentOutput)}/km`}` : ""} · confidence ${a.confidence.toUpperCase()}`,
      ...a.why.map((w) => `  · ${w}`),
    );
  }
  out.push("", "Full page with charts and how to raise each confidence: http://localhost:3000/efficiency");
  return out;
}
