import type { AieClient } from "../mcp/aieClient.js";
import type { GarminClient } from "../mcp/garminClient.js";
import { extractJson } from "../state/assemble.js";
import { ArchiveStore, type ArchivedActivity, type GarminDay, type GarminActivity } from "./store.js";

/**
 * Historical backfill. AIE: page month-by-month (the list caps at 40/call, so narrow windows reach
 * older data). Garmin: per-day pulls, THROTTLED and RESUMABLE (the unofficial client is fragile and
 * rate-limited). Both append to the local archive; re-running skips what's already stored.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SPORTS: Array<[string, ArchivedActivity["sport"]]> = [
  ["getRunningActivity", "Run"],
  ["getCyclingActivity", "Ride"],
  ["getSwimmingActivity", "Swim"],
];

function monthsBetween(fromIso: string, toIso: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let d = new Date(`${fromIso.slice(0, 7)}-01T00:00:00Z`);
  const end = new Date(`${toIso.slice(0, 7)}-01T00:00:00Z`);
  while (d <= end) {
    const start = d.toISOString().slice(0, 10);
    const next = new Date(d);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const last = new Date(next.getTime() - 86_400_000).toISOString().slice(0, 10);
    out.push([start, last]);
    d = next;
  }
  return out;
}

function num(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Page AIE activities month-by-month, dedup against the archive, append new ones. */
export async function backfillActivities(
  aie: AieClient,
  store: ArchiveStore,
  fromIso: string,
  toIso: string,
  log: (m: string) => void,
): Promise<number> {
  const seen = await store.activityKeys();
  let added = 0;
  for (const [s, e] of monthsBetween(fromIso, toIso)) {
    const batch: ArchivedActivity[] = [];
    for (const [tool, sport] of SPORTS) {
      const r = extractJson(await aie.read(tool as never, { startDate: s, endDate: e })) as { activities?: Record<string, unknown>[] };
      for (const a of r?.activities ?? []) {
        const date = String(a.activity_date_local ?? a.activity_date ?? "").slice(0, 10);
        if (!date) continue;
        const key = `${date}|${sport}|${a.activity_movingtime ?? ""}|${a.activity_name ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        batch.push({ sport, date, key, raw: a });
      }
    }
    await store.appendActivities(batch);
    added += batch.length;
    log(`  AIE ${s.slice(0, 7)}: +${batch.length} activities (total new ${added})`);
  }
  return added;
}

function gInner(r: unknown): unknown {
  const o = extractJson(r) as { result?: unknown } | unknown;
  const v = (o as { result?: unknown })?.result ?? o;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return v;
}

/**
 * Pull ALL Garmin activities (the full decade — Garmin keeps far more than AI Endurance) via
 * paginated get_activities. Each has an `id`, so unlike AIE these are detail-addressable later.
 * Fast (~pageSize per call); dedup by id; resumable.
 */
export async function backfillGarminActivities(
  garmin: GarminClient,
  store: ArchiveStore,
  log: (m: string) => void,
  pageSize = 100,
  incremental = false,
): Promise<number> {
  const seen = await store.garminActivityIds();
  let start = 0;
  let added = 0;
  for (;;) {
    const r = gInner(await garmin.tryCall("get_activities", { start, limit: pageSize }));
    const arr: Record<string, unknown>[] = Array.isArray(r) ? r : ((r as { activities?: unknown[] })?.activities as Record<string, unknown>[]) ?? [];
    if (!arr.length) break;
    const batch: GarminActivity[] = [];
    for (const a of arr) {
      const id = String(a.id ?? a.activityId ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      batch.push({
        id,
        date: String(a.start_time ?? a.startTimeLocal ?? a.startTimeGMT ?? "").slice(0, 10),
        type: typeof a.type === "string" ? a.type : typeof a.activityType === "string" ? a.activityType : undefined,
        name: typeof a.name === "string" ? a.name : undefined,
        raw: a,
      });
    }
    await store.appendGarminActivities(batch);
    added += batch.length;
    log(`  Garmin activities: page @${start} → +${batch.length} (total new ${added})`);
    // Incremental refresh (recurring auto-heal): activities come newest-first, so a page that yields no
    // new ids means everything older is already known — stop, instead of re-walking the whole history.
    if (incremental && batch.length === 0) break;
    start += pageSize;
    await sleep(150);
  }
  return added;
}

/** Earliest Garmin activity date in the archive (the floor for daily-metric backfill). */
export async function earliestGarminActivityDate(store: ArchiveStore): Promise<string | null> {
  const acts = await store.loadGarminActivities();
  const dates = acts.map((a) => a.date).filter(Boolean).sort();
  return dates.length ? dates[0] : null;
}

/** Pull Garmin daily metrics for each date in range, throttled + resumable, with a per-run cap. */
export async function backfillGarmin(
  garmin: GarminClient,
  store: ArchiveStore,
  fromIso: string,
  toIso: string,
  log: (m: string) => void,
  throttleMs = 250,
  maxDays = Infinity,
): Promise<number> {
  const have = await store.garminDates();
  const inner = (r: unknown) => {
    const o = extractJson(r) as { result?: unknown } | unknown;
    const v = (o as { result?: unknown })?.result ?? o;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  };

  const dates: string[] = [];
  for (let d = new Date(`${fromIso}T00:00:00Z`); d <= new Date(`${toIso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const allTodo = dates.filter((d) => !have.has(d));
  const todo = Number.isFinite(maxDays) ? allTodo.slice(0, maxDays) : allTodo;
  log(`  Garmin: fetching ${todo.length} of ${allTodo.length} remaining days (${dates.length} in range)`);

  // Body composition is a range call — fetch once and index by calendar date (muscle mass for fuelling).
  const bodyComp = new Map<string, { muscleMassKg?: number; bodyFatPct?: number; weightKg?: number }>();
  if (todo.length) {
    const bcFrom = todo[0];
    const bcTo = todo[todo.length - 1];
    const bc = inner(await garmin.tryCall("get_body_composition", { start_date: bcFrom, end_date: bcTo }));
    for (const w of ((bc as { dateWeightList?: any[] })?.dateWeightList ?? [])) {
      const cd = String((w as any)?.calendarDate ?? "").slice(0, 10);
      if (!cd) continue;
      const g = (x: unknown) => num(x);
      bodyComp.set(cd, {
        muscleMassKg: g((w as any)?.muscleMass) != null ? g((w as any)?.muscleMass)! / 1000 : undefined,
        bodyFatPct: g((w as any)?.bodyFat),
        weightKg: g((w as any)?.weight) != null ? g((w as any)?.weight)! / 1000 : undefined,
      });
    }
    await sleep(throttleMs);
  }

  let added = 0;
  let buffer: GarminDay[] = [];
  for (const date of todo) {
    // get_sleep_data is the rich payload: stages, skin temp, overnight HRV, RHR, Body Battery change,
    // sleep respiration + score (supersedes get_sleep_summary). Plus daytime stress + waking respiration.
    const sd = inner(await garmin.tryCall("get_sleep_data", { date }));
    await sleep(throttleMs);
    const stress_ = inner(await garmin.tryCall("get_all_day_stress", { date }));
    await sleep(throttleMs);
    const resp_ = inner(await garmin.tryCall("get_respiration_data", { date }));
    await sleep(throttleMs);
    const dto = (sd as any)?.dailySleepDTO ?? {};
    const bc = bodyComp.get(date) ?? {};
    const day: GarminDay = {
      date,
      sleepScore: num(dto?.sleepScores?.overall?.value) ?? num((sd as any)?.sleep_score),
      sleepHours: num(dto?.sleepTimeSeconds) != null ? +(num(dto.sleepTimeSeconds)! / 3600).toFixed(2) : undefined,
      hrvMs: num((sd as any)?.avgOvernightHrv) ?? num((sd as any)?.avg_overnight_hrv),
      restingHr: num((sd as any)?.restingHeartRate) ?? num((sd as any)?.resting_heart_rate),
      deepSleepSec: num(dto?.deepSleepSeconds),
      remSleepSec: num(dto?.remSleepSeconds),
      lightSleepSec: num(dto?.lightSleepSeconds),
      awakeSleepSec: num(dto?.awakeSleepSeconds),
      skinTempDevC: num((sd as any)?.avgSkinTempDeviationC),
      bodyBatteryChange: num((sd as any)?.bodyBatteryChange),
      avgSleepRespiration: num(dto?.averageRespirationValue) ?? num((resp_ as any)?.avgSleepRespirationValue),
      avgWakingRespiration: num((resp_ as any)?.avgWakingRespirationValue),
      avgStressLevel: num((stress_ as any)?.avgStressLevel),
      maxStressLevel: num((stress_ as any)?.maxStressLevel),
      muscleMassKg: bc.muscleMassKg,
      bodyFatPct: bc.bodyFatPct,
      weightKg: bc.weightKg,
    };
    buffer.push(day);
    added++;
    if (buffer.length >= 20) {
      await store.appendGarminDays(buffer);
      log(`  Garmin: archived through ${date} (+${added})`);
      buffer = [];
    }
  }
  await store.appendGarminDays(buffer);
  return added;
}
