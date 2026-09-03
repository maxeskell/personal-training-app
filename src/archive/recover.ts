import { config } from "../config.js";
import { todayIso } from "../util/today.js";
import { ArchiveStore } from "./store.js";
import { GarminClient } from "../mcp/garminClient.js";
import { ReauthRequiredError } from "../mcp/aieClient.js";
import { withAie } from "../coach/orchestrator.js";
import { backfillActivities, backfillGarminActivities, backfillGarmin } from "./backfill.js";
import { syncFitSummaries } from "./fitSync.js";

/**
 * Automatic gap recovery — "a connection was broken for a while; download whatever's missing".
 *
 * The scheduled jobs each look at a FIXED window (dashboard refresh syncs the 5 latest, fit-sync the 25
 * latest, archive-heal a ≤200 backlog slice). None of them is framed around "how far behind is this source
 * RIGHT NOW", so a multi-week outage (like the mcp-2.0 Garmin break) is only healed incidentally, over many
 * runs. This module closes that: it measures each source's lag against today and, when a source is reachable
 * again, downloads exactly the missing span.
 *
 * Degrade-don't-crash: every source is best-effort and independent — an unreachable Garmin never blocks the
 * AIE catch-up, and neither ever throws out of `recoverGaps`. The planner is pure (unit-tested); the
 * orchestrator is the thin I/O shell around it.
 */

/** Days beyond which a source is considered to have a real gap worth backfilling (not just normal 1-day lag). */
export const DEFAULT_RECOVER_STALE_DAYS = 2;

/** Pure decision for one source: is it stale, how big is the gap, and what date to backfill FROM. */
export interface GapPlan {
  stale: boolean;
  /** Whole days between the newest archived date and today (0 when there's no baseline). */
  gapDays: number;
  /** ISO date to backfill from (newest − overlap, re-fetching the last partial day). null when not stale. */
  from: string | null;
}

/**
 * `newestIso` is the most recent date already in the archive for this source; `overlapDays` re-fetches a
 * day or two of known data so a day that was only partially captured before the outage is completed. A
 * `null` newest means there's NO baseline (fresh install) — recovery is for filling a gap in an existing
 * series, not a cold start, so that returns not-stale (use `npm run backfill` for a cold start).
 */
export function planGapRecovery(
  newestIso: string | null,
  today: string,
  staleDays: number = DEFAULT_RECOVER_STALE_DAYS,
  overlapDays = 1,
): GapPlan {
  if (!newestIso) return { stale: false, gapDays: 0, from: null };
  const dayMs = 86_400_000;
  const newestMs = Date.parse(`${newestIso}T00:00:00Z`);
  const gapDays = Math.floor((Date.parse(`${today}T00:00:00Z`) - newestMs) / dayMs);
  if (!Number.isFinite(gapDays) || gapDays <= staleDays) return { stale: false, gapDays: Math.max(0, gapDays || 0), from: null };
  const from = new Date(newestMs - overlapDays * dayMs).toISOString().slice(0, 10);
  return { stale: true, gapDays, from };
}

export type SourceStatus = "recovered" | "current" | "unreachable" | "reauth_needed" | "disabled" | "error";

export interface SourceRecovery {
  source: string;
  gapDays: number;
  added: number;
  /** Raw per-second .FIT streams pulled (Garmin activities only). */
  streams?: number;
  status: SourceStatus;
  note?: string;
}

export interface GapRecoveryResult {
  /** True when at least one source actually downloaded missing data. */
  ran: boolean;
  /** True when a source is still behind after the attempt (reachable-source failure or still-unreachable). */
  stillStale: boolean;
  sources: SourceRecovery[];
  /** One-line human summary for logs / notifications. */
  summary: string;
}

const newestDate = (rows: Array<{ date?: string }>): string | null => {
  const ds = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
  return ds.length ? ds[ds.length - 1] : null;
};

/**
 * Measure each source's lag and backfill the gap for any that are both stale AND reachable. Never throws.
 * `opts.staleDays` tunes the trigger; `opts.now` and `opts.store` are injectable for tests.
 */
