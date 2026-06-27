import { AieClient, AIE_READ_TOOLS, AIE_WRITE_TOOLS } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { selectDataSource } from "./sources/index.js";
import { config } from "./config.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { runWeeklyReview } from "./coach/weekly.js";
import { runRacePrep } from "./coach/racePrep.js";
import { runDeepDive } from "./coach/deepDive.js";
import { runTuneUp } from "./coach/tuneUp.js";
import { buildWeekFuelPlans, loadFuelPrefs, formatWeekFuelText } from "./coach/fuelPlan.js";
import { loadInventory } from "./coach/fuelInventory.js";
import { loadFuelLog } from "./coach/fuelLogStore.js";
import { runFuelReview } from "./coach/fuelReview.js";
import { runResearchDigest } from "./coach/research.js";
import { readKnowledge, writePendingDigest, pendingName, approvePending, knowledgeFreshness, listPending } from "./knowledge/store.js";
import { buildTodayState, gatherCompleteness, gatherReadiness, loadArchive, loadPredictionTrajectory, todayIso, withAie } from "./coach/orchestrator.js";
import { formatCompleteness } from "./state/dataCompleteness.js";
import { proposeAdjustments, validateProposals, buildProposerContext, writeContextFor } from "./coach/planAdjust.js";
import { screenNutritionPrompt } from "./guardrails/wellbeing.js";
import { writeReport, listReports } from "./coach/reports.js";
import { seasonNudgeDue } from "./coach/seasonNudge.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildBriefSnapshot, type BriefSnapshot } from "./coach/dailyBrief.js";
import { loadPriorBrief, persistBriefIfAbsent } from "./coach/briefStore.js";
import { latestWeeklyReview, latestResearchDigest, latestSeasonNarrative, latestWeeklyReviewProse } from "./coach/setupSources.js";
import { loadSessionFeedbacks, saveSessionFeedback } from "./coach/sessionFeedbackStore.js";
import { loadMetricOverrides } from "./state/metricOverrides.js";
import { buildDemoWindow, buildDemoGarminDays, demoProfile } from "./demo/sampleData.js";
import { cmdBackfill, cmdProbe, cmdFitSync, cmdArchiveStatus, cmdArchiveCompact, cmdActivityArchiveImport, cmdActivityArchiveBackfill, cmdActivityArchiveHeal } from "./cli/dataCommands.js";
import { buildInsights } from "./insights/engine.js";
import { alertFindings, loadModel } from "./insights/metrics.js";
import { InsightLog } from "./state/insightLog.js";
import { analyseListening, formatListening } from "./coach/listening.js";
import { loadEngagementContext } from "./coach/engagementContext.js";
import { ArchiveStore } from "./archive/store.js";
import { answerQuestion } from "./coach/ask.js";
import { runSessionFeedback } from "./coach/session.js";
import { loadSessionDecays } from "./insights/fit.js";
import { readCostRecords, summarizeCost, isLocalModel } from "./llm/costLog.js";
import { getForecast } from "./weather/store.js";
import { assessWeek, latestActuals, upcomingPlanned, type WeekWeather } from "./weather/assess.js";

import { notify } from "./notify.js";
import { fileChecks, redactSecrets, checkRemoteHealth } from "./health.js";
import open from "open";
import { assessHealthRisk } from "./guardrails/wellbeing.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { DecisionLog, suppressedInsightKeys } from "./state/decisionLog.js";
import { runSetup } from "./setup.js";
import { initProfile } from "./profile/setup.js";
import { loadProfileSafe } from "./profile/load.js";
import { renderQuestionsText, renderQuestionsMarkdown } from "./profile/questions.js";
import { buildSeasonArc, seasonReportText } from "./coach/seasonArc.js";
import { runSeasonNarrative } from "./coach/seasonNarrative.js";
import { loadCareerHistory } from "./coach/careerHistory.js";
import { helpText } from "./help.js";
import type { AthleteState } from "./state/types.js";

/** `setup` — guided wizard that writes .env (key, units, location, Garmin). See src/setup.ts. */
async function cmdSetup(): Promise<void> {
  await runSetup();
}

/** `profile-init` — copy profile.example.yaml → profile.local.yaml and walk the required fields. */
async function cmdProfileInit(): Promise<void> {
  await initProfile();
}

/**
 * `profile-questions` — print the OPTIONAL profile fields you can fill whenever you like, each with a
 * plain-language question and a one-line "why this changes your coaching". Deterministic, no LLM, no
 * network — just renders the single source of truth in src/profile/questions.ts. `--write-doc`
 * regenerates docs/profile-questions.md from the same data so the two never drift.
 */
async function cmdProfileQuestions(): Promise<void> {
  if (process.argv.includes("--write-doc")) {
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(process.cwd(), "docs", "profile-questions.md");
    await writeFile(path, renderQuestionsMarkdown());
    console.log(`\n✓ Wrote ${path} from src/profile/questions.ts\n`);
    return;
  }
  console.log("\n" + renderQuestionsText());
}

/** `help` — the curated everyday commands (full list in docs/commands.md). */
async function cmdHelp(): Promise<void> {
  console.log("\n" + helpText() + "\n");
}

function requireLLM(): boolean {
  if (CoachLLM.hasApiKey()) return true;
  console.error(
    "\nANTHROPIC_API_KEY is not set. This flow needs the LLM core.\n" +
      "Add it to .env (ANTHROPIC_API_KEY=sk-ant-...) and re-run.\n",
  );
  return false;
}

/** Footer note for an LLM flow: dollar cost + cache-read tokens (see `cost` for the running total). */
function costNote(costUsd: number, cacheRead: number): string {
  return `cost $${costUsd.toFixed(4)}; cache read ${cacheRead} tokens`;
}

/** reports/ marker recording that the morning ping last SUCCEEDED — drives ping idempotency + the
 *  doctor heartbeat (so a silently-failed 06:00 ping is detectable). */
async function pingMarkerPath(): Promise<string> {
  const { join } = await import("node:path");
  return join(process.cwd(), "reports", "last-ping.json");
}
async function lastPingOk(): Promise<{ date: string; ts: string } | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const j = JSON.parse(await readFile(await pingMarkerPath(), "utf8"));
    return j && typeof j.date === "string" && typeof j.ts === "string" ? j : null;
  } catch {
    return null;
  }
}
async function recordPingSuccess(date: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(join(process.cwd(), "reports"), { recursive: true });
  await writeFile(await pingMarkerPath(), JSON.stringify({ date, ts: new Date().toISOString() }));
}

/** reports/ marker for the LAST quarterly season-review nudge — keeps the cadence from re-firing daily. */
async function seasonNudgeMarkerPath(): Promise<string> {
  const { join } = await import("node:path");
  return join(process.cwd(), "reports", "last-season-nudge.json");
}
async function lastSeasonNudge(): Promise<{ date: string } | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const j = JSON.parse(await readFile(await seasonNudgeMarkerPath(), "utf8"));
    return j && typeof j.date === "string" ? j : null;
  } catch {
    return null;
  }
}
async function recordSeasonNudge(date: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(join(process.cwd(), "reports"), { recursive: true });
  await writeFile(await seasonNudgeMarkerPath(), JSON.stringify({ date, ts: new Date().toISOString() }));
}

