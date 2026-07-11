import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GarminClient } from "../mcp/garminClient.js";
import { garminInner } from "../state/assemble.js";
import { fitStreamsDir } from "../insights/fit.js";
import { ArchiveStore, type FitSummary } from "./store.js";
import { archiveBuffer, manifestHashes } from "./activityArchive.js";

/**
 * Pull recent Garmin activity .FIT data into the archive — BOTH layers:
 *
 *   1. Thermal/effort SUMMARIES via get_activity_fit_data (session totals, temperature_stats, lap HRV —
 *      not per-second samples) → fit-summaries archive (heat confounder + session card's THERMAL block).
 *   2. RAW per-second .FIT streams via download_activity_file (garmin_mcp ≥ d31de79, 2026-06-10) →
 *      FIT_STREAMS_DIR, unlocking in-session biomechanics (decoupling / cadence / GCT) hands-free.
 *      On older builds the tool is absent and this layer degrades to manual export (Export Original).
 *
 * Dedups against what's already archived/on disk, so in steady state it fetches only genuinely-new
 * activities (≈0–1/day). Reuses an already-connected client so callers (CLI + dashboard Sync) share
 * one session.
 */

const DOWNLOAD_TOOL = "download_activity_file";

/** Whether the connected garmin_mcp build can download raw .FIT streams. */
export async function hasStreamDownloadTool(g: GarminClient): Promise<boolean> {
  return (await g.listToolNames()).includes(DOWNLOAD_TOOL);
}

/** Outcome of a raw-stream download — `ok` plus, on failure, the REAL reason (loud over silent). */
export interface FitDownloadResult {
  ok: boolean;
  /** When ok=false: one-line cause — distinguishes a failed/auth call from a file that never landed. */
  reason?: string;
}

/**
 * Download one activity's raw per-second .FIT into `dir` as `{activityId}.fit` (no-op if present).
 * Caller is responsible for the capability check.
 *
 * Returns the REAL outcome instead of inferring success purely from `existsSync`: a swallowed Garmin
 * error (auth/timeout) and a call that "succeeded" but wrote nothing at the expected path are different
 * failures, and the caller needs to tell them apart to surface an honest gap rather than a clean zero.
 */
export async function downloadFitStream(g: GarminClient, activityId: string, dir = fitStreamsDir()): Promise<FitDownloadResult> {
  const path = join(dir, `${activityId}.fit`);
  if (existsSync(path)) return { ok: true };
  mkdirSync(dir, { recursive: true });
  const res = await g.tryCall(DOWNLOAD_TOOL, { activity_id: activityId, format: "fit", output_dir: dir });
  // tryCall returns null on a thrown error/timeout; an MCP tool failure instead comes back as a result
  // flagged isError. Either way the download did not happen — say so, don't pretend it's just absent.
  if (res == null || (res as { isError?: boolean }).isError) {
    return { ok: false, reason: `${DOWNLOAD_TOOL} call failed (Garmin error/timeout/auth) — see the [garmin] log` };
  }
  if (existsSync(path)) return { ok: true };
  return {
    ok: false,
    reason: `${DOWNLOAD_TOOL} returned but no ${activityId}.fit landed in ${dir} (unexpected filename/format — check the garmin_mcp build, or export the original .FIT manually)`,
  };
}

const num = (x: unknown): number | undefined =>
  typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : undefined;
const sportOf = (s: string): string => (/cycl|bike|ride/i.test(s) ? "Ride" : /run/i.test(s) ? "Run" : /swim/i.test(s) ? "Swim" : s);

/**
 * Garmin activity types whose raw .FIT we pull: the three endurance sports PLUS multisport races
 * (typeKey "multi_sport" — a triathlon/duathlon lands as ONE parent activity). Multisport was previously
 * filtered out here, which silently dropped RACE-DAY streams — the one day granular data matters most —
 * and read as a clean "0 fetched; 0 failed". Exported for tests.
 */
