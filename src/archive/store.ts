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
}

export class ArchiveStore {
  private readonly dir = join(config.dataDir, "archive");
  private readonly actPath = join(this.dir, "activities.jsonl");
  private readonly garPath = join(this.dir, "garmin-daily.jsonl");

  private async ensure() {
    await mkdir(this.dir, { recursive: true });
  }
  private async readJsonl<T>(path: string): Promise<T[]> {
    try {
      return (await readFile(path, "utf8"))
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as T);
    } catch {
      return [];
    }
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

  async summary(): Promise<{ activities: number; actRange: string; garminDays: number; garRange: string }> {
    const acts = await this.loadActivities();
    const gar = await this.loadGarminDays();
    const range = (ds: string[]) => (ds.length ? `${ds[0]} → ${ds[ds.length - 1]}` : "—");
    return {
      activities: acts.length,
      actRange: range(acts.map((a) => a.date).sort()),
      garminDays: gar.length,
      garRange: range(gar.map((d) => d.date).sort()),
    };
  }
}
