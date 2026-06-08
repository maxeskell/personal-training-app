/**
 * Temperature / heat confounder (data-scientist brief §2, catalogue I1/I3 — the #1 validity fix).
 *
 * VO2max, pace-at-HR and efficiency all move with ambient temperature, so a summer EF dip can be heat,
 * not lost fitness. Using per-activity temperature from the .FIT streams, we estimate this athlete's own
 * heat sensitivity — the % EF (power÷HR) change per °C — by regressing EF on temperature across sessions,
 * then attribute how much of a recent EF change is explained by a temperature shift rather than fitness.
 *
 * Deterministic; needs enough sessions across a real temperature range, else stays silent.
 */

import type { SessionDecay } from "./fit.js";
import type { Finding } from "./metrics.js";
import { mean } from "./stats.js";

export interface HeatAnalysis {
  sport: string;
  n: number;
  pctPerC: number | null; // % EF change per °C (negative = EF falls as it warms)
  recentEf: number | null;
  priorEf: number | null;
  efChangePct: number | null; // recent vs prior EF
  recentTempC: number | null;
  priorTempC: number | null;
  heatAttributedPct: number | null; // share of the recent EF change explained by the temperature shift
}

interface Pt {
  date: string;
  ef: number;
  temp: number;
}

/** Least-squares slope of y on x. */
function slope(pts: Array<{ x: number; y: number }>): number | null {
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p.x))!;
  const my = mean(pts.map((p) => p.y))!;
  let sxy = 0;
  let sxx = 0;
  for (const p of pts) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  return sxx === 0 ? null : sxy / sxx;
}

export function analyseHeat(decays: SessionDecay[], sport: "Run" | "Ride"): HeatAnalysis {
  const pts: Pt[] = decays
    .filter((d) => d.sport === sport && d.avgPowerW != null && d.avgHr != null && d.avgHr > 0 && d.avgTempC != null)
    .map((d) => ({ date: d.date, ef: d.avgPowerW! / d.avgHr!, temp: d.avgTempC! }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const empty: HeatAnalysis = { sport, n: pts.length, pctPerC: null, recentEf: null, priorEf: null, efChangePct: null, recentTempC: null, priorTempC: null, heatAttributedPct: null };
  if (pts.length < 8) return empty;
  const temps = pts.map((p) => p.temp);
  if (Math.max(...temps) - Math.min(...temps) < 4) return empty; // need a real temperature range

  const meanEf = mean(pts.map((p) => p.ef))!;
  const slopeEfPerC = slope(pts.map((p) => ({ x: p.temp, y: p.ef })));
  const pctPerC = slopeEfPerC == null || meanEf === 0 ? null : +((slopeEfPerC / meanEf) * 100).toFixed(2);

  const half = Math.min(5, Math.floor(pts.length / 2));
  const recent = pts.slice(-half);
  const prior = pts.slice(-2 * half, -half);
  const recentEf = mean(recent.map((p) => p.ef));
  const priorEf = mean(prior.map((p) => p.ef));
  const recentTempC = mean(recent.map((p) => p.temp));
  const priorTempC = mean(prior.map((p) => p.temp));
  const efChangePct = recentEf != null && priorEf != null && priorEf !== 0 ? +(((recentEf - priorEf) / priorEf) * 100).toFixed(1) : null;

  let heatAttributedPct: number | null = null;
  if (pctPerC != null && recentTempC != null && priorTempC != null && efChangePct != null && efChangePct !== 0) {
    const expectedFromHeat = pctPerC * (recentTempC - priorTempC); // expected EF % change from the temp shift
    // Only meaningful when both the actual change and the heat-expected change point the same way.
    if (Math.sign(expectedFromHeat) === Math.sign(efChangePct)) {
      heatAttributedPct = Math.min(100, +Math.abs((expectedFromHeat / efChangePct) * 100).toFixed(0));
    } else {
      heatAttributedPct = 0;
    }
  }

  return {
    sport,
    n: pts.length,
    pctPerC,
    recentEf: recentEf == null ? null : +recentEf.toFixed(3),
    priorEf: priorEf == null ? null : +priorEf.toFixed(3),
    efChangePct,
    recentTempC: recentTempC == null ? null : +recentTempC.toFixed(1),
    priorTempC: priorTempC == null ? null : +priorTempC.toFixed(1),
    heatAttributedPct,
  };
}

export function heatFinding(h: HeatAnalysis): Finding | null {
  if (h.pctPerC == null || h.n < 8) return null;
  // Surface when heat sensitivity is real (EF falls ≥0.3%/°C) AND a recent EF dip lines up with warmer sessions.
  const sensitive = h.pctPerC <= -0.3;
  const dipExplained = h.efChangePct != null && h.efChangePct < -2 && (h.heatAttributedPct ?? 0) >= 25 && (h.recentTempC ?? 0) > (h.priorTempC ?? 0);
  if (!sensitive) return null;
  if (dipExplained) {
    return {
      family: "Heat confounder",
      title: `${h.sport} EF dip is partly heat`,
      severity: "info",
      detail:
        `Your ${h.sport.toLowerCase()} efficiency falls ~${Math.abs(h.pctPerC)}%/°C in the heat. Recent sessions averaged ${h.recentTempC}°C vs ${h.priorTempC}°C prior, ` +
        `so ~${h.heatAttributedPct}% of the ${Math.abs(h.efChangePct!)}% EF drop is temperature, not lost fitness — read the trend on comparable-temperature sessions.`,
      evidence: `EF regressed on per-activity .FIT temperature, n=${h.n} [derived]`,
      confidence: 0.6,
    };
  }
  return {
    family: "Heat confounder",
    title: `${h.sport} efficiency is heat-sensitive`,
    severity: "info",
    detail:
      `Your ${h.sport.toLowerCase()} EF moves ~${Math.abs(h.pctPerC)}%/°C with ambient temperature (n=${h.n}). Keep this in mind when comparing EF across seasons — compare like temperatures, not raw values.`,
    evidence: `EF regressed on per-activity .FIT temperature [derived]`,
    confidence: 0.5,
  };
}
