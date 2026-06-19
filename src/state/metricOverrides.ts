import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { deriveZones } from "../insights/zones.js";
import type { AthleteState, DisciplineThresholds } from "./types.js";

/**
 * Athlete overrides for auto-detected metrics (the "👎 disagree" on the dashboard's Data-changes card).
 * Each is CONDITIONAL — `{ when, use }`: "while the platform keeps auto-detecting `when`, use `use`
 * instead". So your pin holds against the value you rejected, but if AI Endurance / Garmin later detect a
 * DIFFERENT number, the override stops applying and that new value resurfaces for you to judge afresh
 * (never silently masked forever). Holds live numbers, so it lives in the gitignored data dir, NOT the
 * profile (which rejects live numbers).
 */

export interface MetricOverride {
  when: number; // the auto-detected value you rejected
  use: number; // the value you want used instead
  ts: string;
}

export type MetricOverrides = Record<string, MetricOverride>;

function file(): string {
  return join(config.dataDir, "metric-overrides.json");
}

export async function loadMetricOverrides(): Promise<MetricOverrides> {
  try {
    const parsed = JSON.parse(await readFile(file(), "utf8")) as MetricOverrides;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function save(o: MetricOverrides): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file(), JSON.stringify(o, null, 2));
}

export async function setMetricOverride(metric: string, when: number, use: number): Promise<void> {
  const o = await loadMetricOverrides();
  o[metric] = { when, use, ts: new Date().toISOString() };
  await save(o);
}

export async function clearMetricOverride(metric: string): Promise<void> {
  const o = await loadMetricOverrides();
  if (metric in o) {
    delete o[metric];
    await save(o);
  }
}

/** Tracked-threshold metrics ARE `DisciplineThresholds` field names; vo2max is the one separate slot. */
type ThresholdMetric = keyof DisciplineThresholds;

/**
 * Apply overrides to a freshly-assembled state: where the platform's current value equals the rejected
 * `when`, substitute your `use` (and re-derive zones if a threshold changed). No-op when there are no
 * overrides, or when the platform value has since moved off `when`. Pure (mutates the passed state).
 */
export function applyMetricOverrides(state: AthleteState, overrides: MetricOverrides): void {
  const t: DisciplineThresholds = { ...(state.thresholds.value ?? {}) };
  let thresholdChanged = false;
  for (const [metric, ov] of Object.entries(overrides)) {
    if (metric === "vo2max") {
      if (state.vo2max.value === ov.when) {
        state.vo2max = { value: ov.use, source: "manual", note: `pinned by you (overrode auto-detected ${ov.when})` };
      }
      continue;
    }
    const field = metric as ThresholdMetric;
    if (typeof t[field] === "number" && t[field] === ov.when) {
      (t[field] as number) = ov.use;
      thresholdChanged = true;
    }
  }
  if (thresholdChanged) {
    state.thresholds = { value: t, source: "manual", note: "includes your pinned override(s) from the Data-changes card" };
    state.zones = { value: deriveZones(t), source: "derived", note: "standard zone models from your (pinned) thresholds" };
  }
}
