import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";

interface Goal {
  event_name?: string;
  event_date?: string;
  event_type?: string;
  priority?: string | number;
  target_completion_time_in_seconds?: number;
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${String(toIso).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

function goalsFrom(today: AthleteState): Goal[] {
  const raw = today.raw?.getRaceGoalEvent as { goals?: Goal[] } | undefined;
  return Array.isArray(raw?.goals) ? raw!.goals! : [];
}

/** Pick the named race, else the nearest future race, else the first goal. */
function pickRace(goals: Goal[], today: string, name?: string): Goal | undefined {
  if (!goals.length) return undefined;
  if (name) {
    const m = goals.find((g) => (g.event_name ?? "").toLowerCase().includes(name.toLowerCase()));
    if (m) return m;
  }
  const future = goals
    .filter((g) => g.event_date && daysBetween(today, g.event_date) >= 0)
    .sort((a, b) => daysBetween(today, a.event_date!) - daysBetween(today, b.event_date!));
  return future[0] ?? goals[0];
}

export async function runRacePrep(
  llm: CoachLLM,
  today: AthleteState,
  raceName?: string,
): Promise<{ markdown: string; cacheRead: number; raceLabel: string }> {
  const goals = goalsFrom(today);
  const race = pickRace(goals, today.date, raceName);

  if (!race) {
    const { text, cacheRead } = await llm.text(
      "No race goals are available from AI Endurance right now. Give brief guidance on the season " +
        "shape from memory (Birmingham 11 Jul → Loch Ness 27 Sep, Alderford 6 Sep capped tempo) and " +
        "suggest confirming race goals in AI Endurance.",
    );
    return { markdown: `# Race prep\n\n${text}`, cacheRead, raceLabel: "no race goal" };
  }

  const days = race.event_date ? daysBetween(today.date, race.event_date) : null;
  const r = today.recovery.value;
  const prediction = today.raw?.getPrediction ?? null;

  const prompt = [
    `Produce race-specific prep guidance as markdown for this race, calibrated to TIME-TO-RACE.`,
    `Lead with the single most important thing for this phase. Specificity rises as the race nears.`,
    "",
    `RACE: ${race.event_name ?? "—"} (${race.event_type ?? "—"}, priority ${race.priority ?? "—"})`,
    `DATE: ${race.event_date ?? "—"}  |  DAYS TO RACE: ${days ?? "—"}`,
    race.target_completion_time_in_seconds
      ? `TARGET: ${Math.round(race.target_completion_time_in_seconds / 60)} min`
      : "TARGET: —",
    "",
    `CURRENT RECOVERY [ai-endurance]: cardio ${r?.cardioRecovery ?? "—"}/100, run orthopedic ${
      r?.orthopedic?.run ?? "—"
    }/100, limiter ${r?.limiterToday ?? "—"}`,
    `ML PREDICTION [ai-endurance]: ${prediction ? JSON.stringify(prediction).slice(0, 600) : "unavailable"}`,
    "",
    "Apply the season rules:",
    "- Birmingham (Olympic tri, A): bricks, transitions, race pacing, ~2-week taper (cut volume ~40–60%,",
    "  hold intensity/frequency), progressive carb fuelling rehearsed in long sessions. UK July heat is",
    "  usually a non-issue — only mention heat prep if a heatwave is forecast.",
    "- Alderford (Olympic tri, B, 6 Sep): it is 3 WEEKS before the goal marathon — treat as a HARD-CAPPED",
    "  TEMPO effort, do NOT race it; surface this as the explicit trade-off, not a footnote.",
    "- Loch Ness marathon (B, 27 Sep): off a tri base = injury window. Cap weekly run-volume increases,",
    "  build long runs + marathon-pace work + durability, short marathon taper, maintain (don't build) swim/bike.",
    "Be specific and cite the data where it informs a call.",
  ].join("\n");

  const { text, cacheRead } = await llm.text(prompt);
  const label = `${race.event_name ?? "race"}${days != null ? ` (T-${days}d)` : ""}`;
  return { markdown: `# Race prep — ${label}\n\n${text}`, cacheRead, raceLabel: label };
}
