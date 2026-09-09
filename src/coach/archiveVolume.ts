import { ArchiveStore } from "../archive/store.js";
import type { ArchiveVolume, VolumeActivity } from "./seasonArc.js";

/**
 * Live annual-volume feed for the Season arc's "long arc" card. The TrainingPeaks-built
 * `career-history.json` trajectory stops where that export stopped, so every year since is summed
 * straight from the local archive (`data/archive/*.jsonl`) at render time — never cached in the career
 * file, never hand-typed ("live numbers come live"). Garmin activities lead: elapsed time across ALL
 * sports is the same basis as the TrainingPeaks years (2023: 221h vs 225h, 2024: 202h vs 203h). AI
 * Endurance's swim/bike/run moving time is the fallback for a year Garmin doesn't cover.
 * Best-effort: any failure returns empty lists, which leaves the card exactly as it was (degrade-don't-crash).
 */
export async function loadArchiveVolume(store = new ArchiveStore()): Promise<ArchiveVolume> {
  try {
    const [garminActs, aieActs] = await Promise.all([store.loadGarminActivities(), store.loadActivities()]);
    const garmin: VolumeActivity[] = [];
    for (const a of garminActs) {
      const r = a.raw ?? {};
      const secs = num(r.duration_seconds) ?? num(r.moving_duration_seconds);
      const date = isoDay(a.date);
      if (!date || secs == null || secs <= 0) continue;
      const m = num(r.distance_meters);
      garmin.push({ date, hours: secs / 3600, km: m != null ? m / 1000 : undefined });
    }
    const aie: VolumeActivity[] = [];
    for (const a of aieActs) {
      const r = a.raw ?? {};
      const secs = num(r.activity_movingtime);
      const date = isoDay(a.date);
      if (!date || secs == null || secs <= 0) continue;
      aie.push({ date, hours: secs / 3600, km: num(r.distance_in_km) });
    }
    return { garmin, aie };
  } catch {
    return { garmin: [], aie: [] };
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function isoDay(v: unknown): string | undefined {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined;
}