/**
 * Quarterly nudge: if a season_plan exists and it's been ≥~90d since the last season review (report) or
 * nudge, fire one desktop notification to revisit the multi-season arc, then record it. Best-effort — a
 * failure here must never break the morning ping.
 */
async function maybeSeasonNudge(state: AthleteState): Promise<void> {
  const plan = state.profile?.season_plan;
  const hasPlan = !!(plan && (plan.horizon_goal || (Array.isArray(plan.phases) && plan.phases.length)));
  if (!hasPlan) return;
  const reports = await listReports();
  const lastReviewDate = reports.find((r) => r.name.includes("season-arc"))?.date || undefined;
  const lastNudgeDate = (await lastSeasonNudge())?.date;
  if (!seasonNudgeDue({ today: todayIso(), hasPlan, lastReviewDate, lastNudgeDate })) return;
  await notify("Quarterly season review due", "Revisit your multi-season arc — run `npm run season` (or open /season).");
  await recordSeasonNudge(todayIso());
}
/** `auth` — run the OAuth flow (interactive first time) and confirm the connection. The ONLY flow that
 *  opts into the browser dance; every other context fails fast with a re-auth error instead of hanging. */
async function cmdAuth(): Promise<void> {
  await withAie(async (aie) => {
    const tools = await aie.listToolNames();
    console.log(`\n✓ Connected to AI Endurance — ${tools.length} tools exposed.`);
    const expected = new Set<string>([...AIE_READ_TOOLS, ...AIE_WRITE_TOOLS]);
    const missing = [...expected].filter((t) => !tools.includes(t));
    const extra = tools.filter((t) => !expected.has(t));
    if (missing.length) console.warn(`⚠ expected-but-absent (API drift?): ${missing.join(", ")}`);
    if (extra.length) console.log(`  new/unknown tools: ${extra.join(", ")}`);
    if (!missing.length && !extra.length) console.log("  tool set matches the expected 20. ✓");
    console.log(`\nTokens cached in ${config.secretsDir} — future runs are non-interactive until expiry.`);
  }, { interactive: true });
}

/** `health-remote` — hit the PUBLIC tunnel `/health?deep=1` and alert (macOS) if the connector is down
 *  or needs re-auth. Run on a schedule (scripts/install-healthcheck.sh) so trouble is caught before
 *  Cowork notices. Exits non-zero on failure so the launchd log shows it. */
async function cmdHealthRemote(): Promise<void> {
  const base = config.mcp.publicUrl;
  if (!base) {
    console.error("COACH_MCP_PUBLIC_URL is not set — nothing to check (set it to your public tunnel URL).");
    process.exit(1);
  }
  const result = await checkRemoteHealth(base);
  console.log(`${result.ok ? "✓" : "✗"} remote health (${base}): ${result.detail}`);
  if (!result.ok) {
    await notify("Endurance Coach connector", redactSecrets(result.detail)).catch(() => {});
    process.exit(2);
  }
}

