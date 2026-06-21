/**
 * Uniform data-quality / "possible error" detector across every backfilled physio stream.
 *
 * The other detectors ask "is this trend worrying?"; this one asks "is this reading even real?".
 * A bad bioimpedance step, a stale sync that carries yesterday's number forward, or an out-of-range
 * sensor glitch silently corrupts every downstream trend — the under-fuelling flag, the illness
 * early-warning, the rolling baselines all lean on these series. So we surface an implausible reading
 * as its own gentle finding: never a diagnosis, just "this value looks like a measurement error;
 * re-check it before trusting the trend it feeds."
 *
 * Conservative by design (honour "only show me real problems"):
 *  - physiological bounds are deliberately WIDE, so a genuine human extreme can't trip it;
 *  - the day-over-day check only fires on consecutive calendar days and only where a jump that big is
 *    mechanically impossible (body composition), not merely unusual (HR/stress can legitimately swing);
 *  - each stream emits at most ONE finding (its single worst issue), so a glitchy export can't flood
 *    the surface, and the title is number-free so the feedback key is stable day to day.
 */

import type { GarminDaily } from "./garminTrends.js";
import type { Finding } from "./metrics.js";
import { withinPhysioHorizon } from "./horizon.js";

interface StreamSpec {
  /** Number-free label used in the finding title (keeps the feedback key stable). */
  label: string;
  unit: string;
  /** Physiologically plausible absolute range — outside this is almost certainly a bad reading. */
  min: number;
  max: number;
  /** Largest believable change between consecutive days; bigger = a measurement error. Omit to skip. */
  maxDeltaPerDay?: number;
  /** Whether an identical value repeated across readings is suspect (a daily-varying signal shouldn't flatline). */
  stuck?: boolean;
  /** Pull the stream's value for a day (handles unit conversions such as sec → min). */
  pick: (d: GarminDaily) => number | undefined;
}

/**
 * Per-stream plausibility. Ranges are intentionally generous (human extremes must pass); the
 * day-over-day caps are only set where biology makes a big overnight move impossible — you cannot
 * truly gain/lose kilos of weight or muscle in a day, so such a jump is the scale, not you.
 */
const STREAMS: StreamSpec[] = [
  { label: "Resting HR", unit: "bpm", min: 25, max: 130, stuck: true, pick: (d) => d.restingHr },
  { label: "Weight", unit: "kg", min: 35, max: 250, maxDeltaPerDay: 3, stuck: true, pick: (d) => d.weightKg },
  { label: "Skeletal muscle mass", unit: "kg", min: 20, max: 120, maxDeltaPerDay: 2.5, stuck: true, pick: (d) => d.muscleMassKg },
  { label: "Total sleep", unit: "h", min: 0, max: 16, pick: (d) => d.sleepHours },
  { label: "Deep sleep", unit: "min", min: 0, max: 360, pick: (d) => (typeof d.deepSleepSec === "number" ? d.deepSleepSec / 60 : undefined) },
  { label: "All-day stress", unit: "", min: 0, max: 100, pick: (d) => d.avgStressLevel },
  { label: "Overnight Body-Battery change", unit: "", min: -100, max: 100, pick: (d) => d.bodyBatteryChange },
  { label: "Overnight respiration", unit: "brpm", min: 4, max: 40, pick: (d) => d.avgSleepRespiration },
  { label: "Skin-temp deviation", unit: "°C", min: -6, max: 6, pick: (d) => d.skinTempDevC },
];

const EPS = 1e-9;
const STUCK_RUN = 5; // identical readings in a row before a daily-varying signal is called flatlined

interface Dated {
  date: string;
  v: number;
}

function round(x: number): number {
  return Math.round(x * 10) / 10;
}

function daysBetween(a: string, b: string): number {
  const ms = new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000);
}

function dataQualityFinding(label: string, detail: string, evidence: string, confidence: number): Finding {
  return {
    family: "Data quality",
    title: `${label} reading looks off`,
    severity: "watch",
    detail,
    evidence,
    recommendation:
      "Re-measure (or re-sync the device) before trusting any trend built on this value — one bad reading skews the personal baseline and the under-fuelling / illness flags that lean on it.",
    confidence,
  };
}

