import { pathToFileURL } from "node:url";
import { basename } from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { buildTodayState, gatherCompleteness, gatherReadiness, loadArchive, loadPredictionTrajectory, todayIso, withAie } from "./coach/orchestrator.js";
import { formatCompleteness } from "./state/dataCompleteness.js";
import { loadActivityFits } from "./insights/fit.js";
import { formatSplits, formatCss, computeCss, detectCssEffortsFromLaps, parseClock } from "./insights/sessionSplits.js";
import { reportStreamsDir, ingestFitFile, formatStreamsReport, formatIngest } from "./archive/fitIngest.js";
import { diagnoseFtp, formatFtpDiagnosis } from "./insights/ftpSource.js";
import { richActivities, findingKey } from "./insights/metrics.js";
import { StateStore } from "./state/store.js";
import { buildInsights } from "./insights/engine.js";
import { DecisionLog, suppressedInsightKeys, executedSourceKeys, latestCoachDiscussions, reactionFromLabel, type DecisionRecord } from "./state/decisionLog.js";
import { buildSetupItems } from "./coach/setupCard.js";
import { latestAdviceFindings } from "./coach/adviceRecs.js";
import { latestWeeklyReview, latestResearchDigest } from "./coach/setupSources.js";
import { loadVenue, latestReading } from "./state/venue.js";
import { buildAgenda, formatAgendaText } from "./coach/agenda.js";
import { InsightLog } from "./state/insightLog.js";
import { analyseListening, formatListening } from "./coach/listening.js";
import { loadEngagementContext } from "./coach/engagementContext.js";
import { loadModel } from "./insights/metrics.js";
import { ArchiveStore } from "./archive/store.js";
import { answerQuestion } from "./coach/ask.js";
import { runWeeklyReview } from "./coach/weekly.js";
import { runRacePrep } from "./coach/racePrep.js";
import { runDeepDive, insightMetricsSummary, insightFindings, nextDeepDiveAction, type DeepDiveJob } from "./coach/deepDive.js";
import { coachHeadline } from "./insights/headline.js";
import { buildSeasonArc, seasonReportText } from "./coach/seasonArc.js";
import { runSeasonNarrative } from "./coach/seasonNarrative.js";
import { loadCareerHistory } from "./coach/careerHistory.js";
import { runTuneUp } from "./coach/tuneUp.js";
import { runResearchDigest } from "./coach/research.js";
import { readKnowledge, writePendingDigest, pendingName, knowledgeFreshness, listPending } from "./knowledge/store.js";
import { runSessionFeedback } from "./coach/session.js";
import { loadSessionDecays } from "./insights/fit.js";
import { buildWeekFuelPlans, loadFuelPrefs, formatWeekFuelText } from "./coach/fuelPlan.js";
import { loadInventory } from "./coach/fuelInventory.js";
import { loadFuelLog, saveFuelLog, isFuelOutcome } from "./coach/fuelLogStore.js";
import { runFuelReview } from "./coach/fuelReview.js";
import { upcomingPlanned } from "./weather/assess.js";
import { writeReport, listReports, readReport } from "./coach/reports.js";
import { proposeAdjustments, validateProposals, buildProposerContext, writeContextFor } from "./coach/planAdjust.js";
import { screenNutritionPrompt } from "./guardrails/wellbeing.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { AieClient } from "./mcp/aieClient.js";
import { readCostRecords, summarizeCost, type CostRecord } from "./llm/costLog.js";
import { loadProfile, loadProfileRacesSync } from "./profile/load.js";
import { formatProfileForTool } from "./profile/context.js";
import { updateLocalProfile } from "./profile/update.js";
import { repoRoot, listRepoDir, readRepoFile, writeRepoFile, formatReadResult, deniedReason } from "./mcp/fileAccess.js";
import { setMedicalExposure } from "./mcp/medicalExposure.js";
import type { AthleteState } from "./state/types.js";

/**
 * Local MCP server over the endurance coach (read + gated writes).
 *
 * Exposes the SAME engine the CLI and dashboard use — assembled AthleteState, the n=1 insight
 * engine, the coaching flows and the gated propose→confirm write path — as MCP tools, so a desktop
 * agent (Claude Cowork / Claude Desktop) can interrogate your data locally over stdio. Your AI
 * Endurance tokens, Garmin creds and archive never leave the machine.
 *
 * Safety: every read/analysis tool is side-effect-free against AI Endurance. The ONLY write path is
 * `propose_adjustment` → `confirm`, exactly as in the CLI (WriteGate, logged to the decision log).
 */

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** LLM tools degrade to a clean message (not a crash) when the API key is absent. */
function missingKey(): string | null {
  return CoachLLM.hasApiKey()
    ? null
    : "ANTHROPIC_API_KEY is not set — this tool needs the LLM core. Add it to .env and restart the server.";
}

// ---- pure formatters (exported for tests) ------------------------------------------------------

type Provenance = { value: unknown; source: string; note?: string };
// Show the actual VALUE for scalars (the headline live numbers — weight, HRV, RHR, VO2max, …); fall back
// to "set" only for STRUCTURED fields (plan, zones, recovery model) where a presence flag is enough.
const prov = (p: Provenance) => {
  const v = p.value;
  const shown = v == null ? "—" : typeof v === "object" ? "set" : String(v);
  return `${shown} [${p.source}${p.note ? `: ${p.note}` : ""}]`;
};