/** `verify` — exercise every read tool and report per-tool status. */
async function cmdVerify(): Promise<void> {
  await withAie(async (aie) => {
    console.log("\nVerifying AI Endurance read tools:\n");
    let ok = 0;
    for (const tool of AIE_READ_TOOLS) {
      // Detail tools need an activityId — skip live call, just note they exist.
      if (tool.endsWith("ActivityDetail")) {
        console.log(`  • ${tool.padEnd(26)} — needs activityId, skipped`);
        continue;
      }
      try {
        const args = tool === "getPlannedWorkouts" ? { summaryMode: true } : {};
        await aie.read(tool, args);
        console.log(`  ✓ ${tool}`);
        ok++;
      } catch (err) {
        console.log(`  ✗ ${tool} — ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`\n${ok} read tools returned data.`);

    // Confirm the write-gate stub blocks writes through the read path.
    try {
      await aie.read("skipWorkout" as never);
      console.log("⚠ write tool was NOT blocked — gate missing!");
    } catch {
      console.log("✓ write tools are blocked from the read path (gate enforced in M3).");
    }
  });

  if (config.garmin.enabled) {
    const g = new GarminClient();
    const up = await g.connect();
    console.log(up ? "\n✓ Garmin connected (optional)." : "\nGarmin enabled but unavailable — degrading cleanly.");
    if (up) console.log(`  Garmin tools: ${(await g.listToolNames()).length}`);
    await g.close();
  } else {
    console.log("\nGarmin disabled (set GARMIN_ENABLED=true to use the optional gap-filler).");
  }
}

/** `state` — assemble, persist, and summarise today's AthleteState. */
async function cmdState(): Promise<void> {
  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();

  // Assemble via the configured data-source spine (AI Endurance by default; see src/sources/).
  const state = await selectDataSource().assemble({ store, garmin, date: todayIso(), assembledAt: new Date().toISOString() });
  const garminConnected = garmin ? garmin.available : undefined; // capture before close()
  await garmin?.close();
  await store.save(state);

  console.log(`\nAthleteState for ${state.date} (assembled ${state.assembledAt}):\n`);
  const line = (label: string, p: { value: unknown; source: string; note?: string }) =>
    console.log(
      `  ${label.padEnd(20)} ${p.value == null ? "—" : "set"}  [${p.source}${p.note ? `: ${p.note}` : ""}]`,
    );
  line("planned sessions", state.plannedSessions);
  line("actual activities", state.actualActivities);
  line("recovery model", state.recovery);
  line("prediction", state.prediction);
  line("adherence by zone", state.adherenceByZone);
  line("hrv overnight", state.hrvOvernight);
  line("hrv 7d baseline", state.hrv7dBaseline);
  line("resting hr", state.restingHr);
  line("weight (kg)", state.weightKg);
  line("weight 7d trend", state.weight7dTrend);
  line("sleep (garmin)", state.sleep);
  line("vo2max", state.vo2max);
  line("thresholds (ftp/pace)", state.thresholds);
  line("zones", state.zones);
  line("tiebreak (garmin)", state.tiebreak);
  line("nutrition targets", state.nutritionTargets);

  console.log(`\n  sync gaps: ${state.syncGaps.length}`);
  for (const g of state.syncGaps) console.log(`    - [${g.kind}] ${g.detail}`);

  // Granular-data completeness — a recent session missing its raw .FIT (so its splits/biomechanics are
  // unreachable) is surfaced here, never as a silent zero. (`npm run state` doesn't fetch; run `fit-sync`
  // or the dashboard Sync — or the MCP `sync` tool — to pull missing streams.)
  console.log("");
  for (const line of formatCompleteness(gatherCompleteness(state, { garminConnected }))) console.log(line);

  console.log(`\nSaved to ${config.dataDir}/state/${state.date}.json`);
}

/**
 * `splits [date] [--sport S] [--t400 m:ss --t200 m:ss] [--maxhr N]` — per-interval splits (laps/lengths)
 * for a session from its raw .FIT, plus a swim CSS estimate (400/200 method) with a maximal-effort
 * confidence check. With --t400/--t200 it computes CSS straight from your times (no .FIT needed).
 * Deterministic, no LLM. READ-ONLY — set CSS in AI Endurance yourself.
 */
async function cmdSplits(): Promise<void> {
  const { loadActivityFits } = await import("./insights/fit.js");
  const { formatSplits, formatCss, computeCss, detectCssEffortsFromLaps, parseClock } = await import("./insights/sessionSplits.js");
  const args = process.argv.slice(3);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const sport = flag("--sport");
  const t400 = parseClock(flag("--t400"));
  const t200 = parseClock(flag("--t200"));
  const maxHr = flag("--maxhr") ? Number(flag("--maxhr")) : undefined;

  if (t400 != null && t200 != null) {
    console.log("\n" + formatCss(computeCss({ t400Sec: t400, t200Sec: t200, maxHr, source: "explicit" })).join("\n") + "\n");
    return;
  }
  const matchesSport = (fitSport: string): boolean => {
    if (!sport) return true;
    const q = sport.toLowerCase();
    const want = /cycl|bike|ride/.test(q) ? "ride" : /run/.test(q) ? "run" : /swim/.test(q) ? "swim" : q;
    return fitSport.toLowerCase().includes(want);
  };
  const fits = loadActivityFits().filter((f) => matchesSport(f.sport));
  const pool = date ? fits.filter((f) => f.date === date) : fits;
  const target = pool.length ? pool[pool.length - 1] : null;
  if (!target) {
    console.log(
      `\nNo raw .FIT found for splits${date ? ` on ${date}` : ""}${sport ? ` (${sport})` : ""}. Run \`npm run fit-sync\` to fetch it, ` +
        "or drop an exported .FIT into the streams dir. To compute CSS without a .FIT: --t400 <m:ss> --t200 <m:ss>.\n",
    );
    return;
  }
  const lines = [`\nSession ${target.date} ${target.sport} (activity ${target.activityId}):`, "", ...formatSplits(target.fit)];
  if (target.fit.sport === 5 || /swim/i.test(target.fit.sportName)) {
    const efforts = detectCssEffortsFromLaps(target.fit.laps);
    lines.push("");
    if (efforts) lines.push(...formatCss(computeCss({ ...efforts, maxHr })));
    else lines.push("CSS: couldn't auto-detect a 400 m + 200 m maximal pair from the laps — pass --t400 <m:ss> --t200 <m:ss> to compute it.");
  }
  console.log(lines.join("\n") + "\n");
}

/**
 * `ingest-fit [path]` — the manual-export fallback for raw .FIT streams. With a path, validate an exported
 * .FIT (Garmin Connect → Export Original) and copy it into the watched streams dir; with no path, report
 * what's there + confirm the watched dir. Deterministic, no LLM. Read-only to AI Endurance.
 */
async function cmdIngestFit(): Promise<void> {
  const { reportStreamsDir, ingestFitFile, formatStreamsReport, formatIngest } = await import("./archive/fitIngest.js");
  const path = process.argv.slice(3).find((a) => !a.startsWith("-"));
  const lines = path ? formatIngest(ingestFitFile(path)) : formatStreamsReport(reportStreamsDir());
  console.log("\n" + lines.join("\n") + "\n");
}

/**
 * `ftp-check` — bike-FTP source diagnostic: configured FTP vs Garmin's power-duration estimate, the gap,
 * recent power coverage, and how to resolve a gap with power rides. Read-only; reads the last snapshot
 * (run `npm run state` / the `sync` tool first to refresh). Deterministic, no LLM.
 */
async function cmdFtpCheck(): Promise<void> {
  const { diagnoseFtp, formatFtpDiagnosis } = await import("./insights/ftpSource.js");
  const { richActivities } = await import("./insights/metrics.js");
  const state = (await new StateStore().recent(todayIso(), 1))[0];
  if (!state) {
    console.error("\nNo state assembled yet — run `npm run state` (or the MCP `sync` tool) first.\n");
    process.exit(1);
  }
  const archive = await loadArchive();
  const rides = archive?.activities ?? richActivities(state.raw);
  console.log("\n" + formatFtpDiagnosis(diagnoseFtp(state, rides)).join("\n") + "\n");
}

function printReadiness(v: { verdict: string; why: string; drivers: Array<{ signal: string; reading: string; source: string }>; cautions: string[] }, risk: ReturnType<typeof assessHealthRisk>): void {
  if (risk.level !== "none") console.log(`\n⚠ Wellbeing (${risk.level}): ${risk.message}\n`);
  const dot = v.verdict === "green" ? "🟢" : v.verdict === "amber" ? "🟡" : "🔴";
  console.log(`\n${dot} Readiness: ${v.verdict.toUpperCase()}`);
  console.log(`\n${v.why}\n`);
  console.log("Drivers:");
  for (const d of v.drivers) console.log(`  • ${d.signal}: ${d.reading}  [${d.source}]`);
  if (v.cautions.length) {
    console.log("\nCautions:");
    for (const c of v.cautions) console.log(`  • ${c}`);
  }
}

/** `readiness` — interactive green/amber/red call with cited drivers. */
async function cmdReadiness(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { verdict, risk, cacheRead, costUsd } = await gatherReadiness();
  printReadiness(verdict, risk);
  console.log(`\n(logged to decision log; ${costNote(costUsd, cacheRead)})`);
}

/** `ping` — unattended morning readiness: verdict + report + desktop notification. */
async function cmdPing(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const force = process.argv.includes("--force");
  // Idempotent (ENG-3): a launchd wake or accidental double-fire must not re-notify or re-spend.
  const prior = await lastPingOk();
  if (!force && prior && prior.date === todayIso()) {
    console.log(`\nMorning ping already ran today (${prior.date}). Use --force to re-run.`);
    return;
  }

  try {
    const { state, verdict, risk } = await gatherReadiness();

    const lines = [
      `# Morning readiness — ${state.date}`,
      "",
      `**${verdict.verdict.toUpperCase()}** — ${verdict.why}`,
      "",
      risk.level !== "none" ? `> ⚠ Wellbeing (${risk.level}): ${risk.message}\n` : "",
      "## Drivers",
      ...verdict.drivers.map((d) => `- **${d.signal}**: ${d.reading} _[${d.source}]_`),
      verdict.cautions.length ? "\n## Cautions\n" + verdict.cautions.map((c) => `- ${c}`).join("\n") : "",
    ];
    const md = lines.filter((l) => l !== "").join("\n");
    await writeReport("morning-readiness", state.date, md);

    printReadiness(verdict, risk);
    const note = verdict.why.length > 180 ? verdict.why.slice(0, 177) + "…" : verdict.why;
    await notify(`Readiness: ${verdict.verdict.toUpperCase()}`, note);
    await recordPingSuccess(state.date); // heartbeat for the doctor check
    await maybeSeasonNudge(state).catch(() => {}); // quarterly season-review nudge (best-effort)
    console.log(`\n(report written; desktop notification sent if on macOS)`);
  } catch (err) {
    // PROD-2: an unattended failure is otherwise invisible — the athlete just gets no readiness and no
    // signal it broke. Notify with a redacted reason, then re-throw to keep the non-zero exit + log line.
    const reason = redactSecrets(err instanceof Error ? err.message : String(err));
    await notify("Readiness unavailable", reason.slice(0, 180)).catch(() => {});
    throw err;
  }
}

/** `deep-dive` — compute insight metrics, synthesise a coach-style analysis, write a report. */
async function cmdDeepDive(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state, window } = await buildTodayState();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const engagement = await loadEngagementContext(window);
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
  const { markdown, cacheRead, costUsd } = await runDeepDive(new CoachLLM(await loadSystemPrompt(), "deep-dive"), state, ins);
  console.log("\n" + markdown + "\n");
  const path = await writeReport("deep-dive", todayIso(), markdown);
  console.log(`(report → ${path}; ${costNote(costUsd, cacheRead)})`);
}

/** `season` — multi-season strategic review: the deterministic Season-arc report + an LLM strategic
 *  narrative (the multi-year layer above weekly/deep-dive). No API key → the deterministic digest only. */
async function cmdSeason(): Promise<void> {
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
  if (!CoachLLM.hasApiKey()) {
    console.log("\n" + seasonReportText(report) + "\n\n(no ANTHROPIC_API_KEY — deterministic digest only; set it for the strategic narrative. The /season page shows this same report.)\n");
    return;
  }
  const { markdown, cacheRead, costUsd } = await runSeasonNarrative(new CoachLLM(await loadSystemPrompt(), "season"), report, career, state);
  console.log("\n" + markdown + "\n");
  const path = await writeReport("season-arc", todayIso(), markdown);
  console.log(`(report → ${path}; ${costNote(costUsd, cacheRead)})`);
}

/** `tune` — the smaller, easy-to-action marginal gains (not "train more"), as a weekly report. */
async function cmdTune(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state, window } = await buildTodayState();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const engagement = await loadEngagementContext(window);
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
  const { markdown, gains, cacheRead, costUsd } = await runTuneUp(new CoachLLM(await loadSystemPrompt(), "tune", "medium"), state, ins);
  console.log("\n" + markdown + "\n");
  if (gains.length) {
    const path = await writeReport("tune-up", todayIso(), markdown);
    console.log(`(report → ${path}; ${costNote(costUsd, cacheRead)})`);
  }
}

/** `fuelling` — per-session pre/during/after from your logged inventory (deterministic, no LLM). */
async function cmdFuelling(): Promise<void> {
  const { state, window } = await buildTodayState();
  const inv = loadInventory(state.profile);
  if (!inv.length) {
    console.log("\nNo fuel inventory yet. Add the nutrition you use to profile.local.yaml under fuelling.products (see profile.example.yaml), then rerun.\n");
    return;
  }
  const plans = buildWeekFuelPlans(upcomingPlanned(window, todayIso(), 7).sessions, {
    weightKg: state.weightKg.value,
    inventory: inv,
    prefs: loadFuelPrefs(state.profile?.fuelling),
  });
  console.log("\n" + formatWeekFuelText(plans) + "\n");
}

/** `fuel-review` — learning review over your fuel log (one LLM call; wellbeing-screened; ≥3 logs). */
async function cmdFuelReview(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state } = await buildTodayState();
  const { markdown, costUsd, cacheRead } = await runFuelReview(new CoachLLM(await loadSystemPrompt(), "fuel-review", "medium"), await loadFuelLog(), loadInventory(state.profile), state);
  console.log("\n" + markdown + "\n");
  if (costUsd) console.log(`(${costNote(costUsd, cacheRead)})`);
}

