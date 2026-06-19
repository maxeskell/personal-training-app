import type { AthleteState, DisciplineThresholds, Source } from "../state/types.js";

/**
 * Detect when AI Endurance / Garmin have CHANGED an auto-detected number (FTP, threshold HR/pace, swim
 * CSS, VO₂max) by diffing the trailing daily state snapshots. Neither platform exposes a "we updated your
 * FTP" notification, so we synthesise the change feed from our own history — deterministic, no LLM. Each
 * change is surfaced on the dashboard with agree/disagree/snooze so the athlete gets a say in numbers the
 * app otherwise just adopts silently. Zones aren't diffed separately: they're derived from these
 * thresholds, so a threshold change IS the zone change.
 */

export interface MetricChange {
  /** Stable key for the shared agree/disagree/snooze machinery — per metric+new-value, so a fresh change re-surfaces. */
  key: string;
  metric: string;
  label: string;
  from: string; // formatted previous value
  to: string; // formatted new value
  fromValue: number; // raw previous value (what "disagree" pins as your override)
  toValue: number; // raw new value (the auto-detected number being rejected)
  source: Source;
  /** Date (YYYY-MM-DD) the new value first appeared in the snapshots. */
  date: string;
  ageDays: number;
}

const paceFmt = (secPerKm: number, unit: string): string => `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, "0")}${unit}`;

interface Tracked {
  metric: string;
  label: string;
  pick: (s: AthleteState) => number | null | undefined;
  src: (s: AthleteState) => Source;
  fmt: (n: number) => string;
}

const TRACKED: Tracked[] = [
  { metric: "bikeFtpW", label: "Bike FTP", pick: (s) => s.thresholds.value?.bikeFtpW, src: (s) => s.thresholds.source, fmt: (n) => `${n} W` },
  { metric: "runThresholdPaceSecPerKm", label: "Run threshold pace", pick: (s) => s.thresholds.value?.runThresholdPaceSecPerKm, src: (s) => s.thresholds.source, fmt: (n) => paceFmt(n, "/km") },
  { metric: "runThresholdHr", label: "Run threshold HR", pick: (s) => s.thresholds.value?.runThresholdHr, src: (s) => s.thresholds.source, fmt: (n) => `${n} bpm` },
  { metric: "bikeThresholdHr", label: "Bike threshold HR", pick: (s) => s.thresholds.value?.bikeThresholdHr, src: (s) => s.thresholds.source, fmt: (n) => `${n} bpm` },
  { metric: "runThresholdPowerW", label: "Run threshold power", pick: (s) => s.thresholds.value?.runThresholdPowerW, src: (s) => s.thresholds.source, fmt: (n) => `${n} W` },
  { metric: "swimCssSecPer100", label: "Swim CSS", pick: (s) => s.thresholds.value?.swimCssSecPer100, src: (s) => s.thresholds.source, fmt: (n) => paceFmt(n, "/100m") },
  { metric: "maxHr", label: "Max HR", pick: (s) => s.thresholds.value?.maxHr, src: (s) => s.thresholds.source, fmt: (n) => `${n} bpm` },
  { metric: "vo2max", label: "VO₂max", pick: (s) => s.vo2max.value, src: (s) => s.vo2max.source, fmt: (n) => `${n}` },
];

/**
 * The tracked metrics that live in `DisciplineThresholds` (everything except vo2max, which has its own
 * slot) — these are the ones a per-source side-by-side can be built for, since each source records its
 * own threshold reading on `thresholdsBySource`.
 */
const THRESHOLD_TRACKED = TRACKED.filter((t) => t.metric !== "vo2max");

/** Stable display order for sources in a side-by-side (AIE first, Garmin last). */
const SOURCE_ORDER: Source[] = ["ai-endurance", "intervals", "garmin", "derived", "manual"];

/** The metrics the change-feed + overrides track (the override store validates against this). */
export const TRACKED_METRICS: ReadonlySet<string> = new Set(TRACKED.map((t) => t.metric));

/** Format a raw value for a tracked metric (e.g. bikeFtpW 262 → "262 W"); identity for unknown metrics. */
export function formatMetricValue(metric: string, value: number): string {
  return (TRACKED.find((t) => t.metric === metric)?.fmt ?? ((n: number) => `${n}`))(value);
}

