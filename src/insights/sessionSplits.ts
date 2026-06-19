/**
 * Per-interval splits + swim CSS (the granular layer below the activity summary).
 *
 * The connector exposes per-session summaries, but the structure underneath — run/bike reps, swim
 * lengths, and the maximal efforts a CSS test is built from — lives in the raw `.FIT` lap (msg 19) and
 * length (msg 101) records. (AI Endurance's `*ActivityDetail` would be the other source, but it's blocked
 * upstream: the activity list exposes no `activity_id` to call it — see Insight_Engine_Spec §6.) So this
 * reads the FIT laps/lengths the dependency-free parser now decodes and:
 *   - normalises them into a per-interval split table (any sport), and
 *   - for a swim test, computes **Critical Swim Speed** by the 400/200 method with a maximal-effort
 *     confidence check — because a soft test yields a soft CSS.
 *
 * Pure + deterministic. READ-ONLY to AI Endurance: it computes and recommends; the athlete sets CSS in
 * the AI Endurance app themselves. Never fabricates — an effort it can't find is reported missing.
 */

import type { FitActivity, FitLap, FitLength } from "./fitParser.js";

export interface IntervalSplit {
  index: number;
  distanceM: number | null;
  timeS: number | null; // moving (timer) where available, else elapsed
  paceSecPer100m: number | null; // swim
  paceSecPerKm: number | null; // run/bike
  speedKmh: number | null;
  avgHr: number | null;
  avgPowerW: number | null;
  strokes: number | null;
}

const r1 = (n: number) => +n.toFixed(1);

function lapTime(l: FitLap): number | null {
  return l.timerS ?? l.elapsedS ?? null;
}

/** Normalise FIT laps → per-interval splits (run/bike reps, or swim sets if the watch lapped them). */
export function lapSplits(fit: FitActivity): IntervalSplit[] {
  return fit.laps.map((l, i) => {
    const t = lapTime(l);
    const d = l.distanceM ?? null;
    const speedMs = l.avgSpeedMs ?? (d != null && t != null && t > 0 ? d / t : null);
    return {
      index: l.index ?? i + 1,
      distanceM: d != null ? r1(d) : null,
      timeS: t != null ? r1(t) : null,
      paceSecPer100m: d != null && d > 0 && t != null ? Math.round((t / d) * 100) : null,
      paceSecPerKm: d != null && d > 0 && t != null ? Math.round((t / d) * 1000) : null,
      speedKmh: speedMs != null ? r1(speedMs * 3.6) : null,
      avgHr: l.avgHr ?? null,
      avgPowerW: l.avgPowerW ?? null,
      strokes: l.totalStrokes ?? null,
    };
  });
}

/** Normalise FIT lengths → per-length splits (swim only). Distance per length = the session pool length. */
export function lengthSplits(fit: FitActivity): IntervalSplit[] {
  const pool = fit.session.poolLengthM ?? null;
  return fit.lengths.map((l, i) => {
    const t = l.timerS ?? l.elapsedS ?? null;
    const active = l.lengthType == null || l.lengthType === 1;
    const d = active ? pool : 0; // rest lengths cover no distance
    const speedMs = l.avgSpeedMs ?? (d != null && d > 0 && t != null && t > 0 ? d / t : null);
    return {
      index: l.index ?? i + 1,
      distanceM: d,
      timeS: t != null ? r1(t) : null,
      paceSecPer100m: d != null && d > 0 && t != null ? Math.round((t / d) * 100) : null,
      paceSecPerKm: null,
      speedKmh: speedMs != null ? r1(speedMs * 3.6) : null,
      avgHr: null, // length messages don't carry HR
      avgPowerW: null,
      strokes: l.strokes ?? null,
    };
  });
}

// ---------- CSS from a 400/200 test ----------

export interface CssEfforts {
  t400Sec: number;
  t200Sec: number;
  avgHr400?: number;
  avgHr200?: number;
  /** "explicit" = the athlete gave the times; "auto-laps" = detected from the FIT laps. */
  source: "explicit" | "auto-laps";
}