/** `research` — monthly web-grounded digest of new training/gear thinking → a review proposal (gated). */
async function cmdResearch(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const today = todayIso();
  try {
    const { markdown, costUsd } = await runResearchDigest(new CoachLLM(await loadSystemPrompt(), "research", "high"), await readKnowledge(), today, await loadEngagementContext([]));
    const path = await writePendingDigest(today, markdown);
    console.log(`\nDrafted a research digest for review → ${path}`);
    console.log(`Read it, then apply with:  cd ${process.cwd()} && npm run knowledge -- approve ${pendingName(today)}`);
    console.log(`(${costNote(costUsd, 0)})\n`);
  } catch (e) {
    // Degrade, don't crash: no key / web search unavailable / network leaves the priors untouched.
    console.error(`\nResearch digest unavailable (degraded, priors untouched): ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

/** `knowledge [approve <file>]` — show knowledge-layer freshness + pending digests, or approve one. */
async function cmdKnowledge(): Promise<void> {
  if (process.argv[3] === "approve") {
    const name = process.argv[4];
    if (!name) {
      console.error('\nUsage: npm run knowledge -- approve <file>   (file from `npm run knowledge`)\n');
      process.exit(1);
    }
    await approvePending(name);
    console.log(`\nApproved ${name} → folded into knowledge/sports-science.md and the verified date bumped.`);
    console.log(`The coach now reads it in every flow. Commit the change to keep it.\n`);
    return;
  }
  const f = knowledgeFreshness(await readKnowledge());
  console.log(`\nKnowledge layer — last verified ${f.lastVerified ?? "never"}${f.ageDays != null ? ` (${f.ageDays}d ago)` : ""}: ${f.stale ? "STALE — due a refresh (npm run research)" : "fresh"}`);
  const pending = await listPending();
  if (pending.length) {
    console.log(`\nPending digests awaiting your review (${pending.length}):`);
    for (const p of pending) console.log(`  ${p.name} (${p.bytes} bytes)  →  npm run knowledge -- approve ${p.name}`);
  } else {
    console.log(`\nNo pending digests. Draft one with:  npm run research`);
  }
  console.log();
}

/** `ask "<question>"` — free-form Q&A over your data (same engine as the dashboard chat box). */
async function cmdAsk(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const question = process.argv.slice(3).join(" ").trim();
  if (!question) {
    console.error('\nUsage: npm run ask -- "how were my long rides this month?"\n');
    process.exit(1);
  }
  const { state } = await buildTodayState();
  const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt(), "ask", "medium"), question, state, await loadArchive());
  console.log("\n" + answer + "\n");
}

/** `session [date] [--force]` — deep, coach-quality feedback on one session (the most recent, or a given date). */
async function cmdSession(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const args = process.argv.slice(3);
  const force = args.includes("--force");
  const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const { state, window } = await buildTodayState();
  if (!state.raw) {
    console.error("\nNo data assembled — cannot build session feedback.\n");
    process.exit(1);
  }
  const archive = await loadArchive();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const insights = buildInsights(state, archive, { suppressed, history: window });
  const feedback = await runSessionFeedback(new CoachLLM(await loadSystemPrompt(), "session", "medium"), state, insights, {
    date,
    force,
    decays: loadSessionDecays(),
    fitSummaries: await new ArchiveStore().loadFitSummaries(),
  });
  if (!feedback) {
    console.error(date ? `\nNo activity found for ${date}.\n` : "\nNo recent activity found to analyse.\n");
    process.exit(1);
  }
  if (feedback.skippedNoFit) {
    console.log("\n" + feedback.markdown + "\n");
    console.log("(no LLM call made — add --force for summary-only feedback anyway)");
    return;
  }
  const path = await writeReport("session-feedback", feedback.detail.date, feedback.markdown);
  // Persist to the session-feedback store too, so the dashboard surfaces it inline and the history is
  // kept for analysis (same store the auto-at-sync generation writes to).
  await saveSessionFeedback({
    date: feedback.detail.date,
    sport: String(feedback.detail.sport),
    deep: !!feedback.detail.decay,
    generatedAt: new Date().toISOString(),
    costUsd: feedback.costUsd,
    markdown: feedback.markdown,
  });
  console.log("\n" + feedback.markdown + "\n");
  console.log(`(report → ${path}; saved to the session-feedback store; ${costNote(feedback.costUsd, feedback.cacheRead)})`);
}

/** `dashboard` — generate the glanceable Today/Week/Trends/Race HTML and open it. */
async function cmdDashboard(): Promise<void> {
  const { window, state } = await buildTodayState();
  const decisions = await new DecisionLog().all();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions()); // for the Set-up-&-improve card's dismissals
  const archive = await loadArchive();
  const predictionTrajectory = state.raw ? await loadPredictionTrajectory(state) : undefined;
  const insights = state.raw ? buildInsights(state, archive, { history: window, predictionTrajectory }) : undefined;
  let weather: WeekWeather | undefined;
  if (config.weather.enabled) {
    const fc = await getForecast();
    if (fc) {
      const plan = upcomingPlanned(window, todayIso());
      weather = assessWeek(plan.sessions, fc, { ...config.weather, planAsOf: plan.asOf }, latestActuals(window));
    }
  }
  // Season arc + career history — folded into the Plan and Performance tabs, matching the served dashboard
  // (server.ts). Best-effort: any failure leaves that fold absent (degrade-don't-crash).
  const profile = (await loadProfileSafe())?.profile;
  const career = loadCareerHistory();
  let seasonReport: ReturnType<typeof buildSeasonArc> | undefined;
  let seasonProse: { narrative?: Awaited<ReturnType<typeof latestSeasonNarrative>>; weekly?: Awaited<ReturnType<typeof latestWeeklyReviewProse>> } | undefined;
  try {
    let ctlSeries: Array<{ date: string; v: number }> = [];
    try {
      ctlSeries = await new StateStore().series(todayIso(), 60, (s) => s.load.value?.ctl);
    } catch {
      /* no state series yet */
    }
    seasonReport = buildSeasonArc({
      today: todayIso(),
      plan: profile?.season_plan,
      ctlNow: ctlSeries.length ? ctlSeries[ctlSeries.length - 1].v : undefined,
      ctlSeries,
      career,
      profile,
    });
    const [narrative, weekly] = await Promise.all([latestSeasonNarrative(), latestWeeklyReviewProse()]);
    seasonProse = { narrative, weekly };
  } catch {
    /* the Plan tab degrades to the week-ahead view */
  }
  // Daily brief: same load-prior + persist-today as the server, so the file render shows the diff too.
  let priorBrief: BriefSnapshot | null = null;
  if (config.dailyBrief.enabled) {
    priorBrief = await loadPriorBrief(state.date);
    await persistBriefIfAbsent(buildBriefSnapshot({ window, insights, decisions, now: Date.now() }));
  }
  const html = renderDashboard({
    window,
    decisions,
    insights,
    priorBrief,
    garminDays: archive?.garminDays,
    fitSummaries: archive?.fitSummaries,
    canFetchFit: config.garmin.enabled,
    weather,
    profile,
    seasonReport,
    seasonProse,
    career,
    suppressed,
    weeklyReview: await latestWeeklyReview(), // "This week" actions — reads the persisted report
    researchDigest: await latestResearchDigest(), // "Worth considering" — reads the persisted digest
    sessionFeedbacks: await loadSessionFeedbacks(), // auto-generated at sync; shown inline on the card
    metricOverrides: await loadMetricOverrides(), // your pins on auto-detected metrics (Data-changes card)
    setupHealth: {
      hasApiKey: CoachLLM.hasApiKey(),
      waterTempSet: config.weather.waterTempC != null,
      lastSyncAgeHours: (Date.now() - new Date(state.assembledAt).getTime()) / 3_600_000,
    },
    share: process.argv.includes("--share"), // redacted view for screenshots (race names + location hidden)
  });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, "dashboard.html");
  await writeFile(htmlPath, html);
  console.log(`\nDashboard → ${htmlPath}`);
  await open(htmlPath).catch(() => console.log("(open it manually in a browser)"));
}

/** `demo` — render the dashboard from built-in SAMPLE data: no AI Endurance account, no Garmin, no API
 *  key, no network. Lets anyone see the coach working before setting up their own accounts. */
async function cmdDemo(): Promise<void> {
  const today = todayIso();
  const window = buildDemoWindow(today, 42); // 42d → CTL/ATL/TSB trends + a non-empty Load card
  const state = window[window.length - 1];
  const garminDays = buildDemoGarminDays(today);
  // Feed the demo's Garmin history into the engine too (not just the Trends card) so monitoring /
  // fuelling / sleep-correlation analyse real sample data instead of an empty series.
  const insights = state.raw ? buildInsights(state, { garminDays }, { history: window }) : undefined;
  const yd = new Date(`${today}T00:00:00Z`);
  yd.setUTCDate(yd.getUTCDate() - 1);
  const lastSessionDate = yd.toISOString().slice(0, 10); // the demo's most recent activity (a run)
  // Sample stored feedback so the "Last session" card showcases the auto-generated deep dive inline.
  const sessionFeedbacks = [
    {
      schemaVersion: 1,
      date: lastSessionDate,
      sport: "Run",
      deep: true,
      generatedAt: new Date().toISOString(),
      costUsd: 0.21,
      markdown: [
        `# Session feedback — ${lastSessionDate} Run`,
        "## Verdict",
        "**A controlled aerobic run that landed right where it should** — efficiency a touch above your recent norm on slightly fresher legs.",
        "## What went well",
        "- Power-to-HR held steady through the back half — no late aerobic drift.",
        "- Ran it on a mild positive TSB, so the quality came cheap.",
        "## Watch",
        "- Cadence dipped ~2% in the final 15 min — stay tall when fatigue creeps in.",
        "## Takeaways",
        "- Keep these as your bread-and-butter aerobic volume into the Olympic build.",
        "- No change needed to the next two planned sessions.",
      ].join("\n"),
    },
  ];
  // Rich sample inputs so the demo is a compelling hero: Garmin trends, API-cost card, the full
  // three-section "Set up & improve" card, and the auto session-feedback shown inline.
  const html = renderDashboard({
    window,
    decisions: [],
    insights,
    garminDays,
    canFetchFit: false,
    profile: demoProfile,
    weeklyReview: { date: today, actions: ["Cut one grey-zone ride", "Move the long run off your GI-trough day"] },
    researchDigest: {
      date: today,
      file: `${today}-research-digest.md`,
      items: [
        { topic: "90 g/h carb intake for long course", kind: "change", summary: "Trained guts tolerate up to ~90 g/h of mixed glucose+fructose, holding power deeper into long races.", source: "Jeukendrup, 2023 review" },
        { topic: "165 mm cranks change the fit", kind: "new", summary: "Shorter cranks open the hip angle and can improve comfort/aero with no power loss for most riders.", source: "Bike-fit literature, 2024" },
      ],
    },
    setupHealth: { hasApiKey: true, waterTempSet: false, lastSyncAgeHours: 2 },
    sessionFeedbacks,
  });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, "demo-dashboard.html");
  await writeFile(htmlPath, html);
  console.log(`\nDemo dashboard (built-in sample data — no account / Garmin / API key) → ${htmlPath}`);
  console.log("Everything shown is fictional sample data, not real training.");
  await open(htmlPath).catch(() => console.log("(open it manually in a browser)"));
}

