# CLAUDE.md — standing instructions for this repo

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
  any weather; open-water swims go in any weather except thunderstorms, ideally with Dosthill
  Quarry above **13°C** (`COACH_WATER_TEMP_C` is updated manually — no public feed exists).
- Weekly totals display as h:mm; missing data renders "—", never a misleading zero.