export interface CssResult {
  cssSecPer100m: number;
  display: string; // "1:40 /100m"
  t400Sec: number;
  t200Sec: number;
  confidence: "high" | "medium" | "low";
  flags: string[]; // why confidence isn't high (maximal-effort caveats)
  basis: string;
  source: CssEfforts["source"];
}

function clock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Parse a swim/effort time: a number of seconds, or an "m:ss" / "mm:ss" / "h:mm:ss" clock string. */
export function parseClock(v: string | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const s = v.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return +s > 0 ? +s : null; // bare seconds
  const parts = s.split(":").map((p) => Number(p));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const sec = parts.reduce((acc, n) => acc * 60 + n, 0);
  return sec > 0 ? sec : null;
}

/**
 * Critical Swim Speed by the 400/200 method: CSS pace per 100 m = (T400 − T200) / 2.
 *
 * Returns an error string instead of a number when the inputs can't yield a valid CSS (so we never invent
 * one). A genuine maximal pair has the 400 SLOWER per 100 m than the 200 (T400 > 2·T200); when it isn't,
 * the efforts weren't both maximal (or the times are swapped) and the estimate is flagged unreliable.
 */
export function computeCss(e: CssEfforts & { maxHr?: number }): CssResult | { error: string } {
  const { t400Sec, t200Sec } = e;
  if (!(t400Sec > 0) || !(t200Sec > 0)) return { error: "Both the 400 m and 200 m times must be positive." };
  if (t400Sec <= t200Sec) return { error: `The 400 m time (${clock(t400Sec)}) must exceed the 200 m time (${clock(t200Sec)}) — did you swap them?` };

  const cssSecPer100m = Math.round((t400Sec - t200Sec) / 2);
  const pace400Per100 = t400Sec / 4;
  const pace200Per100 = t200Sec / 2;
  const flags: string[] = [];
  let confidence: CssResult["confidence"] = "high";

  // Validity: a maximal 400 is slower per 100 m than a maximal 200. If not, at least one wasn't maximal.
  if (t400Sec <= 2 * t200Sec) {
    confidence = "low";
    flags.push(
      `Your 400 pace (${clock(pace400Per100)}/100m) is not slower than your 200 pace (${clock(pace200Per100)}/100m) — ` +
        "in a true test the 400 should be the slower per-100m effort, so one of these wasn't maximal (or the times are swapped). CSS is unreliable.",
    );
  } else {
    // Differentiation between the two efforts (a maximal pair typically differs ~2–6% per 100 m).
    const gapPct = ((pace400Per100 - pace200Per100) / pace200Per100) * 100;
    if (gapPct < 1) {
      confidence = "medium";
      flags.push(`Little pace differentiation between the 400 and 200 (${gapPct.toFixed(1)}%) — confirm both were all-out.`);
    } else if (gapPct > 12) {
      confidence = "medium";
      flags.push(`Unusually large gap between the 400 and 200 paces (${gapPct.toFixed(1)}%) — the 400 may have been paced/submaximal rather than a true time-trial.`);
    }
  }

  // HR-based maximality check (only when we have HR for the efforts AND a max-HR reference).
  if (e.maxHr && e.maxHr > 0 && (e.avgHr400 || e.avgHr200)) {
    const hrs = [e.avgHr400, e.avgHr200].filter((h): h is number => h != null && h > 0);
    const peak = Math.max(...hrs);
    const pctMax = (peak / e.maxHr) * 100;
    if (pctMax < 85) {
      flags.push(`Effort HR peaked at ~${Math.round(pctMax)}% of max (${peak}/${e.maxHr} bpm) — that looks submaximal for a CSS test, so the result may understate your true CSS.`);
      confidence = confidence === "high" ? "medium" : "low";
    }
  } else if (e.source === "auto-laps") {
    flags.push("No max-HR reference given, so maximality couldn't be cross-checked against HR — pass maxHr to tighten the confidence.");
  }

  return {
    cssSecPer100m,
    display: `${clock(cssSecPer100m)} /100m`,
    t400Sec,
    t200Sec,
    confidence,
    flags,
    basis: `CSS = (T400 − T200) / 2 = (${clock(t400Sec)} − ${clock(t200Sec)}) / 2 (${e.source === "auto-laps" ? "efforts auto-detected from the .FIT laps" : "times you provided"}).`,
    source: e.source,
  };
}

