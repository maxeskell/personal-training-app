/**
 * Garmin raw-.FIT HISTORY backfill into the durable activity archive — pull every original `.FIT` Garmin
 * holds, so the corpus you own is complete back to the start, independent of any export. Companion to
 * `archive:import` (which seeds from a local export) and the sync's forever-forward hook.
 *
 * Reuses {@link downloadFitStream} (the same per-activity download the dashboard Sync uses) but lands each
 * file in a temp dir, then deposits it in the archive (source "garmin") — so it never pollutes the HOT
 * `data/fit-streams/` with a decade of files. RESUMABLE + THROTTLED + CHUNKED: it skips activities already
 * archived (by id — which also means anything your TP import already covered is not re-downloaded), pauses
 * between calls to respect Garmin rate limits, and `--chunk N` caps a run so a long history grinds over
 * several sittings. Best-effort: a failed download is recorded, never thrown.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GarminClient } from "../mcp/garminClient.js";
import type { GarminActivity } from "./store.js";
import { downloadFitStream } from "./fitSync.js";
import { archiveBuffer, manifestHashes, loadManifest, activityArchiveDir } from "./activityArchive.js";

export interface BackfillFitsResult {
  total: number; // activities known
  pending: number; // not yet archived (the work list)
  downloaded: number;
  archived: number;
  duplicates: number; // downloaded but content already archived (e.g. via the TP import, different name)
  failed: number;
  failures: string[]; // `${id}: ${reason}`, capped by the caller when printing
}

/**
 * The Garmin activity ids still missing from the archive — the resumable work list. Skips ids already
 * archived (so an import-covered activity isn't re-downloaded) and de-dups the input. PURE (tested).
 */
export function pendingActivityIds(activities: Array<{ id: string }>, archivedIds: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of activities) {
    const id = String(a.id ?? "");
    if (!id || archivedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export async function backfillGarminFits(
  g: GarminClient,
  activities: GarminActivity[],
  opts: { throttleMs?: number; chunk?: number; dir?: string } = {},
  log?: (m: string) => void,
): Promise<BackfillFitsResult> {
  const dir = opts.dir ?? activityArchiveDir();
  const throttleMs = opts.throttleMs ?? 300;
  const chunk = opts.chunk ?? Infinity;
  const archivedIds = new Set(loadManifest(dir).map((e) => e.id));
  const hashes = manifestHashes(dir);
  const pending = pendingActivityIds(activities, archivedIds);
  const res: BackfillFitsResult = { total: activities.length, pending: pending.length, downloaded: 0, archived: 0, duplicates: 0, failed: 0, failures: [] };

  const tmp = mkdtempSync(join(tmpdir(), "gfit-"));
  try {
    let done = 0;
    for (const id of pending) {
      if (done >= chunk) break;
      done++;
      const dl = await downloadFitStream(g, id, tmp);
      if (!dl.ok) {
        res.failed++;
        res.failures.push(`${id}: ${dl.reason}`);
        log?.(`  ? ${id}: ${dl.reason}`);
      } else {
        res.downloaded++;
        const path = join(tmp, `${id}.fit`);
        try {
          const r = archiveBuffer(readFileSync(path), { originalName: `${id}.fit`, source: "garmin" }, hashes, dir);
          if (r.archived) {
            res.archived++;
            log?.(`  + ${id}.fit (${r.entry?.date ?? "?"} ${r.entry?.sport ?? "?"})`);
          } else if (r.reason === "duplicate") {
            res.duplicates++;
          }
          rmSync(path, { force: true });
        } catch {
          res.failed++;
          res.failures.push(`${id}: archive write failed`);
        }
      }
      if (throttleMs) await new Promise((r) => setTimeout(r, throttleMs));
    }
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* temp cleanup is best-effort */
    }
  }
  return res;
}
