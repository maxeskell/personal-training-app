import { AieClient, AIE_READ_TOOLS, AIE_WRITE_TOOLS } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { assembleState, extractJson, garminInner } from "./state/assemble.js";
import { config } from "./config.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { assessReadiness } from "./coach/readiness.js";
import { runWeeklyReview } from "./coach/weekly.js";
import { runRacePrep } from "./coach/racePrep.js";
import { proposeAdjustments, parseArgs } from "./coach/planAdjust.js";
import { writeReport } from "./coach/reports.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildInsights, type ArchiveInput } from "./insights/engine.js";
import { mapRichActivity } from "./insights/metrics.js";
import { ArchiveStore, type FitSummary } from "./archive/store.js";
import { backfillActivities, backfillGarmin, backfillGarminActivities, earliestGarminActivityDate } from "./archive/backfill.js";
import { answerQuestion } from "./coach/ask.js";

/** Load the local history archive (if any) as insight inputs. Undefined when empty. */
async function loadArchive(): Promise<ArchiveInput | undefined> {
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
import { notify } from "./notify.js";
import { fileChecks } from "./health.js";
import open from "open";
import { assessHealthRisk } from "./guardrails/wellbeing.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { DecisionLog, decisionId, nowIso, suppressedInsightKeys } from "./state/decisionLog.js";
import type { AthleteState } from "./state/types.js";

/** Assemble (and persist) today's state + trailing window. Handles Garmin lifecycle. */
async function buildTodayState(): Promise<{ state: AthleteState; window: AthleteState[] }> {
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

function requireLLM(): boolean {
  if (CoachLLM.hasApiKey()) return true;
  console.error(
    "\nANTHROPIC_API_KEY is not set. This flow needs the LLM core.\n" +
      "Add it to .env (ANTHROPIC_API_KEY=sk-ant-...) and re-run.\n",
  );
  return false;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function withAie<T>(fn: (aie: AieClient) => Promise<T>): Promise<T> {
  const aie = new AieClient();
  await aie.connect();
  try {
    return await fn(aie);
  } finally {
    await aie.close();
  }
}

/** `auth` — run the OAuth flow (interactive first time) and confirm the connection. */
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
  });
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

  const state = await withAie((aie) =>
    assembleState(aie, garmin, store, { date: todayIso(), assembledAt: new Date().toISOString() }),
  );
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

/** Shared readiness core: assemble → wellbeing → verdict → log. Used by `readiness` and `ping`. */
async function gatherReadiness(): Promise<{
  state: AthleteState;
  verdict: Awaited<ReturnType<typeof assessReadiness>>["verdict"];
  risk: ReturnType<typeof assessHealthRisk>;
  cacheRead: number;
}> {
  const { state, window } = await buildTodayState();
  const risk = assessHealthRisk(window); // deterministic guardrail, runs before the model
  const llm = new CoachLLM(await loadSystemPrompt());
  const { verdict, cacheRead } = await assessReadiness(llm, window);
  await new DecisionLog().append({
    id: decisionId(`readiness:${state.date}`),
    timestamp: nowIso(),
    kind: "readiness",
    summary: `${verdict.verdict}: ${verdict.why}`,
    status: "note",
  });
  return { state, verdict, risk, cacheRead };
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
  const { verdict, risk, cacheRead } = await gatherReadiness();
  printReadiness(verdict, risk);
  console.log(`\n(logged to decision log; cache read ${cacheRead} tokens)`);
}

/** `ping` — unattended morning readiness: verdict + report + desktop notification. */
async function cmdPing(): Promise<void> {
  if (!requireLLM()) process.exit(1);
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
  console.log(`\n(report written; desktop notification sent if on macOS)`);
}

/** `deep-dive` — compute insight metrics, synthesise a coach-style analysis, write a report. */
async function cmdDeepDive(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state, window } = await buildTodayState();
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const ins = buildInsights(state, await loadArchive(), { suppressed, history: window });

  const ev = (t: { recent: number | null; prior: number | null; deltaPct: number | null; n: number }) =>
    `recent ${t.recent ?? "—"} vs prior ${t.prior ?? "—"} (Δ ${t.deltaPct ?? "—"}%, n=${t.n})`;
  const summary = [
    `INSIGHT METRICS for ${ins.date} (computed locally; cite these):`,
    ins.load ? `- Load: CTL ${ins.load.ctl} / ATL ${ins.load.atl} / TSB ${ins.load.tsb}, ΔCTL/wk ${ins.load.rampPerWeek} [derived from daily ESS]` : "- Load: insufficient ESS history",
    `- Run-load ramp: this week ${ins.runRamp.thisWeekEss} ESS vs baseline ${ins.runRamp.baselineEss} (jump ${ins.runRamp.jumpPct ?? "—"}%) [ai-endurance]`,
    `- Run EF: ${ev(ins.ef.run)} | Ride EF: ${ev(ins.ef.ride)} [derived, steady ≥40min]`,
    `- Run durability %: ${ev(ins.durability.run)} [ai-endurance DFA-α1]`,
    `- Run aerobic threshold HR: ${ev(ins.threshold.run)} [ai-endurance DFA-α1, artifact-filtered]`,
    `- Predictions vs goals: ${ins.predictions.map((p) => `${p.race} T-${p.daysTo}d pred ${p.predictedSec ?? "?"}s vs target ${p.targetSec ?? "?"}s`).join("; ") || "none"}`,
    `- Monotony ${ins.monotony.monotony ?? "—"} (strain ${ins.monotony.strain ?? "—"}); intensity split easy/tempo/hard ${ins.tid.easyPct ?? "—"}/${ins.tid.tempoPct ?? "—"}/${ins.tid.hardPct ?? "—"}%`,
    `- n=1 patterns (lagged, autocorr-aware CIs): ${ins.correlations.map((c) => `${c.label} r=${c.r} [${c.ciLow},${c.ciHigh}] lag ${c.lagDays}d, effN ${c.effN}${c.significant ? "" : " (CI spans 0)"}`).join("; ") || "none strong enough yet"}`,
    `- Anomalies today: ${ins.anomalies.map((a) => a.detail).join("; ") || "none"}`,
    `- Monitoring rule (n=1, ${ins.monitoring.validated ? "validated out-of-sample" : "exploratory"}; outcome ${ins.monitoring.outcomeName}${ins.monitoring.outcomeIndependent ? "" : ", dependent"}): ${ins.monitoring.best ? `${ins.monitoring.best.name} → lead ${ins.monitoring.best.lead}d, hit ${Math.round(ins.monitoring.best.hitRate * 100)}% / false-alarm ${Math.round(ins.monitoring.best.falseAlarmRate * 100)}%${ins.monitoring.best.pValue != null ? `, perm p=${ins.monitoring.best.pValue}` : ""} (${ins.monitoring.method}, ${ins.monitoring.days}d)` : `none validated yet (${ins.monitoring.days}d history)`}`,
    `- Regime shifts (change-points): ${ins.changePoints.flatMap((s) => s.points.slice(-1).map((p) => p.date ? `${s.metric} ${p.before}→${p.after} @ ${p.date}` : null)).filter(Boolean).join("; ") || "none dated"}`,
    `- Brick decoupling (Q4): ${ins.brick.decouplingPct != null ? `run EF off-bike ${ins.brick.decouplingPct}% vs fresh (${ins.brick.brickDays} brick days)` : "insufficient power-equipped runs"}`,
    `- Taper target (Q6): ${ins.taper.recommendedTsbLow != null ? `race-day TSB ~${ins.taper.recommendedTsbLow}..${ins.taper.recommendedTsbHigh} (${ins.taper.basis})` : "no past race-day TSB yet"}`,
    `- Economy vs fitness (Q5): ${ins.efficiency.residualSlopePer30d != null ? `fitness-removed EF residual ${ins.efficiency.residualSlopePer30d}/30d (${ins.efficiency.fitnessExplains ? "gains are fitness, not economy" : "independent economy gain"})` : "insufficient steady runs"}`,
    `- Race split plans: ${ins.splits.map((p) => `${p.race} ${Math.round(p.predictedSec / 60)}min over ${p.distanceKm}km — ${p.strategy}`).join(" | ") || "no run races with predictions"}`,
    "",
    `TOP SURFACED INSIGHTS (good-signal, ranked; suppressed/dismissed removed):`,
    ...ins.topFindings.slice(0, 5).map((f) => `- [${f.severity}, ${Math.round((f.confidence ?? 0.6) * 100)}%] ${f.title}: ${f.detail} (${f.evidence})`),
    "",
    `ALL DETECTOR FINDINGS (triaged by severity):`,
    ...ins.findings.map((f) => `- [${f.severity}] ${f.title}: ${f.detail} (${f.evidence})`),
  ].join("\n");

  const prompt = [
    "Write a deep-dive analysis as markdown — the trends/issues a sharp coach would pull out of these",
    "metrics over time. LEAD with the single most important finding. Group by theme (load & form,",
    "efficiency & durability, injury risk, goal tracking). Be specific, cite the numbers, distinguish",
    "trend from noise (call out where n is small). Where relevant, note ACWR is intentionally not used.",
    "Honour the season shape and the marathon-off-tri run-load caution. End with 2–4 concrete actions.",
    "",
    summary,
  ].join("\n");

  const { text, cacheRead } = await new CoachLLM(await loadSystemPrompt()).text(prompt);
  const md = `# Deep dive — ${ins.date}\n\n${text}`;
  console.log("\n" + md + "\n");
  const path = await writeReport("deep-dive", todayIso(), md);
  console.log(`(report → ${path}; cache read ${cacheRead} tokens)`);
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
  const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt()), question, state, await loadArchive());
  console.log("\n" + answer + "\n");
}