/** `decisions [retro <id> "<note>"]` — view the decision log, or add a retrospective. */
async function cmdDecisions(): Promise<void> {
  const log = new DecisionLog();
  const sub = process.argv[3];
  if (sub === "retro") {
    const id = process.argv[4];
    const note = process.argv.slice(5).join(" ").trim();
    if (!id || !note) {
      console.error('\nUsage: npm run decisions -- retro <id> "how the call held up"\n');
      process.exit(1);
    }
    const original = (await log.all()).find((r) => r.id === id);
    if (!original) {
      console.error(`\nNo decision with id ${id}\n`);
      process.exit(1);
    }
    await log.updateStatus(id, original.status, note);
    console.log(`\nAdded retrospective to ${id}.`);
    return;
  }

  const all = await log.all();
  if (!all.length) {
    console.log("\nNo decisions logged yet.");
    return;
  }

  // `decisions pending` — un-acted plan-adjust proposals (latest status per id == "proposed").
  if (sub === "pending") {
    const latest = new Map<string, (typeof all)[number]>();
    for (const r of all) latest.set(r.id, r);
    const pending = [...latest.values()].filter((r) => r.kind === "plan-adjust" && r.status === "proposed");
    if (!pending.length) {
      console.log("\nNo pending proposals — nothing awaiting confirm/decline.");
      return;
    }
    console.log(`\nPending proposals (${pending.length}):\n`);
    for (const r of pending) {
      console.log(`  [${r.id}] ${r.summary}`);
      if (r.tradeoff) console.log(`      trade-off: ${r.tradeoff}`);
      if (r.basis?.length) console.log(`      because: ${r.basis.join("; ")}`);
      console.log(`      → npm run confirm -- ${r.id}   |   npm run decline -- ${r.id}`);
    }
    return;
  }

  console.log(`\nDecision log (${all.length} entries, most recent last):\n`);
  for (const r of all.slice(-20)) {
    console.log(`  ${r.timestamp.slice(0, 16)}  [${r.id}] ${r.kind}/${r.status}`);
    console.log(`      ${r.summary}`);
    if (r.tradeoff) console.log(`      trade-off: ${r.tradeoff}`);
    if (r.basis?.length) console.log(`      because: ${r.basis.join("; ")}`);
    if (r.retro) console.log(`      retro: ${r.retro}`);
  }
  if (all.length > 500) console.log(`\n(log is large — consider archiving data/decisions/log.jsonl)`);
}

