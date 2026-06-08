# Path B — Custom orchestrator plan

> **Status:** queued. Build *after* validating Path A. All three §1 needs apply
> (unattended scheduling, glanceable dashboard, persistent decision log), so a custom
> orchestrator is justified — but only these pieces, no feature sprawl.

## Why Path B is justified here
The Build Spec §1 says build only if one of three needs bites. You confirmed **all three**:
1. **Unattended scheduling** — pushed daily readiness ping (~06:00) without opening a chat.
2. **Glanceable dashboard** — Today / Week / Trends / Race at a glance.
3. **Persistent decision log** — durable record of proposals/decisions and how calls held up.

## Architecture (local-first)
```
AI Endurance MCP (remote, OAuth)  ──►  Orchestrator  ──►  Interface
   plan of record + ML model            · assemble daily AthleteState     (Today/Week/Trends/Race)
Garmin MCP (optional, local)     ┄┄►    · readiness logic (LLM + priors)  + scheduler (push)
   5 gap metrics, degradable             · confirm-before-write           + decision log (store)
```
Solid = required (AIE). Dotted = optional (Garmin). Must be fully useful on AIE alone.

## Milestones (Build Spec §10)
- **M1 — Scaffold + MCP clients.** Repo structure, AIE client (required, OAuth), Garmin client
  (optional, degradable). Verify reads. Secrets encrypted, out of prompts/logs/repo.
- **M2 — AthleteState + store + baselines.** One record/day, **provenance per field**. Planned-vs-actual
  join, HRV-vs-baseline / RHR / sleep / weight-trend, sync-gap detection. Don't recompute what AIE trends.
- **M3 — LLM core + knowledge + guardrails.** Science as *priors* in `knowledge/sports-science.md`
  (§7), interpreted by the model. **Deterministic code only** for hard guardrails: write-gate +
  fuelling/weight limits.
- **M4 — The four flows + dated markdown reports.** Daily readiness, weekly review, gated plan-adjust,
  race prep. **This is the product** — meets the §9 acceptance criteria.
