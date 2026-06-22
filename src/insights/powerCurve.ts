/**
 * Mean-maximal power (MMP) curve from raw `.FIT` power streams — the data behind the /career page's
 * "recent" (Last-90-days / Season) power lines.
 *
 * The intervals.icu power-curve export only carries the windows its labels expose, so recent windows can
 * come out empty. Since we already load your raw `.FIT`s for race splits, we can compute the recent curves
 * directly: for each standard duration, the best average power over any contiguous window of that length
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
