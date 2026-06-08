import { mkdir, readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";

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
    return out;
  }

  async loadActivities(): Promise<ArchivedActivity[]> {
    return this.readJsonl<ArchivedActivity>(this.actPath);
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
    return this.readJsonl<GarminDay>(this.garPath);
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
    return this.readJsonl<GarminActivity>(this.garActPath);
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
    return this.readJsonl<FitSummary>(this.fitSumPath);
  }
  async fitSummaryIds(): Promise<Set<string>> {
    return new Set((await this.loadFitSummaries()).map((s) => String(s.activityId)));
  }
  async appendFitSummaries(items: FitSummary[]): Promise<void> {
    if (!items.length) return;
    await this.ensure();
    await appendFile(this.fitSumPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
  }

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
