# Contributing

Thanks for your interest in the Endurance Coach. It is a local-first, single-athlete app, but it is
built to be cloned, run, and extended by anyone. This page is the short version of how to work on it;
the deeper engineering context lives in [`HANDOVER.md`](./HANDOVER.md) and [`docs/`](./docs/).

## Local setup

```bash
git clone https://github.com/maxeskell/personal-training-app.git
cd personal-training-app
npm install
cp .env.example .env
npm run typecheck && npm test     # should be green before you change anything
```

You do **not** need any external account to build, typecheck, or run the test suite — tests are pure
and use fixtures, never the network. You only need accounts (AI Endurance, Anthropic, optionally
Garmin) to exercise the live flows. See [Prerequisites](./README.md#prerequisites).

## Definition of done (every change)

These are non-negotiable and mirror [`CLAUDE.md`](./CLAUDE.md):

1. **Code and docs move together.** Any behaviour, command, config or card change updates the matching
   docs in the *same commit*: `README.md` (user-facing behaviour), `.env.example` (every new env var,
   with a comment), and `docs/specs/*` when a spec is the source of truth for what changed.
2. **Green before commit.** `npm run typecheck` and `npm test` must pass locally. New logic gets unit
   tests (`node:test`, pure functions preferred, **no network in tests** — use fixtures).
3. **Small commits, clear messages.** Imperative subject ("Add X", "Fix Y"); one logical change per PR.
4. **Open a PR; let CI go green.** CI (`.github/workflows/ci.yml`) runs typecheck + tests + build on
   every PR and on `main`.
5. **Report honestly.** If something is skipped or a test is flaky, say so in the PR — never present it
   as done.

## Conventions you must keep

- **Every write is gated.** Nothing mutates AI Endurance except `WriteGate.confirm()` on a logged
  proposal (propose → confirm two-step). New features are **display-only** unless explicitly asked.
- **Degrade, don't crash.** External fetches (Garmin, weather, local LLM) are best-effort with
  timeouts. A failure means a missing card/field with a note — never an error page or a blocked flow.
- **Cost-aware LLM use.** Deterministic flows make **no** LLM calls. Cheap frequent flows run
  `effort: "medium"`; deep flows (`weekly`/`race`/`deep-dive`/`propose`) run `"high"`. Every call is
  cost-logged to `data/cost-log.jsonl` (counts + cost only — never prompt text).
- **Honest models.** Anything estimated (zones, splits, road dryness, race predictions) is labelled a
  MODEL/estimate in the UI and docs, with its assumptions stated.
- **Dashboard HTML is escaped.** All interpolated text goes through `escapeHtml`; event handlers use
  `data-*` attributes, never quoted JS args. Tests assert the script blocks still parse.

## Security & privacy

- **Never commit secrets or personal data.** Tokens live outside the repo (`~/.endurance-coach`,
  `~/.garminconnect`); `.env`, `data/`, `reports/`, `*.log` and token dirs are gitignored. Double-check
  `git status` before committing.
- The local dashboard server binds `127.0.0.1` by default and gates every route with a pairing token.
  Keep it that way — LAN exposure is strictly opt-in (`COACH_LAN=1`).
- Report a security issue privately to the maintainer rather than opening a public issue.

## Where to start reading

`README.md` (what it does) → `HANDOVER.md` (how it is built and operated) →
`docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md` (authoritative design) →
`docs/engineering-review.md` + `docs/improvement-plan.md` (known gaps and the roadmap).
