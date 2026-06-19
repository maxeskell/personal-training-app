/**
 * Bike-FTP source diagnostic (user ask: "resolve the 183 W vs 223 W gap — which power source feeds AI
 * Endurance?").
 *
 * Honest by construction: this connector is **read-only to AI Endurance** and only sees the FTP *number*
 * `getUser` exposes — NOT which engine set it (a manual test entry vs an auto-sync). So it can't "resolve"
 * the source; what it CAN do is lay the evidence side by side and make the gap actionable:
 *   - the configured FTP the coach reads (and which integration it came from in *this* assemble),
 *   - Garmin's power-duration (MMP) FTP estimate — a floor that only sees power-equipped rides,
 *   - your recent **power coverage** (how many rides actually carry power), which explains a low estimate,
 *   - a recommendation to ride with power (so the estimate converges) and to verify the AIE figure, rather
 *     than guessing.
 *
 * Pure + deterministic. Never invents — a missing input is reported missing.
 */

import type { AthleteState } from "../state/types.js";
import type { RichActivity } from "./metrics.js";

export interface PowerCoverage {
  ridesWithPower: number;
  totalRides: number;
  pct: number | null; // null when there were no rides in the window
  windowDays: number;
}

export interface FtpDiagnosis {
  configuredFtpW: number | null;
  configuredSource: string; // which integration THIS assemble read it from (not AIE's internal source)
  configuredNote?: string; // bikeFtpNote — set when Garmin's auto-detected FTP differs from the test value
  garminEstimateW: number | null;
  garminActivitiesAnalyzed: number | null;
  gapW: number | null; // configured − Garmin estimate (positive = configured is higher)
  gapPct: number | null; // gap as % of the configured FTP
  coverage: PowerCoverage;
  flags: string[];
  recommendation: string;
}

function shiftIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Share of recent rides that actually carry power — the data the Garmin MMP estimate is built from. */
export function powerCoverage(rides: RichActivity[], today: string, windowDays = 90): PowerCoverage {
  const cutoff = shiftIso(today, -windowDays);
  const inWindow = rides.filter((a) => a.sport === "Ride" && a.date >= cutoff && a.date <= today);
  const withPower = inWindow.filter((a) => a.avwatts != null && a.avwatts > 0);
  return {
    ridesWithPower: withPower.length,
    totalRides: inWindow.length,
    pct: inWindow.length ? Math.round((withPower.length / inWindow.length) * 100) : null,
    windowDays,
  };
}

const MATERIAL_GAP_PCT = 5; // within this, the two FTP figures agree (noise)

export function diagnoseFtp(state: AthleteState, rides: RichActivity[]): FtpDiagnosis {
  const t = state.thresholds.value;
  const configuredFtpW = t?.bikeFtpW ?? null;
  const garminEstimateW = state.powerCurve.value?.ftpEstimateW ?? null;
  const garminActivitiesAnalyzed = state.powerCurve.value?.activitiesAnalyzed ?? null;
  const coverage = powerCoverage(rides, state.date);

  const gapW = configuredFtpW != null && garminEstimateW != null ? configuredFtpW - garminEstimateW : null;
  const gapPct = gapW != null && configuredFtpW ? Math.round((gapW / configuredFtpW) * 100) : null;

  const flags: string[] = [];
  // The core honesty: we can't see AIE's internal source.
  flags.push(
    `Read-only to AI Endurance: the coach reads the FTP *number* (from ${state.thresholds.source}) but not which engine set it — verify in AI Endurance (Settings → Thresholds) that ${configuredFtpW ?? "your"} W is from a recent power test, not a stale or manual entry.`,
  );
  if (t?.bikeFtpNote) flags.push(t.bikeFtpNote);
  if (coverage.pct != null && coverage.pct < 60) {
    flags.push(`Only ${coverage.ridesWithPower}/${coverage.totalRides} of your last-${coverage.windowDays}d rides carry power (${coverage.pct}%) — Garmin's estimate is starved, so a low estimate is expected, not a fitness drop.`);
  }

  let recommendation: string;
  if (configuredFtpW == null) {
    recommendation = "No bike FTP is configured in AI Endurance — set one from a recent power test so bike zones and race-leg estimates work. Then ride with power so Garmin can corroborate it.";
  } else if (garminEstimateW == null) {
    recommendation = `No Garmin power-duration estimate to cross-check the configured ${configuredFtpW} W (Garmin off, or no power-equipped rides analysed). Ride with power so a curve forms, then re-run this.`;
  } else if (gapPct != null && Math.abs(gapPct) <= MATERIAL_GAP_PCT) {
    recommendation = `Configured (${configuredFtpW} W) and Garmin-estimated (${garminEstimateW} W) FTP agree within ~${MATERIAL_GAP_PCT}% — no action; your zones are on a sound number.`;
  } else if (gapW != null && gapW > 0) {
    // Configured higher than Garmin's estimate — the 223-vs-183 case.
    recommendation =
      `Configured ${configuredFtpW} W sits ${gapPct}% above Garmin's ${garminEstimateW} W estimate. Garmin's MMP curve only revises up on hard, sustained POWER-equipped efforts, so close the gap with data, not guesswork: ` +
      `do 2–3 power-meter rides with a sustained threshold block (and a ~20-min max effort) over the next fortnight and re-check — the estimate should climb toward ${configuredFtpW} W. ` +
      `If it stays well below after genuine power efforts, the configured ${configuredFtpW} W may be optimistic — retest. Zones keep using the configured figure meanwhile.`;
  } else {
    // Garmin estimate ABOVE configured — the configured number may be stale/low.
    recommendation = `Garmin's estimate (${garminEstimateW} W) is ${Math.abs(gapPct ?? 0)}% ABOVE your configured ${configuredFtpW} W — your configured FTP may be stale. Consider a fresh power test and updating it in AI Endurance.`;
  }

  return { configuredFtpW, configuredSource: state.thresholds.source, configuredNote: t?.bikeFtpNote, garminEstimateW, garminActivitiesAnalyzed, gapW, gapPct, coverage, flags, recommendation };
}

export function formatFtpDiagnosis(d: FtpDiagnosis): string[] {
  const w = (n: number | null) => (n == null ? "—" : `${n} W`);
  const lines = [
    "Bike FTP — source diagnostic (MODEL / read-only):",
    `  Configured FTP (used for zones): ${w(d.configuredFtpW)}  [read from: ${d.configuredSource}]`,
    `  Garmin power-duration estimate:  ${w(d.garminEstimateW)}${d.garminActivitiesAnalyzed != null ? `  (from ${d.garminActivitiesAnalyzed} activities)` : ""}`,
  ];
  if (d.gapW != null) lines.push(`  Gap: ${d.gapW > 0 ? "+" : ""}${d.gapW} W (${d.gapPct}% of configured)`);
  lines.push(`  Power coverage: ${d.coverage.pct == null ? "no rides in window" : `${d.coverage.ridesWithPower}/${d.coverage.totalRides} rides carry power (${d.coverage.pct}%) over ${d.coverage.windowDays}d`}`);
  if (d.flags.length) {
    lines.push("", "Caveats:");
    for (const f of d.flags) lines.push(`  ⚠ ${f}`);
  }
  lines.push("", `Recommendation: ${d.recommendation}`);
  lines.push("(Read-only: this connector never writes FTP — apply any change in AI Endurance yourself.)");
  return lines;
}
