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

  let added = 0;
  let buffer: GarminDay[] = [];
  for (const date of todo) {
    const sleep_ = inner(await garmin.tryCall("get_sleep_summary", { date }));
    await sleep(throttleMs);
    const day: GarminDay = {
      date,
      sleepScore: num((sleep_ as any)?.sleep_score),
      sleepHours: num((sleep_ as any)?.sleep_hours),
      hrvMs: num((sleep_ as any)?.avg_overnight_hrv),
      restingHr: num((sleep_ as any)?.resting_heart_rate) ?? num((sleep_ as any)?.restingHeartRate),
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
