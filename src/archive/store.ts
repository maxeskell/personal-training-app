import { mkdir, readFile, appendFile, writeFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

/** Parsed-JSONL cache keyed by path, invalidated by file mtime+size — avoids re-parsing the (large,
 *  decade-deep) archive on every dashboard request. Appends bump mtime, so the cache self-invalidates. */
const jsonlCache = new Map<string, { mtimeMs: number; size: number; data: unknown[] }>();

/**
 * Collapse to one record per key, LAST occurrence wins (the freshest backfill of that date/id),
 * preserving first-seen order. The append-only files can accrue duplicates: the backfill's
 * dedup-on-read is not atomic, so two overlapping runs (e.g. a manual `backfill` while the scheduled
 * `--daily-only` grind fires) each see a date as "missing" and both append it. Deduping at the read
 * boundary keeps the insight engine — which consumes the raw series — from double-weighting days.
 */
function dedupByKey<T>(items: T[], key: (t: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const it of items) byKey.set(key(it), it);
  return [...byKey.values()];
}

/**
 * Local historical archive (append-only JSONL). The backfill writes here; the insight engine reads
 * here for long-history trends. Two files under data/archive/:
 *   activities.jsonl   — one rich AIE activity per line (with a `sport` tag)
 *   garmin-daily.jsonl — one Garmin daily-metrics record per line
 * Append-only + resumable: re-running backfill skips dates already present.
 */
export interface ArchivedActivity {
  sport: "Run" | "Ride" | "Swim";
  date: string; // YYYY-MM-DD
  key: string; // dedup key
  raw: Record<string, unknown>;
}
export interface GarminDay {
  date: string;
  sleepScore?: number;
  sleepHours?: number;
  hrvMs?: number;
  restingHr?: number;
  weightKg?: number;
  trainingReadiness?: number;
  // Slice-1b health series (from get_sleep_data / get_all_day_stress / get_respiration_data / get_body_composition).
  deepSleepSec?: number;
  remSleepSec?: number;
  lightSleepSec?: number;
  awakeSleepSec?: number;
  skinTempDevC?: number; // overnight skin-temperature deviation from baseline (°C)
  bodyBatteryChange?: number; // overnight Body Battery recharge
  avgSleepRespiration?: number;
  avgWakingRespiration?: number;
  avgStressLevel?: number; // all-day average stress (0–100)
  maxStressLevel?: number;
  muscleMassKg?: number;
  bodyFatPct?: number;
}
/** A Garmin activity (the full decade of workouts — Garmin keeps far more history than AI Endurance). */
export interface GarminActivity {
  id: string;
  date: string; // YYYY-MM-DD
  type?: string;
  name?: string;
  raw: Record<string, unknown>;
}

/** Per-activity summary parsed from get_activity_fit_data (+ weather) — powers the heat confounder. */
export interface FitSummary {
  activityId: string;
  date: string;
  sport: string; // "Run" | "Ride" | "Swim"
  avgHr?: number;
  avgPowerW?: number;
  distanceM?: number;
  durationS?: number;
  avgTempC?: number;
  minTempC?: number;
  maxTempC?: number;
  hrCoolThirdBpm?: number; // avg HR in the coolest third of the session
  hrHotThirdBpm?: number; // avg HR in the hottest third
  trainingEffect?: number;
  weatherTempC?: number; // ambient (from get_activity_weather, F→C corrected)
  humidityPct?: number;
}

export class ArchiveStore {
  private readonly dir = join(config.dataDir, "archive");
  private readonly actPath = join(this.dir, "activities.jsonl");
  private readonly garPath = join(this.dir, "garmin-daily.jsonl");
  private readonly garActPath = join(this.dir, "garmin-activities.jsonl");
  private readonly fitSumPath = join(this.dir, "fit-summaries.jsonl");

  private async ensure() {
    await mkdir(this.dir, { recursive: true });
  }
  private async readJsonl<T>(path: string): Promise<T[]> {
    // Serve from cache when the file is unchanged (mtime+size) — re-parsing the decade-deep archive on
    // every request was O(file) × routes.
    let mtimeMs = 0;
    let size = 0;
    try {
      const st = await stat(path);
      mtimeMs = st.mtimeMs;
      size = st.size;
      const hit = jsonlCache.get(path);
      if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.data as T[];
    } catch {
      return []; // no file yet
    }
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return []; // no file yet
    }
    // Parse per line: a single corrupt/partial line (crash mid-append) must not discard the whole archive.
    const out: T[] = [];
    let skipped = 0;
    for (const l of text.split("\n")) {
      if (!l.trim()) continue;
      try {
        out.push(JSON.parse(l) as T);
      } catch {
        skipped++;
      }
    }
    if (skipped) console.warn(`[archive] skipped ${skipped} unparseable line(s) in ${path}`);
    jsonlCache.set(path, { mtimeMs, size, data: out });
    return out;
  }

  async loadActivities(): Promise<ArchivedActivity[]> {
    return dedupByKey(await this.readJsonl<ArchivedActivity>(this.actPath), (a) => a.key);
  }
  async activityKeys(): Promise<Set<string>> {
    return new Set((await this.loadActivities()).map((a) => a.key));
  }
  async appendActivities(items: ArchivedActivity[]): Promise<void> {
    if (!items.length) return;
    await this.ensure();
    await appendFile(this.actPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  }

  async loadGarminDays(): Promise<GarminDay[]> {
    return dedupByKey(await this.readJsonl<GarminDay>(this.garPath), (d) => d.date);
  }
  async garminDates(): Promise<Set<string>> {
    return new Set((await this.loadGarminDays()).map((d) => d.date));
  }
  async appendGarminDays(days: GarminDay[]): Promise<void> {
    if (!days.length) return;
    await this.ensure();
    await appendFile(this.garPath, days.map((d) => JSON.stringify(d)).join("\n") + "\n");
  }

  async loadGarminActivities(): Promise<GarminActivity[]> {
    return dedupByKey(await this.readJsonl<GarminActivity>(this.garActPath), (a) => a.id);
  }
  async garminActivityIds(): Promise<Set<string>> {
    return new Set((await this.loadGarminActivities()).map((a) => a.id));
  }
  async appendGarminActivities(items: GarminActivity[]): Promise<void> {
    if (!items.length) return;
    await this.ensure();
    await appendFile(this.garActPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  }

  async loadFitSummaries(): Promise<FitSummary[]> {
    return dedupByKey(await this.readJsonl<FitSummary>(this.fitSumPath), (s) => String(s.activityId));
  }
  async fitSummaryIds(): Promise<Set<string>> {
    return new Set((await this.loadFitSummaries()).map((s) => String(s.activityId)));
  }
  async appendFitSummaries(items: FitSummary[]): Promise<void> {
    if (!items.length) return;
    await this.ensure();
    await appendFile(this.fitSumPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  }

  /**
   * Physically de-duplicate every archive file in place (one record per date/id, last write wins).
   * The loaders already dedup on read, so this is a housekeeping pass that shrinks the on-disk files
   * and makes the raw line counts match the distinct counts. Atomic per file (tmp + rename), and a
   * no-op for files with no duplicates. Returns before/after line counts per file.
   */
  async compact(): Promise<Array<{ file: string; before: number; after: number; removed: number }>> {
    const specs: Array<{ path: string; name: string; key: (x: Record<string, unknown>) => string }> = [
      { path: this.actPath, name: "activities.jsonl", key: (a) => String(a.key) },
      { path: this.garPath, name: "garmin-daily.jsonl", key: (d) => String(d.date) },
      { path: this.garActPath, name: "garmin-activities.jsonl", key: (a) => String(a.id) },
      { path: this.fitSumPath, name: "fit-summaries.jsonl", key: (s) => String(s.activityId) },
    ];
    const out: Array<{ file: string; before: number; after: number; removed: number }> = [];
    for (const { path, name, key } of specs) {
      const raw = await this.readJsonl<Record<string, unknown>>(path);
      const deduped = dedupByKey(raw, key);
      if (deduped.length !== raw.length) {
        await this.ensure();
        const tmp = `${path}.tmp`;
        await writeFile(tmp, deduped.map((d) => JSON.stringify(d)).join("\n") + "\n");
        await rename(tmp, path); // atomic on POSIX — never leaves a half-written archive
        jsonlCache.delete(path);
      }
      out.push({ file: name, before: raw.length, after: deduped.length, removed: raw.length - deduped.length });
    }
    return out;
  }

  /** Distinct counts/ranges — the loaders dedup on read, so these reflect one record per date/id. */
  async summary(): Promise<{ activities: number; actRange: string; garminDays: number; garRange: string; garminActivities: number; garActRange: string }> {
    const acts = await this.loadActivities();
    const gar = await this.loadGarminDays();
    const gAct = await this.loadGarminActivities();
    const range = (ds: string[]) => (ds.length ? `${ds[0]} → ${ds[ds.length - 1]}` : "—");
    return {
      activities: acts.length,
      actRange: range(acts.map((a) => a.date).sort()),
      garminDays: gar.length,
      garRange: range(gar.map((d) => d.date).sort()),
      garminActivities: gAct.length,
      garActRange: range(gAct.map((a) => a.date).sort()),
    };
  }
}
