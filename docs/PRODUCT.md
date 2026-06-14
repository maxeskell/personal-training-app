# Product one-pager — Endurance Coach

A single-page product + risk summary for review. For usage see [README](../README.md); for setup
[SETUP.md](../SETUP.md); for engineering [HANDOVER.md](../HANDOVER.md).

## What it is

A **local-first AI endurance coach** for one triathlete/runner. It reads your plan, races, season
calendar and training metrics **live from [AI Endurance](https://aiendurance.com)** (and optionally
Garmin), assembles them into a daily snapshot, and *interprets* rather than re-plots: readiness
verdicts, weekly reviews, race prep, gated plan tweaks, deep single-session feedback, and an n=1
statistical insight layer. It runs as a CLI plus a small local web dashboard you can open on your phone.

## Problem & who it's for

Platforms like AI Endurance and Garmin produce excellent data and plans, but the athlete is left to
interpret it. This closes that gap with individualised, evidence-cited coaching. **Target user:** a
self-coached endurance athlete who already uses AI Endurance, is comfortable running a couple of CLI
commands (or having an AI assistant do it — see SETUP.md), and wants honest, data-grounded guidance on
their own machine. It is explicitly **not** a multi-tenant SaaS or a replacement for a human coach.

## How it works (high level)

`AI Endurance (+ optional Garmin) → assemble one daily AthleteState → deterministic insight engine →
LLM coaching narratives → CLI / dashboard`. The statistical layer runs without any LLM call; the LLM
(Anthropic Opus) writes the human-facing coaching on top.

## Data & privacy posture

- **Local-first.** No database, no app accounts, no server you don't run. State is flat JSON/JSONL on
  your machine. Nothing is shared with other users — it is single-user by construction.
- **Secrets stay off-repo and out of logs.** OAuth/API tokens live in `~/.endurance-coach` /
  `~/.garminconnect`; `.env`, `data/`, `reports/`, logs and token dirs are gitignored; token-shaped
  strings are redacted from logs and notifications.
- **Egress is limited and purposeful:** reads from AI Endurance/Garmin/Open-Meteo, and LLM calls to
  Anthropic (counts + dollar cost logged locally; **no prompt text persisted**). No analytics/telemetry.
- **The dashboard is closed by default:** binds `127.0.0.1`, every route gated by a per-install pairing
  token, Host-header allow-listed (anti-DNS-rebind). LAN/phone access is strictly opt-in (`COACH_LAN=1`).

## Safety & trust model

- **Every write is gated.** The coach can only *propose* plan changes; nothing mutates AI Endurance
  until you `confirm`. New features are display-only by default.
- **Honest models.** Estimated outputs (zones, race splits, road dryness, predictions) are labelled
  MODEL/estimate with assumptions stated; correlations report effect sizes + CIs with FDR control, not
  naive significance.
- **Degrade, don't crash.** Optional dependencies are best-effort with timeouts — a failure yields a
  missing card with a note, never an error page or a blocked flow.
- **Cost-aware.** Deterministic flows cost nothing; LLM effort is tuned per flow and every call is
  cost-logged with a monthly projection (`npm run cost`).

## Limitations / non-goals

- **Requires an AI Endurance account** (the data spine) and an Anthropic API key for coaching flows.
- **Single athlete**; no multi-user or hosted offering.
- **Garmin is an unofficial client** — degradable and occasionally fragile; tokens expire ~6-monthly.
- **No demo/no-account mode** today (intended use is your own accounts).
- **macOS-oriented extras** (desktop notifications, auto-start installers); the core CLI + dashboard
  run on Linux, with printed cron/systemd equivalents.

## Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM gives wrong/over-confident advice | Medium | Medium | Writes gated (propose→confirm); estimates labelled; insight engine is deterministic + CI/FDR-guarded |
| Secret/token leakage | Low | High | Tokens off-repo with tight perms; gitignore; log redaction; `127.0.0.1` default + token-gated dashboard |
| Garmin client breaks / rate-limits | Medium | Low | Optional + degradable; timeouts + wall-clock budget; coach falls back to AI Endurance |
| AI Endurance API/schema drift | Low | High | Provenanced fields degrade to `null` not crash; `doctor` flags tool drift |
| Runaway LLM spend | Low | Medium | Per-flow effort tuning, prompt caching, local cost log + projection |
| Thin test coverage on parser/server/write-gate | Medium | Medium | Tracked in `improvement-plan.md`; standing "invert the test pyramid" priority |

## Roadmap

Sequenced technical priorities live in [`improvement-plan.md`](./improvement-plan.md) (test inversion
first); the deeper analytics direction is in [`specs/Insight_Engine_Spec.md`](./specs/Insight_Engine_Spec.md).
The known engineering gaps are catalogued honestly in [`engineering-review.md`](./engineering-review.md).
