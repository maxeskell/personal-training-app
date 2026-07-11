/**
 * Mean-maximal power (MMP) curve from raw `.FIT` power streams — the data behind the /career page's
 * "recent" (Last-90-days / Season) power lines.
 *
 * We compute these directly from your raw `.FIT`s (which we already load for race splits) rather than lean
 * on any platform's pre-computed windows: for each standard duration, the best average power over any
 * contiguous window of that length
 * (Coggan MMP), taken across every activity in the window. Samples are treated as ~1 Hz (the same MODEL
 * approximation as the Normalized-Power calc); gaps count as zero power. PURE + deterministic.
 */

export interface PowerSamples {
  date: string; // YYYY-MM-DD
  watts: Array<number | undefined>; // per-second power (gaps = undefined)
}

export interface CurvePoint {
  durationSec: number;
  watts: number;
  date?: string; // the activity that set this point
}

/** Best average power over any contiguous `d`-second window (gaps → 0). Null if the stream is shorter than d. */
export function bestAvgPower(watts: Array<number | undefined>, d: number): number | null {
  if (!(d > 0)) return null;
  const p = watts.map((x) => (typeof x === "number" && x >= 0 ? x : 0));
  if (p.length < d) return null;
  let sum = 0;
  for (let i = 0; i < d; i++) sum += p[i];
  let best = sum;
  for (let i = d; i < p.length; i++) {
    sum += p[i] - p[i - d];
    if (sum > best) best = sum;
  }
  return best / d;
}

/**
 * Mean-maximal power curve across a set of activities: for each duration, the max MMP over all activities
 * (and the date of the one that set it). Durations longer than every activity are simply absent.
 */
export function meanMaximalCurve(acts: PowerSamples[], durations: number[]): CurvePoint[] {
  const out: CurvePoint[] = [];
  for (const d of durations) {
    let best: { watts: number; date?: string } | null = null;
    for (const a of acts) {
      const m = bestAvgPower(a.watts, d);
      if (m != null && m > 0 && (!best || m > best.watts)) best = { watts: Math.round(m), date: a.date };
    }
    if (best) out.push({ durationSec: d, watts: best.watts, date: best.date });
  }
  return out;
}

// ---------- power plausibility guard (keeps calibration-glitch power out of the all-time curve) ----------
//
// A single miscalibrated power file otherwise wins EVERY point of the mean-maximal curve: the all-time
// curve is a max across activities, so one ride reading ~2× true power sets the whole line (that is exactly
// the 2023-12-17 case — and the wider TrainingPeaks "574019" cluster — that this guard removes). The bests
// table already spike-filters its "Best power" row (a p90×1.25 ceiling in the career build); this brings the
// same honesty to the curve, which had no guard.

/** Linear-interpolated percentile (q in [0,1]) of a numeric list; empty → null. */
function percentile(vals: number[], q: number): number | null {
  const v = vals.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const idx = q * (v.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

/** Fewest rides whose NP we'll trust to anchor an FTP proxy — below this the curve is left unguarded. */
export const MIN_RIDES_FOR_FTP = 20;

/**
 * Robust functional-threshold-power proxy (W) from a set of per-ride normalized-power values — a MODEL.
 * The 90th percentile of ride NP sits at the athlete's genuinely hard rides (≈ threshold), yet being a
 * percentile it can't be dragged up by a handful of miscalibrated/spiky power files. Returns null when
 * there's too little ride-power history (< {@link MIN_RIDES_FOR_FTP} rides) to anchor anything — the caller
 * then leaves the curve unguarded rather than invent a ceiling from noise.
 */
export function ftpProxyFromNp(nps: number[]): number | null {
  const v = nps.filter((n) => Number.isFinite(n) && n > 0);
  if (v.length < MIN_RIDES_FOR_FTP) return null;
  return percentile(v, 0.9);
}

// Power-duration ceilings as a multiple of FTP (a MODEL): [durationSec, ×FTP]. The 20-minute window is the
// TIGHT anchor — the classic threshold-test duration, where genuine and glitch power separate cleanly (a
// maximal genuine 20-min is ~1.05×FTP; the ceiling is 1.2×). The other sustained windows are deliberately
// GENEROUS backstops: an all-out RACE effort (e.g. a triathlon bike leg) legitimately runs hot at 5–30 min,
// so a tight ceiling there would clip a real PB — every corrupt ride is already caught at 20 min anyway
// (mean-max power only falls with duration, so inflated 60-min power means inflated 20-min power too). Only
// sustained windows (≥5 min) are anchored: sprint power is 4–6×FTP and far too athlete-variable to police
// without clipping a genuine peak. Interpolated in log(duration).
const CEILING_ANCHORS: Array<[durationSec: number, xFtp: number]> = [
  [300, 1.6], // 5 min
  [600, 1.4], // 10 min
  [1200, 1.2], // 20 min — the tight threshold-test anchor
  [1800, 1.2], // 30 min — held level with 20 min so a hard race effort isn't clipped
  [3600, 1.15], // 60 min ≈ FTP by definition; 15% headroom
];

/** Durations (s) the plausibility guard inspects — the sustained windows anchored above. */
export const GUARDED_DURATIONS = CEILING_ANCHORS.map(([d]) => d);

/**
 * Highest believable mean-maximal power (W) at `durationSec` for an athlete of threshold power `ftpW` — the
 * plausibility ceiling. A MODEL (see {@link CEILING_ANCHORS}); flat outside the anchored 5–60 min range.
 */
export function plausibleCeilingW(durationSec: number, ftpW: number): number {
  const a = CEILING_ANCHORS;
  const mult = (): number => {
    if (durationSec <= a[0][0]) return a[0][1];
    if (durationSec >= a[a.length - 1][0]) return a[a.length - 1][1];
    for (let i = 1; i < a.length; i++) {
      if (durationSec <= a[i][0]) {
        const [d0, m0] = a[i - 1];
        const [d1, m1] = a[i];
        const t = (Math.log(durationSec) - Math.log(d0)) / (Math.log(d1) - Math.log(d0));
        return m0 + (m1 - m0) * t;
      }
    }
    return a[a.length - 1][1];
  };
  return Math.round(mult() * ftpW);
}

/**
 * True when a ride's power stream is physiologically implausible for the given FTP envelope: its
 * mean-maximal power over ANY guarded sustained window exceeds that window's ceiling. Windows the ride is
 * too short to fill are skipped, so a short ride is never flagged on sustained power it never produced. Pure.
 */
export function isImplausibleRidePower(watts: Array<number | undefined>, ftpW: number): boolean {
  for (const d of GUARDED_DURATIONS) {
    const p = bestAvgPower(watts, d);
    if (p != null && p > plausibleCeilingW(d, ftpW)) return true;
  }
  return false;
}

/**
 * Drop rides whose power is implausible for the FTP envelope (see {@link isImplausibleRidePower}) so a
 * miscalibrated file can't set the all-time curve. `ftpW` null/≤0 ⇒ no reference, so nothing is dropped
 * (degrade, don't guess). Pure — returns a new array.
 */
export function keepPlausibleRides<T extends { watts: Array<number | undefined> }>(rides: T[], ftpW: number | null): T[] {
  if (!(ftpW && ftpW > 0)) return rides;
  return rides.filter((r) => !isImplausibleRidePower(r.watts, ftpW));
}
