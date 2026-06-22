import { AieClient, type AieClientOptions } from "../mcp/aieClient.js";
import { GarminClient } from "../mcp/garminClient.js";
import { StateStore } from "../state/store.js";
import { selectDataSource } from "../sources/index.js";
import { config } from "../config.js";
import { CoachLLM } from "../llm/client.js";
import { loadSystemPrompt } from "./persona.js";
import { assessReadiness } from "./readiness.js";
import { recsToFindings } from "./adviceRecs.js";
import { refreshAdviceEmbeddings } from "./refreshAdviceEmbeddings.js";
import { InsightLog } from "../state/insightLog.js";
import { assessHealthRisk } from "../guardrails/wellbeing.js";
import { DecisionLog, decisionId, nowIso } from "../state/decisionLog.js";
import { ArchiveStore } from "../archive/store.js";
import { mapRichActivity, richActivities } from "../insights/metrics.js";
import { loadSessionDecays } from "../insights/fit.js";
import { syncFitSummaries, type FitSyncResult } from "../archive/fitSync.js";
import { assessCompleteness, type DataCompletenessReport } from "../state/dataCompleteness.js";
import { todayIso } from "../util/today.js";
import { loadProfileSafe } from "../profile/load.js";
import { nearestRaceName, racePredictedSec, type ArchiveInput } from "../insights/engine.js";
import { withinPhysioHorizon } from "../insights/horizon.js";
import type { AthleteState } from "../state/types.js";

/** How far back the race-day projection's FALLBACK trend looks (days). Bounds the deep read; the
 *  statistical gate needs ≥10 points, so this comfortably clears it while capping parse cost. */
export const PREDICTION_HISTORY_DAYS = 180;

// Re-exported so existing importers (CLI, dashboard, MCP server) keep getting `todayIso` from here,
// while the single source of truth — a timezone-aware "today" (DATA-3) — lives in util/today.
export { todayIso };

/**
 * Shared orchestration the coach's three faces (CLI, dashboard server, MCP server) all build on:
 * assembling today's state, loading the local archive, and the readiness core. Kept in one place
 * so the engine never drifts between entrypoints.
 */

/** Connect an AI Endurance client, run `fn`, and always close — the read lifecycle for one flow.
 *  `opts` is non-interactive by default; only the explicit `auth` flow passes { interactive: true }. */
export async function withAie<T>(fn: (aie: AieClient) => Promise<T>, opts?: AieClientOptions): Promise<T> {
  const aie = new AieClient(opts);
  await aie.connect();
  try {
    return await fn(aie);
  } finally {
    await aie.close();
  }
}

/** Load the local history archive (if any) as insight inputs. Undefined when empty. */
export async function loadArchive(): Promise<ArchiveInput | undefined> {
  const store = new ArchiveStore();
  const acts = await store.loadActivities();
  const gar = await store.loadGarminDays();
  const fitSummaries = await store.loadFitSummaries();
  if (!acts.length && !gar.length && !fitSummaries.length) return undefined;
  return {
    activities: acts.map((a) => mapRichActivity(a.raw, a.sport)),
    // Floor the physio feed to the six-month horizon: every insight consumer (trends, baselines, the
    // under-fuelling/illness/data-quality flags) only ever sees the last ~6 months of daily readings, so
    // nothing leans on stale data. The race-time predictor is exempt — it reads its own StateStore series.
    garminDays: withinPhysioHorizon(gar), // GarminDay already carries every field ArchiveInput needs (incl. slice-1b series)
    fitSummaries,
  };
}

export interface BuildStateOpts {
  /**
   * Also pull recent raw `.FIT` streams (and per-activity summaries) while the Garmin client is open,
   * then attach a `dataCompleteness` readout. ONLY the explicit `sync` surface sets this — the FIT pull
   * is a network round-trip we don't want on every readiness/ask/weekly assemble. Mirrors the dashboard
   * refresh, which fit-syncs on its own Sync. Best-effort: a fetch failure never breaks the assemble.
   */
  syncFit?: boolean;
}

/**
 * Gather the granular-data completeness readout for a state: which recent sessions have their raw `.FIT`
 * present locally, plus the Garmin capability + this-sync fetch outcome. Pure-ish (reads the local streams
 * dir + the state's own activities); the Garmin facts are passed in by the caller.
 */
export function gatherCompleteness(
  state: AthleteState,
  opts: { garminConnected?: boolean; fitSync?: FitSyncResult } = {},
): DataCompletenessReport {
  return assessCompleteness({
    recent: richActivities(state.raw).map((a) => ({ date: a.date, sport: a.sport })),
    streams: loadSessionDecays().map((d) => ({ date: d.date, sport: d.sport })),
    today: state.date,
    garminEnabled: config.garmin.enabled,
    garminConnected: opts.garminConnected,
    fitSync: opts.fitSync
      ? {
          streamsDownloaded: opts.fitSync.streamsDownloaded,
          streamsFailed: opts.fitSync.streamsFailed,
          streamsSupported: opts.fitSync.streamsSupported,
          streamFailures: opts.fitSync.streamFailures,
        }
      : undefined,
  });
}

