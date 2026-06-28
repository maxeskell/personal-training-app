/**
 * Persistence for the daily brief's since-yesterday diff: one tiny JSON snapshot per day under
 * `data/brief/`, mirroring the `data/state/` per-day layout. Write-if-absent (the first dashboard render
 * of the day captures the reference point; later renders/syncs don't clobber it), and "prior" is the most
 * recent snapshot strictly before today — so a skipped day reads as "since {last captured date}" rather
 * than breaking the diff. Gitignored runtime data; best-effort throughout (a store failure must never
 * break a render).
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import type { BriefSnapshot } from "./dailyBrief.js";

function dir(): string {
  return join(config.dataDir, "brief");
}

function file(date: string): string {
  return join(dir(), `${date}.json`);
}

/** The most recent persisted snapshot strictly before `beforeDate`, or null if none exists. */
export async function loadPriorBrief(beforeDate: string): Promise<BriefSnapshot | null> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return null; // dir absent → no history yet
  }
  const dates = names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((d) => d < beforeDate)
    .sort();
  const latest = dates[dates.length - 1];
  if (!latest) return null;
  try {
    const snap = JSON.parse(await readFile(file(latest), "utf8")) as BriefSnapshot;
    return snap && typeof snap.date === "string" ? snap : null;
  } catch {
    return null;
  }
}

/** Persist today's snapshot once — the first writer of the day wins, so the diff's reference is stable. */
export async function persistBriefIfAbsent(snap: BriefSnapshot): Promise<void> {
  try {
    await mkdir(dir(), { recursive: true });
    const path = file(snap.date);
    try {
      await readFile(path, "utf8");
      return; // already captured today
    } catch {
      /* not present yet — write it */
    }
    await writeFile(path, JSON.stringify(snap));
  } catch {
    /* never let snapshot persistence break a render */
  }
}