/** `weekly` — planned vs actual, load by sport, adherence, trends, next-week focus. */
async function cmdWeekly(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { window } = await buildTodayState();
  const llm = new CoachLLM(await loadSystemPrompt(), "weekly");
  const { markdown, cacheRead, costUsd } = await runWeeklyReview(llm, window, await loadEngagementContext(window));
  console.log("\n" + markdown + "\n");
  const path = await writeReport("weekly-review", todayIso(), markdown);
  console.log(`(report → ${path}; ${costNote(costUsd, cacheRead)})`);
}

/** `race [name]` — event-specific prep, calibrated to time-to-race. */
async function cmdRace(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const raceName = process.argv.slice(3).join(" ").trim() || undefined;
  const { state } = await buildTodayState();
  const llm = new CoachLLM(await loadSystemPrompt(), "race");
  const { markdown, cacheRead, costUsd, raceLabel } = await runRacePrep(llm, state, raceName);
  console.log("\n" + markdown + "\n");
  const path = await writeReport(`race-prep-${raceLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, todayIso(), markdown);
  console.log(`(report → ${path}; ${costNote(costUsd, cacheRead)})`);
}

/** `propose "<request>"` — gated plan-adjustment proposals (nothing is written here). */
async function cmdPropose(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const request = process.argv.slice(3).join(" ").trim();
  if (!request) {
    console.error('\nUsage: npm run propose -- "move my long run off race week"\n');
    process.exit(1);
  }
  const screen = screenNutritionPrompt(request);
  if (screen.blocked) {
    console.log(`\n${screen.redirect}\n`);
    return;
  }
  const { state, window } = await buildTodayState();
  const engagement = await loadEngagementContext(window);
  const ins = buildInsights(state, await loadArchive(), { history: window, engagement });
  const llm = new CoachLLM(await loadSystemPrompt(), "propose");
  const { result, cacheRead, costUsd } = await proposeAdjustments(llm, request, state, buildProposerContext(state, ins, engagement));
  const { valid, rejected } = validateProposals(result.proposals, state.plannedSessions.value ?? [], writeContextFor(state));

  if (!valid.length) {
    console.log(`\nNo applicable change proposed. ${result.notes}`);
    if (rejected.length) console.log(rejected.map((r) => `  · ${r}`).join("\n"));
    console.log(`(${costNote(costUsd, cacheRead)})`);
    return;
  }

  // Record each VALIDATED proposal via the gate (logs to the decision log; fires NO write).
  const gate = new WriteGate(new AieClient(), new DecisionLog()); // not connected — propose() never calls the API
  console.log("\nProposed adjustments (nothing changed yet):\n");
  for (const p of valid) {
    const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human, basis: p.basis });
    console.log(`  [${proposal.id}] ${p.human}`);
    console.log(`      ${p.summary} — trade-off: ${p.tradeoff}`);
    if (p.basis.length) console.log(`      because: ${p.basis.join("; ")}`);
  }
  if (rejected.length) console.log(`\nNot applied (couldn't be tied to a real session):\n${rejected.map((r) => `  · ${r}`).join("\n")}`);
  if (result.notes) console.log(`\nNotes: ${result.notes}`);
  console.log(`\nTo apply:  npm run confirm -- <id>     |  To dismiss:  npm run decline -- <id>`);
  console.log(`(${costNote(costUsd, cacheRead)})`);
}

/** `act` — turn the GATED, feedback-aware top findings into gated plan-adjustment proposals (no write here). */
async function cmdAct(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state, window } = await buildTodayState();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const engagement = await loadEngagementContext(window);
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
  // Act only on SURFACED findings (good-signal, not dismissed) that warrant a plan change.
  const actionable = ins.topFindings.filter((f) => f.severity !== "info");
  if (!actionable.length) {
    console.log("\nNo actionable signals — nothing above the confidence bar (and not dismissed) needs a plan change.\n");
    return;
  }

  console.log("\nActing on surfaced signals (gated; agree/disagree respected):");
  for (const f of actionable) console.log(`  • [${f.severity}, ${Math.round((f.confidence ?? 0.6) * 100)}%] ${f.title}`);

  // Ground the proposer in the FULL picture (load/form bands + health + races + predictions + taper + decline-aware).
  const ctx = buildProposerContext(state, ins, engagement);

  const request =
    "Turn these surfaced training signals into minimal, specific plan adjustments with trade-offs " +
    "(don't restructure the week; the smallest change that helps):\n" +
    actionable
      .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.recommendation ? ` (suggested: ${f.recommendation})` : ""}`)
      .join("\n");

  const llm = new CoachLLM(await loadSystemPrompt(), "act");
  const { result, cacheRead, costUsd } = await proposeAdjustments(llm, request, state, ctx);
  const { valid, rejected } = validateProposals(result.proposals, state.plannedSessions.value ?? [], writeContextFor(state));
  if (!valid.length) {
    console.log(`\nNo applicable plan change proposed. ${result.notes}`);
    if (rejected.length) console.log(rejected.map((r) => `  · ${r}`).join("\n"));
    console.log(`(${costNote(costUsd, cacheRead)})`);
    return;
  }
  const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
  console.log("\nProposed (nothing changed — gated):\n");
  for (const p of valid) {
    const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human, basis: p.basis });
    console.log(`  [${proposal.id}] ${p.human}`);
    console.log(`      ${p.summary} — trade-off: ${p.tradeoff}`);
    if (p.basis.length) console.log(`      because: ${p.basis.join("; ")}`);
  }
  if (rejected.length) console.log(`\nNot applied (no matching session):\n${rejected.map((r) => `  · ${r}`).join("\n")}`);
  if (result.notes) console.log(`\nNotes: ${result.notes}`);
  console.log(`\nApply:  npm run confirm -- <id>   |  Dismiss:  npm run decline -- <id>`);
  console.log(`(${costNote(costUsd, cacheRead)})`);
}

/**
 * `check` — fire-only health watch. Deterministic (no LLM, so cheap to run on a schedule): assembles
 * today's state, gates the findings (confidence + your agree/disagree feedback), and sends ONE macOS
 * notification only if something genuinely warrants attention (any flag, or a health/injury early-warning).
 * Silent otherwise — it taps you on the shoulder when it matters, not every day.
 */
async function cmdCheck(): Promise<void> {
  const { state, window } = await buildTodayState();
  if (!state.raw) {
    console.log("\nNo data assembled — skipping check.");
    return;
  }
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window });
  const alerts = alertFindings(ins.topFindings);
  if (!alerts.length) {
    console.log(`\n✓ All clear (${state.date}) — nothing above the alert bar.`);
    return;
  }
  const top = alerts.slice(0, 3);
  console.log(`\n⚠ ${alerts.length} alert(s) for ${state.date}:`);
  for (const f of top) console.log(`  • [${f.severity}] ${f.title}: ${f.detail}`);
  const msg = top.map((f) => f.title).join(" · ") + (alerts.length > top.length ? ` (+${alerts.length - top.length} more)` : "");
  await notify(`Coach: ${alerts.length} signal${alerts.length > 1 ? "s" : ""}`, msg);
  console.log(`\n(macOS notification sent if on darwin — run \`npm run act\` to turn these into gated plan proposals.)`);
}

