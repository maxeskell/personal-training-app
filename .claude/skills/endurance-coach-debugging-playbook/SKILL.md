---
name: endurance-coach-debugging-playbook
description: >
  Load this to TRIAGE a live symptom in the Endurance Coach app (local-first single-athlete TypeScript
  coaching app at /Users/maxeskell/dev/personal-training-app). Use when something is broken or wrong RIGHT
  NOW and you need to find the cause fast: "dashboard won't load" / "page is blank" / "port 3000 already in
  use" / "EADDRINUSE"; "no data" / "fields show —" / "readiness/state is empty"; OAuth / 401 / "re-auth
  needed" / "AI Endurance unreachable" / token expired; "structured output 400" / "maxItems is not permitted"
  / an LLM structured call throws; "my commits landed on main" / HEAD hijacked / wrong branch; Garmin returns
  null / "FTP looks too low" / lactate-threshold pace is ~10× off / Garmin token stale; "a correlation looks
  too good" / "is this signal real"; ".FIT won't parse" / no splits / no power curve; "coach flow errored" /
  "ANTHROPIC_API_KEY is not set"; "tests fail" / suite red; "which runner is live" / launchd vs npm start
  fight. Keywords: doctor, probe, verify:reads, state:today, degrade, Provenanced, WriteGate, escapeHtml,
  keep-higher FTP, permutation null, FDR-confirmed, exploratory. Don't load this for the settled historical
  record of WHY something was removed/reverted (use endurance-coach-failure-archaeology) or to PROVE a
  statistical method from first principles (use endurance-coach-proof-and-analysis-toolkit).
---

# Endurance Coach — debugging playbook

**Use this when** a symptom is happening now and you need to find the cause and fix-or-degrade it fast.
**Don't use this when** you want the settled story of why a past decision was made or reverted — that's
`endurance-coach-failure-archaeology`. For deriving/proving a statistical method, use
`endurance-coach-proof-and-analysis-toolkit`. For the change gate / how to ship a fix, use
`endurance-coach-change-control` (gate) and `endurance-coach-run-and-operate` (ship mechanics).

All commands below assume the repo at `/Users/maxeskell/dev/personal-training-app`. Copy them whole.

## Jargon, defined once

- **Provenanced slot** — every field of the daily `AthleteState` is `{ value: T | null, source, note? }`.
  A tool error or shape drift degrades ONE field to `value: null` (rendered `—`) with a `note` saying why —
  it never crashes the assemble. So a missing field is *expected behaviour*, not a bug, unless the whole
  state is null.
- **Degrade, don't crash** — external fetches (Garmin, weather, local LLM, `.FIT` parse) are best-effort
  with timeouts. A failure = a missing card/field with a note, never an error page. Enforced project-wide.
- **WriteGate** — the propose→confirm two-step; the ONLY path that mutates AI Endurance
  (`src/guardrails/writeGate.ts`). Never route a fix around it.
- **AIE** — AI Endurance, the platform that owns the load model (FTP/CSS/threshold/recovery), pulled live
  over MCP/OAuth. **MODEL/estimate** — any computed/predicted number; always labelled as such.

## First move: read the machine before you theorise

Two commands answer most "is it me or the box?" questions. Run them first.

```bash
# 1. Health check: creds, Garmin token age, Anthropic key, AIE tool drift, morning-ping heartbeat.
cd /Users/maxeskell/dev/personal-training-app && npm run doctor

# 2. Which server is actually listening on 3000, and is the launchd service loaded?
lsof -nP -iTCP:3000 -sTCP:LISTEN; launchctl list | grep -i endurance
```

You cannot tell launchd from pm2 from a bare log line — look with command 2, or if you can't see the Mac,
ask the user to paste its output. (See `endurance-coach-diagnostics-and-tooling` for a wrapper script and
the other measurement tools: `npm run cost`, `npm run verify:reads`, `npm run probe`, `npm run
backfill:status`, `npm run health-remote`.)

### Reading `npm run doctor` (source: `src/cli.ts:1093`, `src/health.ts`)

