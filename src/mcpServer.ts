import { pathToFileURL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { buildTodayState, gatherReadiness, loadArchive, todayIso, withAie } from "./coach/orchestrator.js";
import { StateStore } from "./state/store.js";
import { buildInsights } from "./insights/engine.js";
import { DecisionLog, suppressedInsightKeys, reactionFromLabel, type DecisionRecord } from "./state/decisionLog.js";
import { InsightLog } from "./state/insightLog.js";
import { analyseListening, formatListening } from "./coach/listening.js";
import { loadEngagementContext } from "./coach/engagementContext.js";
import { loadModel } from "./insights/metrics.js";
import { ArchiveStore } from "./archive/store.js";
import { answerQuestion } from "./coach/ask.js";
import { runWeeklyReview } from "./coach/weekly.js";
import { runRacePrep } from "./coach/racePrep.js";
import { runDeepDive, insightMetricsSummary, insightFindings } from "./coach/deepDive.js";
import { runTuneUp } from "./coach/tuneUp.js";
import { runResearchDigest } from "./coach/research.js";
import { readKnowledge, writePendingDigest, pendingName, knowledgeFreshness, listPending } from "./knowledge/store.js";
import { runSessionFeedback } from "./coach/session.js";
import { loadSessionDecays } from "./insights/fit.js";
import { writeReport, listReports, readReport } from "./coach/reports.js";
import { proposeAdjustments, validateProposals, buildProposerContext } from "./coach/planAdjust.js";
import { screenNutritionPrompt } from "./guardrails/wellbeing.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { AieClient } from "./mcp/aieClient.js";
import { readCostRecords, summarizeCost, type CostRecord } from "./llm/costLog.js";
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
const prov = (p: Provenance) => `${p.value == null ? "—" : "set"} [${p.source}${p.note ? `: ${p.note}` : ""}]`;

/** A glanceable, provenance-tagged digest of an AthleteState (mirrors `npm run state`). */
export function summarizeState(state: AthleteState): string {
  const L = (label: string, p: Provenance) => `  ${label.padEnd(22)} ${prov(p)}`;
  return [
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
    L("thresholds (ftp/pace)", state.thresholds),
    L("zones", state.zones),
    L("tiebreak (garmin)", state.tiebreak),
    L("nutrition targets", state.nutritionTargets),
    `  sync gaps: ${state.syncGaps.length}`,
    ...state.syncGaps.map((g) => `    - [${g.kind}] ${g.detail}`),
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
 */
export function buildServer(opts: { includeWrites?: boolean } = {}): McpServer {
  const server = new McpServer({ name: "endurance-coach", version: "0.1.0" });

  // ---- deterministic reads (no LLM, no token cost) ----
  server.tool(
    "sync",
    "Assemble today's AthleteState fresh from AI Endurance (+ Garmin if enabled) and persist it. Returns a summary + any sync gaps. Network call; no LLM cost.",
    {},
    async () => ok(summarizeState((await buildTodayState()).state)),
  );

  server.tool(
    "get_state",
    "Return today's AthleteState (plan, recovery, HRV/RHR, weight, thresholds, zones, …). Reads the last persisted snapshot by default; pass fresh=true to re-sync from AI Endurance first.",
    { fresh: z.boolean().optional().describe("Re-assemble from AI Endurance before returning (default: use the last snapshot).") },
    async ({ fresh }) => {
      const state = fresh ? (await buildTodayState()).state : (await new StateStore().recent(todayIso(), 1))[0];
      if (!state) return fail("No state assembled yet — call the `sync` tool (or get_state with fresh=true) first.");
      return ok(summarizeState(state));
    },
  );

  server.tool(
    "insights",
    "Run the local n=1 insight engine over your history (CTL/ATL/TSB & ramp, EF, durability, run-load, autocorr-aware correlations, change-points, taper target, validated monitoring rules) and return the computed metrics + top surfaced findings. Deterministic — no LLM cost.",
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
      const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
      await insightLog.recordSurfaced(ins.topFindings, "mcp-insights");
      return ok([
        insightMetricsSummary(ins),
        "",
        insightFindings(ins, { firstSeen, reactions }),
        "",
        "(react with `react_to_insight`: key=… + like / dislike / snooze / clear — like/dislike persist & are reversible; snooze hides ~2wk)",
      ].join("\n"));
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
    "Record your reaction to a surfaced insight — the same like/dislike/snooze the dashboard offers, so it persists and shapes future surfacing (parity with the website; no AI Endurance write). `key` comes from the `insights` tool (key=…). like/dislike are saved, visible, REVERSIBLE opinions (dislike just down-ranks, stays visible); snooze hides it ~2 weeks; clear removes a prior opinion. Local decision-log write only.",
    {
      key: z.string().min(1).describe("Finding key from the `insights` tool output (the key=… field)."),
      reaction: z.enum(["like", "dislike", "snooze", "clear"]),
      summary: z.string().optional().describe("The finding's title, for the audit log (optional)."),
    },
    async ({ key, reaction, summary }) => {
      const mapped = reactionFromLabel(reaction);
      if (!mapped) return fail(`Unknown reaction: ${reaction}`);
      await new DecisionLog().recordInsightFeedback(key, mapped, summary ?? key);
      const note =
        reaction === "snooze" ? "hidden ~2 weeks" : reaction === "clear" ? "opinion cleared" : `saved (${reaction === "dislike" ? "stays visible, down-ranked" : "reversible"})`;
      return ok(`Recorded ${reaction} on "${key}" — ${note}.`);
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

  // ---- LLM flows (need ANTHROPIC_API_KEY; every call is cost-logged) ----
  server.tool(
    "ask",
    "Free-form question over your assembled data + insights (the same engine as the dashboard 'Ask your data' box). e.g. 'how were my long rides this month?'",
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
    "Weekly review (takeaway-led): load by sport, adherence, trends, next-week focus. Also writes a dated report.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { window } = await buildTodayState();
      const { markdown } = await runWeeklyReview(new CoachLLM(await loadSystemPrompt(), "weekly"), window);
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
      const { markdown, raceLabel } = await runRacePrep(new CoachLLM(await loadSystemPrompt(), "race"), state, race);
      await writeReport(`race-prep-${raceLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, todayIso(), markdown);
      return ok(markdown);
    },
  );

  server.tool(
    "deep_dive",
    "Insight-engine deep dive: a coach-style analysis (load & form, efficiency & durability, injury risk, goal tracking) over your computed metrics. Also writes a dated report.",
    {},
    async () => {
      const miss = missingKey();
      if (miss) return fail(miss);
      const { state, window } = await buildTodayState();
      const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
      const engagement = await loadEngagementContext(window);
      const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
      const { markdown } = await runDeepDive(new CoachLLM(await loadSystemPrompt(), "deep-dive"), state, ins);
      await writeReport("deep-dive", todayIso(), markdown);
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
        const { markdown } = await runResearchDigest(new CoachLLM(await loadSystemPrompt(), "research", "high"), await readKnowledge(), today);
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

  // ---- gated write path (propose → confirm) — the ONLY way to mutate AI Endurance ----
  // Omitted entirely when includeWrites is false (e.g. a read-only HTTP/Cowork surface).
  if (opts.includeWrites !== false) registerWriteTools(server);

  return server;
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
      const ins = buildInsights(state, await loadArchive(), { history: window });
      const { result } = await proposeAdjustments(new CoachLLM(await loadSystemPrompt(), "propose"), request, state, buildProposerContext(state, ins));
      const { valid, rejected } = validateProposals(result.proposals, state.plannedSessions.value ?? []);
      if (!valid.length) {
        const tail = rejected.length ? "\n" + rejected.map((r) => `  · ${r}`).join("\n") : "";
        return ok(`No applicable change proposed. ${result.notes ?? ""}${tail}`.trim());
      }
      const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
      const lines = ["Proposed adjustments (nothing changed yet):", ""];
      for (const p of valid) {
        const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human });
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

  const server = buildServer();
  await server.connect(new StdioServerTransport());
  console.error(
    "endurance-coach MCP server ready (stdio). Read tools: sync/get_state/insights/react_to_insight/list_reports/" +
      "read_report/decisions/listening/knowledge/cost · LLM tools: ask/readiness/weekly/race_prep/deep_dive/tune/research/session_feedback · " +
      "gated writes: propose_adjustment/confirm/decline.",
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
