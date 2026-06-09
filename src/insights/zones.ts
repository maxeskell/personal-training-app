/**
 * Training-zone surfacing (user ask: latest HR/power/pace zones per discipline + FTP/threshold).
 *
 * AI Endurance owns the athlete's configured zones via `getUser`/`setZones`; where those explicit
 * boundaries are exposed we surface them directly. Where only the THRESHOLD markers are available
 * (bike FTP, run threshold pace/HR, swim CSS) we derive standard zone bands from them with the
 * conventional models (Coggan power, %-LTHR heart-rate, %-threshold pace), flagged `source:"derived"`.
 * Deterministic and pure — no model/black-box estimates.
 */

import type { DisciplineThresholds, DisciplineZones, ZoneSet } from "../state/types.js";

/** Build a ZoneSet from a threshold value and ascending multiplier edges (bounds = threshold×edge). */
function fromThreshold(
  metric: ZoneSet["metric"],
  unit: string,
  threshold: number,
  edges: number[],
  labels: string[],
): ZoneSet {
  return {
    metric,
    unit,
    bounds: edges.map((e) => Math.round(threshold * e)),
    labels,
    source: "derived",
  };
}

// Coggan power zones as % of FTP (Z1..Z6; top two merged).
const POWER_EDGES = [0, 0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
const POWER_LABELS = ["Z1 Recovery", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 VO2", "Z6 Anaerobic"];
// Heart-rate zones as % of threshold (lactate-threshold) HR.
const HR_EDGES = [0, 0.85, 0.9, 0.95, 1.0, 1.06];
const HR_LABELS = ["Z1 Easy", "Z2 Endurance", "Z3 Tempo", "Z4 Threshold", "Z5 VO2"];
// Pace zones as multiples of threshold pace time (higher sec = slower = easier; bounds ascending).
const PACE_EDGES = [0.9, 0.97, 1.03, 1.1, 1.2, 1.45];
const PACE_LABELS = ["Z5 VO2", "Z4 Threshold", "Z3 Tempo", "Z2 Endurance", "Z1 Easy"];
const SWIM_EDGES = [0.9, 0.97, 1.03, 1.12, 1.3];
const SWIM_LABELS = ["Fast", "Threshold", "Tempo", "Easy"];

/** Derive per-discipline zones from threshold markers (used when getUser has no explicit zone tables). */
export function deriveZones(t: DisciplineThresholds | null | undefined): DisciplineZones {
  const z: DisciplineZones = {};
  if (!t) return z;
  if (t.bikeFtpW && t.bikeFtpW > 0) {
    z.bike = { power: fromThreshold("power", "W", t.bikeFtpW, POWER_EDGES, POWER_LABELS) };
  }
  // Bike HR zones from bike LTHR when set; else fall back to run LTHR (bike LTHR usually sits a few
  // bpm lower, so the dashboard flags the fallback and advises treating zone tops conservatively).
  const bikeHr = t.bikeThresholdHr ?? t.runThresholdHr;
  if (bikeHr && bikeHr > 0) {
    z.bike = { ...(z.bike ?? {}), hr: fromThreshold("hr", "bpm", bikeHr, HR_EDGES, HR_LABELS) };
  }
  if (t.runThresholdPowerW && t.runThresholdPowerW > 0) {
    // Running power zones use the same Coggan %-of-threshold model as the bike.
    z.run = { ...(z.run ?? {}), power: fromThreshold("power", "W", t.runThresholdPowerW, POWER_EDGES, POWER_LABELS) };
  }
  if (t.runThresholdHr && t.runThresholdHr > 0) {
    z.run = { ...(z.run ?? {}), hr: fromThreshold("hr", "bpm", t.runThresholdHr, HR_EDGES, HR_LABELS) };
  }
  if (t.runThresholdPaceSecPerKm && t.runThresholdPaceSecPerKm > 0) {
    z.run = { ...(z.run ?? {}), pace: fromThreshold("pace", "sec/km", t.runThresholdPaceSecPerKm, PACE_EDGES, PACE_LABELS) };
  }
  if (t.swimCssSecPer100 && t.swimCssSecPer100 > 0) {
    z.swim = { pace: fromThreshold("pace", "sec/100m", t.swimCssSecPer100, SWIM_EDGES, SWIM_LABELS) };
  }
  return z;
}

/** Merge explicit zones (from getUser) over derived ones — explicit always wins per metric. */
export function mergeZones(explicit: DisciplineZones | null | undefined, derived: DisciplineZones): DisciplineZones {
  if (!explicit) return derived;
  return {
    run: { ...derived.run, ...explicit.run },
    bike: { ...derived.bike, ...explicit.bike },
    swim: { ...derived.swim, ...explicit.swim },
  };
}

/** Format sec/km or sec/100m as m:ss for display. */
export function paceStr(secs: number | undefined): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
