/**
 * N4 — n=1 responder analysis + anomaly detection. Computed from the AI Endurance recovery model's
 * 60-day daily series (HRV/rMSSD, RHR, recovery score, ESS). This is THIS athlete's own response —
 * priors only set the hypothesis; the data decides. Correlations off ~60 days are suggestive, not
 * proof: we report n and only surface notably-strong relationships, with caveats.
 *
 * (The headline "sleep <6.5h → next-day quality drop" needs accumulated Garmin sleep history, which
 *  the daily ping is now building; until then we mine the AIE series, which is already deep.)
 */

function nums(arr: unknown): Array<number | null> {
  return (Array.isArray(arr) ? arr : []).map((x) => {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    return Number.isFinite(n) ? n : null;
  });
}

/** Pearson r over paired finite values. Returns {r, n}. */
function pearson(xs: Array<number | null>, ys: Array<number | null>): { r: number | null; n: number } {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x != null && y != null) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < 8) return { r: null, n };
  const mx = pairs.reduce((a, [x]) => a + x, 0) / n;
  const my = pairs.reduce((a, [, y]) => a + y, 0) / n;
  let sxy = 0,
    sxx = 0,
    syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return { r: null, n };
  return { r: +(sxy / Math.sqrt(sxx * syy)).toFixed(2), n };
}

/** Shift y back by `lag` days so x[t] pairs with y[t+lag] (e.g. yesterday's HRV vs today's load). */
function lag(xs: Array<number | null>, ys: Array<number | null>, days: number): [Array<number | null>, Array<number | null>] {
  if (days <= 0) return [xs, ys];
  return [xs.slice(0, -days), ys.slice(days)];
}

export interface Correlation {
  label: string;
  r: number;
  n: number;
  interpretation: string;
}
export interface Anomaly {
  metric: string;
  z: number;
  detail: string;
}

const strength = (r: number) => (Math.abs(r) >= 0.5 ? "strong" : Math.abs(r) >= 0.3 ? "moderate" : "weak");

export interface CorrelationResult {
  correlations: Correlation[];
  anomalies: Anomaly[];
}

/**
 * Archive-powered n=1 signal: last night's sleep vs the NEXT day's training load — the headline
 * "do I train worse on poor sleep?" pattern, now computable once the Garmin sleep history is backfilled.
 */
export function sleepVsNextDayLoad(
  garminDays: Array<{ date: string; sleepHours?: number }>,
  essByDate: Map<string, number>,
): Correlation | null {
  const days = [...garminDays].sort((a, b) => a.date.localeCompare(b.date));
  const xs: Array<number | null> = [];
  const ys: Array<number | null> = [];
  for (const d of days) {
    const next = new Date(`${d.date}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextEss = essByDate.get(next.toISOString().slice(0, 10));
    xs.push(d.sleepHours ?? null);
    ys.push(nextEss ?? null);
  }
  const { r, n } = pearson(xs, ys);
  if (r == null || n < 20 || Math.abs(r) < 0.3) return null;
  return {
    label: "Last night's sleep → next-day training load",
    r,
    n,
    interpretation: `${strength(r)} (r=${r}, n=${n}): ${r > 0 ? "you train more after good sleep — readiness shows up the next day." : "your training load doesn't follow sleep — but watch session quality on short-sleep days."}`,
  };
}

export function analyseRecoverySeries(
  data: { date?: unknown[]; rMSSD?: unknown[]; resting_heart_rate?: unknown[]; recovery?: unknown[]; external_stress_score?: unknown[] } | undefined,
): CorrelationResult {
  const hrv = nums(data?.rMSSD);
  const rhr = nums(data?.resting_heart_rate);
  const rec = nums(data?.recovery);
  const ess = nums(data?.external_stress_score);

  const correlations: Correlation[] = [];
  const add = (label: string, x: Array<number | null>, y: Array<number | null>, mk: (r: number) => string) => {
    const { r, n } = pearson(x, y);
    if (r != null && n >= 15 && Math.abs(r) >= 0.3) correlations.push({ label, r, n, interpretation: mk(r) });
  };

  // Yesterday's load → today's recovery (training response).
  const [essY, recT] = lag(ess, rec, 1);
  add("Yesterday's load → today's recovery", essY, recT, (r) =>
    `${strength(r)} ${r < 0 ? "negative" : "positive"} (r=${r}): ${r < 0 ? "harder days clearly cost you recovery the next day — respect the easy day after a big session." : "your recovery holds up well after load — a durable autonomic system."}`,
  );
  // Yesterday's HRV → today's load (do you train to readiness?).
  const [hrvY, essT] = lag(hrv, ess, 1);
  add("Yesterday's HRV → today's training load", hrvY, essT, (r) =>
    `${strength(r)} (r=${r}): ${r > 0 ? "you tend to train harder after higher-HRV days — you're already training to readiness." : "your load doesn't follow HRV — worth gating harder sessions on a good HRV morning."}`,
  );
  // Same-day RHR vs recovery (sanity / responder).
  add("Resting HR vs recovery (same day)", rhr, rec, (r) =>
    `${strength(r)} ${r < 0 ? "negative" : "positive"} (r=${r}): RHR ${r < 0 ? "rises as recovery drops for you — a reliable personal fatigue signal." : "tracks unusually — read with care."}`,
  );

  // Anomalies: most-recent value vs series mean/SD (z-score).
  const anomalies: Anomaly[] = [];
  const z = (arr: Array<number | null>, name: string, dir: "high" | "low", word: string) => {
    const v = arr.filter((x): x is number => x != null);
    if (v.length < 14) return;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    const last = v[v.length - 1];
    if (sd === 0) return;
    const zsc = +((last - m) / sd).toFixed(1);
    if ((dir === "high" && zsc > 2) || (dir === "low" && zsc < -2)) {
      anomalies.push({ metric: name, z: zsc, detail: `${name} is ${word} today (${last.toFixed(0)} vs ${m.toFixed(0)} avg, z=${zsc}).` });
    }
  };
  z(rhr, "Resting HR", "high", "unusually elevated");
  z(hrv, "HRV", "low", "unusually suppressed");

  return { correlations, anomalies };
}
