# CLAUDE.md — standing instructions for this repo

> **Setting this repo up for a NEW user?** Follow [SETUP.md](./SETUP.md) instead of applying the
> specifics below. The machine path (`/Users/maxeskell/...`) and the "athlete preferences already
> encoded" section are the **original author's** — a fresh setup must gather the new user's own units,
> training location and preferences (SETUP.md Step 3), never reuse these. The conventions in this file
> (definition of done, gated writes, degrade-don't-crash, escaping) DO apply to all code changes.

## Definition of done (apply to EVERY change, without being asked)

1. **Code + docs move together.** Any behaviour, command, config or card change updates the
   matching docs in the same commit: `README.md` (user-facing behaviour), `.env.example`
   (every new env var, with a comment explaining it), and `docs/specs/*` when a spec is the
   source of truth for what changed.
2. **Green before commit.** `npm run typecheck` and `npm test` must pass locally. New logic gets
   unit tests (node:test, pure functions preferred, no network in tests — fixtures instead).
3. **Commit, push, PR.** Commit with a clear message, push the working branch, and open a draft
   PR if one doesn't exist. Don't leave work uncommitted in the session.
4. **Report honestly.** If tests fail or something was skipped, say so — never present it as done.
5. **Gitignored user data ships a committed template + guidance.** Any new *user-authored* gitignored
   file or structure (a new block in `profile.local.yaml`, a new local data file the user fills in) lands
   in the SAME commit with: (a) a committed example/template carrying placeholders or a commented draft
   (the `profile.example.yaml` / `.env.example` pattern), (b) `README.md` + `SETUP.md` guidance on how to
   fill it, and (c) an in-app nudge where one fits — an optional `profile/questions.ts` entry (which
   surfaces in the "Set up & improve → Finish setup" card) and/or a card empty-state hint. **Exempt:**
   runtime-generated files (`data/`, `knowledge/pending/`, logs) — the app writes them, the user doesn't
   author them — and secrets/tokens (`.env`, `*.tokens.json`, token dirs), which must NEVER be templated
   with real values. The test in `test/profileQuestions.test.ts` (every question's field exists in the
   example profile) keeps a profile addition honest.

## Talking to the user

- **Always give absolute paths in CLI instructions.** Any command the user is told to run must be
  copy-pasteable from anywhere: `cd /Users/maxeskell/personal-training-app && npm run update`,
  never a bare `npm run update` that assumes a working directory. The repo lives at
  `/Users/maxeskell/personal-training-app` on the user's Mac.

## Running the server (ONE canonical model — never give conflicting commands)

The dashboard runs as a **single always-on macOS launchd service** (`com.endurance-coach.dashboard`,
port 3000), installed once with `npm run serve:install`. That service — not an open terminal — serves
the site: it starts at login, restarts on crash (RunAtLoad + KeepAlive), and a `post-merge` git hook
restarts it after a pull. This is the everyday model; treat it as the default in all advice.

- **Deploying an update is ONE command:** `cd /Users/maxeskell/personal-training-app && npm run update`.
  It pulls `COACH_DEPLOY_BRANCH` (default `main`) and restarts the service. Never tell the user to *also*
  run `npm start` / `npm run serve` afterwards.
- **`npm start` / `npm run serve` is DEV-ONLY** (foreground, dies with the terminal). Running it while
  the service is up starts a second instance fighting for port 3000. Never present it as an alternative
  way to "run the server", and never in the same breath as the service.
- **Don't guess which runner is active — look, or have the user paste this ONE diagnostic:**
  `lsof -nP -iTCP:3000 -sTCP:LISTEN; launchctl list | grep -i endurance`. If you can't see the machine,
  ask for that output instead of inferring (you cannot tell launchd from pm2 from a log line alone).
- **Advise with exactly ONE command for the user's setup.** No menus of co-equal run methods, no
  "or pm2 also works" alongside the canonical path. pm2 is a fallback *instead of* launchd, never
  alongside it — the two must never both manage the dashboard.

## Project conventions (read before writing code)

- **One athlete, local-first.** Plan data comes from AI Endurance (MCP, OAuth in
  `~/.endurance-coach`); Garmin is optional and degradable. Secrets/data never go in git —
  `data/`, `reports/`, token dirs are gitignored.
- **Every write is gated.** Nothing mutates AI Endurance except `WriteGate.confirm()` on a logged
  proposal (propose → confirm two-step). New features are display-only unless explicitly asked.
- **Degrade, don't crash.** External fetches (Garmin, weather, local LLM) are best-effort with
  timeouts: a failure means a missing card/field with a note, never an error page or a blocked flow.
- **Cost-aware LLM use.** Deterministic flows (check, dashboard cards, weather) make NO LLM calls.
  Cheap frequent flows run `effort: "medium"`; deep flows (weekly/race/deep-dive/propose) `"high"`.
  Every call is cost-logged.
- **Honest models.** Anything estimated (zones, splits, road dryness, predictions) is labelled a
  MODEL/estimate in the UI and docs, with assumptions stated.
- **Dashboard HTML is escaped.** All interpolated text goes through `escapeHtml`; handlers use
  `data-*` attributes, not quoted JS args. Tests assert script blocks still parse.

## Athlete preferences already encoded (don't re-ask)

- Rides want **dry roads + low wind** (gust/rain-prob thresholds in `config.weather`); runs go in
  any weather; open-water swims go in any weather except thunderstorms, ideally with the local
  open-water venue above **13°C** — the temp has no public feed, so it's entered manually in the
  dashboard's Week-ahead water-temp box (persisted to `data/venue.json`, read live; `COACH_WATER_TEMP_C`
  is now only an optional seed that the dashboard reading overrides).
- Weekly totals display as h:mm; missing data renders "—", never a misleading zero.