/**
 * Auto-detect the 400 m and 200 m maximal efforts from a swim's FIT laps: the FASTEST lap whose distance
 * is ≈400 m and the fastest ≈200 m (within tolerance). Returns null when either can't be found — the
 * caller then asks for the times rather than guessing.
 */
export function detectCssEffortsFromLaps(laps: FitLap[], tolerance = 0.06): CssEfforts | null {
  const near = (d: number | undefined, target: number) => d != null && Math.abs(d - target) <= target * tolerance;
  const fastest = (target: number): FitLap | null => {
    const cands = laps.filter((l) => near(l.distanceM, target) && lapTime(l) != null);
    if (!cands.length) return null;
    return cands.reduce((best, l) => (lapTime(l)! < lapTime(best)! ? l : best));
  };
  const l400 = fastest(400);
  const l200 = fastest(200);
  if (!l400 || !l200) return null;
  return {
    t400Sec: lapTime(l400)!,
    t200Sec: lapTime(l200)!,
    avgHr400: l400.avgHr,
    avgHr200: l200.avgHr,
    source: "auto-laps",
  };
}

// ---------- formatting ----------

function paceClock(secPer: number): string {
  const m = Math.floor(secPer / 60);
  const s = Math.round(secPer % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Render a per-interval split table for an activity (swim → lengths-or-laps; run/bike → laps). */
export function formatSplits(fit: FitActivity): string[] {
  const isSwim = fit.sport === 5 || /swim/i.test(fit.sportName);
  // Prefer laps when present (the athlete/device marked reps); for a pure pool swim with only lengths, show those.
  const splits = fit.laps.length ? lapSplits(fit) : isSwim ? lengthSplits(fit) : [];
  if (!splits.length) return [`No lap/length structure in this ${fit.sportName} .FIT (continuous effort, or the device recorded no laps).`];
  const unit = isSwim ? "/100m" : "/km";
  const lines = [`Per-interval splits (${fit.laps.length ? "laps" : "lengths"}) — ${fit.sportName}:`];
  for (const s of splits) {
    const pace = isSwim ? s.paceSecPer100m : s.paceSecPerKm;
    const parts = [
      `#${s.index}`,
      s.distanceM != null ? `${s.distanceM} m` : "— m",
      s.timeS != null ? paceClock(s.timeS) : "—",
      pace != null ? `${paceClock(pace)}${unit}` : "—",
    ];
    if (s.avgHr != null) parts.push(`${s.avgHr} bpm`);
    if (s.avgPowerW != null) parts.push(`${s.avgPowerW} W`);
    if (s.strokes != null) parts.push(`${s.strokes} str`);
    lines.push(`  ${parts.join("  ·  ")}`);
  }
  return lines;
}

/** Render a CSS computation (or the error) plus the read-only "set it in AI Endurance" reminder. */
export function formatCss(result: CssResult | { error: string }): string[] {
  if ("error" in result) return [`CSS not computed: ${result.error}`];
  const r = result;
  const lines = [
    `Critical Swim Speed (MODEL — 400/200 test): ${r.display}  ·  confidence: ${r.confidence.toUpperCase()}`,
    `  ${r.basis}`,
  ];
  for (const f of r.flags) lines.push(`  ⚠ ${f}`);
  lines.push(
    `  Read-only: this connector can't set CSS in AI Endurance — apply ${r.display} yourself in the AI Endurance app (Settings → swim CSS)${
      r.confidence !== "high" ? ", and consider re-testing maximally first given the caveat(s) above" : ""
    }.`,
  );
  return lines;
}