export function isStreamCandidate(type: string): boolean {
  return /run|cycl|bike|ride|swim|multi_?sport|triathlon|duathlon/.test(type);
}

/** Multisport parents get their RAW stream only: get_activity_fit_data's single-session summary can't
 *  represent per-leg (swim/bike/run) data, so the thermal/effort summary layer skips them. */
export function isMultisportType(type: string): boolean {
  return /multi_?sport|triathlon|duathlon/.test(type);
}
// get_activity_weather reports temperature in °F mislabelled as °C (e.g. 63 ≈ 17°C) — correct values >45.
const toC = (t: number | undefined): number | undefined => (t == null ? undefined : t > 45 ? +(((t - 32) * 5) / 9).toFixed(1) : t);

export interface FitSyncResult {
  total: number; // candidate activities seen
  added: number;
  skipped: number; // already archived, or summary-layer N/A (multisport parent — raw stream only)
  failed: number;
  summaries: FitSummary[];
  /** Raw per-second streams pulled into FIT_STREAMS_DIR (0 when download_activity_file is absent). */
  streamsDownloaded: number;
  /** Whether the connected garmin_mcp build offers raw-stream download at all. */
  streamsSupported: boolean;
  /** Raw-stream downloads that were ATTEMPTED but failed (no longer swallowed — surfaced to the caller). */
  streamsFailed: number;
  /** One line per failed stream download (`{id}: {reason}`), for a loud completeness readout. */
  streamFailures: string[];
}

export async function syncFitSummaries(g: GarminClient, store: ArchiveStore, limit = 25, log?: (msg: string) => void): Promise<FitSyncResult> {
  const have = await store.fitSummaryIds();
  const actsRaw = garminInner(await g.tryCall("get_activities", { limit }));
  const list = ((actsRaw as { activities?: Array<Record<string, unknown>> })?.activities ?? (Array.isArray(actsRaw) ? actsRaw : [])) as Array<Record<string, unknown>>;
  const streamsSupported = await hasStreamDownloadTool(g);
  const streamsDir = fitStreamsDir();

  let added = 0;
  let skipped = 0;
  let failed = 0;
  let streamsDownloaded = 0;
  let streamsFailed = 0;
  const streamFailures: string[] = [];
  const buffer: FitSummary[] = [];
  // Forever-forward: every raw stream we pull is also deposited in the DURABLE activity archive, so the
  // corpus you own grows automatically. Best-effort — archiving must never break a sync. Hashes loaded once.
  const archiveHashes = manifestHashes();
  for (const a of list) {
    const id = String(a.activityId ?? a.id ?? a.activity_id ?? "");
    const type = String(a.type ?? (a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "").toLowerCase();
    if (!id || !isStreamCandidate(type)) continue;
    // Raw stream first, independent of the summary dedup — earlier syncs predate stream download,
    // so already-archived activities in the window still get their .FIT pulled. Best-effort.
    if (streamsSupported && !existsSync(join(streamsDir, `${id}.fit`))) {
      const dl = await downloadFitStream(g, id, streamsDir);
      if (dl.ok) {
        streamsDownloaded++;
        log?.(`  ⬇ ${id}.fit → ${streamsDir}`);
        try {
          archiveBuffer(readFileSync(join(streamsDir, `${id}.fit`)), { originalName: `${id}.fit`, source: "garmin" }, archiveHashes);
        } catch {
          /* archiving is best-effort — a failure here never breaks the sync */
        }
      } else {
        streamsFailed++;
        streamFailures.push(`${id}: ${dl.reason}`);
        log?.(`  ? ${id}: stream download failed — ${dl.reason}`);
      }
    }
    // Multisport parent (race day): the raw stream above IS the value — its legs are expanded at read
    // time (expandMultisportFit). The per-sport summary layer can't represent it, so don't fetch one.
    if (isMultisportType(type)) {
      skipped++;
      continue;
    }
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
  return { total: list.length, added, skipped, failed, summaries: buffer, streamsDownloaded, streamsSupported, streamsFailed, streamFailures };
}