Each line is `✓ ok` / `⚠ warn` / `✗ fail` / `· info`. It ends with an `N fail, M warn` summary.

| Line | Healthy | Unhealthy → do this |
|---|---|---|
| AI Endurance auth | `token present (refreshed Nd ago; auto-refreshes)` | `✗ no cached token` → `npm run auth:aie` (host-only, opens a browser) |
| Anthropic API key | `set` | `✗ not set` → add `ANTHROPIC_API_KEY=sk-ant-...` to `.env`. LLM flows are disabled until then. |
| Garmin | `disabled (optional…)` or `⚠ token Nd old` | Garmin is optional — treat breakage as "degrade to AIE", not an outage. `>150d` warns; re-run `garmin-mcp-auth` before the ~180d expiry. |
| AIE tool set | `all N expected tools present` | `⚠ expected-but-absent: …` → AIE changed its tool surface; a read/write tool moved. `· new/unknown tools` is informational. |
| AIE connection | (absent when OK) | `⚠ could not reach AI Endurance: …` → network/OAuth; see OAuth row below. |
| Morning ping | `last success YYYY-MM-DD` | `⚠ last success Nh ago` (>25h) → the scheduled 06:00 ping is silently failing; check the `.morning` launchd job. |

`doctor` is best-effort: an unreachable AIE warns, it does not fail the whole check.

## Symptom → cause → discriminating check → fix

Work top-down. Each row's **Check** is the exact command that confirms or rules out the cause.