/** `cost [days]` — local token-cost report from the cost log: windowed totals + per-flow breakdown. */
async function cmdCost(): Promise<void> {
  const records = await readCostRecords();
  if (!records.length) {
    console.log("\nNo LLM calls logged yet. Run a flow (readiness / ask / weekly / session …) and check back.\n");
    return;
  }
  const arg = Number(process.argv[3]);
  const windows =
    Number.isFinite(arg) && arg > 0
      ? [{ label: `last ${arg}d`, days: arg }]
      : [
          { label: "today", days: 1 },
          { label: "last 7d", days: 7 },
          { label: "last 30d", days: 30 },
          { label: "all-time", days: undefined as number | undefined },
        ];

  // Operations whose calls ran on a local (Ollama) model: $0 API cost, marked so a $0.0000 row reads clearly.
  const localOps = new Set(records.filter((r) => isLocalModel(r.model)).map((r) => r.operation));
  // Headline the primary (Anthropic) model, not whatever ran last — a sync ends on a local embed call.
  const primaryModel = [...records].reverse().find((r) => !isLocalModel(r.model))?.model ?? records[records.length - 1].model;
  console.log(`\nToken cost — model ${primaryModel}, ${records.length} call(s) logged:`);
  for (const w of windows) {
    const s = summarizeCost(records, w.days);
    console.log(`\n  ${w.label}: $${s.total.costUsd.toFixed(4)} over ${s.total.calls} call(s)`);
    for (const op of s.byOperation) {
      const local = localOps.has(op.operation) ? " · local (no API cost)" : "";
      console.log(`    ${op.operation.padEnd(12)} $${op.costUsd.toFixed(4).padStart(8)}  ${op.calls}× · in ${op.input}/out ${op.output}/cacheR ${op.cacheRead}${local}`);
    }
  }
  const w7 = summarizeCost(records, 7).total;
  if (w7.calls) console.log(`\n  ≈ $${((w7.costUsd / 7) * 30).toFixed(2)}/month at the last-7-day rate.\n`);
}

/**
 * `listening` — your engagement model: which insight families you act on vs dismiss, proposal
 * accept/decline, what's currently hidden, and findings that recurred after you dismissed them.
 * Deterministic (no LLM); prints the markdown and also writes a dated report.
 */
async function cmdListening(): Promise<void> {
  const snapshots = await new InsightLog().all();
  const decisions = await new DecisionLog().all();
  const states = await new StateStore().recent(todayIso(), 90);
  const latest = states[states.length - 1];
  const recData = (latest?.raw?.getRecoveryModel as { data?: Parameters<typeof loadModel>[0] } | undefined)?.data;
  const model = analyseListening({ snapshots, decisions, states, load: loadModel(recData) });
  const markdown = formatListening(model, todayIso());
  console.log("\n" + markdown);
  const path = await writeReport("listening-model", todayIso(), markdown);
  console.log(`Saved → ${path}\n`);
}

/** `confirm <id>` — the ONLY path that fires a write, and only for a logged proposal. */
async function cmdConfirm(): Promise<void> {
  const id = process.argv[3];
  if (!id) {
    console.error("\nUsage: npm run confirm -- <proposal-id>\n");
    process.exit(1);
  }
  await withAie(async (aie) => {
    const gate = new WriteGate(aie, new DecisionLog());
    const result = await gate.confirm(id);
    console.log(`\n✓ Applied ${id} and synced to AI Endurance.`);
    console.log(typeof result === "string" ? result : JSON.stringify(result).slice(0, 300));
  });
}

/** `decline <id>` — dismiss a pending proposal (no API call). */
async function cmdDecline(): Promise<void> {
  const id = process.argv[3];
  if (!id) {
    console.error("\nUsage: npm run decline -- <proposal-id>\n");
    process.exit(1);
  }
  const gate = new WriteGate(new AieClient(), new DecisionLog()); // decline() never calls the API
  await gate.decline(id);
  console.log(`\nDismissed ${id}.`);
}