- **M5 — Scheduling + dashboard.** Both apply: a pushed 06:00 readiness ping, and a glanceable
  Today/Week/Trends/Race view. Decision log (need #3) lands as part of M2/M4's store + M4 reports.
- **M6 — Harden.** Garmin-breakage handling, AIE tool-change tolerance, secret hygiene, decision-log review.

## Hard guardrails (enforced in code, non-negotiable)
- **Write-gate:** no AIE write tool (`changeWorkoutDate`, `skipWorkout`, `create*Workout`, `setZones`…)
  fires without explicit per-action confirmation. No autonomous plan rewrites.
- **Wellbeing:** fuel to train; use AIE ranges. **Never** recommend deficits / restriction / "race weight."
  Weight = trend, secondary, never a daily target. **No clinical-syndrome detection** — co-occurring
  risk signals → raise gently + refer to a professional; don't label RED-S, don't treat loss as a win.
- **Reliability:** Garmin optional/degradable — on failure, say so, fall back to AIE, ask for pasted
  numbers, never guess. Tolerate AIE tools changing/disappearing.

## Acceptance criteria (Build Spec §9)
1. AIE connects; daily state assembles with correct provenance; sync gaps surfaced.
2. Readiness = green/amber/red on a **trend** that doesn't flip on one bad night; black-box scores tiebreak only.
3. Weekly review leads with the takeaway.
4. An auto-write attempt is **blocked** without confirmation.
5. Race prep adapts by event + time-to-race; explicitly surfaces Alderford decision + run-load caution.
6. Garmin-down degrades cleanly.
7. A restriction-implying nutrition prompt is redirected to adequate fuelling.
8. Every output cites its data.

## Outcome metrics (the actual point)
Arrive at Birmingham and Loch Ness **uninjured** and on/above predicted time; run-volume ramp stays in
safe bounds with no flare; health-risk signals never missed; "this coached me well."
**Explicitly NOT** engagement/% days acted on — that rewards dependence, which is a failure mode.

## Stack decision (TBD before M1)
To be chosen when we start M1 — candidates: TypeScript/Node (good MCP SDK support) or Python (matches
the Garmin client ecosystem). Local-first, simple store (SQLite or flat files + git), thin interface.

**Research note (verified June 2026):** the orchestrator is an **MCP client to two servers** —
AIE (remote, Streamable HTTP + OAuth) and Garmin (local stdio subprocess via `uvx`). Both the
official TS and Python MCP SDKs support multi-server clients with OAuth helpers, so orchestrator
language is **free** — a TS orchestrator can still spawn the Python Garmin server as a stdio
subprocess. Recommendation: **TypeScript/Node** (official `@modelcontextprotocol/sdk` has mature
client + OAuth 2.1/PKCE + Streamable HTTP support, and pairs naturally with a web dashboard for
need #2), spawning the Python `garmin_mcp` over stdio for the optional 5 metrics.

---

## Verified technical findings (researched June 2026)

### AI Endurance MCP — confirmed (`github.com/ai-endurance/mcp`)
- **Endpoints:** base `https://aiendurance.com/mcp`, messages `/mcp/messages`, manifest
  `/.well-known/ai-plugin.json`. **OAuth 2.0** — authorize `https://aiendurance.com/authorize/`,
  token `https://aiendurance.com/api/o/token/`, scopes `read` + `write`. Transport: Streamable HTTP
  (preferred) / SSE (legacy). Protocol **MCP 2025-06-18**, JSON-RPC 2.0. **No explicit rate limits.**
- **Exactly 20 tools** (matches the spec). Reads: `getUser`, `getAvailability`, `getPlannedWorkouts`,
  `get{Cycling,Running,Swimming}Activity`, `get{Cycling,Running,Swimming}ActivityDetail`,
  `getRaceGoalEvent`, `getPrediction`, `getRecoveryModel`, `getPlanProgress`, `getNutritionModel`.
  Writes (gate these): `setZones`, `changeWorkoutDate`, `skipWorkout`, `changeWorkoutAdvice`,
  `createRideRunWorkout`, `createSwimWorkout`, `createStrengthOtherWorkout`.
- **Cost control is real and built-in:** `*ActivityDetail` takes a `resolution` arg —
  `low` (~1,250 tokens, default) → `full` (**18k–125k tokens, "use sparingly"**). And
  `getPlannedWorkouts` has a `summaryMode` flag for lightweight overviews. → Default to `low` +
  `summaryMode`; escalate only for a specific session deep-dive. (Satisfies the §8 cost NFR concretely.)
- **`getRecoveryModel` gives exactly what the marathon injury-window caution needs:** DFA α1, rMSSD,
  RHR trend, ESS, **and per-sport orthopedic recovery (run/bike/swim separately)** + "what's limiting
  recovery today." → directly powers run-load progression monitoring.
- **`getNutritionModel`** returns daily calorie + protein/fat/carb **ranges (lower/upper bounds)** for
  6 days → use as adequate-fuelling targets, never deficits.
- **Blast radius of writes is naturally bounded** — the server *cannot* start plan generation, alter
  3rd-party connections, delete the account/billing, or delete historical activities; `skipWorkout`
  only affects *future* workouts. The write-gate still applies, but worst-case damage is limited.
- ⚠️ **Scope nuance to verify at M1:** the README's OAuth flow narration says the user grants *"read"
  scope*, while the scopes list and config show `read` + `write`. Confirm `write` is actually granted
  during the consent flow before relying on write tools.

### Garmin MCP — confirmed (`Taxuspt/garmin_mcp`, the one the spec names)
- **MIT licensed.** 110+ tools (~90% of `python-garminconnect` v0.3.2) — far more than the 5 we need;
  we'll call only sleep / Body Battery / Training Readiness / VO₂max+Training Status / weight trend.
- **Auth:** one-time `uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth`,
  handles **MFA**, saves OAuth tokens to `~/.garminconnect`, **~6-month lifetime** (re-auth on expiry).
  Supports `GARMIN_EMAIL_FILE` / `GARMIN_PASSWORD_FILE` for creds-out-of-env hygiene.
- **Run as stdio server:** `uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp`.
  Skips destructive ops (`delete_activity`); excludes large GPS payloads. → confirms the spec's
  "fragile, optional, degradable" stance; the ~6-month token expiry is the predictable failure mode to
  handle gracefully (M6). Thinner alternatives exist (`Nicolasvegam/garmin-connect-mcp`, 61 tools;
  `eddmann/garmin-connect-mcp`) if 110 tools prove unwieldy.

### Building the orchestrator-as-MCP-client — confirmed
- Official **`@modelcontextprotocol/sdk`** (npm) ships client transports (stdio + Streamable HTTP) and
  **OAuth helpers**; the MCP authorization spec (OAuth 2.1 + PKCE) landed 2025-03-25. A single client
  can connect to both servers. This is the standard, supported path — no need to hand-roll OAuth.
