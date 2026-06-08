/**
 * Shared statistical primitives for the n=1 insight layer.
 *
 * The data-scientist brief is explicit that the failure mode here is "impressive-looking
 * nonsense": fitness, fatigue, HRV and weight are all heavily autocorrelated, so a naive
 * Pearson r on two trending series is inflated and must never be read as causal. These helpers
 * give every correlation an HONEST uncertainty: a Fisher-z confidence interval computed on the
 * *effective* sample size (down-weighted for lag-1 autocorrelation), not the raw point count.
 */

export type Maybe = number | null;

export function finiteNums(arr: unknown): Maybe[] {
  return (Array.isArray(arr) ? arr : []).map((x) => {
    const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
    return Number.isFinite(n) ? n : null;
  });
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function sd(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const m = mean(xs)!;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
}

/** Lag-1 autocorrelation of a series — used to discount the effective sample size. */
export function lag1Autocorr(xs: number[]): number {
  if (xs.length < 3) return 0;
  const m = mean(xs)!;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    den += (xs[i] - m) ** 2;
    if (i > 0) num += (xs[i] - m) * (xs[i - 1] - m);
  }
  return den === 0 ? 0 : num / den;
}

export interface Corr {
  r: number;
  n: number; // paired observations actually used
  effN: number; // effective N after autocorrelation discount
  ciLow: number; // 95% CI on r (Fisher z, on effN)
  ciHigh: number;
  /** True when the CI excludes 0 — the bar for calling a relationship real here. */
  significant: boolean;
}

/**
 * Pearson r WITH an autocorrelation-aware 95% CI. The effective sample size uses the
 * standard variance-inflation factor (1+rx·ry)/(1−rx·ry) from the two series' lag-1
 * autocorrelations — the same correction used to keep time-series correlations honest.
 */
export function corrWithCi(xsIn: Maybe[], ysIn: Maybe[]): Corr | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < Math.min(xsIn.length, ysIn.length); i++) {
    const x = xsIn[i];
    const y = ysIn[i];
    if (x != null && y != null) {
      xs.push(x);
      ys.push(y);
    }
  }
  const n = xs.length;
  if (n < 10) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = Math.max(-0.999, Math.min(0.999, sxy / Math.sqrt(sxx * syy)));

  // Effective N: discount for serial dependence in BOTH series (variance inflation factor).
  const rx = Math.max(-0.99, Math.min(0.99, lag1Autocorr(xs)));
  const ry = Math.max(-0.99, Math.min(0.99, lag1Autocorr(ys)));
  const vif = (1 + rx * ry) / (1 - rx * ry || 1e-6);
  const effN = Math.max(4, n / Math.max(1, vif));

  // Fisher z transform → CI on effN → back-transform.
  const z = Math.atanh(r);
  const se = 1 / Math.sqrt(effN - 3 > 1 ? effN - 3 : 1);
  const lo = Math.tanh(z - 1.96 * se);
  const hi = Math.tanh(z + 1.96 * se);
  return {
    r: +r.toFixed(2),
    n,
    effN: +effN.toFixed(1),
    ciLow: +lo.toFixed(2),
    ciHigh: +hi.toFixed(2),
    significant: lo > 0 || hi < 0,
  };
}

/** Shift y forward by `lag` so x[t] pairs with y[t+lag] (predictor leads outcome). */
export function applyLag(xs: Maybe[], ys: Maybe[], lag: number): [Maybe[], Maybe[]] {
  if (lag <= 0) return [xs, ys];
  return [xs.slice(0, -lag), ys.slice(lag)];
}

export interface LagScan {
  bestLag: number;
  corr: Corr;
}

/**
 * Lagged cross-correlation: scan predictor at t−k against outcome at t for k in [minLag,maxLag]
 * and return the lag with the strongest *significant* association (largest |r| whose CI excludes 0).
 * Respects the arrow of time — the brief's requirement for any lead-lag claim.
 */
export function bestLaggedCorr(xs: Maybe[], ys: Maybe[], minLag = 0, maxLag = 4): LagScan | null {
  let best: LagScan | null = null;
  for (let k = minLag; k <= maxLag; k++) {
    const [lx, ly] = applyLag(xs, ys, k);
    const c = corrWithCi(lx, ly);
    if (!c) continue;
    if (!best || (c.significant && Math.abs(c.r) > Math.abs(best.corr.r))) {
      if (k === minLag || c.significant) best = { bestLag: k, corr: c };
    }
  }
  return best;
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 approximation). */
function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

/** Two-sided p-value for a correlation via the Fisher-z normal approximation on the effective N. */
export function corrPValue(r: number, effN: number): number {
  if (effN <= 4) return 1;
  const z = Math.atanh(Math.max(-0.999, Math.min(0.999, r))) * Math.sqrt(effN - 3);
  return Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.abs(z)))));
}

/**
 * Benjamini–Hochberg FDR control. Returns a boolean per input p-value: true = discovery survives at
 * false-discovery-rate `q`. The brief's guard against fishing across many metrics (multiple comparisons).
 */
export function benjaminiHochberg(pvals: number[], q = 0.1): boolean[] {
  const m = pvals.length;
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  let maxK = -1;
  for (let k = 0; k < m; k++) {
    if (order[k].p <= ((k + 1) / m) * q) maxK = k;
  }
  const pass = new Array(m).fill(false);
  for (let k = 0; k <= maxK; k++) pass[order[k].i] = true;
  return pass;
}

/** Rolling personal baseline: z-score of the last point vs the trailing window (excludes itself). */
export function trailingZ(series: Maybe[], window = 42): { z: number; mean: number; sd: number } | null {
  const v = series.filter((x): x is number => x != null);
  if (v.length < 14) return null;
  const hist = v.slice(-window - 1, -1);
  const last = v[v.length - 1];
  const m = mean(hist);
  const s = sd(hist);
  if (m == null || s == null || s === 0) return null;
  return { z: +((last - m) / s).toFixed(2), mean: +m.toFixed(1), sd: +s.toFixed(1) };
}