/**
 * `backfill [fromDate] [--chunk N]` — archive full history.
 *  - AIE activities (month-paged, ~2024+) + AIE recovery already in the daily snapshot.
 *  - Garmin ACTIVITIES: ALL of them (the full decade), paginated — one-shot, fast.
 *  - Garmin DAILY metrics (sleep/HRV/RHR): from your earliest Garmin activity forward, throttled,
 *    resumable, and CHUNKED (--chunk N caps days per run) so a decade grinds over days/weeks.
 *  `fromDate` defaults to "auto" (earliest Garmin activity). Pass a date to override.
 */
async function cmdBackfill(): Promise<void> {
  const args = process.argv.slice(3);
  const chunkIdx = args.indexOf("--chunk");
  const chunk = chunkIdx >= 0 ? Number(args[chunkIdx + 1]) : Infinity;
  const dailyOnly = args.includes("--daily-only"); // scheduled grind uses this (skips AIE + activity re-paginate)
  const fromArg = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || "auto";
  const to = todayIso();
  const store = new ArchiveStore();
  console.log(`\nBackfilling into ${config.dataDir}/archive/ …\n`);

  // AIE activities (only go back to ~2024) — skipped in daily-only grind mode.
  if (!dailyOnly) {
    await withAie(async (aie) => {
      const added = await backfillActivities(aie, store, fromArg === "auto" ? "2024-01-01" : fromArg, to, (m) => console.log(m));
      console.log(`AIE activities: +${added} new.\n`);
    });
  }

  if (!config.garmin.enabled) {
    console.log("Garmin disabled — skipped (set GARMIN_ENABLED=true to include it).\n");
  } else {
    const g = new GarminClient();
    if (await g.connect()) {
      // All Garmin activities first (fast, gives us the earliest date) — skipped in grind mode.
      if (!dailyOnly) {
        console.log("Garmin activities (full history, paginated):");
        const a = await backfillGarminActivities(g, store, (m) => console.log(m));
        console.log(`Garmin activities: +${a} new.\n`);
      }

      const from = fromArg === "auto" ? (await earliestGarminActivityDate(store)) ?? "2014-01-01" : fromArg;
      console.log(`Garmin daily metrics from ${from} (throttled, resumable${Number.isFinite(chunk) ? `, ${chunk}/run` : ""}):`);
      const d = await backfillGarmin(g, store, from, to, (m) => console.log(m), 250, chunk);
      console.log(`Garmin daily: +${d} new days.\n`);
      await g.close();
    } else {
      console.log("Garmin enabled but unavailable — skipped (re-run when connected).\n");
    }
  }

  await printArchiveStatus(store);
}

