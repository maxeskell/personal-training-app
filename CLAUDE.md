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

## Talking to the user

- **Always give absolute paths in CLI instructions.** Any command the user is told to run must be
  copy-pasteable from anywhere: `cd /Users/maxeskell/personal-training-app && npm run update`,
  never a bare `npm run update` that assumes a working directory. The repo lives at
  `/Users/maxeskell/personal-training-app` on the user's Mac.

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
  open-water venue above **13°C** (`COACH_WATER_TEMP_C` is updated manually — no public feed exists).
- Weekly totals display as h:mm; missing data renders "—", never a misleading zero.
