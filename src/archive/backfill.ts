import type { AieClient } from "../mcp/aieClient.js";
import type { GarminClient } from "../mcp/garminClient.js";
import { extractJson } from "../state/assemble.js";
import { ArchiveStore, type ArchivedActivity, type GarminDay, type GarminActivity, type GarminExtraDay } from "./store.js";

/**
 * Historical backfill. AIE: page month-by-month (the list caps at 40/call, so narrow windows reach
 * older data). Garmin: per-day pulls, THROTTLED and RESUMABLE (the unofficial client is fragile and
 * rate-limited). Both append to the local archive; re-running skips what's already stored.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Tool → sport → extra read args. Exported so a test can pin the arg contract: `with_dfa_alpha1: true`
 * restores the DFA-α1 fields AIE moved behind an opt-in flag in 2026-08 (spec 10) — without it, every
 * newly archived row would permanently lack them (the archive is append-once, so a missed field is a
 * hole in the trend history forever). Swims never carry DFA-α1.
 */
export const BACKFILL_SPORTS: Array<[string, ArchivedActivity["sport"], Record<string, unknown>]> = [
  ["getRunningActivity", "Run", { with_dfa_alpha1: true }],
  ["getCyclingActivity", "Ride", { with_dfa_alpha1: true }],
  ["getSwimmingActivity", "Swim", {}],
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
    for (const [tool, sport, extraArgs] of BACKFILL_SPORTS) {
      const r = extractJson(await aie.read(tool as never, { startDate: s, endDate: e, ...extraArgs })) as { activities?: Record<string, unknown>[] };
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

/**
 * True when an MCP tool result is a failure rather than an answer: the protocol's `isError` flag (e.g. an
 * unknown tool on an older garmin_mcp pin), or garmin_mcp's own "Error …" text. A failure must not mark a
 * day as fetched; "No … data found" is a real answer and does. Pure — exported for tests.
 */
export function isToolFailure(raw: unknown): boolean {
  if (raw == null) return true;
  const r = raw as { isError?: boolean; content?: Array<{ type?: string; text?: string }> };
  if (r.isError === true) return true;
  const text = Array.isArray(r.content) ? r.content.find((c) => c?.type === "text")?.text ?? "" : "";
  return /^\s*(error\b|unknown tool|tool .* not found)/i.test(text);
}

/** Split [from, to] (inclusive ISO dates) into consecutive chunks of at most `size` days. Pure — exported for tests. */
export function dateChunks(fromIso: string, toIso: string, size: number): Array<{ start: string; end: string; days: string[] }> {
  const days: string[] = [];
  for (let d = new Date(`${fromIso}T00:00:00Z`); d <= new Date(`${toIso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  const out: Array<{ start: string; end: string; days: string[] }> = [];
  for (let i = 0; i < days.length; i += size) {
    const c = days.slice(i, i + size);
    out.push({ start: c[0], end: c[c.length - 1], days: c });
  }
  return out;
}

/** get_running_tolerance_trend (daily) payload → per-date rows. Defensive about the wrapper. Pure — exported for tests. */
export function toleranceRows(payload: unknown): GarminExtraDay[] {
  const p = payload as { trend?: unknown; daily?: unknown } | unknown[] | null;
  const list = Array.isArray(p) ? p : Array.isArray((p as { trend?: unknown })?.trend) ? ((p as { trend: unknown[] }).trend) : [];
  const out: GarminExtraDay[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    const date = typeof e?.date === "string" ? e.date.slice(0, 10) : "";
    if (!date) continue;
    out.push({
      date,
      runToleranceKm: num(e.tolerance_km),
      runAcuteLoadKm: num(e.acute_load_km),
      runDistanceKm: num(e.distance_km),
      runLoadRatio: num(e.load_ratio),
    });
  }
  return out;
}

/**
 * Backfill the a2ca5fc-connector daily signals into `garmin-extras.jsonl`: running tolerance via the daily
 * trend tool (≤90 days per call, so a year is ~5 calls) and heat/altitude acclimation via one get_acclimation
 * per day (throttled). Resumable: days already asked for are skipped, except the last `refreshDays`, which
 * are re-asked because Garmin updates them. A null response (tool missing on an older garmin_mcp pin, or an
 * error) leaves the day unmarked so a later run retries it; only a real answer, data or "no data", marks it.
 */
export async function backfillGarminExtras(
  garmin: GarminClient,
  store: ArchiveStore,
  fromIso: string,
  toIso: string,
  log: (m: string) => void,
  opts: { throttleMs?: number; refreshDays?: number } = {},
): Promise<{ toleranceDays: number; acclimationDays: number }> {
  const throttleMs = opts.throttleMs ?? 250;
  const refreshFrom = new Date(Date.parse(`${toIso}T00:00:00Z`) - (opts.refreshDays ?? 3) * 86400000).toISOString().slice(0, 10);
  const have = new Map((await store.loadGarminExtras()).map((d) => [d.date, d]));
  // `> refreshFrom`: the last `refreshDays` days, today included (0 → none re-asked).
  const due = (d: string, flag: "tolFetched" | "acclFetched") => d > refreshFrom || !have.get(d)?.[flag];

  let toleranceDays = 0;
  for (const c of dateChunks(fromIso, toIso, 90)) {
    if (!c.days.some((d) => due(d, "tolFetched"))) continue;
    const raw = await garmin.tryCall("get_running_tolerance_trend", { start_date: c.start, end_date: c.end, aggregation: "daily" });
    if (isToolFailure(raw)) {
      log(`  Garmin extras: running tolerance unavailable for ${c.start}…${c.end} (older garmin_mcp, or an error) — will retry next run`);
      continue;
    }
    const rows = new Map(toleranceRows(gInner(raw)).map((r) => [r.date, r]));
    const batch = c.days.map((d) => ({ ...(rows.get(d) ?? { date: d }), tolFetched: true }));
    await store.appendGarminExtras(batch);
    toleranceDays += rows.size;
    log(`  Garmin extras: running tolerance ${c.start}…${c.end} → ${rows.size} day(s) with data`);
    await sleep(throttleMs);
  }

  let acclimationDays = 0;
  let buffer: GarminExtraDay[] = [];
  for (const c of dateChunks(fromIso, toIso, 1)) {
    const date = c.start;
    if (!due(date, "acclFetched")) continue;
    const raw = await garmin.tryCall("get_acclimation", { date });
    await sleep(throttleMs);
    if (isToolFailure(raw)) continue; // tool missing / error: leave unmarked so a later run retries
    const a = gInner(raw) as Record<string, unknown> | null;
    const row: GarminExtraDay = { date, acclFetched: true };
    if (a && typeof a === "object") {
      row.heatAcclimationPct = num(a.heat_acclimation_percent);
      row.heatTrend = typeof a.heat_trend === "string" ? a.heat_trend : undefined;
      row.altitudeAcclimationM = num(a.altitude_acclimation_meters);
      if (row.heatAcclimationPct != null || row.altitudeAcclimationM != null) acclimationDays++;
    }
    buffer.push(row);
    if (buffer.length >= 30) {
      await store.appendGarminExtras(buffer);
      log(`  Garmin extras: acclimation through ${date} (${acclimationDays} day(s) with data)`);
      buffer = [];
    }
  }
  await store.appendGarminExtras(buffer);
  return { toleranceDays, acclimationDays };
}