/**
 * `probe` — Phase-2 data introspection. Lists the live Garmin MCP tool surface and captures one sample
 * payload per tool (trying common arg shapes), plus AIE activity summary-vs-detail so we can confirm the
 * activityId join. Writes everything to a gitignored reports/ file to build the health/injury-risk
 * mappers against REAL field shapes instead of guesses. Review before sharing — it's your own data.
 */
async function cmdProbe(): Promise<void> {
  const today = todayIso();
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const out: Record<string, unknown> = { capturedAt: new Date().toISOString(), today };

  // --- Garmin: list the tool surface, then sample each tool with candidate arg shapes ---
  if (!config.garmin.enabled) {
    console.log("Garmin disabled (GARMIN_ENABLED=false) — skipping Garmin probe. Set it true + auth to capture health metrics.");
  } else {
    const g = new GarminClient();
    if (await g.connect()) {
      const tools = await g.listToolNames();
      console.log(`\nGarmin tools available (${tools.length}):\n  ${tools.join("\n  ")}\n`);

      // SAFETY: only sample read-only tools. Never call mutating ones (set_/add_/delete_/upload_/…).
      const readOnly = (name: string) => /^(get_|count_)/.test(name) && name !== "request_reload";

      // Many tools need a real activity_id — pull a recent one from get_activities first.
      let activityId: number | string | undefined;
      try {
        const actsRaw = garminInner(await g.tryCall("get_activities", { limit: 5 }));
        const list = (actsRaw as { activities?: Array<Record<string, unknown>> })?.activities ?? (Array.isArray(actsRaw) ? (actsRaw as Array<Record<string, unknown>>) : []);
        const a0 = list[0] ?? {};
        // get_activities reports the id as `id` (not `activityId`) — accept either.
        activityId = (a0.activityId ?? a0.id ?? a0.activity_id) as number | string | undefined;
        console.log(`  (using activity_id=${activityId} for per-activity tools)`);
      } catch { /* best effort */ }

      const argCandidates: Array<Record<string, unknown>> = [
        {},
        { date: today },
        { start_date: weekAgo, end_date: today },
        { end_date: today },
        { start_date: monthAgo },
        ...(activityId != null ? [{ activity_id: activityId }, { activity_id: activityId, start_date: weekAgo, end_date: today }] : []),
      ];
      const samples: Record<string, unknown> = {};
      let captured = 0, skipped = 0;
      for (const tool of tools) {
        if (!readOnly(tool)) { samples[tool] = { skipped: "non-read-only (not sampled)" }; skipped++; continue; }
        let sample: unknown = null;
        let usedArgs: Record<string, unknown> | null = null;
        for (const args of argCandidates) {
          const r = await g.tryCall(tool, args);
          if (r != null && !isErrorResult(r)) { sample = r; usedArgs = args; break; }
        }
        samples[tool] = { args: usedArgs, sample: sample ?? "(no non-error response for tried arg shapes)" };
        if (sample != null) captured++;
        console.log(`  · ${tool}: ${sample != null ? "captured" : "no data"}`);
      }
      console.log(`\nGarmin: ${captured} captured, ${skipped} mutating tools skipped, ${tools.length - captured - skipped} read-only with no data.`);
      out.garminTools = tools;
      out.garminSamples = samples;
      await g.close();
    } else {
      console.log("Garmin enabled but unavailable — run garmin-mcp-auth and retry.");
    }
  }

  // --- AIE: summary vs detail for one recent run, to inspect the activityId join keys ---
  try {
    await withAie(async (aie) => {
      out.aieRunningActivity = extractJson(await aie.read("getRunningActivity", {}));
      out.aieRunningActivityDetail = extractJson(await aie.read("getRunningActivityDetail", {}));
      out.aieUser = extractJson(await aie.read("getUser", {}));
    });
    console.log("\nAIE: captured getRunningActivity + getRunningActivityDetail + getUser (for join-key + zone/FTP field inspection).");
  } catch (err) {
    console.log(`\nAIE probe skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  // Timestamp to the second so repeated runs in a day don't overwrite each other.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const path = join(dir, `probe-${stamp}.json`);
  await writeFile(path, JSON.stringify(out, null, 2));
  console.log(`\nProbe written → ${path}`);
  console.log("Review it (it's your own health data, gitignored), redact anything you want, then share it back so I can build the Phase-2 mappers against your real field shapes.");
}

/**
 * `fit-sync [n]` — pull per-activity summaries for the most recent n Garmin run/ride/swim activities via
 * get_activity_fit_data (+ get_activity_weather) and archive them. Taxuspt parses the .FIT server-side and
 * returns a SUMMARY (session totals, temperature_stats, lap HRV) — not per-second records — so this feeds
 * the heat confounder (per-activity EF + temperature) automatically. Resumable: archived ids are skipped.
 * (Per-second decoupling/biomechanics still come from raw .FIT files in the streams dir.)
 */
async function cmdFitSync(): Promise<void> {
  if (!config.garmin.enabled) {
    console.error("\nGarmin is disabled. Set GARMIN_ENABLED=true (and run garmin-mcp-auth) to sync.\n");
    process.exit(1);
  }
  const limit = Number(process.argv[3]) || 25;
  const store = new ArchiveStore();
  const have = await store.fitSummaryIds();

  const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() && Number.isFinite(Number(x)) ? Number(x) : undefined);
  const sportOf = (s: string): string => (/cycl|bike|ride/i.test(s) ? "Ride" : /run/i.test(s) ? "Run" : /swim/i.test(s) ? "Swim" : s);
  // get_activity_weather reports temperature in °F mislabelled as °C (e.g. 63 ≈ 17°C) — correct >45.
  const toC = (t: number | undefined): number | undefined => (t == null ? undefined : t > 45 ? +(((t - 32) * 5) / 9).toFixed(1) : t);

  const g = new GarminClient();
  if (!(await g.connect())) {
    console.error("\nGarmin unavailable — run garmin-mcp-auth and retry.\n");
    process.exit(1);
  }
  try {
    const actsRaw = garminInner(await g.tryCall("get_activities", { limit }));
    const list = ((actsRaw as { activities?: Array<Record<string, unknown>> })?.activities ?? (Array.isArray(actsRaw) ? actsRaw : [])) as Array<Record<string, unknown>>;
    console.log(`\nfit-sync: ${list.length} recent activities → fit-summaries archive\n`);
    let added = 0, skipped = 0, failed = 0;
    const buffer: FitSummary[] = [];
    for (const a of list) {
      const id = String(a.activityId ?? a.id ?? a.activity_id ?? "");
      const type = String(a.type ?? (a.activityType as { typeKey?: string } | undefined)?.typeKey ?? "").toLowerCase();
      if (!id || !/run|cycl|bike|ride|swim/.test(type)) continue;
      if (have.has(id)) { skipped++; continue; }
      const fd = garminInner(await g.tryCall("get_activity_fit_data", { activity_id: id }));
      const sess = (fd as { session?: Record<string, unknown> })?.session;
      if (!sess) { failed++; console.log(`  ? ${id} (${type}): no session in get_activity_fit_data`); continue; }
      const ts = (sess.temperature_stats ?? {}) as Record<string, unknown>;
      const weather = garminInner(await g.tryCall("get_activity_weather", { activity_id: id })) as Record<string, unknown> | null;
      const sum: FitSummary = {
        activityId: id,
        date: String(sess.start_time ?? a.start_time ?? "").slice(0, 10),
        sport: sportOf(String(sess.sport ?? type)),
        avgHr: num(sess.avg_heart_rate_bpm),
        avgPowerW: num(sess.avg_power) ?? num(sess.avg_power_w) ?? num(sess.normalized_power),
        distanceM: num(sess.total_distance_m),
        durationS: num(sess.total_timer_time_s) ?? num(sess.total_elapsed_time_s),
        avgTempC: num(ts.avg_temp_c),
        minTempC: num(ts.min_temp_c),
        maxTempC: num(ts.max_temp_c),
        hrCoolThirdBpm: num(ts.avg_hr_coolest_third_bpm),
        hrHotThirdBpm: num(ts.avg_hr_hottest_third_bpm),
        trainingEffect: num(sess.total_training_effect),
        weatherTempC: toC(num(weather?.temperature_celsius)),
        humidityPct: num(weather?.humidity_percent),
      };
      buffer.push(sum);
      added++;
      console.log(`  + ${id} (${sum.sport}, ${sum.date}, ${sum.avgTempC ?? "?"}°C${sum.avgPowerW != null ? `, ${sum.avgPowerW}W` : ""})`);
    }
    await store.appendFitSummaries(buffer);
    console.log(`\nfit-sync: +${added} new summaries, ${skipped} already archived, ${failed} failed → data/archive/fit-summaries.jsonl`);
    console.log("These feed the heat confounder (per-activity EF vs temperature) automatically.");
  } finally {
    await g.close();
  }
}

/** A Garmin MCP result is an "error" if flagged isError or its text is a tool/validation error. */
function isErrorResult(r: unknown): boolean {
  if (r && typeof r === "object") {
    if ((r as { isError?: boolean }).isError) return true;
    const text = (r as { content?: Array<{ text?: string }> }).content?.[0]?.text;
    if (typeof text === "string" && /Error executing tool|validation error|Field required/.test(text)) return true;
  }
  return false;
}

async function printArchiveStatus(store: ArchiveStore): Promise<void> {
  const s = await store.summary();
  console.log(`\nArchive (${config.dataDir}/archive/):`);
  console.log(`  AIE activities:    ${s.activities} (${s.actRange})`);
  console.log(`  Garmin activities: ${s.garminActivities} (${s.garActRange})`);
  console.log(`  Garmin daily:      ${s.garminDays} days (${s.garRange})`);
}

/** `archive-status` — show what's archived (used by `npm run backfill:status`). */
async function cmdArchiveStatus(): Promise<void> {
  await printArchiveStatus(new ArchiveStore());
}

/** `dashboard` — generate the glanceable Today/Week/Trends/Race HTML and open it. */
async function cmdDashboard(): Promise<void> {
  const { window, state } = await buildTodayState();
  const decisions = await new DecisionLog().all();
  const insights = state.raw ? buildInsights(state, await loadArchive()) : undefined;
  const html = renderDashboard({ window, decisions, insights });
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = join(process.cwd(), "reports");
  await mkdir(dir, { recursive: true });
  const htmlPath = join(dir, "dashboard.html");
  await writeFile(htmlPath, html);
  console.log(`\nDashboard → ${htmlPath}`);
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
  const llm = new CoachLLM(await loadSystemPrompt());
  const { markdown, cacheRead } = await runWeeklyReview(llm, window);
  console.log("\n" + markdown + "\n");
  const path = await writeReport("weekly-review", todayIso(), markdown);
  console.log(`(report → ${path}; cache read ${cacheRead} tokens)`);
}

/** `race [name]` — event-specific prep, calibrated to time-to-race. */
async function cmdRace(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const raceName = process.argv.slice(3).join(" ").trim() || undefined;
  const { state } = await buildTodayState();
  const llm = new CoachLLM(await loadSystemPrompt());
  const { markdown, cacheRead, raceLabel } = await runRacePrep(llm, state, raceName);
  console.log("\n" + markdown + "\n");
  const path = await writeReport(`race-prep-${raceLabel.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, todayIso(), markdown);
  console.log(`(report → ${path}; cache read ${cacheRead} tokens)`);
}

/** `propose "<request>"` — gated plan-adjustment proposals (nothing is written here). */
async function cmdPropose(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const request = process.argv.slice(3).join(" ").trim();
  if (!request) {
    console.error('\nUsage: npm run propose -- "move my long run off race week"\n');
    process.exit(1);
  }
  const { state } = await buildTodayState();
  const llm = new CoachLLM(await loadSystemPrompt());
  const { result, cacheRead } = await proposeAdjustments(llm, request, state);

  if (!result.proposals.length) {
    console.log(`\nNo change proposed. ${result.notes}\n(cache read ${cacheRead} tokens)`);
    return;
  }

  // Record each proposal via the gate (logs to the decision log; fires NO write).
  const log = new DecisionLog();
  const gate = new WriteGate(new AieClient(), log); // not connected — propose() never calls the API
  console.log("\nProposed adjustments (nothing changed yet):\n");
  for (const p of result.proposals) {
    const proposal = await gate.propose({
      tool: p.tool as never,
      args: parseArgs(p.argsJson),
      rationale: p.summary,
      tradeoff: p.tradeoff,
    });
    console.log(`  [${proposal.id}] ${p.summary}`);
    console.log(`      trade-off: ${p.tradeoff}`);
    console.log(`      write: ${p.tool} ${p.argsJson}`);
  }
  if (result.notes) console.log(`\nNotes: ${result.notes}`);
  console.log(`\nTo apply:  npm run confirm -- <id>     |  To dismiss:  npm run decline -- <id>`);
  console.log(`(cache read ${cacheRead} tokens)`);
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

  // Ground the proposer in the specific load/health/recovery numbers so it targets the right session.
  const r = state.recovery.value;
  const ts = state.trainingStatus.value;
  const ctx = [
    ins.load ? `- Load: CTL ${ins.load.ctl} / ATL ${ins.load.atl} / TSB ${ins.load.tsb}, ΔCTL/wk ${ins.load.rampPerWeek}` : "",
    ts ? `- Garmin acute:chronic ${ts.loadRatio ?? "—"} (${ts.acwrStatus ?? "—"}), status ${ts.label ?? "—"}` : "",
    state.hrvStatus.value ? `- HRV status ${state.hrvStatus.value.status ?? "—"}` : "",
    r ? `- Recovery limiter ${r.limiterToday ?? "—"}; orthopedic run/bike ${r.orthopedic?.run ?? "—"}/${r.orthopedic?.bike ?? "—"}` : "",
    `- Run-load ramp ${ins.runRamp.jumpPct ?? "—"}% vs baseline`,
  ].filter(Boolean).join("\n");

  const request =
    "Turn these surfaced training signals into minimal, specific plan adjustments with trade-offs " +
    "(don't restructure the week; the smallest change that helps):\n" +
    actionable
      .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.recommendation ? ` (suggested: ${f.recommendation})` : ""}`)
      .join("\n");

  const llm = new CoachLLM(await loadSystemPrompt());
  const { result, cacheRead } = await proposeAdjustments(llm, request, state, ctx);
  if (!result.proposals.length) {
    console.log(`\nNo plan change proposed. ${result.notes}\n(cache read ${cacheRead} tokens)`);
    return;
  }
  const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
  console.log("\nProposed (nothing changed — gated):\n");
  for (const p of result.proposals) {
    const proposal = await gate.propose({ tool: p.tool as never, args: parseArgs(p.argsJson), rationale: p.summary, tradeoff: p.tradeoff });
    console.log(`  [${proposal.id}] ${p.summary}`);
    console.log(`      trade-off: ${p.tradeoff}`);
    console.log(`      write: ${p.tool} ${p.argsJson}`);
  }
  if (result.notes) console.log(`\nNotes: ${result.notes}`);
  console.log(`\nApply:  npm run confirm -- <id>   |  Dismiss:  npm run decline -- <id>`);
  console.log(`(cache read ${cacheRead} tokens)`);
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

  const icon = (s: string) => (s === "ok" ? "✓" : s === "warn" ? "⚠" : s === "fail" ? "✗" : "·");
  console.log("\nEndurance Coach — health check:\n");
  for (const c of checks) console.log(`  ${icon(c.status)} ${c.name.padEnd(20)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  console.log(`\n${fails} fail, ${warns} warn. ${fails ? "Resolve fails before the daily ping can run." : "Core is healthy."}`);
}

const [, , cmd] = process.argv;
const commands: Record<string, () => Promise<void>> = {
  auth: cmdAuth,
  verify: cmdVerify,
  doctor: cmdDoctor,
  state: cmdState,
  readiness: cmdReadiness,
  ping: cmdPing,
  weekly: cmdWeekly,
  race: cmdRace,
  propose: cmdPropose,
  confirm: cmdConfirm,
  decline: cmdDecline,
  dashboard: cmdDashboard,
  "deep-dive": cmdDeepDive,
  act: cmdAct,
  ask: cmdAsk,
  backfill: cmdBackfill,
  "archive-status": cmdArchiveStatus,
  probe: cmdProbe,
  "fit-sync": cmdFitSync,
  decisions: cmdDecisions,
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log("Usage: tsx src/cli.ts <command>");
  console.log("  auth       run OAuth + confirm the AI Endurance connection");
  console.log("  verify     exercise every read tool, confirm the write-gate");
  console.log("  doctor     health check: creds, Garmin token age, key, AIE tool drift");
  console.log("  state      assemble + persist + summarise today's AthleteState");
  console.log("  readiness  green/amber/red verdict with cited drivers");
  console.log("  ping       unattended morning readiness: verdict + report + desktop notification");
  console.log("  weekly     weekly review → dated markdown report");
  console.log('  race [name] race-specific prep (auto-picks next race) → report');
  console.log('  propose "<request>"  gated plan-adjustment proposals');
  console.log("  confirm <id> / decline <id>   apply or dismiss a proposal");
  console.log("  dashboard  generate + open the glanceable Today/Week/Trends/Race view");
  console.log("  deep-dive  insight-engine analysis (load/EF/durability/ramp/goal) → report");
  console.log("  act        turn surfaced (gated, feedback-aware) findings into gated plan-adjustment proposals");
  console.log('  ask "<q>"  free-form question of your data (also a chat box on the dashboard)');
  console.log("  backfill [from]  archive full history (AIE activities + Garmin daily) → data/archive/");
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
