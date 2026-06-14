import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { emptyState } from "../src/state/types.js";
import type { AthleteState } from "../src/state/types.js";
import type { CoachLLM } from "../src/llm/client.js";
import {
  classifyRace,
  priorityRank,
  deriveSeasonShape,
  raceCalendarLines,
  liveCoachingContext,
  raceContext,
  athleteContext,
  type Goal,
} from "../src/coach/seasonContext.js";
import { runWeeklyReview } from "../src/coach/weekly.js";
import { runRacePrep } from "../src/coach/racePrep.js";

const TODAY = "2026-06-14";
// A deliberately DIFFERENT calendar from the old hard-coded one — proves the coaching follows goals.
const GOALS: Goal[] = [
  { event_name: "Outlaw Half Bowood", event_type: "Triathlon (70.3)", event_date: "2026-08-02", priority: "A", target_completion_time_in_seconds: 5 * 3600 },
  { event_name: "Club Sprint Tri", event_type: "Triathlon", event_date: "2026-07-26", priority: "B" },
  { event_name: "Snowdonia Marathon", event_type: "Marathon", event_date: "2026-10-24", priority: "B" },
  { event_name: "Old Race", event_type: "Run", event_date: "2026-01-01", priority: "C" }, // past → excluded
];
const OLD = /Birmingham|Loch Ness|Alderford/;

function stateWith(goals: Goal[]): AthleteState {
  const s = emptyState(TODAY, new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals } };
  return s;
}

function stubLlm(): { llm: CoachLLM; prompts: string[] } {
  const prompts: string[] = [];
  const llm = { text: async (p: string) => { prompts.push(p); return { text: "ok", cacheRead: 0, costUsd: 0 }; } } as unknown as CoachLLM;
  return { llm, prompts };
}

test("classifyRace + priorityRank read type/name and priority", () => {
  assert.equal(classifyRace(GOALS[0]), "tri");
  assert.equal(classifyRace(GOALS[2]), "run");
  assert.equal(classifyRace({ event_name: "Lakeside OW Swim", event_type: "Open Water" }), "swim");
  assert.equal(classifyRace({ event_name: "Mystery", event_type: "" }), "other");
  assert.equal(priorityRank("A"), 0);
  assert.equal(priorityRank("B"), 1);
  assert.equal(priorityRank(1), 0);
  assert.equal(priorityRank(undefined), 9);
});

test("raceCalendarLines lists future races soonest-first with countdown + kind, drops past", () => {
  const lines = raceCalendarLines(GOALS, TODAY);
  assert.equal(lines.length, 3, "the past race is excluded");
  assert.match(lines[0], /Club Sprint Tri in 42d .*priority B, tri/);
  assert.match(lines[1], /Outlaw Half Bowood in 49d/);
  assert.ok(!lines.join("\n").match(OLD));
});

test("deriveSeasonShape computes the calls from the live calendar, not a frozen one", () => {
  const shape = deriveSeasonShape(GOALS, TODAY).join("\n");
  assert.match(shape, /Taper:.*Outlaw Half Bowood/); // ~2wk tri taper into the A race
  assert.match(shape, /Club Sprint Tri sits 7d before your higher-priority Outlaw Half Bowood.*capped tempo/);
  assert.match(shape, /Snowdonia Marathon is a run goal built off a triathlon base.*injury window/);
  assert.match(shape, /maintain \(don't build\) swim\/bike/);
  assert.ok(!shape.match(OLD), "no frozen race names leak in");
});

test("two A-races close together triggers the don't-stack-peaks call", () => {
  const shape = deriveSeasonShape(
    [
      { event_name: "Race One", event_type: "Triathlon", event_date: "2026-08-02", priority: "A" },
      { event_name: "Race Two", event_type: "Triathlon", event_date: "2026-08-16", priority: "A" },
    ],
    TODAY,
  ).join("\n");
  assert.match(shape, /Race One and Race Two are both A-races only 14d apart.*stacked peaks/);
});

test("no goals → empty shape and a confirm-your-goals nudge in the live block", () => {
  assert.deepEqual(deriveSeasonShape([], TODAY), []);
  const block = liveCoachingContext(stateWith([]));
  assert.match(block, /no upcoming races set/);
  assert.equal(raceContext(stateWith([])), "(no upcoming races)");
});

test("athleteContext uses live getUser profile, degrades when absent", () => {
  const s = stateWith(GOALS);
  s.athleteProfile = { value: { name: "Sam Runner", age: 38, sex: "male" }, source: "ai-endurance" };
  assert.match(athleteContext(s), /Sam Runner, 38y, male/);
  const bare = athleteContext(stateWith(GOALS)); // no profile set
  assert.ok(!bare.includes("undefined"));
});

test("weekly review prompt carries the LIVE calendar, never the old hard-coded races", async () => {
  const { llm, prompts } = stubLlm();
  await runWeeklyReview(llm, [stateWith(GOALS)]);
  assert.match(prompts[0], /Outlaw Half Bowood/);
  assert.match(prompts[0], /SEASON SHAPE/);
  assert.ok(!prompts[0].match(OLD), "weekly prompt must not name Birmingham/Loch Ness/Alderford");
});

test("race prep prompt derives from the picked live race, no frozen season rules", async () => {
  const { llm, prompts } = stubLlm();
  const out = await runRacePrep(llm, stateWith(GOALS));
  assert.match(out.raceLabel, /Club Sprint Tri/); // nearest future race auto-picked
  assert.match(prompts[0], /discipline-specific prep for a tri race/);
  assert.ok(!prompts[0].match(OLD), "race prep prompt must not name the old races");
});

test("named race prep can still target a specific live race", async () => {
  const { llm, prompts } = stubLlm();
  const out = await runRacePrep(llm, stateWith(GOALS), "Snowdonia");
  assert.match(out.raceLabel, /Snowdonia Marathon/);
  assert.match(prompts[0], /discipline-specific prep for a run race/);
});

test("source-of-truth docs and the built system prompt are free of frozen race names", async () => {
  const persona = await readFile("docs/specs/AI_Triathlon_Coach_Project_Instructions.md", "utf8");
  const science = await readFile("knowledge/sports-science.md", "utf8");
  assert.ok(!persona.match(OLD), "persona must not hard-code specific races");
  assert.ok(!science.match(OLD), "knowledge file must not hard-code specific races");
  const { loadSystemPrompt } = await import("../src/coach/persona.js");
  assert.ok(!(await loadSystemPrompt()).match(OLD), "assembled system prompt must be race-agnostic");
});