/** Scan one stream and return its single worst data-quality finding, or null when it looks clean. */
function scanStream(spec: StreamSpec, daysAsc: GarminDaily[]): Finding | null {
  const pts: Dated[] = [];
  for (const d of daysAsc) {
    const v = spec.pick(d);
    if (v != null && Number.isFinite(v)) pts.push({ date: d.date, v });
  }
  if (pts.length === 0) return null;
  const u = spec.unit ? ` ${spec.unit}` : "";

  // 1. Out-of-range — the clearest "this is wrong" (report the most recent offender).
  const oor = [...pts].reverse().find((p) => p.v < spec.min || p.v > spec.max);
  if (oor) {
    return dataQualityFinding(
      spec.label,
      `${spec.label} on ${oor.date} reads ${round(oor.v)}${u}, outside the plausible human range (${spec.min}–${spec.max}${u}). That's almost certainly a bad measurement or a unit/sync glitch, not a real change.`,
      `value ${round(oor.v)}${u} vs plausible ${spec.min}–${spec.max}${u} [garmin — data check]`,
      0.8,
    );
  }

  // 2. Impossible day-over-day jump (consecutive calendar days only — a multi-day gap isn't a "jump").
  if (spec.maxDeltaPerDay != null) {
    for (let i = pts.length - 1; i > 0; i--) {
      if (daysBetween(pts[i - 1].date, pts[i].date) !== 1) continue;
      const delta = Math.abs(pts[i].v - pts[i - 1].v);
      if (delta > spec.maxDeltaPerDay) {
        return dataQualityFinding(
          spec.label,
          `${spec.label} moved ${round(delta)}${u} from ${pts[i - 1].date} to ${pts[i].date} (${round(pts[i - 1].v)} → ${round(pts[i].v)}${u}). A real overnight change that large isn't physiological — it points to a measurement error such as a bad bioimpedance step.`,
          `Δ ${round(delta)}${u}/day vs believable ≤ ${spec.maxDeltaPerDay}${u} [garmin — data check]`,
          0.7,
        );
      }
    }
  }

  // 3. Stuck / flatlined — the same value carried across several readings (stale sync or a single
  // reading repeated). Only for streams that genuinely drift day to day.
  if (spec.stuck) {
    let run = 1;
    for (let i = pts.length - 1; i > 0; i--) {
      if (Math.abs(pts[i].v - pts[i - 1].v) < EPS) run++;
      else break;
    }
    if (run >= STUCK_RUN) {
      return dataQualityFinding(
        spec.label,
        `${spec.label} has read the exact same value (${round(pts[pts.length - 1].v)}${u}) for ${run} readings running. A signal that normally drifts day to day flatlining usually means a stale sync or one reading being carried forward — not real data.`,
        `${run} identical consecutive readings [garmin — data check]`,
        0.55,
      );
    }
  }

  return null;
}

/**
 * One data-quality finding per stream at most: physiologically implausible, impossible-jump, or stale
 * readings across the backfilled physio series. Pure and self-gating — silent when every stream looks
 * clean (the common case), so it only ever speaks up about a value that could be an error.
 */
export function detectDataQuality(days: GarminDaily[]): Finding[] {
  const asc = [...days].sort((a, b) => a.date.localeCompare(b.date));
  if (!asc.length) return [];
  // Only scan readings within the physio horizon (six months from the latest reading) — a long-dead
  // outlier (a 2016 archive glitch under a 2026 cluster) feeds no live trend, so it's left alone rather
  // than surfaced as a current finding. Same floor the feed applies (orchestrator.loadArchive); here as
  // defence-in-depth for any direct caller.
  const recent = withinPhysioHorizon(asc);
  const out: Finding[] = [];
  for (const spec of STREAMS) {
    const f = scanStream(spec, recent);
    if (f) out.push(f);
  }
  return out;
}
