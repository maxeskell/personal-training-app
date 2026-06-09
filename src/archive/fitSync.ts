import type { GarminClient } from "../mcp/garminClient.js";
import { garminInner } from "../state/assemble.js";
import { ArchiveStore, type FitSummary } from "./store.js";

/**
 * Pull recent Garmin activity .FIT *summaries* (thermal / effort) into the archive.
 *
 * NOTE: get_activity_fit_data returns a PARSED SUMMARY (session totals, temperature_stats, lap HRV) —
 * NOT per-second samples. This populates the thermal/effort layer (heat confounder + the session
 * card's THERMAL block). It does NOT produce the in-session biomechanics (decoupling / cadence / GCT),
 * which need a raw per-second .FIT exported into FIT_STREAMS_DIR — no Garmin MCP tool exposes that.
 *
 * Dedups against what's already archived, so in steady state it fetches only genuinely-new activities
 * (≈0–1/day). Reuses an already-connected client so callers (CLI + dashboard Sync) share one session.
 */

const num = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : undefined;
const sportOf = (s: string): string => (/cycl|bike|ride/i.test(s) ? "Ride" : /run/i.test(s) ? "Run" : /swim/i.test(s) ? "Swim" : s);
// get_activity_weather reports temperature in °F mislabelled as °C (e.g. 63 ≈ 17°C) — correct values >45.
const toC = (t: number | undefined): number | undefined => (t == null ? undefined : t > 45 ? +(((t - 32) * 5) / 9).toFixed(1) : t);

export interface FitSyncResult {
  total: number; // candidate activities seen
  added: number;
  skipped: number; // already archived
  failed: number;
  summaries: FitSummary[];
}

export async function syncFitSummaries(g: GarminClient, store: ArchiveStore, limit = 25, log?: (msg: string) => void): Promise<FitSyncResult> {
  const have = await store.fitSummaryIds();
  const actsRaw = garminInner(await g.tryCall("get_activities", { limit }));
  const list = ((actsRaw as { activities?: Array<Record<string, unknown>> })?.activities ?? (Array.isArray(actsRaw) ? actsRaw : [])) as Array<Record<string, unknown>>;

  let added = 0;
  let skipped = 0;
  let failed = 0;
  const buffer: FitSummary[] = [];
  for (const a of list) {
    const id = String(a.activityId ?? a.id ?? a.activity_id ?? "");
    const type = String(a.type ?? (a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "").toLowerCase();
    if (!id || !/run|cycl|bike|ride|swim/.test(type)) continue;
    if (have.has(id)) {
      skipped++;
      continue;
    }
    const fd = garminInner(await g.tryCall("get_activity_fit_data", { activity_id: id }));
    const sess = (fd as { session?: Record<string, unknown> })?.session;
    if (!sess) {
      failed++;
      log?.(`  ? ${id} (${type}): no session in get_activity_fit_data`);
      continue;
    }
    const ts = (sess.temperature_stats ?? {}) as Record<string, unknown>;
    const weather = garminInner(await g.tryCall("get_activity_weather", { activity_id: id })) as Record<string, unknown> | null;
    const sum: FitSummary = {
      activityId: id,
      date: String(sess.start_time ?? a.start_time ?? "").slice(0, 10),
      sport: sportOf(String(sess.sport ?? type)),
      avgHr: num(sess.avg_heart_rate_bpm),
      avgPowerW: num(sess.avg_power) ?? num(sess.avg_power_w) ?? num(sess.normalized_power),
      distanceM: num(sess.total_distance_m),
      durationS: num(sess.total_timer_time_s) ?? num(sess.total_elapsed_time_s),
      avgTempC: num(ts.avg_temp_c),
      minTempC: num(ts.min_temp_c),
      maxTempC: num(ts.max_temp_c),
      hrCoolThirdBpm: num(ts.avg_hr_coolest_third_bpm),
      hrHotThirdBpm: num(ts.avg_hr_hottest_third_bpm),
      trainingEffect: num(sess.total_training_effect),
      weatherTempC: toC(num(weather?.temperature_celsius)),
      humidityPct: num(weather?.humidity_percent),
    };
    buffer.push(sum);
    added++;
    log?.(`  + ${id} (${sum.sport}, ${sum.date}, ${sum.avgTempC ?? "?"}°C${sum.avgPowerW != null ? `, ${sum.avgPowerW}W` : ""})`);
  }
  await store.appendFitSummaries(buffer);
  return { total: list.length, added, skipped, failed, summaries: buffer };
}