/** A glanceable, provenance-tagged digest of an AthleteState (mirrors `npm run state`). */
export function summarizeState(state: AthleteState, today: string = todayIso()): string {
  const L = (label: string, p: Provenance) => `  ${label.padEnd(22)} ${prov(p)}`;
  // Staleness cue: a snapshot read (get_state with no fresh) can silently be from a previous day. If the
  // snapshot was assembled before today, say so loudly and point at `sync` — never let a stale read pass
  // as current. Pure given `today` (passed in), so it's deterministically testable.
  const assembledDate = (state.assembledAt ?? "").slice(0, 10);
  const daysOld = assembledDate && assembledDate < today ? Math.round((Date.parse(today) - Date.parse(assembledDate)) / 86_400_000) : 0;
  const staleCue =
    daysOld > 0
      ? [`⚠ STALE SNAPSHOT: assembled ${state.assembledAt} — ${daysOld} day${daysOld === 1 ? "" : "s"} before today (${today}). Run \`sync\` (or get_state fresh=true) to refresh.`, ""]
      : [];
  // thresholds is a structured field, so spell out the headline markers (FTP, run threshold pace, swim CSS,
  // max HR) explicitly rather than a bare "set" — these are exactly the numbers a coach needs at a glance.
  const tv = state.thresholds.value;
  const mmss = (sec: number, unit: string) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}${unit}`;
  const thrBits = tv
    ? [
        tv.bikeFtpW != null ? `bike FTP ${tv.bikeFtpW} W${tv.bikeFtpWkg != null ? ` (${tv.bikeFtpWkg} W/kg)` : ""}` : null,
        tv.runThresholdPaceSecPerKm != null ? `run thr ${mmss(tv.runThresholdPaceSecPerKm, "/km")}` : null,
        tv.swimCssSecPer100 != null ? `swim CSS ${mmss(tv.swimCssSecPer100, "/100m")}` : null,
        tv.maxHr != null ? `max HR ${tv.maxHr}` : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const thresholdLine = `  ${"thresholds (ftp/pace)".padEnd(22)} ${thrBits || "—"} [${state.thresholds.source}${state.thresholds.note ? `: ${state.thresholds.note}` : ""}]`;
  return [
    ...staleCue,
    `AthleteState for ${state.date} (assembled ${state.assembledAt}):`,
    L("planned sessions", state.plannedSessions),
    L("actual activities", state.actualActivities),
    L("recovery model", state.recovery),
    L("prediction", state.prediction),
    L("adherence by zone", state.adherenceByZone),
    L("hrv overnight", state.hrvOvernight),
    L("hrv 7d baseline", state.hrv7dBaseline),
    L("resting hr", state.restingHr),
    L("weight (kg)", state.weightKg),
    L("weight 7d trend", state.weight7dTrend),
    L("sleep (garmin)", state.sleep),
    L("vo2max", state.vo2max),
    thresholdLine,
    L("zones", state.zones),
    L("tiebreak (garmin)", state.tiebreak),
    L("nutrition targets", state.nutritionTargets),
    `  sync gaps: ${state.syncGaps.length}`,
    ...state.syncGaps.map((g) => `    - [${g.kind}] ${g.detail}`),
    // Granular-data completeness — never a silent zero: a recent session missing its raw .FIT (so its
    // splits/biomechanics are unreachable) is called out explicitly here, with the reason.
    ...(state.dataCompleteness ? ["", ...formatCompleteness(state.dataCompleteness)] : []),
  ].join("\n");
}

/** Render the decision log (or just the pending proposals) as text. */
export function formatDecisions(all: DecisionRecord[], filter: "all" | "pending"): string {
  if (!all.length) return "No decisions logged yet.";
  if (filter === "pending") {
    const latest = new Map<string, DecisionRecord>();
    for (const r of all) latest.set(r.id, r); // append-only log: latest status per id wins
    const pending = [...latest.values()].filter((r) => r.kind === "plan-adjust" && r.status === "proposed");
    if (!pending.length) return "No pending proposals — nothing awaiting confirm/decline.";
    return [
      `Pending proposals (${pending.length}):`,
      ...pending.flatMap((r) => [
        `  [${r.id}] ${r.summary}`,
        ...(r.tradeoff ? [`      trade-off: ${r.tradeoff}`] : []),
        ...(r.basis?.length ? [`      because: ${r.basis.join("; ")}`] : []),
        `      → confirm id=${r.id}  |  decline id=${r.id}`,
      ]),
    ].join("\n");
  }
  return [
    `Decision log (${all.length} entries, most recent last):`,
    ...all.slice(-30).flatMap((r) => [
      `  ${r.timestamp.slice(0, 16)}  [${r.id}] ${r.kind}/${r.status}`,
      `      ${r.summary}`,
      ...(r.tradeoff ? [`      trade-off: ${r.tradeoff}`] : []),
      ...(r.basis?.length ? [`      because: ${r.basis.join("; ")}`] : []),
      ...(r.retro ? [`      retro: ${r.retro}`] : []),
    ]),
  ].join("\n");
}

/** Windowed token-cost report (mirrors `npm run cost`). */
export function formatCost(records: CostRecord[], days?: number): string {
  if (!records.length) return "No LLM calls logged yet. Run a flow (ask / readiness / weekly …) and check back.";
  const windows =
    days && days > 0
      ? [{ label: `last ${days}d`, days }]
      : [
          { label: "today", days: 1 },
          { label: "last 7d", days: 7 },
          { label: "last 30d", days: 30 },
          { label: "all-time", days: undefined as number | undefined },
        ];
  const out = [`Token cost — model ${records[records.length - 1].model}, ${records.length} call(s) logged:`];
  for (const w of windows) {
    const s = summarizeCost(records, w.days);
    out.push(`\n  ${w.label}: $${s.total.costUsd.toFixed(4)} over ${s.total.calls} call(s)`);
    for (const op of s.byOperation) {
      out.push(`    ${op.operation.padEnd(12)} $${op.costUsd.toFixed(4)}  ${op.calls}× · in ${op.input}/out ${op.output}/cacheR ${op.cacheRead}`);
    }
  }
  const w7 = summarizeCost(records, 7).total;
  if (w7.calls) out.push(`\n  ≈ $${((w7.costUsd / 7) * 30).toFixed(2)}/month at the last-7-day rate.`);
  return out.join("\n");
}

/** Readiness verdict as text (mirrors the CLI's printout). */
export function formatReadiness(
  v: { verdict: string; why: string; drivers: Array<{ signal: string; reading: string; source: string }>; cautions: string[] },
  risk: { level: string; message?: string },
): string {
  const dot = v.verdict === "green" ? "🟢" : v.verdict === "amber" ? "🟡" : "🔴";
  const lines: string[] = [];
  if (risk.level !== "none") lines.push(`⚠ Wellbeing (${risk.level}): ${risk.message ?? ""}`, "");
  lines.push(`${dot} Readiness: ${v.verdict.toUpperCase()}`, "", v.why, "", "Drivers:");
  for (const d of v.drivers) lines.push(`  • ${d.signal}: ${d.reading} [${d.source}]`);
  if (v.cautions.length) {
    lines.push("", "Cautions:");
    for (const c of v.cautions) lines.push(`  • ${c}`);
  }
  return lines.join("\n");
}

// ---- server -----------------------------------------------------------------------------------

/**
 * Build the MCP server with every tool registered (no transport — so tests can introspect it).
 * `includeWrites` (default true) gates the propose/confirm/decline tools — set false for a read-only
 * surface, e.g. an internet-exposed HTTP/Cowork endpoint (COACH_MCP_READONLY=true).
 * `includeProfileWrite` (default false) gates the local-file `update_profile` tool: always on for the
 * local stdio surface, opt-in on the remote HTTP/Cowork surface (COACH_MCP_PROFILE_WRITE=true) since it
 * writes a file on the host from a remote session.
 */
/**
 * The single in-flight deep-dive job (see DeepDiveJob). Module-scoped so it survives across `deep_dive`
 * calls within a process — the tool starts generation in the background and returns at once, so a
 * follow-up call can report progress or hand back the finished report instead of paying the LLM again.
 */
let deepDiveJob: DeepDiveJob | null = null;

/**
 * Generate the deep dive and write its report, OFF the request/response path. Runs to completion in the
 * background even after the caller's request returns (or its client has timed out), so the report always
 * lands. Never throws — a failure is recorded on the job for the next `deep_dive` call to surface.
 */
async function generateDeepDive(job: DeepDiveJob): Promise<void> {
  try {
    const { state, window } = await buildTodayState();
    const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
    const engagement = await loadEngagementContext(window);
    const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
    const { markdown } = await runDeepDive(new CoachLLM(await loadSystemPrompt(), "deep-dive"), state, ins);
    await writeReport("deep-dive", job.date, markdown);
  } catch (e) {
    job.error = e instanceof Error ? e.message : String(e);
  } finally {
    job.done = true;
  }
}

export function buildServer(opts: { includeWrites?: boolean; includeProfileWrite?: boolean; includeFileAccess?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "endurance-coach", version: "0.1.0" });
  // Whether this surface may take a caller-supplied filesystem path. Off by default (the HTTP/Cowork
  // surface); on for local stdio. Used to contain the `ingest_fit` path-oracle (see its handler).
  const includeFileAccess = opts.includeFileAccess ?? false;

  // ---- deterministic reads (no LLM, no token cost) ----
  server.tool(
    "sync",
    "Assemble today's AthleteState fresh from AI Endurance (+ Garmin if enabled), auto-fetch recent raw .FIT streams, and persist it. Returns a summary, any sync gaps, AND a granular-data completeness readout (which recent sessions are missing their raw .FIT — so their per-interval splits / biomechanics are unreachable — and why). Network call; no LLM cost.",
    {},
    async () => ok(summarizeState((await buildTodayState({ syncFit: true })).state)),
  );

  server.tool(
    "get_state",
    "Return today's AthleteState (plan, recovery, HRV/RHR, weight, thresholds, zones, …) plus a granular-data completeness readout — the raw data dump, no interpretation. Reads the last persisted snapshot by default (flagged with a ⚠ STALE line if it's from a previous day); pass fresh=true to re-sync from AI Endurance first (use `sync` to also auto-fetch raw .FIT streams). Use-when: you want the underlying numbers. For 'how am I today / should I train', use `readiness` (an interpreted verdict), not this.",
    { fresh: z.boolean().optional().describe("Re-assemble from AI Endurance before returning (default: use the last snapshot).") },
    async ({ fresh }) => {
      const state = fresh ? (await buildTodayState()).state : (await new StateStore().recent(todayIso(), 1))[0];
      if (!state) return fail("No state assembled yet — call the `sync` tool (or get_state with fresh=true) first.");
      // Attach a completeness readout (no FIT fetch here — that's `sync`'s job). For a snapshot read,
      // garminConnected is left undefined so the note says capability is "from the last snapshot".
      state.dataCompleteness ??= gatherCompleteness(state);
      return ok(summarizeState(state));
    },
  );

  server.tool(
    "splits",
    "Per-interval splits (laps/lengths) for a session from its raw .FIT — run/bike reps, swim lengths — AND, for a swim test, a Critical Swim Speed estimate by the 400/200 method with a maximal-effort confidence check. Pass t400 & t200 (seconds or m:ss) to compute CSS directly from times with NO .FIT needed; otherwise it reads the .FIT for `date` (or the most recent session) and auto-detects the 400/200 maximal pair. Deterministic, no LLM cost. READ-ONLY: it computes & recommends — you set CSS in AI Endurance yourself.",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Session date (defaults to the most recent activity with a .FIT)."),
      sport: z.string().optional().describe("Filter by sport (e.g. 'swim', 'run', 'ride')."),
      t400: z.union([z.string(), z.number()]).optional().describe("Maximal 400 m time for a CSS calc — seconds or m:ss (e.g. '6:20')."),
      t200: z.union([z.string(), z.number()]).optional().describe("Maximal 200 m time for a CSS calc — seconds or m:ss (e.g. '3:00')."),
      maxHr: z.number().optional().describe("Your max HR — lets the confidence check confirm the test efforts were maximal."),
    },
    async ({ date, sport, t400, t200, maxHr }) => {
      // Direct CSS from supplied times — works with no .FIT at all.
      if (t400 != null && t200 != null) {
        const a = parseClock(t400);
        const b = parseClock(t200);
        if (a == null || b == null) return fail("Couldn't parse t400/t200 — give seconds (e.g. 380) or m:ss (e.g. '6:20').");
        return ok(formatCss(computeCss({ t400Sec: a, t200Sec: b, maxHr, source: "explicit" })).join("\n"));
      }
      // Otherwise read the session's raw .FIT.
      const matchesSport = (fitSport: string): boolean => {
        if (!sport) return true;
        const q = sport.toLowerCase();
        const want = /cycl|bike|ride/.test(q) ? "ride" : /run/.test(q) ? "run" : /swim/.test(q) ? "swim" : q;
        return fitSport.toLowerCase().includes(want);
      };
      const fits = loadActivityFits().filter((f) => matchesSport(f.sport));
      const pool = date ? fits.filter((f) => f.date === date) : fits;
      const target = pool.length ? pool[pool.length - 1] : null; // sorted ascending → latest
      if (!target) {
        return ok(
          `No raw .FIT found for splits${date ? ` on ${date}` : ""}${sport ? ` (${sport})` : ""}. Run the \`sync\` tool (or \`npm run fit-sync\`) to fetch it, or drop an exported .FIT into the streams dir. ` +
            "To compute CSS without a .FIT, pass t400 and t200 (your maximal 400 m and 200 m times).",
        );
      }
      const lines = [`Session ${target.date} ${target.sport} (activity ${target.activityId}):`, "", ...formatSplits(target.fit)];
      const isSwim = target.fit.sport === 5 || /swim/i.test(target.fit.sportName);
      if (isSwim) {
        const efforts = detectCssEffortsFromLaps(target.fit.laps);
        lines.push("");
        if (efforts) lines.push(...formatCss(computeCss({ ...efforts, maxHr })));
        else lines.push("CSS: couldn't auto-detect a 400 m + 200 m maximal pair from the laps — pass t400 and t200 (your test times) to compute it.");
      }
      return ok(lines.join("\n"));
    },
  );

  server.tool(
    "ingest_fit",
    "The manual-export fallback for raw .FIT streams (when the Garmin auto-download can't run). With no args: report what's in the watched streams dir (each file's validity + summary) and confirm the absolute path + the drop convention. With `path`: validate an exported .FIT at that path and copy it in so `splits` / `session_feedback` can read it. Deterministic, no LLM cost, read-only to AI Endurance.",
    { path: z.string().optional().describe("Absolute path to an exported .FIT (Garmin Connect → Export Original) to validate + ingest. Omit to just report the streams dir.") },
    async ({ path }) => {
      if (path) {
        // Containment: a caller-supplied path is a file-existence + parse-verdict ORACLE for anything the
        // process can read. Allow it only on the file-access surface (local stdio); the remote surface
        // gets the no-path streams-dir report instead. Even when allowed, refuse secret/credential files.
        if (!includeFileAccess) {
          return fail(
            "ingest_fit with a file `path` is disabled on this surface (it would let a caller probe the host filesystem). " +
              "Drop the exported .FIT into the streams dir and call ingest_fit with no path, or enable COACH_MCP_FILE_ACCESS.",
          );
        }
        const denied = deniedReason(basename(path));
        if (denied) return fail(`refused: "${basename(path)}" is ${denied}. ingest_fit excludes secrets and credentials.`);
        return ok(formatIngest(ingestFitFile(path)).join("\n"));
      }
      return ok(formatStreamsReport(reportStreamsDir()).join("\n"));
    },
  );

  server.tool(
    "ftp_check",
    "Bike-FTP source diagnostic — lays the configured FTP (used for zones), Garmin's power-duration (MMP) estimate, the gap between them, and your recent power-meter coverage side by side, then recommends how to resolve a gap (e.g. 223 W configured vs ~183 W estimated) with power-equipped rides rather than guessing. HONEST: this connector is read-only and can't see which engine set AI Endurance's FTP — it says so. Deterministic, no LLM cost; never writes.",
    {},
    async () => {
      const state = (await new StateStore().recent(todayIso(), 1))[0];
      if (!state) return fail("No state assembled yet — call the `sync` tool first.");
      const archive = await loadArchive();
      const rides = archive?.activities ?? richActivities(state.raw);
      return ok(formatFtpDiagnosis(diagnoseFtp(state, rides)).join("\n"));
    },
  );

  server.tool(
    "get_profile",
    "Return the validated athlete profile — STABLE context (identity, biomechanics, health/medication, availability, equipment, fuelling, race targets) that AI Endurance/Garmin don't hold — plus a computed `dose_cycle` (days_since_dose, in_gi_trough) when a medication cycle is set. NO live numbers: FTP, weight, paces, swim CSS, HRV and training load come from `get_state`. Reads profile.local.yaml, else profile.example.yaml. Deterministic — no LLM cost.",
    {},
    async () => {
      try {
        return ok(formatProfileForTool(await loadProfile(), todayIso()));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "insights",
    "Run the local n=1 insight engine over your history (CTL/ATL/TSB & ramp, EF, durability, run-load, autocorr-aware correlations, taper target, validated monitoring rules) and return a one-line coach headline, the computed metrics, and the top surfaced findings. Use-when: the fast, no-LLM read of the numbers themselves. Deterministic — NO LLM cost. For a written explanation of these same metrics use `deep_dive`; for one specific question use `ask`.",
    {},
    async () => {
      const { state, window } = await buildTodayState();
      if (!state.raw) return fail("No data assembled — nothing to analyse.");
      const reactionState = await new DecisionLog().insightReactions();
      const suppressed = suppressedInsightKeys(reactionState);
      const reactions = new Map([...reactionState].map(([k, v]) => [k, v.reaction] as const));
      const engagement = await loadEngagementContext(window);
      const insightLog = new InsightLog();
      const firstSeen = await insightLog.firstSeenByKey(); // before recording this surfacing → new = brand new
      const predictionTrajectory = await loadPredictionTrajectory(state);
      const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement, predictionTrajectory });
      await insightLog.recordSurfaced(ins.topFindings, "mcp-insights");
      // Lead with the synthesised one-call headline so the output answers "what matters" before the
      // metric wall — same headline the dashboard and `ask` use.
      const hl = coachHeadline(ins, state);
      return ok([
        `COACH HEADLINE [${hl.severity.toUpperCase()}]: ${hl.line}${hl.action ? ` → ${hl.action}` : ""}`,
        "",
        insightMetricsSummary(ins),
        "",
        insightFindings(ins, { firstSeen, reactions }),
        "",
        "(react with `react_to_insight`: key=… + like / dislike / snooze / clear — like/dislike persist & are reversible; snooze hides ~2wk)",
      ].join("\n"));
    },
  );

  server.tool(
    "agenda",
    "Walk the SAME items the dashboard shows on its 'This week' and 'Set up & improve' cards: coach recommendations (latest readiness/deep-dive), timely cues, finish-setup gaps, 'discuss with coach' open items and races — each with its stable key + current reaction. Use-when: 'walk me through this week' / going through the dashboard with the athlete. Deterministic — NO LLM cost. Record each outcome against its key with `react_to_insight`; a training-change cue applies via the gated propose→confirm flow.",
    {},
    async () => {
      const { state, window } = await buildTodayState();
      const profile = (await loadProfile()).profile;
      if (!profile) return fail("No profile found — nothing to set up or discuss.");
      const log = new DecisionLog();
      const decisions = await log.all();
      const reactionState = await log.insightReactions();
      const suppressed = suppressedInsightKeys(reactionState);
      const reactions = new Map([...reactionState].map(([k, v]) => [k, v.reaction] as const));
      const appliedKeys = executedSourceKeys(decisions);
      const discussions = latestCoachDiscussions(decisions);

      // Mirror the dashboard's assembly so the coach sees exactly the athlete's cards (no drift).
      const engagement = await loadEngagementContext(window);
      const insights = state.raw ? buildInsights(state, await loadArchive(), { suppressed, history: window, engagement }) : undefined;
      const surfacedInsightKeys = new Set<string>(insights ? insights.topFindings.slice(0, 5).map((f) => findingKey(f)) : []);
      const lead = insights?.topFindings.find((f) => f.severity === "flag") ?? insights?.topFindings.find((f) => f.severity === "watch");
      if (lead) surfacedInsightKeys.add(findingKey(lead));
      const coachRecs = latestAdviceFindings(await new InsightLog().all(), suppressed);

      const setupItems = buildSetupItems(profile, {
        suppressed,
        reactions,
        appliedKeys,
        insights,
        surfacedInsightKeys,
        weeklyReview: await latestWeeklyReview(),
        researchDigest: await latestResearchDigest(),
        setupHealth: {
          hasApiKey: CoachLLM.hasApiKey(),
          waterTempSet: latestReading(await loadVenue())?.tempC != null,
          lastSyncAgeHours: (Date.now() - new Date(state.assembledAt).getTime()) / 3_600_000,
        },
        liveThresholds: state.thresholds.value ?? undefined,
      });

      return ok(formatAgendaText(buildAgenda(setupItems, coachRecs, reactions, appliedKeys, discussions)));
    },
  );

  server.tool(
    "list_reports",
    "List the dated markdown reports the coach has written (weekly reviews, race prep, deep dives, session feedback), newest first.",
    {},
    async () => {
      const reports = await listReports();
      if (!reports.length) return ok("No reports yet. Run weekly / race_prep / deep_dive / session_feedback to generate some.");
      return ok(reports.map((r) => `  ${r.name}  (${r.bytes} bytes, ${r.modified.slice(0, 10)})`).join("\n"));
    },
  );

  server.tool(
    "read_report",
    "Return the full markdown of one report by file name (from list_reports).",
    { name: z.string().describe("Report file name, e.g. 2026-06-14-weekly-review.md") },
    async ({ name }) => {
      try {
        return ok(await readReport(name));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "decisions",
    "View the decision log (audit trail of readiness calls, insight feedback and gated plan proposals). filter='pending' shows only proposals awaiting confirm/decline.",
    { filter: z.enum(["all", "pending"]).optional() },
    async ({ filter }) => ok(formatDecisions(await new DecisionLog().all(), filter ?? "all")),
  );

  server.tool(
    "react_to_insight",
    "Record your reaction to a surfaced insight or `agenda` item — the same like/dislike/snooze the dashboard offers, so it persists and shapes future surfacing (parity with the website; no AI Endurance write). `key` comes from the `insights` or `agenda` tool (key=…). like/dislike are saved, visible, REVERSIBLE opinions (dislike just down-ranks, stays visible); snooze hides it ~2 weeks; clear removes a prior opinion. Pass `note` to record the WHY from discussing it with the athlete — it's stamped as a coach discussion and the dashboard card then shows 'discussed with coach · <date> · <outcome> — <note>'. Local decision-log write only.",
    {
      key: z.string().min(1).describe("Finding/agenda key (the key=… field)."),
      reaction: z.enum(["like", "dislike", "snooze", "clear"]),
      summary: z.string().optional().describe("The finding's title, for the audit log (optional)."),
      family: z.string().optional().describe("The finding's family — only needed when reacting to a setup:* card key the insight log doesn't carry, so the engagement model can weight it."),
      note: z.string().optional().describe("One line on WHY — the call you and the athlete reached. Marks this a coach discussion and surfaces on the dashboard card."),
    },
    async ({ key, reaction, summary, family, note }) => {
      const mapped = reactionFromLabel(reaction);
      if (!mapped) return fail(`Unknown reaction: ${reaction}`);
      // Every react_to_insight call IS a coach-surface action → stamp via:"coach" so the dashboard can show
      // it was discussed (not a bare click); the optional note carries the why.
      await new DecisionLog().recordInsightFeedback(key, mapped, summary ?? key, family, note, "coach");
      const msg =
        reaction === "snooze" ? "hidden ~2 weeks" : reaction === "clear" ? "opinion cleared" : `saved (${reaction === "dislike" ? "stays visible, down-ranked" : "reversible"})`;
      return ok(`Recorded ${reaction} on "${key}"${note ? ` — discussed: "${note}"` : ""} — ${msg}.`);
    },
  );

  server.tool(
    "retrospect",
    "Record how a past insight/recommendation HELD UP — a free-text outcome note (e.g. 'the carb advice was right, fewer late fades'). `key` is the finding/setup key you reacted to (from `insights` or the card). It's logged against that key WITHOUT changing your reaction, then joined back into `listening` (an 'Outcomes you recorded' section) and shown by `decisions` — so you can answer 'advice → what I did → how it worked out'. Local decision-log write only.",
    {
      key: z.string().min(1).describe("The finding/setup key the outcome is about (from the `insights` tool or a card)."),
      note: z.string().min(1).describe("How it held up — the retrospective ('proved right', 'didn't fit', 'irrelevant', …)."),
      summary: z.string().optional().describe("The insight's title, for the audit log (optional)."),
    },
    async ({ key, note, summary }) => {
      await new DecisionLog().recordRetro(key, note, summary);
      return ok(`Logged a retrospective on "${key}". It'll show in \`listening\` (Outcomes you recorded) and \`decisions\`.`);
    },
  );

  server.tool(
    "listening",
    "Your engagement model: which insight families you act on vs dismiss, gated-proposal accept/decline, findings that recurred after you dismissed them, your plan ADHERENCE (AI Endurance plan progress — done vs planned hours, and its trend), and PLAN CHANGES detected from daily snapshots (added/moved/dropped sessions). Deterministic — no LLM cost. Descriptive, not causal.",
    {},
    async () => {
      const snapshots = await new InsightLog().all();
      const decisions = await new DecisionLog().all();
      const states = await new StateStore().recent(todayIso(), 90);
      const latest = states[states.length - 1];
      const recData = (latest?.raw?.getRecoveryModel as { data?: Parameters<typeof loadModel>[0] } | undefined)?.data;
      const model = analyseListening({ snapshots, decisions, states, load: loadModel(recData) });
      return ok(formatListening(model, todayIso()));
    },
  );

  server.tool(
    "cost",
    "Local token-cost report for the LLM flows (today / 7d / 30d / all-time, or a custom window) with a monthly projection. Reads the local cost log only.",
    { days: z.number().int().positive().optional() },
    async ({ days }) => ok(formatCost(await readCostRecords(), days)),
  );

  server.tool(
    "fuelling",
    "Per-session fuelling plan (pre / during / after) for your UPCOMING sessions, built from YOUR own logged nutrition (profile.local.yaml → fuelling.products). Deterministic — no LLM cost. Honours 'only what you need': a short/easy session returns 'water's fine'. Carb/hr targets are a MODEL and respect your learned tolerance ceiling.",
    { days: z.number().int().positive().max(14).optional().describe("Horizon in days (default 7).") },
    async ({ days }) => {
      const { state, window } = await buildTodayState();
      const inv = loadInventory(state.profile);
      if (!inv.length) return ok("No fuel inventory yet. Add the nutrition you use to profile.local.yaml under fuelling.products (see profile.example.yaml), then ask again.");
      const plans = buildWeekFuelPlans(upcomingPlanned(window, todayIso(), days ?? 7).sessions, {
        weightKg: state.weightKg.value,
        inventory: inv,
        prefs: loadFuelPrefs(state.profile?.fuelling),
      });
      return ok(formatWeekFuelText(plans));
    },
  );

  server.tool(
    "log_fuel",
    "Log how a session's fuelling actually went — the one-tap feedback that improves future guidance over time. Appends to your LOCAL fuel log only (no AI Endurance write).",
    {
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sport: z.string().min(1),
      outcome: z.enum(["good", "rough", "bonked", "skipped"]),
      carb_g_per_hour: z.number().positive().optional().describe("The carb/hr you actually took, if known — sharpens the tolerance model."),
      note: z.string().optional(),
    },
    async ({ date, sport, outcome, carb_g_per_hour, note }) => {
      if (!isFuelOutcome(outcome)) return fail("outcome must be one of: good, rough, bonked, skipped");
      await saveFuelLog({ date, sport: sport.slice(0, 16), outcome, carbTargetGPerHour: carb_g_per_hour, note: note?.slice(0, 300), loggedAt: new Date().toISOString() });
      return ok(`Logged "${outcome}" for ${date} ${sport}. I'll factor it into your fuelling review.`);
    },
  );

  // ---- LLM flows (need ANTHROPIC_API_KEY; every call is cost-logged) ----
  server.tool(
    "fuel_review",
    "Learning review over your fuel log: observed carb/hr tolerance, what sits well per sport, caffeine/timing, and suggested profile tweaks to apply yourself. ONE LLM call; wellbeing-screened (fuel adequately for the work, never restriction). Needs ≥3 logged sessions.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state } = await buildTodayState();
      const { markdown } = await runFuelReview(new CoachLLM(await loadSystemPrompt(), "fuel-review", "medium"), await loadFuelLog(), loadInventory(state.profile), state);
      return ok(markdown);
    },
  );

  server.tool(
    "ask",
    "Free-form question over your assembled data + insights — this is the coaching surface for one-off questions (the dashboard has no Ask box; Q&A lives here). e.g. 'how were my long rides this month?'. Use-when: one specific question. Medium LLM cost. For a full structured review use `weekly` (last week) or `deep_dive` (all-time trends); for the raw numbers with no LLM use `insights`.",
    { question: z.string().min(1) },
    async ({ question }) => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state } = await buildTodayState();
      const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt(), "ask", "medium"), question, state, await loadArchive());
      return ok(answer);
    },
  );

  server.tool(
    "readiness",
    "Daily green/amber/red readiness verdict with cited drivers and a wellbeing check, on a trend (not one bad night). Logs to the decision log.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { verdict, risk } = await gatherReadiness();
      return ok(formatReadiness(verdict, risk));
    },
  );

  server.tool(
    "weekly",
    "Weekly review (takeaway-led): load by sport, adherence, trends, next-week focus. Also writes a dated report. Use-when: you want LAST WEEK reviewed. High LLM cost. For all-time trends use `deep_dive`, for the multi-season picture use `season_arc`.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { window } = await buildTodayState();
      const { markdown } = await runWeeklyReview(new CoachLLM(await loadSystemPrompt(), "weekly"), window, await loadEngagementContext(window));
      await writeReport("weekly-review", todayIso(), markdown);
      return ok(markdown);
    },
  );

  server.tool(
    "race_prep",
    "Race-specific prep for the next race (or a named one), calibrated to time-to-race. Also writes a dated report.",
    { race: z.string().optional().describe("Race name from your AI Endurance goals; omit to auto-pick the next race.") },
    async ({ race }) => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state } = await buildTodayState();
      const { markdown, raceLabel } = await runRacePrep(new CoachLLM(await loadSystemPrompt(), "race"), state, race, loadProfileRacesSync());
      await writeReport(`race-prep-${raceLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, todayIso(), markdown);
      return ok(markdown);
    },
  );

  server.tool(
    "deep_dive",
    "Insight-engine deep dive: a coach-style analysis (load & form, efficiency & durability, injury risk, goal tracking) over your computed metrics, written to a dated report. ASYNC (two-step): the first call starts generation in the background and returns at once (it's high-cost — two Opus-4.8 passes — and outran the old blocking call's transport timeout); call it AGAIN — or `read_report <date>-deep-dive.md` — a minute later to get the finished write-up. Returns today's report immediately if already generated (pass refresh=true to regenerate). `insights` is the same data with NO LLM and no wait; `weekly` is scoped to last week; `season_arc` is the multi-season view.",
    { refresh: z.boolean().optional().describe("Regenerate today's deep dive even if a report already exists (default false → return the existing one).") },
    async ({ refresh }) => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const today = todayIso();
      const reportName = `${today}-deep-dive.md`;
      const reportExists = (await listReports()).some((r) => r.name === reportName);
      const action = nextDeepDiveAction({ today, reportExists, job: deepDiveJob, now: Date.now(), refresh: !!refresh });
      switch (action.kind) {
        case "return-report":
          return ok(await readReport(reportName));
        case "in-progress":
          return ok(
            `⏳ Deep dive still generating (${action.elapsedSec}s elapsed; Opus 4.8 at high effort usually takes ~60–120s). ` +
              `Call \`deep_dive\` again — or \`read_report ${reportName}\` — shortly to read it. \`insights\` has the same numbers right now, no wait.`,
          );
        case "report-error": {
          deepDiveJob = null; // surfaced once — allow a retry on the next call
          return fail(`Previous deep-dive attempt failed: ${action.error}. Call \`deep_dive\` again to retry.`);
        }
        case "start": {
          const job: DeepDiveJob = { date: today, startedAt: Date.now(), done: false };
          deepDiveJob = job;
          void generateDeepDive(job); // fire-and-forget: writes reports/<date>-deep-dive.md when done
          return ok(
            `🚀 Deep dive started (Opus 4.8, high effort — usually ~60–120s). It writes to reports/${reportName}. ` +
              `Call \`deep_dive\` again — or \`read_report ${reportName}\` — in a moment to read it. Meanwhile \`insights\` gives the same numbers with no LLM wait.`,
          );
        }
      }
    },
  );

  server.tool(
    "season_arc",
    "Multi-season strategic review (rebuild → 70.3 → Ironman): CTL arc vs phase targets, the long-arc volume benchmark, structural levers (strength / swim CSS / bloods age / threshold) and risk flags, then an LLM strategic narrative. Reads your season_plan + live CTL + career trajectory. Writes a dated report. Without an API key it returns the deterministic digest. Use-when: the multi-YEAR strategic picture. High LLM cost. For a single week use `weekly`; for current-state trends use `deep_dive`.",
    {},
    async () => {
      const { state, window } = await buildTodayState();
      const career = loadCareerHistory();
      const ctlSeries = window
        .map((s) => ({ date: s.date, v: s.load.value?.ctl }))
        .filter((x): x is { date: string; v: number } => typeof x.v === "number");
      const report = buildSeasonArc({
        today: todayIso(),
        plan: state.profile?.season_plan,
        ctlNow: ctlSeries.length ? ctlSeries[ctlSeries.length - 1].v : undefined,
        ctlSeries,
        career,
        profile: state.profile,
      });
      // The Season-arc report is meaningful WITHOUT the LLM, so degrade to the deterministic digest
      // (more useful than failing) rather than gating the whole tool on the API key.
      if (missingKey()) return ok(`${seasonReportText(report)}\n\n(deterministic digest — set ANTHROPIC_API_KEY for the strategic narrative.)`);
      const { markdown } = await runSeasonNarrative(new CoachLLM(await loadSystemPrompt(), "season"), report, career, state);
      await writeReport("season-arc", todayIso(), markdown);
      return ok(markdown);
    },
  );

  server.tool(
    "tune",
    "Weekly tune-up: the SMALLER, easy-to-action marginal gains from your data (efficiency, durability, fuelling, pacing, biomechanics) — the easy wins, not 'train more / be consistent'. Also writes a dated report.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state, window } = await buildTodayState();
      const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
      const engagement = await loadEngagementContext(window);
      const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
      const { markdown, gains } = await runTuneUp(new CoachLLM(await loadSystemPrompt(), "tune", "medium"), state, ins);
      if (gains.length) await writeReport("tune-up", todayIso(), markdown);
      return ok(markdown);
    },
  );

  server.tool(
    "research",
    "Monthly research digest: web-searches recent training/triathlon/gear thinking (e.g. tyre width, fuelling g/h, heat) against your knowledge layer and DRAFTS proposed prior updates. Writes a review proposal to knowledge/pending/ — nothing is applied until you approve it (`npm run knowledge -- approve <file>`). Best-effort; uses web search.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const today = todayIso();
      try {
        const { markdown } = await runResearchDigest(new CoachLLM(await loadSystemPrompt(), "research", "high"), await readKnowledge(), today, await loadEngagementContext([]));
        await writePendingDigest(today, markdown);
        return ok(`Drafted a research digest for review → knowledge/pending/${pendingName(today)}\nReview it, then approve with the CLI: npm run knowledge -- approve ${pendingName(today)}\n\n${markdown}`);
      } catch (e) {
        return fail(`Research digest unavailable (degraded, priors untouched): ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    "knowledge",
    "Knowledge-layer status: when the coach's sports-science priors were last verified (stale flag) and any research digests awaiting your review. Read-only — approving a digest is a deliberate CLI action (`npm run knowledge -- approve`).",
    {},
    async () => {
      const f = knowledgeFreshness(await readKnowledge());
      const pending = await listPending();
      const lines = [
        `Knowledge layer — last verified ${f.lastVerified ?? "never"}${f.ageDays != null ? ` (${f.ageDays}d ago)` : ""}: ${f.stale ? "STALE — due a refresh (the `research` tool)" : "fresh"}`,
        pending.length ? `\nPending digests awaiting review (${pending.length}):` : "\nNo pending digests — run the `research` tool to draft one.",
        ...pending.map((p) => `  ${p.name} (${p.bytes} bytes) → approve via CLI: npm run knowledge -- approve ${p.name}`),
      ];
      return ok(lines.join("\n"));
    },
  );

  server.tool(
    "session_feedback",
    "Deep, coach-quality feedback on one session (the most recent, or a given date). Needs the session's raw .FIT for biomechanics; pass force=true for summary-only feedback.",
    { date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), force: z.boolean().optional() },
    async ({ date, force }) => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state, window } = await buildTodayState();
      if (!state.raw) return fail("No data assembled — cannot build session feedback.");
      const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
      const insights = buildInsights(state, await loadArchive(), { suppressed, history: window });
      const feedback = await runSessionFeedback(new CoachLLM(await loadSystemPrompt(), "session", "medium"), state, insights, {
        date,
        force,
        decays: loadSessionDecays(),
        fitSummaries: await new ArchiveStore().loadFitSummaries(),
      });
      if (!feedback) return fail(date ? `No activity found for ${date}.` : "No recent activity found to analyse.");
      if (feedback.skippedNoFit) return ok(feedback.markdown + "\n\n(no LLM call made — pass force=true for summary-only feedback)");
      await writeReport("session-feedback", feedback.detail.date, feedback.markdown);
      return ok(feedback.markdown);
    },
  );

  // ---- profile write (local file) — opt-in on remote surfaces, always on locally ----
  // Writes profile.local.yaml only, through validateProfile (no live numbers). Gated separately from the
  // AIE write path because it touches the host filesystem, not AI Endurance.
  if (opts.includeProfileWrite) registerProfileWriteTool(server);

  // ---- gated, repo-scoped file read/write (gitignored files a web clone doesn't have) ----
  if (opts.includeFileAccess) registerFileAccessTools(server);

  // ---- gated write path (propose → confirm) — the ONLY way to mutate AI Endurance ----
  // Omitted entirely when includeWrites is false (e.g. a read-only HTTP/Cowork surface).
  if (opts.includeWrites !== false) registerWriteTools(server);

  return server;
}

/**
 * Register the `update_profile` tool — write the STABLE athlete profile by talking to Claude. It
 * deep-merges a partial patch onto the current profile, validates (schema + no-live-numbers guard), and
 * writes the gitignored profile.local.yaml. Never mutates AI Endurance; live numbers are rejected.
 */
function registerProfileWriteTool(server: McpServer): void {
  server.tool(
    "update_profile",
    "Write to your athlete profile (profile.local.yaml) — the STABLE context: identity, biomechanics, health/medication, availability, equipment, fuelling, race targets. Pass `patch`: a partial profile object (same shape as `get_profile` / profile.example.yaml) holding ONLY the fields to set; it is deep-merged onto your current profile (nested objects merged, arrays/scalars replaced), validated, then written. NO live numbers — FTP, weight, paces, swim CSS, HRV and training load are rejected (they come live from AI Endurance/Garmin). Call `get_profile` first to see the current shape.",
    { patch: z.record(z.string(), z.any()).describe("Partial profile object: the fields to set/update. Nested objects are merged; arrays and scalars replace.") },
    async ({ patch }) => {
      try {
        const { path, changed } = await updateLocalProfile(patch);
        return ok(`✓ Updated ${path}${changed.length ? ` (sections set: ${changed.join(", ")})` : ""}. Validated — no live numbers stored.`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/**
 * Register the gated, repo-scoped file tools — `list_files` / `read_file` / `write_file`. They let a
 * session read and update the project's GITIGNORED files (profile.local.yaml, data/, reports/,
 * knowledge/ …) that a fresh web-session clone never has on disk. Scoped to the repo root with a hard
 * secrets deny-list (`.env*`, tokens, keys, `.git/`, `node_modules/`) enforced in `fileAccess.ts`, so it
 * can read/write your data but never a secret. Off unless enabled (local stdio, or COACH_MCP_FILE_ACCESS
 * on the HTTP/Cowork surface).
 */
function registerFileAccessTools(server: McpServer): void {
  const fmtSize = (n?: number) => (n == null ? "" : n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}K`);
  server.tool(
    "list_files",
    "List a directory in the project repo (default the repo root). Use this to discover the GITIGNORED files a fresh clone doesn't have — profile.local.yaml, data/, reports/, knowledge/. Scoped to the repo; secrets (.env*, tokens, keys), .git/ and node_modules/ are hidden. Read-only, no LLM cost.",
    { path: z.string().optional().describe("Directory relative to the repo root (e.g. 'reports'). Omit for the root.") },
    async ({ path }) => {
      try {
        const { rel, entries } = await listRepoDir(repoRoot(), path ?? ".");
        if (!entries.length) return ok(`${rel}/ is empty (or only holds excluded files).`);
        const lines = entries.map((e) => `  ${e.type === "dir" ? "📁" : "📄"} ${e.name}${e.type === "dir" ? "/" : ""}${e.size != null ? `  (${fmtSize(e.size)})` : ""}`);
        return ok(`${rel}/ — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
  server.tool(
    "read_file",
    "Read a UTF-8 text file from the project repo — including GITIGNORED files (profile.local.yaml, data/*.json, reports/*, knowledge/*) that a web-session clone doesn't have on disk. Returns the file's EXACT contents (no added header), so an edit can be written straight back with write_file. Scoped to the repo; secrets (.env*, tokens, keys) and .git/ are refused. Read-only, no LLM cost.",
    { path: z.string().min(1).describe("File path relative to the repo root, e.g. 'profile.local.yaml'.") },
    async ({ path }) => {
      try {
        const { content } = await readRepoFile(repoRoot(), path);
        return ok(formatReadResult(content));
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
  server.tool(
    "write_file",
    "Write (create or overwrite) a UTF-8 text file in the project repo — for the GITIGNORED files you maintain (e.g. profile.local.yaml, a local data/ file). ⚠ Writes a real file on the host. Scoped to the repo with parent dirs created as needed; secrets (.env*, tokens, keys), .git/ and node_modules/ are refused. Read the file first if you're editing it — this replaces the whole file. (For the athlete profile, prefer `update_profile`, which deep-merges and validates.)",
    {
      path: z.string().min(1).describe("File path relative to the repo root, e.g. 'data/notes.json'."),
      content: z.string().describe("The full new file contents (UTF-8). This REPLACES the file."),
    },
    async ({ path, content }) => {
      try {
        const { rel, bytes } = await writeRepoFile(repoRoot(), path, content);
        return ok(`✓ Wrote ${rel} (${bytes} bytes).`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

/** Register the gated write tools. The ONLY path that can mutate AI Endurance (propose → confirm). */
function registerWriteTools(server: McpServer): void {
  server.tool(
    "propose_adjustment",
    "Propose plan adjustments for a request (e.g. 'move my long run off race week'). NOTHING is written — each proposal is logged with its trade-off and an id. Apply with `confirm`, dismiss with `decline`.",
    { request: z.string().min(1) },
    async ({ request }) => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const screen = screenNutritionPrompt(request);
      if (screen.blocked) return ok(screen.redirect!);
      const { state, window } = await buildTodayState();
      const engagement = await loadEngagementContext(window);
      const ins = buildInsights(state, await loadArchive(), { history: window, engagement });
      const { result } = await proposeAdjustments(new CoachLLM(await loadSystemPrompt(), "propose"), request, state, buildProposerContext(state, ins, engagement));
      const { valid, rejected } = validateProposals(result.proposals, state.plannedSessions.value ?? [], writeContextFor(state));
      if (!valid.length) {
        const tail = rejected.length ? "\n" + rejected.map((r) => `  · ${r}`).join("\n") : "";
        return ok(`No applicable change proposed. ${result.notes ?? ""}${tail}`.trim());
      }
      const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
      const lines = ["Proposed adjustments (nothing changed yet):", ""];
      for (const p of valid) {
        const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human, basis: p.basis });
        lines.push(`  [${proposal.id}] ${p.human}`, `      ${p.summary} — trade-off: ${p.tradeoff}`);
        if (p.basis.length) lines.push(`      because: ${p.basis.join("; ")}`);
      }
      if (rejected.length) lines.push("", "Not applied (no matching session):", ...rejected.map((r) => `  · ${r}`));
      if (result.notes) lines.push("", `Notes: ${result.notes}`);
      lines.push("", "Apply with the `confirm` tool (id=…), or dismiss with `decline` (id=…).");
      return ok(lines.join("\n"));
    },
  );

  server.tool(
    "confirm",
    "Apply a previously-proposed plan adjustment by id — the ONLY tool that writes to AI Endurance. Single-use; fails if the proposal isn't in a confirmable state.",
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        return await withAie(async (aie) => {
          const result = await new WriteGate(aie, new DecisionLog()).confirm(id);
          const detail = typeof result === "string" ? result : JSON.stringify(result).slice(0, 300);
          return ok(`✓ Applied ${id} and synced to AI Endurance.\n${detail}`);
        });
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );

  server.tool(
    "decline",
    "Dismiss a pending plan-adjustment proposal by id (no API call).",
    { id: z.string().min(1) },
    async ({ id }) => {
      try {
        await new WriteGate(new AieClient(), new DecisionLog()).decline(id);
        return ok(`Dismissed ${id}.`);
      } catch (e) {
        return fail(e instanceof Error ? e.message : String(e));
      }
    },
  );
}

async function main(): Promise<void> {
  // stdio MCP: stdout is the protocol channel. Funnel any stray console.log from the flows to
  // stderr so it can't corrupt a protocol frame. (StdioServerTransport writes via
  // process.stdout.write, which this override does NOT touch — frames are unaffected.)
  console.log = (...args: unknown[]) => console.error(...args);

  // Local stdio is the user's own machine spawning the process, so the local-file writes are on, and the
  // medical context is exposed (the coach needs it; the user is reading their own data).
  setMedicalExposure(true);
  const server = buildServer({ includeProfileWrite: true, includeFileAccess: true });
  await server.connect(new StdioServerTransport());
  console.error(
    "endurance-coach MCP server ready (stdio). Read tools: sync/get_state/splits/ingest_fit/ftp_check/get_profile/insights/react_to_insight/list_reports/" +
      "read_report/decisions/listening/knowledge/cost · LLM tools: ask/readiness/weekly/race_prep/deep_dive/tune/research/session_feedback · " +
      "writes: update_profile (local file), list_files/read_file/write_file (repo files) · gated AIE writes: propose_adjustment/confirm/decline.",
  );
}

// Only start the server when run directly (not when imported by tests).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("Fatal:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
