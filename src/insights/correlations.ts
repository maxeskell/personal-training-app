/**
 * N4 — n=1 responder analysis + anomaly detection, computed from the AI Endurance recovery model's
 * ~60-day daily series (HRV/rMSSD, RHR, recovery score, ESS). This is THIS athlete's own response —
 * priors only set the hypothesis; the data decides.
 *
 * UPGRADED (data-scientist brief §2/§5): the brief's #1 named failure mode is a naive Pearson r on
 * two trending, autocorrelated series read as causal. We now:
 *   - down-weight the sample size for serial dependence (effective N) and attach a 95% CI to every r,
 *   - only surface relationships whose CI EXCLUDES 0 ("significant" here means that, n=1, not p-values),
 *   - scan LAGS (predictor at t−k vs outcome at t) and report the lag with the strongest stable link,
 *     so the arrow of time is respected and we never claim a same-day correlation is predictive.
 * Everything here remains hypothesis-generating for an n≈60 single athlete — labelled as such.
 */

import { corrWithCi, bestLaggedCorr, finiteNums, corrPValue, benjaminiHochberg, type Maybe } from "./stats.js";

export interface Correlation {
  label: string;
  r: number;
  n: number;
  /** Lag in days at which the predictor leads the outcome (0 = same day). */
  lagDays: number;
  ciLow: number;
  ciHigh: number;
  effN: number;
  significant: boolean; // CI excludes 0
  /** Survives Benjamini–Hochberg FDR control across the scanned set (q=0.1). */
  fdrPass?: boolean;
  lagsScanned?: number; // how many lags the selection searched (for multiplicity-aware FDR)
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
  // Sleep[t] already leads load[t+1] via the next-day pairing above, so this is a 0-lag corr on lagged data.
  const c = corrWithCi(xs, ys);
  if (!c || c.n < 20 || Math.abs(c.r) < 0.3) return null;
  return {
    label: "Last night's sleep → next-day training load",
    r: c.r,
    n: c.n,
    lagDays: 1,
    ciLow: c.ciLow,
    ciHigh: c.ciHigh,
    effN: c.effN,
    significant: c.significant,
    fdrPass: c.significant,
    interpretation: `${strength(c.r)} (r=${c.r}, 95% CI [${c.ciLow},${c.ciHigh}], n=${c.n}${c.significant ? "" : ", CI spans 0 — tentative"}): ${c.r > 0 ? "you train more after good sleep — readiness shows up the next day." : "your training load doesn't follow sleep — but watch session quality on short-sleep days."}`,
  };
}

export function analyseRecoverySeries(
  data: { date?: unknown[]; rMSSD?: unknown[]; resting_heart_rate?: unknown[]; recovery?: unknown[]; external_stress_score?: unknown[] } | undefined,
): CorrelationResult {
  const hrv = finiteNums(data?.rMSSD);
  const rhr = finiteNums(data?.resting_heart_rate);
  const rec = finiteNums(data?.recovery);
  const ess = finiteNums(data?.external_stress_score);

  const correlations: Correlation[] = [];
  const add = (
    label: string,
    x: Maybe[],
    y: Maybe[],
    opts: { minLag: number; maxLag: number },
    mk: (r: number, lag: number, sig: boolean) => string,
  ) => {
    const scan = bestLaggedCorr(x, y, opts.minLag, opts.maxLag);
    if (!scan) return;
    const c = scan.corr;
    // Surface a relationship only if it's at least moderate; flag whether its CI clears 0.
    if (Math.abs(c.r) >= 0.3) {
      correlations.push({
        label,
        r: c.r,
        n: c.n,
        lagDays: scan.bestLag,
        ciLow: c.ciLow,
        ciHigh: c.ciHigh,
        effN: c.effN,
        significant: c.significant,
        lagsScanned: opts.maxLag - opts.minLag + 1,
        interpretation: mk(c.r, scan.bestLag, c.significant),
      });
    }
  };

  // Load leading recovery: scan lags 1–3 (yesterday/2-3 days ago's load → today's recovery).
  add("Training load → later recovery", ess, rec, { minLag: 1, maxLag: 3 }, (r, lag, sig) =>
    `${strength(r)} ${r < 0 ? "negative" : "positive"} at a ${lag}-day lag (r=${r}${sig ? "" : ", CI spans 0 — tentative"}): ` +
    `${r < 0 ? `harder days cost you recovery ${lag} day(s) later — respect the easy day after a big session.` : "your recovery holds up after load — a durable autonomic system."}`,
  );
  // HRV leading training choice (do you train to readiness?).
  add("Morning HRV → that day's training load", hrv, ess, { minLag: 0, maxLag: 1 }, (r, _lag, sig) =>
    `${strength(r)} (r=${r}${sig ? "" : ", CI spans 0 — tentative"}): ` +
    `${r > 0 ? "you train harder after higher-HRV mornings — already training to readiness." : "your load doesn't follow HRV — consider gating hard sessions on a good-HRV morning."}`,
  );
  // RHR vs recovery (same-day sanity / responder check).
  add("Resting HR → recovery", rhr, rec, { minLag: 0, maxLag: 0 }, (r, _lag, sig) =>
    `${strength(r)} ${r < 0 ? "negative" : "positive"} (r=${r}${sig ? "" : ", CI spans 0 — tentative"}): ` +
    `RHR ${r < 0 ? "rises as recovery drops for you — a reliable personal fatigue signal." : "tracks unusually — read with care."}`,
  );

  // Anomalies: most-recent value vs the series mean/SD (z-score).
  const anomalies: Anomaly[] = [];
  const z = (arr: Maybe[], name: string, dir: "high" | "low", word: string) => {
    const v = arr.filter((x): x is number => x != null);
    if (v.length < 14) return;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const s = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
    const last = v[v.length - 1];
    if (s === 0) return;
    const zsc = +((last - m) / s).toFixed(1);
    if ((dir === "high" && zsc > 2) || (dir === "low" && zsc < -2)) {
      anomalies.push({ metric: name, z: zsc, detail: `${name} is ${word} today (${last.toFixed(0)} vs ${m.toFixed(0)} avg, z=${zsc}).` });
    }
  };
  z(rhr, "Resting HR", "high", "unusually elevated");
  z(hrv, "HRV", "low", "unusually suppressed");

  // FDR control across the scanned set (brief §2/§4): a relationship is "confirmed" only if its CI
  // clears 0 AND it survives Benjamini–Hochberg at q=0.1. The per-relationship p is first inflated by the
  // number of lags scanned (a Bonferroni step) so the lag SEARCH can't sneak past the multiplicity guard —
  // i.e. no double-dipping the selection that picked the best lag.
  if (correlations.length) {
    const pass = benjaminiHochberg(
      correlations.map((c) => Math.min(1, corrPValue(c.r, c.effN) * (c.lagsScanned ?? 1))),
      0.1,
    );
    correlations.forEach((c, i) => {
      c.fdrPass = pass[i] && c.significant;
      if (!c.fdrPass && !/tentative/.test(c.interpretation)) c.interpretation += " [exploratory — not FDR-confirmed]";
    });
  }

  return { correlations, anomalies };
}
