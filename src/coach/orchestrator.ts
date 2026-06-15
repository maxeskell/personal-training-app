import { AieClient, type AieClientOptions } from "../mcp/aieClient.js";
import { GarminClient } from "../mcp/garminClient.js";
import { StateStore } from "../state/store.js";
import { assembleState } from "../state/assemble.js";
import { config } from "../config.js";
import { CoachLLM } from "../llm/client.js";
import { loadSystemPrompt } from "./persona.js";
import { assessReadiness } from "./readiness.js";
import { assessHealthRisk } from "../guardrails/wellbeing.js";
import { DecisionLog, decisionId, nowIso } from "../state/decisionLog.js";
import { ArchiveStore } from "../archive/store.js";
import { mapRichActivity } from "../insights/metrics.js";
import { todayIso } from "../util/today.js";
import type { ArchiveInput } from "../insights/engine.js";
import type { AthleteState } from "../state/types.js";

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
    garminDays: gar, // GarminDay already carries every field ArchiveInput needs (incl. slice-1b series)
    fitSummaries,
  };
}

/** Assemble (and persist) today's state + trailing window. Handles Garmin lifecycle. */
export async function buildTodayState(): Promise<{ state: AthleteState; window: AthleteState[] }> {
  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();
  const today = todayIso();
  const state = await withAie((aie) =>
    assembleState(aie, garmin, store, { date: today, assembledAt: new Date().toISOString() }),
  );
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
  return { state, window };
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
  return { state, verdict, risk, cacheRead, costUsd };
}
