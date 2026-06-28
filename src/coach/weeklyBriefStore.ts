/**
 * Persistence for the Sunday weekly brief's week-over-week delta: one tiny JSON snapshot per week under
 * `data/weekly-brief/`, keyed by the Monday that starts the week (mirroring the daily `data/brief/` layout).
 * Write-if-absent (the Sunday job captures the week once; a re-run or a manual invocation that day doesn't
 * clobber it), and the delta reads the two most recent snapshots — so a skipped week reads as "vs {last
 * captured week}" rather than breaking the diff. Gitignored runtime data; best-effort throughout (a store
 * failure must never break a render or the morning ping).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { WeeklySnapshot } from "./weeklyBrief.js";

function dir(): string {
  return join(config.dataDir, "weekly-brief");
}

function file(weekStart: string): string {
  return join(dir(), `${weekStart}.json`);
}

/**
 * The most recent persisted weekly snapshots, oldest-first (so `[prev, curr]` for a 2-take). Returns up to
 * `limit` of them; fewer (or none) when history is short — the caller degrades to a "building history" note.
 */
export async function loadRecentWeeklyBriefs(limit = 2): Promise<WeeklySnapshot[]> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return []; // dir absent → no history yet
  }
  const weekStarts = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .sort(); // YYYY-MM-DD sorts chronologically
  const recent = weekStarts.slice(-limit);
  const out: WeeklySnapshot[] = [];
  for (const ws of recent) {
    try {
      const snap = JSON.parse(await readFile(file(ws), "utf8")) as WeeklySnapshot;
      if (snap && typeof snap.weekStart === "string") out.push(snap);
    } catch {
      /* skip an unreadable/partial snapshot rather than break the diff */
    }
  }
  return out;
}

/** Persist this week's snapshot once — the first writer of the week wins, so the diff's reference is stable. */
export async function persistWeeklyBriefIfAbsent(snap: WeeklySnapshot): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const path = file(snap.weekStart);
    try {
      await readFile(path, "utf8");
      return; // already captured this week
    } catch {
      /* not present yet — write it */
    }
    await writeFile(path, JSON.stringify(snap));
  } catch {
    /* never let snapshot persistence break a render or the ping */
  }
}
