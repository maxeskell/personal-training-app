import { AieClient, AIE_READ_TOOLS, AIE_WRITE_TOOLS } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { assembleState } from "./state/assemble.js";
import { config } from "./config.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { assessReadiness } from "./coach/readiness.js";
import { runWeeklyReview } from "./coach/weekly.js";
import { runRacePrep } from "./coach/racePrep.js";
import { proposeAdjustments, parseArgs } from "./coach/planAdjust.js";
import { writeReport } from "./coach/reports.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildInsights } from "./insights/engine.js";
import { notify } from "./notify.js";
import { fileChecks } from "./health.js";
import open from "open";
import { assessHealthRisk } from "./guardrails/wellbeing.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { DecisionLog, decisionId, nowIso } from "./state/decisionLog.js";
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
  const { state } = await buildTodayState();
  const ins = buildInsights(state);

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
    "",
    `DETECTOR FINDINGS (already triaged by severity):`,
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

/** `dashboard` — generate the glanceable Today/Week/Trends/Race HTML and open it. */
async function cmdDashboard(): Promise<void> {
  const { window, state } = await buildTodayState();
  const decisions = await new DecisionLog().all();
  const insights = state.raw ? buildInsights(state) : undefined;
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
  console.log('  decisions [pending | retro <id> "<note>"]   view log / pending / add retrospective');
  console.log("  (LLM flows need ANTHROPIC_API_KEY)");
  process.exit(1);
}
run().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
