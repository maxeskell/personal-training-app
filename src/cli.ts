import { AieClient, AIE_READ_TOOLS, AIE_WRITE_TOOLS } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { assembleState } from "./state/assemble.js";
import { config } from "./config.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { assessReadiness } from "./coach/readiness.js";
import { assessHealthRisk } from "./guardrails/wellbeing.js";
import { DecisionLog, decisionId, nowIso } from "./state/decisionLog.js";

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
  if (!CoachLLM.hasApiKey()) {
    console.error(
      "\nANTHROPIC_API_KEY is not set. The readiness verdict needs the LLM core.\n" +
        "Set it in your environment (or .env) and re-run:  export ANTHROPIC_API_KEY=sk-ant-...\n",
    );
    process.exit(1);
  }

  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();
  const today = todayIso();
  const state = await withAie((aie) =>
    assembleState(aie, garmin, store, { date: today, assembledAt: new Date().toISOString() }),
  );
  await garmin?.close();
  await store.save(state);

  // Trailing window for trend-based reasoning + the wellbeing co-occurrence check.
  const window = await store.recent(today, 7);

  // Deterministic wellbeing guardrail runs BEFORE the model — it can't be reasoned away.
  const risk = assessHealthRisk(window);
  if (risk.level !== "none") {
    console.log(`\n⚠ Wellbeing (${risk.level}): ${risk.message}\n`);
  }

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

  // Persist to the decision log (durable record beyond chat history).
  const log = new DecisionLog();
  await log.append({
    id: decisionId(`readiness:${today}`),
    timestamp: nowIso(),
    kind: "readiness",
    summary: `${verdict.verdict}: ${verdict.why}`,
    status: "note",
  });
  console.log(`\n(logged to decision log; cache read ${cacheRead} tokens)`);
}

const [, , cmd] = process.argv;
const commands: Record<string, () => Promise<void>> = {
  auth: cmdAuth,
  verify: cmdVerify,
  state: cmdState,
  readiness: cmdReadiness,
};

const run = commands[cmd ?? ""];
if (!run) {
  console.log("Usage: tsx src/cli.ts <auth|verify|state|readiness>");
  console.log("  auth       run OAuth + confirm the AI Endurance connection");
  console.log("  verify     exercise every read tool, confirm the write-gate");
  console.log("  state      assemble + persist + summarise today's AthleteState");
  console.log("  readiness  green/amber/red verdict with cited drivers (needs ANTHROPIC_API_KEY)");
  process.exit(1);
}
run().catch((err) => {
  console.error("\nError:", err instanceof Error ? err.message : err);
  process.exit(1);
});
