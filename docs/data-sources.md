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

## AI Endurance token lifecycle

One OAuth token file, `~/.endurance-coach/aie-tokens.json` (0600), is shared by **every** process that
talks to AI Endurance: the dashboard and MCP services, the 06:00 ping, the 19:00 post-swim job, CLI runs
and Claude Code / Desktop sessions. Nothing coordinates them; this is how it behaves, learnt the hard way
(the 30 Aug 2026 outage — [spec 11](specs/improvements/11-aie-token-loss-and-blind-reauth.md)):

- **Refresh happens only on a 401**, by whichever process hits it first (the MCP SDK has no proactive
  expiry check). AI Endurance answers `initialize` and `tools/list` **without** a token; only a tool call
  is refused. So a bare connect never exercises the token — every "is auth OK?" check in this repo
  (`auth:aie`, `doctor`, `/health?deep=1`) makes one real read (`getUser`) instead.
- **The refresh token rotates on every use** (MODEL: AI Endurance's token endpoint is
  Django-OAuth-Toolkit-shaped, whose default is rotate-with-no-grace; the `[aie-oauth] … refresh=<fingerprint>`
  audit lines in the job logs let you verify it — a changing fingerprint on each save means rotation).
  A refresh whose reply is lost — a short-lived job suspended by sleep mid-request, then timed out and
  exited — leaves a dead refresh token on disk; the next refresh anywhere gets `invalid_grant`.
- **On `invalid_grant` the SDK asks the provider to invalidate the tokens.** The provider **retires** the
  file to `aie-tokens.revoked-<time>.json` (never `rm`s it) and logs `event=invalidated(tokens)`; the live
  path is gone, so every headless caller fails fast with `ReauthRequiredError` until a human runs
  `cd /Users/maxeskell/dev/personal-training-app && npm run auth:aie`. `doctor` lists retired copies.
- **Saves are atomic** (tmp + rename) and carry `saved_at`; the audit line never contains a token value.
- **One browser authorization at a time.** The SDK can start a second one mid-dance (it did, from its
  background event-stream GET — now answered locally with a 405); the provider reuses the listener and
  keeps the first PKCE verifier so the open tab's code still exchanges.

- **Reads are the raw `tools/call` request, not `Client.callTool()`.** AI Endurance declares an
  `outputSchema` on every tool but answers text-only; the SDK's `callTool()` rejects that on every read
  (3 Sep 2026). `extractJson` parses `content[].text` and prefers `structuredContent` when present.

What is *not* solved here (see the plan in spec 11): a lost-reply rotation cannot be recovered client-side
— only detected and surfaced — so the scheduled jobs that refresh should not run while the Mac is dozing.

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

**Honest note on parity:** AI Endurance provides modelled signals (its **race predictions**,
**plan-progress adherence**, the **recovery model**, **DFA-α1 thresholds**) that other sources may not
expose. The a1 fields became opt-in in AIE's 2026-08 "durability for all workouts" update — the app
requests them with `with_dfa_alpha1: true` on the activity list reads. Per-activity **durability**
returned on 2026-08-25 via the per-activity *Detail* tools as two opt-in measurements (internal
`durability_drift` vs the athlete's own trend; mechanical `within_session_durability` on nearly every
ride/run): the app fetches them once per analysed session in the session readout — never in bulk, the
payload weight is why AIE slimmed the summaries — and renders them on the Last-session card; archived
pre-2026-08 history still carries the old summary values for the multi-week trend (see
`docs/specs/improvements/10-aie-durability-for-all-workouts.md`). Those cards degrade for a source that
lacks them — the coach is most capable on AI Endurance. Label what a source can't provide; never
fabricate it.
