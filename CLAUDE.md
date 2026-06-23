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
3. **Branch, then ship — local-first (no PRs).** Never edit on `main`; work on a feature branch.
   Deploy with one command, `npm run ship` (run from the branch): it runs the test + typecheck gate,
   merges the branch into `main`, restarts the dashboard, pushes `main` to GitHub as a backup, and
   returns you to your branch. **No PRs, no branch protection, no CI gate — the local gate IS the gate;
   GitHub is a backup mirror, not the deploy source.** Claude commits the branch and stops there; **the
   user runs `npm run ship`** (it deploys *and* pushes) unless they explicitly ask Claude to ship. Don't
   leave work uncommitted in the session.
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
  copy-pasteable from anywhere: `cd /Users/maxeskell/dev/personal-training-app && npm run ship`,
  never a bare `npm run ship` that assumes a working directory. The repo lives at
  `/Users/maxeskell/dev/personal-training-app` on the user's Mac.

## Talking things through (coaching chat — not always a code change)

Sometimes the user isn't asking for code — they want to **talk a training question through** (fuelling,
pacing, a race plan, "how should I think about X"). That is a first-class use of this repo, not a detour.

- **Read the coaching brief first, then answer in that voice.** Before responding, read
  `coach-instructions.md` (the coach persona + how it weighs evidence), `knowledge/sports-science.md`
  (the priors) and `coaching-notes.md` (this athlete's durable context, open questions and past decisions).
  All three are committed, so they're available even in a fresh Claude-Code-on-the-web checkout — unlike
  `profile.local.yaml`, which is gitignored and will **not** be present there.
- **Pull live numbers when you can, but know where they live.** The MCP server (`npm run mcp`) exposes
  races/FTP/weight/plan, but it reads local OAuth tokens + `data/` on the Mac — so it only answers in a
  **local** Claude Code/Desktop session, never in a web container (no tokens/account/`data/` there).
- **Lead with the recommendation, grounded in those files — don't front-load caveats.** If a live number
  (weight, the forecast, the product list) would sharpen the answer but isn't to hand, say so in one line,
  state the assumption you're using, and answer anyway. Ask for a number only when it changes the call.
- **n=1 outranks the textbook** — same rule as the app coach: this athlete's own logged response beats any
  population prior; say so when they conflict.
- **Keep the notes current — that's how the next conversation gets better.** When a chat produces a durable
  fact, a decision, or a follow-up action, write it into `coaching-notes.md` in the same turn (right heading
  / the "To do" list). Keep secrets and live/drifting numbers out of it (trends and targets are fine).

## Running the server (ONE canonical model — never give conflicting commands)

The dashboard runs as a **single always-on macOS launchd service** (`com.endurance-coach.dashboard`,
port 3000), installed once with `npm run serve:install`. That service — not an open terminal — serves
the site: it starts at login, restarts on crash (RunAtLoad + KeepAlive), and a `post-merge` git hook
restarts it after a merge (including the local merge `npm run ship` does). This is the everyday model;
treat it as the default in all advice.

- **Deploying is ONE command, run from a feature branch:** `cd /Users/maxeskell/dev/personal-training-app && npm run ship`.
  It gates (test + typecheck), merges the branch into `main`, restarts the service, and pushes `main` to
  GitHub as a backup. The old pull-based `npm run update` / launchd autoupdate model is **retired**
  (autoupdate uninstalled 2026-06-23; `npm run autoupdate:install` still exists if you ever want it back).
  Never tell the user to *also* run `npm start` / `npm run serve` afterwards.
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
  open-water venue above **13°C** — the temp has no public feed, so it's confirmed manually in the
  dashboard's Week-ahead water-temp box (persisted to `data/venue.json`, read live). A stale reading is
  forecast by drifting it on air temperature (a damped MODEL) for you to Confirm/Correct; `COACH_WATER_TEMP_C`
  is now only an optional seed that any confirmed reading overrides.
- Weekly totals display as h:mm; missing data renders "—", never a misleading zero.
