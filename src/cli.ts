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

/** `readiness` — assemble today's state, run wellbeing checks, produce the green/amber/red call. */
async function cmdReadiness(): Promise<void> {
  if (!requireLLM()) process.exit(1);
  const { state, window } = await buildTodayState();

  // Deterministic wellbeing guardrail runs BEFORE the model — it can't be reasoned away.
  const risk = assessHealthRisk(window);
  if (risk.level !== "none") console.log(`\n⚠ Wellbeing (${risk.level}): ${risk.message}\n`);

  const llm = new CoachLLM(await loadSystemPrompt());
  const { verdict, cacheRead } = await assessReadiness(llm, window);

  const dot = verdict.verdict === "green" ? "🟢" : verdict.verdict === "amber" ? "🟡" : "🔴";
  console.log(`\n${dot} Readiness: ${verdict.verdict.toUpperCase()}`);
  console.log(`\n${verdict.why}\n`);
  console.log("Drivers:");
  for (const d of verdict.drivers) console.log(`  • ${d.signal}: ${d.reading}  [${d.source}]`);
  if (verdict.cautions.length) {
    console.log("\nCautions:");
    for (const c of verdict.cautions) console.log(`  • ${c}`);
  }

  await new DecisionLog().append({
    id: decisionId(`readiness:${state.date}`),
    timestamp: nowIso(),
    kind: "readiness",
    summary: `${verdict.verdict}: ${verdict.why}`,
    status: "note",
  });
  console.log(`\n(logged to decision log; cache read ${cacheRead} tokens)`);
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

const [, , cmd] = process.argv;
const commands: Record<string, () => Promise<void>> = {
  auth: cmdAuth,
  verify: cmdVerify,
  state: cmdState,
  readiness: cmdReadiness,
  weekly: cmdWeekly,
  race: cmdRace,
  propose: cmdPropose,
  confirm: cmdConfirm,
  decline: cmdDecline,
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log("Usage: tsx src/cli.ts <command>");
  console.log("  auth       run OAuth + confirm the AI Endurance connection");
  console.log("  verify     exercise every read tool, confirm the write-gate");
  console.log("  state      assemble + persist + summarise today's AthleteState");
  console.log("  readiness  green/amber/red verdict with cited drivers");
  console.log("  weekly     weekly review → dated markdown report");
  console.log('  race [name] race-specific prep (auto-picks next race) → report');
  console.log('  propose "<request>"  gated plan-adjustment proposals');
  console.log("  confirm <id> / decline <id>   apply or dismiss a proposal");
  console.log("  (LLM flows need ANTHROPIC_API_KEY)");
  process.exit(1);
}
run().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
