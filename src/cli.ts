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
import { runResearchDigest } from "./coach/research.js";
import { readKnowledge, writePendingDigest, pendingName, approvePending, knowledgeFreshness, listPending } from "./knowledge/store.js";
import { buildTodayState, gatherReadiness, loadArchive, loadPredictionTrajectory, todayIso, withAie } from "./coach/orchestrator.js";
import { proposeAdjustments, validateProposals, buildProposerContext, writeContextFor } from "./coach/planAdjust.js";
import { screenNutritionPrompt } from "./guardrails/wellbeing.js";
import { writeReport } from "./coach/reports.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildDemoWindow, demoProfile } from "./demo/sampleData.js";
import { cmdBackfill, cmdProbe, cmdFitSync, cmdArchiveStatus, cmdArchiveCompact } from "./cli/dataCommands.js";
import { buildInsights } from "./insights/engine.js";
import { alertFindings, loadModel } from "./insights/metrics.js";
import { InsightLog } from "./state/insightLog.js";
import { analyseListening, formatListening } from "./coach/listening.js";
import { loadEngagementContext } from "./coach/engagementContext.js";
import { ArchiveStore } from "./archive/store.js";
import { answerQuestion } from "./coach/ask.js";
import { runSessionFeedback } from "./coach/session.js";
import { loadSessionDecays } from "./insights/fit.js";
import { readCostRecords, summarizeCost } from "./llm/costLog.js";
import { getForecast } from "./weather/store.js";
import { assessWeek, upcomingPlanned, type WeekWeather } from "./weather/assess.js";

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
  console.log(`\nSaved to ${config.dataDir}/state/${state.date}.json`);
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

/** `research` — monthly web-grounded digest of new training/gear thinking → a review proposal (gated). */
async function cmdResearch(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const today = todayIso();
  try {
    const { markdown, costUsd } = await runResearchDigest(new CoachLLM(await loadSystemPrompt(), "research", "high"), await readKnowledge(), today);
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
  console.log("\n" + feedback.markdown + "\n");
  console.log(`(report → ${path}; ${costNote(feedback.costUsd, feedback.cacheRead)})`);
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
      weather = assessWeek(plan.sessions, fc, { ...config.weather, planAsOf: plan.asOf });
    }
  }
  const html = renderDashboard({
    window,
    decisions,
    insights,
    garminDays: archive?.garminDays,
    costRecords: await readCostRecords(),
    fitSummaries: archive?.fitSummaries,
    canFetchFit: config.garmin.enabled,
    weather,
    profile: (await loadProfileSafe())?.profile,
    suppressed,
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
  const window = buildDemoWindow(todayIso(), 21);
  const state = window[window.length - 1];
  const insights = state.raw ? buildInsights(state, undefined, { history: window }) : undefined;
  const html = renderDashboard({ window, decisions: [], insights, costRecords: [], canFetchFit: false, profile: demoProfile });
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
      console.log(`      → npm run confirm -- ${r.id}   |   npm run decline -- ${r.id}`);
    }
    return;
  }

  console.log(`\nDecision log (${all.length} entries, most recent last):\n`);
  for (const r of all.slice(-20)) {
    console.log(`  ${r.timestamp.slice(0, 16)}  [${r.id}] ${r.kind}/${r.status}`);
    console.log(`      ${r.summary}`);
    if (r.tradeoff) console.log(`      trade-off: ${r.tradeoff}`);
    if (r.retro) console.log(`      retro: ${r.retro}`);
  }
  if (all.length > 500) console.log(`\n(log is large — consider archiving data/decisions/log.jsonl)`);
}

/** `weekly` — planned vs actual, load by sport, adherence, trends, next-week focus. */
async function cmdWeekly(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { window } = await buildTodayState();
  const llm = new CoachLLM(await loadSystemPrompt(), "weekly");
  const { markdown, cacheRead, costUsd } = await runWeeklyReview(llm, window);
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
  const ins = buildInsights(state, await loadArchive(), { history: window });
  const llm = new CoachLLM(await loadSystemPrompt(), "propose");
  const { result, cacheRead, costUsd } = await proposeAdjustments(llm, request, state, buildProposerContext(state, ins));
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
    const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human });
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
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window });
  // Act only on SURFACED findings (good-signal, not dismissed) that warrant a plan change.
  const actionable = ins.topFindings.filter((f) => f.severity !== "info");
  if (!actionable.length) {
    console.log("\nNo actionable signals — nothing above the confidence bar (and not dismissed) needs a plan change.\n");
    return;
  }

  console.log("\nActing on surfaced signals (gated; agree/disagree respected):");
  for (const f of actionable) console.log(`  • [${f.severity}, ${Math.round((f.confidence ?? 0.6) * 100)}%] ${f.title}`);

  // Ground the proposer in the FULL picture (load/form bands + health + races + predictions + taper).
  const ctx = buildProposerContext(state, ins);

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
    const proposal = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human });
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

  console.log(`\nToken cost — model ${records[records.length - 1].model}, ${records.length} call(s) logged:`);
  for (const w of windows) {
    const s = summarizeCost(records, w.days);
    console.log(`\n  ${w.label}: $${s.total.costUsd.toFixed(4)} over ${s.total.calls} call(s)`);
    for (const op of s.byOperation) {
      console.log(`    ${op.operation.padEnd(12)} $${op.costUsd.toFixed(4).padStart(8)}  ${op.calls}× · in ${op.input}/out ${op.output}/cacheR ${op.cacheRead}`);
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
  tune: cmdTune,
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
  console.log("  tune       weekly marginal-gains: the smaller, easy-to-action tweaks (not 'train more') → report");
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