| Symptom | Likely cause | Discriminating check | Fix / escalate |
|---|---|---|---|
| Commits/edits landed on `main` unexpectedly | HEAD was moved off your feature branch (the historical autoupdate-hijack trap — see below) | `cd /Users/maxeskell/dev/personal-training-app && git branch --show-current` | If it says `main`, you were on main. Branch first (`git checkout -b <name>`), cherry-pick your commits over, and work in a git worktree. Full story: `endurance-coach-failure-archaeology`. |
| Dashboard won't load / `EADDRINUSE` / "port 3000 in use" | Two servers fighting for 3000 (launchd service **and** a stray `npm start`/`npm run serve`) | `lsof -nP -iTCP:3000 -sTCP:LISTEN; launchctl list | grep -i endurance` | Kill the stray foreground `tsx src/server.ts`; keep ONE runner. Canonical runner = the launchd service `com.endurance-coach.dashboard`; `npm start`/`serve` is dev-only. See `endurance-coach-run-and-operate`. |
| Dashboard loads but every card/field is `—` | Assemble degraded the Provenanced slots (AIE unreachable / OAuth expired), or no state persisted yet | `npm run state:today` then look at the `[source: note]` tags | If `AI Endurance auth` failed in `doctor` → `npm run auth:aie`. If AIE is reachable, a specific `—` with a note is a genuine data gap (e.g. no `.FIT`), not a bug. |
| `AI Endurance re-auth needed` / 401 / OAuth error | Cached AIE OAuth token missing or unrefreshable | `npm run doctor` (AI Endurance auth line) or `npm run health-remote` | `cd /Users/maxeskell/dev/personal-training-app && npm run auth:aie` — **host-only** (waits on `http://localhost:8765/callback`; cannot be done headless/cloud). Auth failures are surfaced as-is, never retried (`aieClient.ts:166`). |
| A coach flow (`ask`/`weekly`/`race`/`session`…) errors immediately with "ANTHROPIC_API_KEY is not set" | No API key; LLM core disabled | `npm run doctor` (Anthropic API key line) | Add `ANTHROPIC_API_KEY` to `.env`. Deterministic flows (`state`, `check`, `cost`, `dashboard`, insights, weather) make ZERO LLM calls and work without it — use `npm run demo` to sanity-check the render path. |
| Structured LLM call 400s / "maxItems is not permitted" / a structured flow throws | Array-length constraint (`maxItems`/`minItems`) leaked into a schema Anthropic rejects | Grep the schema: `grep -rn "maxItems\|minItems" src/` | The client already strips these before sending (`src/llm/client.ts:86`); array caps are enforced in code instead. If it recurs, a NEW schema bypassed the scrubber — route it through the same strip. History: `endurance-coach-failure-archaeology`. |
| Garmin FTP "looks too low" and drives wrong power zones | Garmin auto-detects cycling FTP only from power-equipped rides → sits low on sparse power data | `npm run ftp-check` (configured FTP vs Garmin MMP estimate + power coverage) | This is handled: assemble keeps the HIGHER of Garmin's device FTP and the AIE/test value and flags the gap (`src/state/assemble.ts:523`). If zones are still wrong, check `state.thresholds.note` (bikeFtpNote). Do a power-meter FTP effort so Garmin re-detects. |
| Garmin run threshold PACE is absurd (~10× too fast/slow) | Garmin's `lactate_threshold_speed_mps` is reported ~10× too small | `npm run state:today` and inspect the run threshold pace | Already guarded: a speed in 0.2–0.8 m/s is normalised ×10 before deriving pace, and only a plausible 2–7 m/s is accepted (`src/state/assemble.ts:540`). If a NEW Garmin field drifts, add the same range guard — don't silently trust the raw value. |
| Garmin returns `null` for a whole card | Garmin is an unofficial, rate-limited, fragile scraper; token may be stale | `npm run doctor` (Garmin auth age) or `npm run probe` (captures the live Garmin tool surface → `reports/`) | Degrade to AIE — Garmin is optional by design. Re-auth if the token is old. Do NOT treat Garmin down as an outage. |
| ".FIT won't parse" / no splits / power curve empty | The `.FIT` file is missing, truncated, or not a real FIT (parser is dependency-free + deliberately thin coverage) | `npm run splits [date]` / `npm run session [date]` — it tells you if the raw `.FIT` is absent | The parser returns `null` (never throws) on a bad magic / <14-byte header and returns partial data on truncation (`src/insights/fitParser.ts:247`,`318`). Missing `.FIT` → `npm run fit-sync` to fetch, or `npm run ingest-fit <path>` to import an export. `session --force` gives summary-only feedback without the `.FIT`. |
| "A correlation looks too good to be true" | Naive read of an association on autocorrelated/planned series | See the correlation triage below | Check the finding's label. If it isn't FDR-confirmed AND CI-excludes-0, it's exploratory by design. |
| `npm test` is red | A real regression, OR you added logic without a test | `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 | tail -20` | Read the failing assertion name (they're invariant-describing). Fix the code, not the test, unless the test encoded a now-wrong invariant. Green is the gate — see `endurance-coach-validation-and-qa`. |

## The correlation "too good" triage

The insight engine is honest by construction. Before you believe a relationship, find its label — the code
already tells you how much to trust it (source: `src/insights/correlations.ts`).

| The finding says… | Means | Trust |
|---|---|---|
| `CI spans 0 — tentative` | the 95% confidence interval includes 0 | Do NOT act on it. Noise. |
| `[association on a single uncorrected test — not causal, not FDR-confirmed]` | CI excludes 0 but it's ONE test | Weak. An association, not proof; next-day load is mostly PLANNED, so it's often "you schedule more when rested", not causation. |
| `[exploratory — not FDR-confirmed]` | it did not survive Benjamini-Hochberg FDR across the scanned set | A hypothesis to watch as more history accrues — never report as confirmed. |
| (no caveat tag, `fdrPass` true) | CI excludes 0 **and** it survived FDR (`correlations.ts:162`) | The strongest an n=1 correlation gets here. Still an association, not a controlled experiment. |

For a **monitoring rule** (`src/insights/monitoring.ts`): `validated: true` requires a walk-forward
holdout with ≥8 outcomes / ≥4 fires, positive Youden J, beating a circular-shift permutation null AFTER a
Bonferroni correction for best-of-N selection. `<50` usable days → in-sample only, labelled `in-sample
(exploratory)`, never "validated". A rule validated against AIE's recovery score (derived from HRV/RHR) is
relabelled "concordance, not independent prediction" — it's not an independent outcome.

To PROVE these methods (effective-N, Fisher-z CI, Bonferroni-before-BH, the permutation null) from first
principles, use `endurance-coach-proof-and-analysis-toolkit`. To RUN a full validation campaign on a new
detector, use `endurance-coach-n1-validation-campaign`.

## When to degrade vs when to fix

Ask: **is the failing thing an external best-effort source, or a load-bearing invariant?**

- **Degrade (leave it, add/verify a note):** Garmin down, weather fetch timeout, local LLM unreachable,
  a single `.FIT` missing, one Provenanced field `—` with a truthful note. The design intends these to be
  soft. A missing card with a note is the *correct* end state.
- **Fix (it's a bug):** the whole `AthleteState` is null / assemble threw; the dashboard renders an error
  page instead of a card-with-note; a `.FIT` parse *throws* instead of returning null; a write happened
  outside `WriteGate`; interpolated dashboard text isn't `escapeHtml`'d; a state write wasn't atomic/locked;
  a live number (FTP/HRV/pace…) got hard-coded into profile/committed data. These break a load-bearing
  invariant — see `endurance-coach-architecture-contract` for the full invariant list and where each is
  enforced.

Any fix still goes through the gate: `npm run typecheck && npm test` green, on a feature branch, docs moved
with code (`endurance-coach-change-control`). Never patch around the propose→confirm write gate or the
wellbeing gate to make a symptom go away.

## The autoupdate HEAD-hijack trap (know it even though it's now fenced)

The costliest failure on the real Mac: the `com.endurance-coach.autoupdate` launchd job could move HEAD
back to `main` mid-work, so edits/commits silently landed on `main`. Current `scripts/autoupdate.sh` is
fenced — it **skips entirely if the tree is dirty** (`git diff --quiet` guard) and only switches branches
on a clean tree — and the job is OFF by default. Two habits keep you safe regardless:

1. `cd /Users/maxeskell/dev/personal-training-app && git branch --show-current` **before every commit.**
2. Do feature work in a git **worktree** so a branch switch elsewhere can't touch your working set.

The settled root-cause writeup lives in `endurance-coach-failure-archaeology`; don't re-litigate it here.

## Provenance and maintenance

_Verified against the repo on 2026-07-04 (branch `main`)._ Re-run these to check a fact still holds:

- Test count (730 as of 2026-07-04): `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 | tail -5`
- Runner diagnostic still the canonical one: `grep -n "iTCP:3000" CLAUDE.md`
- `doctor` behaviour + lines: `sed -n '1093,1131p' src/cli.ts` and `sed -n '30,72p' src/health.ts`
- Structured-output scrubber (strips `maxItems`/`minItems`): `grep -n "maxItems" src/llm/client.ts`
- Garmin keep-higher FTP guard: `grep -n "keeping the higher\|priorBikeFtp" src/state/assemble.ts`
- Garmin lactate-speed ×10 guard: `grep -n "10× under-report\|v \*= 10" src/state/assemble.ts`
- `.FIT` parser returns null (never throws) on bad/short input: `sed -n '245,320p' src/insights/fitParser.ts`
- Correlation FDR/exploratory labelling: `grep -n "fdrPass\|exploratory\|significant" src/insights/correlations.ts`
- Monitoring `validated` bar: `grep -n "validated\|walk-forward\|permutation\|Bonferroni" src/insights/monitoring.ts`
- Autoupdate dirty-tree fence: `grep -n "local changes present\|git diff --quiet" scripts/autoupdate.sh`
- Proposal TTL (7 days): `grep -n "PROPOSAL_TTL_DAYS" src/guardrails/writeGate.ts`
- AIE write-tool set (8 tools, 3 proposable): `sed -n '41,50p' src/mcp/aieClient.ts`
- `state` renders `—` for null slots: `grep -n '"—"' src/cli.ts`
- OAuth is host-only (localhost:8765): `grep -rn "8765" src/ scripts/ HANDOVER.md`