export async function recoverGaps(opts: {
  staleDays?: number;
  now?: string;
  store?: ArchiveStore;
  log?: (m: string) => void;
} = {}): Promise<GapRecoveryResult> {
  const staleDays = opts.staleDays ?? DEFAULT_RECOVER_STALE_DAYS;
  const today = opts.now ?? todayIso();
  const store = opts.store ?? new ArchiveStore();
  const log = opts.log ?? (() => {});
  const sources: SourceRecovery[] = [];

  // --- AI Endurance activities (its recovery/daily snapshot already rides the live assemble; only the
  //     activity-detail archive lags, because the scheduled grind runs --daily-only). ---
  const aiePlan = planGapRecovery(newestDate(await store.loadActivities()), today, staleDays);
  if (!aiePlan.stale) {
    sources.push({ source: "AIE activities", gapDays: aiePlan.gapDays, added: 0, status: "current" });
  } else {
    try {
      const added = await withAie((aie) => backfillActivities(aie, store, aiePlan.from!, today, log));
      sources.push({ source: "AIE activities", gapDays: aiePlan.gapDays, added, status: "recovered" });
    } catch (e) {
      // A missing/rejected token is not a transient blip (spec 11): name it, so the ping's notification and
      // the doctor say "re-auth" rather than "unreachable — will retry".
      sources.push({ source: "AIE activities", gapDays: aiePlan.gapDays, added: 0, status: e instanceof ReauthRequiredError ? "reauth_needed" : "unreachable", note: reason(e) });
    }
  }

  // --- Garmin (optional, degradable) — one connection covers both the daily series and activities/streams. ---
  if (!config.garmin.enabled) {
    sources.push({ source: "Garmin", gapDays: 0, added: 0, status: "disabled" });
    return summarizeRecovery(sources, staleDays);
  }
  const gDailyPlan = planGapRecovery(newestDate(await store.loadGarminDays()), today, staleDays);
  const gActPlan = planGapRecovery(newestDate(await store.loadGarminActivities()), today, staleDays);
  if (!gDailyPlan.stale && !gActPlan.stale) {
    sources.push({ source: "Garmin daily", gapDays: gDailyPlan.gapDays, added: 0, status: "current" });
    sources.push({ source: "Garmin activities+streams", gapDays: gActPlan.gapDays, added: 0, status: "current" });
    return summarizeRecovery(sources, staleDays);
  }

  const g = new GarminClient();
  try {
    if (!(await g.connect())) {
      const gapDays = Math.max(gDailyPlan.gapDays, gActPlan.gapDays);
      sources.push({ source: "Garmin", gapDays, added: 0, status: "unreachable", note: g.lastError ?? "connect failed" });
      return summarizeRecovery(sources, staleDays);
    }
    // Activities list + raw streams: size the stream-sync window to the gap so a long outage is covered in
    // one pass, not incrementally over many archive-heal runs. Clamped to a sane [25, 200].
    if (gActPlan.stale) {
      try {
        const added = await backfillGarminActivities(g, store, log, 100, true); // incremental: stop at first known page
        const limit = Math.min(200, Math.max(25, gActPlan.gapDays * 2));
        const fs = await syncFitSummaries(g, store, limit, log);
        sources.push({ source: "Garmin activities+streams", gapDays: gActPlan.gapDays, added, streams: fs.streamsDownloaded, status: "recovered" });
      } catch (e) {
        sources.push({ source: "Garmin activities+streams", gapDays: gActPlan.gapDays, added: 0, status: "error", note: reason(e) });
      }
    } else {
      sources.push({ source: "Garmin activities+streams", gapDays: gActPlan.gapDays, added: 0, status: "current" });
    }
    if (gDailyPlan.stale && gDailyPlan.from) {
      try {
        const added = await backfillGarmin(g, store, gDailyPlan.from, today, log, 250, Infinity);
        sources.push({ source: "Garmin daily", gapDays: gDailyPlan.gapDays, added, status: "recovered" });
      } catch (e) {
        sources.push({ source: "Garmin daily", gapDays: gDailyPlan.gapDays, added: 0, status: "error", note: reason(e) });
      }
    } else {
      sources.push({ source: "Garmin daily", gapDays: gDailyPlan.gapDays, added: 0, status: "current" });
    }
  } finally {
    await g.close();
  }
  return summarizeRecovery(sources, staleDays);
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pure: collapse per-source outcomes into the result + one-line summary. `staleDays` is the caller's
 *  threshold (it used to silently use the default, so a custom threshold never changed `stillStale`). */
export function summarizeRecovery(sources: SourceRecovery[], staleDays: number = DEFAULT_RECOVER_STALE_DAYS): GapRecoveryResult {
  const recovered = sources.filter((s) => s.status === "recovered");
  const failing = (s: SourceRecovery) => s.status === "unreachable" || s.status === "error" || s.status === "reauth_needed";
  const stillStale = sources.some((s) => failing(s) && s.gapDays > staleDays);
  const reauth = sources.find((s) => s.status === "reauth_needed");
  const summary = recovered.length
    ? "Recovered " +
      recovered
        .map((s) => `${s.source} +${s.added}${s.streams != null ? ` (+${s.streams} streams)` : ""} over ${s.gapDays}d`)
        .join("; ")
    : reauth
      ? `AI Endurance needs re-authorisation (\`npm run auth:aie\` on the host) — ${reauth.source} ${reauth.gapDays}d behind.`
      : sources.some(failing)
        ? "Gap detected but source unreachable — will retry next run."
        : "All sources current — nothing to recover.";
  return { ran: recovered.length > 0, stillStale, sources, summary };
}