/** `doctor` — hardening health check: creds, Garmin token age, Anthropic key, AIE tool drift. */
async function cmdDoctor(): Promise<void> {
  const checks = await fileChecks();

  // Live AIE tool-drift check (best-effort — don't fail the whole doctor if AIE is unreachable).
  try {
    await withAie(async (aie) => {
      const tools = await aie.listToolNames();
      const expected = new Set<string>([...AIE_READ_TOOLS, ...AIE_WRITE_TOOLS]);
      const missing = [...expected].filter((t) => !tools.includes(t));
      const extra = tools.filter((t) => !expected.has(t));
      if (missing.length) checks.push({ name: "AIE tool set", status: "warn", detail: `expected-but-absent: ${missing.join(", ")}` });
      else if (extra.length) checks.push({ name: "AIE tool set", status: "info", detail: `new/unknown tools: ${extra.join(", ")}` });
      else checks.push({ name: "AIE tool set", status: "ok", detail: `all ${tools.length} expected tools present` });
    });
  } catch (e) {
    checks.push({ name: "AIE connection", status: "warn", detail: `could not reach AI Endurance: ${e instanceof Error ? e.message : String(e)}` });
  }

  // Morning-ping heartbeat (PROD-2): surface a silently-failing 06:00 ping.
  const prior = await lastPingOk();
  if (!prior) {
    checks.push({ name: "Morning ping", status: "info", detail: "no successful ping recorded yet (runs after the first `npm run ping`)" });
  } else {
    const ageH = (Date.now() - new Date(prior.ts).getTime()) / 3_600_000;
    checks.push(
      ageH > 25
        ? { name: "Morning ping", status: "warn", detail: `last success ${ageH.toFixed(0)}h ago (${prior.date}) — the scheduled ping may be silently failing` }
        : { name: "Morning ping", status: "ok", detail: `last success ${prior.date} (${ageH.toFixed(0)}h ago)` },
    );
  }

  const icon = (s: string) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : s === "fail" ? "✗" : "·");
  console.log("\nEndurance Coach — health check:\n");
  for (const c of checks) console.log(`  ${icon(c.status)} ${c.name.padEnd(20)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(`\n${fails} fail, ${warns} warn. ${fails ? "Resolve fails before the daily ping can run." : "Core is healthy."}`);
}

const [, , cmd] = process.argv;
const commands: Record<string, () => Promise<void>> = {
  setup: cmdSetup,
  "profile-init": cmdProfileInit,
  "profile-questions": cmdProfileQuestions,
  help: cmdHelp,
  auth: cmdAuth,
  verify: cmdVerify,
  doctor: cmdDoctor,
  "health-remote": cmdHealthRemote,
  state: cmdState,
  splits: cmdSplits,
  "ingest-fit": cmdIngestFit,
  "ftp-check": cmdFtpCheck,
  readiness: cmdReadiness,
  ping: cmdPing,
  weekly: cmdWeekly,
  race: cmdRace,
  propose: cmdPropose,
  confirm: cmdConfirm,
  decline: cmdDecline,
  dashboard: cmdDashboard,
  demo: cmdDemo,
  "deep-dive": cmdDeepDive,
  season: cmdSeason,
  tune: cmdTune,
  fuelling: cmdFuelling,
  "fuel-review": cmdFuelReview,
  research: cmdResearch,
  knowledge: cmdKnowledge,
  act: cmdAct,
  check: cmdCheck,
  ask: cmdAsk,
  session: cmdSession,
  cost: cmdCost,
  listening: cmdListening,
  backfill: cmdBackfill,
  "archive-status": cmdArchiveStatus,
  "archive-compact": cmdArchiveCompact,
  "archive-import": cmdActivityArchiveImport,
  "archive-backfill": cmdActivityArchiveBackfill,
  "archive-heal": cmdActivityArchiveHeal,
  probe: cmdProbe,
  "fit-sync": cmdFitSync,
  decisions: cmdDecisions,
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log("Usage: tsx src/cli.ts <command>   (or `npm run help` for the common ones)");
  console.log("  setup      guided wizard: write .env (key, units, location, Garmin)");
  console.log("  profile-init  copy profile.example.yaml → profile.local.yaml and fill the required fields");
  console.log("  profile-questions  list the OPTIONAL profile fields + why each one helps the coach (--write-doc regenerates the doc)");
  console.log("  help       the curated everyday commands (full list: docs/commands.md)");
  console.log("  auth       run OAuth + confirm the AI Endurance connection");
  console.log("  verify     exercise every read tool, confirm the write-gate");
  console.log("  doctor     health check: creds, Garmin token age, key, AIE tool drift");
  console.log("  health-remote  ping the PUBLIC tunnel /health and alert if the connector is down/needs re-auth");
  console.log("  state      assemble + persist + summarise today's AthleteState");
  console.log("  readiness  green/amber/red verdict with cited drivers");
  console.log("  ping       unattended morning readiness: verdict + report + desktop notification");
  console.log("  weekly     weekly review → dated markdown report");
  console.log('  race [name] race-specific prep (auto-picks next race) → report');
  console.log('  propose "<request>"  gated plan-adjustment proposals');
  console.log("  confirm <id> / decline <id>   apply or dismiss a proposal");
  console.log("  dashboard  generate + open the glanceable Today/Week/Trends/Race view");
  console.log("  demo       render the dashboard from built-in SAMPLE data (no account/Garmin/key needed)");
  console.log("  deep-dive  insight-engine analysis (load/EF/durability/ramp/goal) → report");
  console.log("  season     multi-season strategic review (CTL arc / phases / structural levers) → report; also the /season page");
  console.log("  tune       weekly marginal-gains: the smaller, easy-to-action tweaks (not 'train more') → report");
  console.log("  fuelling   per-session pre/during/after from your logged nutrition (deterministic, only what a session needs)");
  console.log("  fuel-review  learning review over your fuel log: carb/hr tolerance, what sits well, suggested tweaks (≥3 logs)");
  console.log("  research   monthly web-grounded digest of new training/gear thinking → review proposal (gated)");
  console.log('  knowledge [approve <file>]   knowledge-layer freshness + pending digests / approve one');
  console.log("  act        turn surfaced (gated, feedback-aware) findings into gated plan-adjustment proposals");
  console.log("  check      fire-only health watch: macOS alert ONLY if a flag / early-warning fires (no LLM)");
  console.log('  ask "<q>"  free-form question of your data (also a chat box on the dashboard)');
  console.log("  session [date] [--force]  deep feedback on one session (needs its raw .FIT; --force = summary-only)");
  console.log("  cost [days]   local token-cost report (per-flow breakdown + windowed totals)");
  console.log("  listening  engagement model: act-on-vs-dismiss, plan adherence + plan changes, dismissed-but-recurred → report");
  console.log("  backfill [from]  archive full history (AIE activities + Garmin daily) → data/archive/");
  console.log("  archive-status  show archived counts + date ranges (distinct records)");
  console.log("  archive-compact  de-duplicate the archive files in place (one record per date/id)");
  console.log("  probe      capture live Garmin tool surface + AIE detail samples → reports/ (Phase-2 mapping)");
  console.log("  fit-sync [n]  download recent Garmin run/ride .FIT files (get_activity_fit_data) → streams dir");
  console.log('  decisions [pending | retro <id> "<note>"]   view log / pending / add retrospective');
  console.log("  (LLM flows need ANTHROPIC_API_KEY)");
  process.exit(1);
}
run().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
