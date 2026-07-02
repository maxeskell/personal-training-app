# Data sources (the spine adapter seam)

The coach assembles a uniform **`AthleteState`** from a *training-data spine*, and everything downstream
— the insight engine, dashboard, MCP tools, all the flows — consumes that `AthleteState` without knowing
which source produced it. Today there's one spine (**AI Endurance**); the seam (Phase 3a) makes adding
another one a contained change.

## The contract

`src/sources/types.ts`:

```ts
interface DataSource {
  readonly id: string;     // COACH_SOURCE value + provenance tag
  readonly label: string;
  assemble(ctx: AssembleContext): Promise<AthleteState>;
}
```

- **`selectDataSource()`** (`src/sources/index.ts`) picks the source from `COACH_SOURCE` (default
  `ai-endurance`); an unknown value **falls back to AI Endurance** with a warning — degrade, don't crash.
- **`AieDataSource`** (`src/sources/aieSource.ts`) is the default: it wraps the existing AI Endurance
  assemble path verbatim (connect → `assembleState` → close), so the seam is a **zero-behaviour-change**
  refactor.
- **Garmin stays a cross-cutting, optional gap-filler** passed in via `AssembleContext` — it is *not* a
  source of its own.

The primary assembly path — `buildTodayState()` (orchestrator) and `npm run state` — now routes through
`selectDataSource()`. *(The dashboard's background `refresh()` in `server.ts` is still on the direct AIE
path; it's routed through the seam in Phase 3b, alongside the first non-AIE adapter, because its
degrade-on-connect-fail + Garmin fit-sync + weather refresh hold the open clients.)*

## TrainingPeaks / Strava / others?

**TrainingPeaks and Strava aren't direct spines here.** TrainingPeaks has **no self-serve personal API**
— access is partner-gated (a commercial agreement), so there's no API key a single athlete can generate;
Strava's API exists but isn't wired up as a live source. What the app *does* read from these platforms is
your **exported history, offline**: the read-only `/career` page is built from a TrainingPeaks CSV export
plus your raw `.FIT`/`.TCX`/`.PWX` files (`npm run career:build` — see SETUP.md → "Career history"). If you
ever obtain TP partner-API access, the `DataSource` seam below is where a native adapter would slot in.

## Adding another source

1. Implement `DataSource` in `src/sources/<name>Source.ts` — map your API into `AthleteState`. Fields a
   source can't provide stay `absent()`/`null`; the app already **degrades** missing cards rather than
   erroring, so partial coverage is fine and honest. Keep the mapping pure + fixture-tested.
2. Register it in `selectDataSource()`.
3. Add its config to `.env.example`, and set `COACH_SOURCE=<name>` in `.env`.

**Honest note on parity:** AI Endurance provides modelled signals (DFA-α1 **durability**, its **race
predictions**, **plan-progress adherence**) that other sources may not expose. Those cards degrade for a
source that lacks them — the coach is most capable on AI Endurance. Label what a source can't provide;
never fabricate it.