/** Human label for a tracked metric (e.g. "Bike FTP"); the metric name itself for unknown ones. */
export function metricLabel(metric: string): string {
  return TRACKED.find((t) => t.metric === metric)?.label ?? metric;
}

function ageDays(date: string, now: number): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/**
 * The most recent change per tracked metric across the snapshot `window` (ascending by date). For each
 * metric, finds the latest non-null value and the nearest earlier DIFFERENT non-null value; the change is
 * dated to the first snapshot that carried the new value. Only changes within `maxAgeDays` are returned,
 * newest first. Pure.
 */
export function detectMetricChanges(window: AthleteState[], opts: { now?: number; maxAgeDays?: number } = {}): MetricChange[] {
  const now = opts.now ?? Date.now();
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const out: MetricChange[] = [];
  for (const t of TRACKED) {
    const vals = window.map((s) => ({ date: s.date, v: t.pick(s) ?? null, src: t.src(s) }));
    let i = vals.length - 1;
    while (i >= 0 && vals[i].v == null) i--; // latest non-null
    if (i < 1) continue;
    const latest = vals[i];
    let j = i - 1;
    while (j >= 0 && (vals[j].v == null || vals[j].v === latest.v)) j--; // nearest earlier DIFFERENT value
    if (j < 0) continue;
    const prev = vals[j];
    let k = j + 1;
    while (k < i && (vals[k].v == null || vals[k].v !== latest.v)) k++; // first snapshot with the new value
    const date = vals[k].date;
    const age = ageDays(date, now);
    if (age == null || age > maxAgeDays) continue;
    out.push({
      key: `change:${t.metric}:${latest.v}`,
      metric: t.metric,
      label: t.label,
      from: t.fmt(prev.v as number),
      to: t.fmt(latest.v as number),
      fromValue: prev.v as number,
      toValue: latest.v as number,
      source: latest.src,
      date,
      ageDays: age,
    });
  }
  return out.sort((a, b) => a.ageDays - b.ageDays);
}

/** One source's reading of a metric, formatted for display. */
export interface SourceReading {
  source: Source;
  value: number;
  formatted: string;
}

/**
 * A metric where AI Endurance and Garmin currently report DIFFERENT values — the "AIE 250 vs Garmin
 * 262" disagreement the user asked to see side by side. `inUse` is the reading that matches the merged
 * winner on `state.thresholds` (what the coach actually uses); `alt` is the other one, which a single
 * tap can pin (via the same conditional-override machinery as a change's "disagree").
 */
export interface SourceConflict {
  /** Stable key for snooze, per metric + the disagreeing values (so a new pair re-surfaces). */
  key: string;
  metric: string;
  label: string;
  readings: SourceReading[]; // every source's reading, in SOURCE_ORDER
  inUse: SourceReading; // the reading currently driving the coach (the merged winner)
  alt: SourceReading; // the other reading — what "use this instead" would pin
}

/**
 * Find the tracked threshold metrics where the recorded per-source readings (`state.thresholdsBySource`)
 * DISAGREE today — so the dashboard can show both numbers and which one is in force. Deterministic, no
 * LLM; tolerant of the field being absent on older snapshots. Pure.
 */
export function detectSourceConflicts(state: AthleteState): SourceConflict[] {
  const bySource = state.thresholdsBySource ?? {};
  const sources = Object.keys(bySource) as Source[];
  if (sources.length < 2) return [];
  const out: SourceConflict[] = [];
  for (const t of THRESHOLD_TRACKED) {
    const field = t.metric as keyof DisciplineThresholds;
    const readings: SourceReading[] = [];
    for (const src of sources) {
      const v = bySource[src]?.[field];
      if (typeof v === "number") readings.push({ source: src, value: v, formatted: t.fmt(v) });
    }
    const distinct = new Set(readings.map((r) => r.value));
    if (readings.length < 2 || distinct.size < 2) continue; // need ≥2 sources that actually disagree
    readings.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
    const live = state.thresholds.value?.[field];
    const inUse = readings.find((r) => r.value === live) ?? readings[0];
    const alt = readings.find((r) => r.value !== inUse.value) ?? readings[readings.length - 1];
    out.push({
      key: `conflict:${t.metric}:${[...distinct].sort((a, b) => a - b).join("v")}`,
      metric: t.metric,
      label: t.label,
      readings,
      inUse,
      alt,
    });
  }
  return out;
}
