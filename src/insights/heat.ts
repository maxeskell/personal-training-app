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

import type { Finding } from "./metrics.js";
import { mean, slope } from "./stats.js";

/** Any per-activity record with the fields the heat regression needs (SessionDecay or FitSummary). */
export interface HeatInput {
  date: string;
  sport: string;
  avgPowerW?: number | null;
  avgHr?: number | null;
  avgTempC?: number | null;
  /** Ambient (met) air temp for the activity — Garmin's get_activity_weather, synced onto FitSummary. */
  weatherTempC?: number | null;
}

export interface HeatAnalysis {
  sport: string;
  n: number;
  /** How many of the n points used ambient (met) air temp rather than the device sensor. */
  metN: number;
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
  met: boolean;
}

export function analyseHeat(records: HeatInput[], sport: "Run" | "Ride"): HeatAnalysis {
  // Ambient (met) air temp beats the device sensor when both exist: the wrist/head-unit thermistor
  // reads body heat + direct sun (Birmingham 2026 raced at a device 23–24°C vs 18–22°C actual air),
  // and that bias VARIES with sun/clothing, so it adds noise to the EF~temp regression.
  const candidates: Pt[] = records
    .filter((d) => d.sport === sport && d.avgPowerW != null && d.avgHr != null && d.avgHr > 0 && (d.weatherTempC ?? d.avgTempC) != null)
    .map((d) => ({ date: d.date, ef: d.avgPowerW! / d.avgHr!, temp: (d.weatherTempC ?? d.avgTempC)!, met: d.weatherTempC != null }));
  // De-dup by date (a raw .FIT and its synced summary can both be present) — prefer the record that
  // carries ambient temp; first-seen wins among equals (the old behaviour).
  const byDate = new Map<string, Pt>();
  for (const p of candidates) {
    const cur = byDate.get(p.date);
    if (!cur || (!cur.met && p.met)) byDate.set(p.date, p);
  }
  const pts = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const metN = pts.filter((p) => p.met).length;

  const empty: HeatAnalysis = { sport, n: pts.length, metN, pctPerC: null, recentEf: null, priorEf: null, efChangePct: null, recentTempC: null, priorTempC: null, heatAttributedPct: null };
  if (pts.length < 8) return empty;
  const temps = pts.map((p) => p.temp);
  if (Math.max(...temps) - Math.min(...temps) < 4) return empty; // need a real temperature range

  const meanEf = mean(pts.map((p) => p.ef))!;
  const slopeEfPerC = slope(pts.map((p) => p.temp), pts.map((p) => p.ef));
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
  // Floor the denominator: an attribution ratio on a near-zero EF change is meaningless (a 0.05% change
  // would read as "100% heat"). Only attribute when the EF actually moved by ≥2%.
  if (pctPerC != null && recentTempC != null && priorTempC != null && efChangePct != null && Math.abs(efChangePct) >= 2) {
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
    metN,
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
      evidence: `EF regressed on per-activity ${tempSourceNote(h)}, n=${h.n} [derived]`,
      confidence: 0.6,
    };
  }
  return {
    family: "Heat confounder",
    title: `${h.sport} efficiency is heat-sensitive`,
    severity: "info",
    detail:
      `Your ${h.sport.toLowerCase()} EF moves ~${Math.abs(h.pctPerC)}%/°C with ambient temperature (n=${h.n}). Keep this in mind when comparing EF across seasons — compare like temperatures, not raw values.`,
    evidence: `EF regressed on per-activity ${tempSourceNote(h)} [derived]`,
    confidence: 0.5,
  };
}

/** Honest provenance for the evidence line: which temperature source(s) the regression actually used. */
function tempSourceNote(h: Pick<HeatAnalysis, "n" | "metN">): string {
  if (h.metN === 0) return ".FIT device temperature";
  if (h.metN >= h.n) return "ambient (met) air temperature";
  return `temperature (ambient met air for ${h.metN}/${h.n}, .FIT device for the rest)`;
}