/** Assemble (and persist) today's state + trailing window. Handles Garmin lifecycle. */
export async function buildTodayState(opts: BuildStateOpts = {}): Promise<{ state: AthleteState; window: AthleteState[]; fitSync?: FitSyncResult }> {
  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();
  const garminConnected = garmin ? garmin.available : undefined; // capture before close()
  const today = todayIso();
  // Assemble via the configured data-source spine (AI Endurance by default; see src/sources/).
  const state = await selectDataSource().assemble({ store, garmin, date: today, assembledAt: new Date().toISOString() });

  // On the explicit `sync` surface, also pull recent raw .FIT streams while Garmin is open — so the MCP
  // `sync` has parity with the dashboard's Sync (which fit-syncs) and a session's deep analysis isn't
  // silently missing its stream the next time it's asked for. Best-effort.
  let fitSync: FitSyncResult | undefined;
  if (opts.syncFit && garmin && garminConnected) {
    try {
      fitSync = await syncFitSummaries(garmin, new ArchiveStore(), 8);
    } catch (e) {
      console.warn(`sync: raw .FIT fetch failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await garmin?.close();
  await store.save(state);

  // AIE tool-change tolerance: a read that errored degrades its field to null rather than
  // crashing — but surface it so silent API drift doesn't pass unnoticed (Integration Spec §2.1).
  const failed = Object.entries(state.raw ?? {})
    .filter(([, v]) => v && typeof v === "object" && "error" in (v as Record<string, unknown>))
    .map(([tool]) => tool);
  if (failed.length) {
    console.warn(`⚠ AI Endurance reads returned errors (continuing on partial data): ${failed.join(", ")}`);
  }

  const window = await store.recent(today, 7);

  // Attach the stable athlete profile (profile.local.yaml) for the coaching prompts — best-effort and
  // AFTER save, so the medical/personal context is never persisted into data/state/*.json. Degrade
  // silently if it's absent or invalid; the explicit `get_profile` MCP tool is the loud surface.
  const loaded = await loadProfileSafe();
  if (loaded) {
    state.profile = loaded.profile;
    if (window.length) window[window.length - 1].profile = loaded.profile;
  }

  // On the `sync` surface, attach the granular-data completeness readout (after the .FIT fetch above, so
  // it reflects what was just pulled). In-memory + AFTER save, like the profile — it's derived and stripped
  // by the store regardless. Loud-over-silent: a recent session missing its .FIT shows here.
  if (opts.syncFit) {
    state.dataCompleteness = gatherCompleteness(state, { garminConnected, fitSync });
    if (window.length) window[window.length - 1].dataCompleteness = state.dataCompleteness;
  }

  return { state, window, fitSync };
}

/**
 * Deep, lightweight race-prediction history for the race-day projection's FALLBACK trend. Keyed to
 * today's nearest race so the series tracks one comparable target rather than mixing races as they pass.
 * Loaded separately from the 7-day `window` (kept short for cost/latency on the readiness path) and only
 * by the insight surfaces that show the finish-time range. Returns [] when there's no history yet.
 */
export async function loadPredictionTrajectory(state: AthleteState, days = PREDICTION_HISTORY_DAYS): Promise<Array<{ date: string; v: number }>> {
  const nearest = nearestRaceName(state);
  return new StateStore().series(state.date, days, (s) => racePredictedSec(s, nearest));
}

/** Shared readiness core: assemble → wellbeing → verdict → log. Used by `readiness` and `ping`. */
export async function gatherReadiness(): Promise<{
  state: AthleteState;
  verdict: Awaited<ReturnType<typeof assessReadiness>>["verdict"];
  risk: ReturnType<typeof assessHealthRisk>;
  cacheRead: number;
  costUsd: number;
}> {
  const { state, window } = await buildTodayState();
  const risk = assessHealthRisk(window); // deterministic guardrail, runs before the model
  const llm = new CoachLLM(await loadSystemPrompt(), "readiness", "medium");
  const { verdict, cacheRead, costUsd } = await assessReadiness(llm, window);
  // Idempotent per day (ENG-3): the readiness id is deterministic from the date, so a re-run (manual +
  // the 06:00 ping, or a launchd wake) must not append a duplicate readiness line. First call of the day wins.
  const log = new DecisionLog();
  const id = decisionId(`readiness:${state.date}`);
  if (!(await log.all()).some((r) => r.id === id)) {
    await log.append({ id, timestamp: nowIso(), kind: "readiness", summary: `${verdict.verdict}: ${verdict.why}`, status: "note" });
  }
  // Surface the verdict's recommendations as individually reactable advice (item 4-iii): logged to the
  // insight log so they're keyed, dashboard-reactable, and fed into the engagement weights. Best-effort.
  const recFindings = recsToFindings(verdict.recommendations, "readiness");
  await new InsightLog().recordSurfaced(recFindings, "readiness");
  await refreshAdviceEmbeddings(recFindings); // sync-time, off render path; no-op unless clustering is on
  return { state, verdict, risk, cacheRead, costUsd };
}
