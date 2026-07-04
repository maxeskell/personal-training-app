---
name: endurance-coach-diagnostics-and-tooling
description: Load this to MEASURE the Endurance Coach's health instead of guessing — when you need to check credentials / OAuth / API-key / Garmin-token-age / AIE-tool-drift (npm run doctor), read LLM spend (npm run cost), exercise every read tool + confirm the write-gate blocks (npm run verify:reads), probe the live Garmin/AIE field shapes (npm run probe), see archive depth and date ranges (npm run backfill:status), check the public tunnel is up (npm run health-remote), assemble/inspect today's degraded-slot state (npm run state:today), or find out which process is actually serving port 3000. Triggers: "how do I check health", "is auth expired / 401 / re-auth", "run the doctor", "how much am I spending on the LLM", "check cost", "verify the reads work", "is my data complete / why is a field —", "how deep is the archive", "is the connector down", "is config drifting", "are the skills' npm commands still valid", "which runner is live", "port 3000 who owns it". Ships read-only helper scripts (which-runner.sh, config-drift.sh, verify-runbook.sh). Don't load this for the statistical proof recipes (use endurance-coach-proof-and-analysis-toolkit) or the QA/acceptance thresholds (use endurance-coach-validation-and-qa); don't load it to fix a broken symptom (use endurance-coach-debugging-playbook) — this tells you how to READ the instruments, that skill tells you what to DO about a bad reading.
---

# Endurance Coach — diagnostics and tooling

**Use this when** you need to *measure* the system's health rather than eyeball it: check auth/creds, read
LLM cost, verify the read tools work, probe live device field shapes, inspect archive depth, confirm the
public connector is up, see why a state field renders "—", or find out which process owns port 3000.

**Don't use this when** you want to (a) *fix* a live symptom — that's `endurance-coach-debugging-playbook`,
which uses these same instruments but owns the symptom→fix triage; (b) *derive/prove* a statistical claim —
`endurance-coach-proof-and-analysis-toolkit`; (c) set *acceptance thresholds* or add a test —
`endurance-coach-validation-and-qa`; (d) operate/deploy the services — `endurance-coach-run-and-operate`.

All commands are copy-pasteable and **read-only** (they inspect; none mutate AIE, the archive, or git).
Run them from the repo root: `cd /Users/maxeskell/dev/personal-training-app`.

**Jargon, defined once (all live-sourced, never cached in the repo):**
- **AIE** — AI Endurance, the ML coaching platform this app pulls the plan/goals/metrics from over
  **MCP** (Model Context Protocol) with **OAuth** (tokens cached in `~/.endurance-coach`, outside the repo).
- **AthleteState** — the one daily object `assemble.ts` joins from AIE + optional Garmin. Every field is
  **`Provenanced`**: `{ value, source, note }`. A failed fetch degrades ONE field to `value:null` (renders
  **"—"**), never crashes. "Missing data is `—`, never a misleading zero" is a house rule.
- **launchd** — macOS's service manager; the dashboard runs as one launchd service (the canonical runner).
- **h:mm** — the house duration format (weekly totals etc.). **MODEL/estimate** — the label every estimated
  number carries.

---

## 1. The instrument panel — pick the right tool for the question

| Question you're asking | Command (from repo root) | Reads / touches | LLM? |
|---|---|---|---|
| Is everything healthy? creds, keys, token ages, AIE tool drift, ping heartbeat | `npm run doctor` | local files + one live AIE tool-list call | no |
| How much am I spending on the LLM? | `npm run cost` (or `npm run cost -- 14` for a 14-day window) | `data/cost-log.jsonl` (tokens/cost only — never prompt text) | no |
| Do the AIE read tools actually return data, and is the write-gate holding? | `npm run verify:reads` | live AIE reads + a write-tool-blocked assertion | no |
| What do the live Garmin/AIE tool responses actually look like? (field-shape capture) | `npm run probe` | live Garmin + AIE reads → `reports/probe-*.json` | no |
| How deep is my archive? counts + date ranges | `npm run backfill:status` | `data/archive/` | no |
| Is the *public* connector (tunnel) up, or does it need re-auth? | `npm run health-remote` | HTTP `GET <public>/health?deep=1` | no |
| What's in today's state — and which fields degraded to "—"? | `npm run state:today` | assembles + persists today's AthleteState | no |
| Which process is actually serving port 3000, and how? | `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/which-runner.sh` | sockets + launchctl + pm2 | no |
| Is any env var undocumented / stale vs `.env.example`? | `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/config-drift.sh` | `src/`, `scripts/`, `.env.example` | no |
| Are the skills' `npm run …` commands still valid? | `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/verify-runbook.sh` | `.claude/skills/**/SKILL.md` vs `package.json` | no |

> Every tool here is deterministic — **zero LLM calls**. Reading `npm run cost` never costs anything.

---

## 2. `npm run doctor` — the first thing to run

The hardening health check: composes file/env checks (`src/health.ts` `fileChecks()`) with a live AIE
tool-drift check and the morning-ping heartbeat (`src/cli.ts` `cmdDoctor`). No network is required for the
file checks; the AIE and ping lines degrade gracefully if offline.

**Healthy output looks like this** (captured 2026-07-04):

```
Endurance Coach — health check:

  ✓ AI Endurance auth    token present (refreshed 0d ago; auto-refreshes)
  ✓ Anthropic API key    set
  ✓ Garmin auth          token 0d old (re-auth by ~180d)
  ✓ AIE tool set         all 22 expected tools present
  ⚠ Morning ping         last success 28h ago (2026-07-03) — the scheduled ping may be silently failing

0 fail, 1 warn. Core is healthy.
```

**How to read each line:**

| Line | ✓ (ok) | ⚠ (warn) | ✗ (fail) → do this |
|---|---|---|---|
| AI Endurance auth | token cached; auto-refreshes | — | no cached token → `npm run auth:aie` (host-only OAuth; see `endurance-coach-build-and-env`) |
| Anthropic API key | `ANTHROPIC_API_KEY` set | — | not set → add to `.env`; LLM flows are disabled without it |
| Garmin | `info` when disabled (that's fine — it's optional) | token > 150d old (lifetime ~6mo) → re-run `garmin-mcp-auth` soon | enabled but no token → run `garmin-mcp-auth` |
| AIE tool set | all **22** expected tools present (14 read + 8 write) | `expected-but-absent: …` = AIE dropped/renamed a tool → API drift, investigate | — |
| AIE connection | — | `could not reach AI Endurance: …` (offline / re-auth) | — |
| Morning ping | last success ≤ 25h ago | > 25h → the 06:00 launchd `ping` may be **silently failing** (see `endurance-coach-run-and-operate`) | never recorded → run `npm run ping` once |

**Thresholds (verify in `src/health.ts` / `src/cli.ts`):** Garmin re-auth warns at **150 days**
(`GARMIN_REAUTH_WARN_DAYS`); the ping warns past **25h**. The "22 expected tools" is
`AIE_READ_TOOLS` (14) + `AIE_WRITE_TOOLS` (8) from `src/mcp/aieClient.ts` — a MODEL of the expected surface;
if AIE adds a tool you'll see an `info: new/unknown tools: …` line, which is benign.

The footer counts fails and warns. **Any `fail` blocks the daily ping from running** — resolve it first.

---

## 3. `npm run cost` — LLM spend, honestly

Reads `data/cost-log.jsonl` (written by `src/llm/costLog.ts`). The log records timestamp / operation /
model / four token buckets / `costUsd` — **never prompt text or responses**. Local (Ollama) calls log at
$0 but still record tokens, marked `· local (no API cost)`.

**Output** (per-window totals + per-operation breakdown; captured 2026-07-04):

```
    session      $  2.6775  48× · in 61770/out 61220/cacheR 102750
    readiness    $  0.9210  17× · in 12189/out 12036/cacheR 0
    …
  all-time: $6.8625 over 99 call(s)
  ≈ $5.09/month at the last-7-day rate.
```

- Default windows: **today / last 7d / last 30d / all-time**. Pass a number for a custom window:
  `npm run cost -- 14`.
- `in/out/cacheR` = input / output / cache-read tokens. A rising `cacheR` share is good (cheaper); note the
  system-prompt cache is currently a **no-op** below Opus 4.8's 4096-token cache minimum (an architecture
  fact, see `endurance-coach-architecture-contract`), so today most calls show `cacheR 0`.
- The headline model is the primary **Anthropic** model (`claude-opus-4-8`), not whatever ran last (a sync
  ends on a local embed call).
- **"No LLM calls logged yet"** just means no coach flow has run — not an error.
- Prices come from `COACH_PRICE_*` env vars (defaults: input $5 / output $25 per MTok). If a monthly
  estimate looks wildly off, check those flags (catalog in `endurance-coach-config-and-flags`).

---

## 4. `npm run verify:reads` — do the reads work, and is the write-gate holding?

`src/cli.ts` `cmdVerify`. Exercises every AIE **read** tool live, then asserts a **write** tool is blocked
from the read path — a live confirmation of the propose→confirm write gate (contract in
`endurance-coach-architecture-contract`).

Read this output as:
- `✓ <tool>` — returned data. `✗ <tool> — <error>` — that tool failed (often re-auth or AIE drift).
- `• <tool> — needs activityId, skipped` — the `*ActivityDetail` tools need an id; not a failure.
- `✓ write tools are blocked from the read path (gate enforced in M3).` — **the gate is holding.** If you
  ever see `⚠ write tool was NOT blocked — gate missing!`, that is a **serious regression** — a write path
  is reachable without `WriteGate.confirm()`. Stop and escalate.
- Garmin line: `disabled` (fine) / `connected` / `enabled but unavailable — degrading cleanly`.

Requires a live AIE connection. If offline you'll get a re-auth error — run `npm run auth:aie` (host-only).

---

## 5. `npm run probe` — capture the live device field shapes

`src/cli/dataCommands.ts` `cmdProbe`. For when you're writing/fixing a mapper and need to see the *actual*
JSON AIE/Garmin returns. It lists the Garmin tool surface, samples each **read-only** tool
(`get_*`/`count_*` only — mutating tools are never called) with candidate arg shapes, and captures one AIE
`getRunningActivity` + `getRunningActivityDetail` + `getUser` to inspect join keys and FTP/zone fields.

- Writes a timestamped `reports/probe-<stamp>.json` (gitignored — it's raw health data). Console prints
  `captured` / `no data` per tool and a summary line.
- Garmin section is skipped entirely if `GARMIN_ENABLED=false` — that's expected on the default setup.
- Read the file, redact anything sensitive, before sharing it to build a mapper against real shapes.

---

## 6. `npm run backfill:status` — archive depth

`src/cli/dataCommands.ts` (`archive-status` → `printArchiveStatus`). Shows distinct-record counts and date
ranges for the long-history archive under `data/archive/`:

```
Archive (/Users/maxeskell/dev/personal-training-app/data/archive/):
  AIE activities:    532 (2024-01-01 → 2026-06-07)
  Garmin activities: 1973 (2015-07-11 → 2026-07-03)
  Garmin daily:      4012 days (2015-07-11 → 2026-07-04)
```

Use it to answer "do I have enough history for a walk-forward validation?" (the n=1 campaign needs
**≥50 usable days**; see `endurance-coach-n1-validation-campaign`). Counts are **distinct** (loaders dedup
on read), so a raw line count that's higher just means the file wants a `npm run backfill:compact`
housekeeping pass — that's cosmetic, not data loss.

---

## 7. `npm run health-remote` — is the public connector up?

`src/cli.ts` `cmdHealthRemote` → `src/health.ts` `checkRemoteHealth`. Hits `GET <public>/health?deep=1`
through the tunnel and prints a one-line verdict. Needs `COACH_MCP_PUBLIC_URL` set (else it exits 1 with a
message). Exits non-zero on trouble so a scheduled run surfaces in the launchd log.

| Verdict | Meaning | Action |
|---|---|---|
| `✓ remote health (…): ok (aie=ok)` | tunnel + server + AIE all up | — |
| `✗ … AI Endurance re-auth needed` | server up, AIE token expired | `npm run auth:aie` on the host |
| `✗ … unreachable (no response / timeout)` | the tunnel or the server is down | check the tunnel + the `com.endurance-coach.mcp` service |
| `✗ HTTP <code> from /health` | server reachable but unhealthy | inspect server logs |

This is the *remote* check. For the *local* runner, use `which-runner.sh` (§10).

---

## 8. `npm run state:today` — what's in today's state, and what degraded

`src/cli.ts` `cmdState`. Assembles + persists today's AthleteState and prints each field as `set` or
**"—"** with its `[source: note]`. This is the definitive answer to **"why is a field empty on the
dashboard?"** — a `—` here means `assemble.ts` degraded that Provenanced slot (a fetch failed or a shape
drifted), not that the number is zero.

Read the three sections:
1. **The field list** — `set`/`—` + provenance per slot (planned sessions, recovery, HRV, weight, sleep,
   thresholds, zones, nutrition, …).
2. **`sync gaps: N`** — enumerated gaps `assemble.ts` detected.
3. **Data-completeness lines** — e.g. a recent session missing its raw `.FIT` (so splits/biomechanics are
   unreachable) is surfaced here, never as a silent zero. `npm run state:today` does **not** fetch streams;
   run `npm run fit-sync` (or the dashboard Sync) to pull missing `.FIT` streams.

Saves to `data/state/<date>.json`. Interpreting the *numbers* (what a normal HRV/TSB is) →
`endurance-domain-reference`; *fixing* a persistent `—` → `endurance-coach-debugging-playbook`.

---

## 9. Config-drift greps (and the false-positive that must be corrected)

`.env.example` is the catalog of every knob; the definition of done says a new flag lands in `config.ts`
(the only parser) **and** `.env.example` in the **same commit**. To audit that both directions hold, use
the shipped `config-drift.sh` (§10) — or these one-liners. **Scan `scripts/` too, not just `src/*.ts`:**

```bash
cd /Users/maxeskell/dev/personal-training-app
# vars READ in code (src + scripts) but ABSENT from .env.example — undocumented flags:
comm -23 \
  <(cat <(grep -rhoE "process\.env\.[A-Z0-9_]+" src | sed 's/process\.env\.//') \
        <(grep -rhoE "\$\{?(COACH|AIE|GARMIN|ANTHROPIC|LOCAL)_[A-Z0-9_]+" scripts | tr -d '${') \
     | sort -u) \
  <(sed -nE 's/^[[:space:]]*#?[[:space:]]*([A-Z][A-Z0-9_]+)=.*/\1/p' .env.example | sort -u)
```

> **Do not repeat the `COACH_DEPLOY_BRANCH` false positive.** A prior scan flagged it "dead" — WRONG. It
> is read by `scripts/ship.sh:17` (`DEPLOY_BRANCH="${COACH_DEPLOY_BRANCH:-main}"`). The scan only grepped
> `src/*.ts`. Any config-drift check MUST include `scripts/`, which `config-drift.sh` does.

As of 2026-07-04 the repo has **zero** drift in both directions (verified). The full env catalog and the
"how to add a flag" checklist live in `endurance-coach-config-and-flags` — this skill only tells you how to
*detect* drift.

---

## 10. The shipped helper scripts

Three POSIX-bash, read-only scripts under
`.claude/skills/endurance-coach-diagnostics-and-tooling/scripts/`. Each has a header comment explaining use
and an exit code you can gate on.

| Script | What it answers | Exit 0 / non-0 |
|---|---|---|
| `which-runner.sh` | What is serving port 3000, and is it the canonical launchd service? Wraps the `lsof … ; launchctl list ; pm2` diagnostic + a plain verdict. | 0 = port served; 1 = nothing listening |
| `config-drift.sh` | Env vars read in code (src **and** scripts) but missing from `.env.example`, and vice-versa. | 0 = no drift; 1 = drift found |
| `verify-runbook.sh` | Every `npm run <x>` referenced in any `SKILL.md` still exists in `package.json` (a wrong runbook is worse than none). | 0 = all valid; 1 = a referenced script is missing |

Run them:

```bash
cd /Users/maxeskell/dev/personal-training-app
bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/which-runner.sh
bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/config-drift.sh
bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/verify-runbook.sh
```

**Interpreting `which-runner.sh`** — the healthy canonical case (verified 2026-07-04):
- `lsof` shows a `node` process `LISTEN`ing on `*:3000`.
- `launchctl list | grep -i endurance` shows `com.endurance-coach.dashboard` with a **numeric PID** in
  column 1 (= running). A `-` PID means loaded-but-not-running.
- Verdict: `✓ launchd service … is running and owns the port — the canonical setup.`
- If instead you see the port served but launchd's dashboard line has a `-` PID, something else (a
  dev-only `npm start`/`npm run serve`, or pm2) owns it — reconcile to **one** runner (full rules in
  `endurance-coach-run-and-operate`).

**`verify-runbook.sh`** filters teaching-placeholders (`x`, `x:y`, `<name>`) and shell redirects
(`npm run 2>/dev/null`). Any remaining `✗` is real drift — either fix the skill text or restore the script.

**`config-drift.sh`** prints both drift directions with `✓ none` when clean. A rare false positive can
occur if a var is read only via a computed key — eyeball before editing.

---

## 11. When the reading is bad — where to go next

These tools tell you *what* is wrong; other skills own *what to do*:

- Bad `doctor` line, a `—` that shouldn't be there, port fight, OAuth 401, "correlation looks too good" →
  **`endurance-coach-debugging-playbook`** (symptom→triage→fix).
- "Has this failure been seen/settled before?" (e.g. the autoupdate HEAD-hijack, intervals.icu removal) →
  **`endurance-coach-failure-archaeology`**.
- Operating/deploying/serving (ship, launchd service table, autoupdate hazard) →
  **`endurance-coach-run-and-operate`**.
- Env catalog + safe defaults for security flags → **`endurance-coach-config-and-flags`**.
- Interpreting the *numbers* (HRV/TSB/EF/decoupling meaning + ranges) → **`endurance-domain-reference`**.
- Proving a statistical finding is real → **`endurance-coach-proof-and-analysis-toolkit`** /
  **`endurance-coach-n1-validation-campaign`**.

Nothing in this skill routes around the propose→confirm write gate, the wellbeing gate, or the
green-before-commit gate — it only *observes*.

---

## Provenance and maintenance

Date-stamped **2026-07-04**. Facts here drift; re-verify with these exact commands from
`cd /Users/maxeskell/dev/personal-training-app`:

- **npm scripts exist & map as documented** (doctor/cost/verify:reads/probe/backfill:status/health-remote/
  state:today): `node -e 'const s=require("./package.json").scripts;for(const k of ["doctor","cost","verify:reads","probe","backfill:status","health-remote","state:today"])console.log(k,"->",s[k])'`
- **The three shipped scripts still run clean:**
  `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/config-drift.sh` (expect `✓ No config drift.`);
  `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/which-runner.sh` (expect a verdict);
  `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/verify-runbook.sh` (expect `✓ … in sync`).
- **AIE expected-tool count = 22** (14 read + 8 write): `sed -n '/AIE_READ_TOOLS = \[/,/\] as const/p' src/mcp/aieClient.ts | grep -cE '^\s*"'` (→ 14) and `sed -n '/AIE_WRITE_TOOLS = \[/,/\] as const/p' src/mcp/aieClient.ts | grep -cE '^\s*"'` (→ 8) — or just re-run `npm run doctor` and read the "AIE tool set" line.
- **doctor thresholds** (Garmin warn 150d, ping warn 25h): `grep -n "GARMIN_REAUTH_WARN_DAYS\|ageH > 25" src/health.ts src/cli.ts`.
- **`COACH_DEPLOY_BRANCH` is read by ship.sh (NOT dead):** `grep -n COACH_DEPLOY_BRANCH scripts/ship.sh`.
- **LLM price defaults** (input $5 / output $25 per MTok): `grep -n "COACH_PRICE_INPUT\|COACH_PRICE_OUTPUT" src/config.ts`.
- **Test suite green** (context for cost/verify claims — 730 tests / ~6s as of 2026-07-04):
  `npm test 2>&1 | tail -5`.
- **Resolved drift (2026-07-04): the phantom `archive:compact` / `archive-compact` npm script.** No such
  npm script exists — the real one is `npm run backfill:compact` (it runs `tsx src/cli.ts archive-compact`;
  the hyphen form is the CLI subcommand, not an npm script). There were **three** offenders, now all
  corrected to `backfill:compact`: `endurance-coach-failure-archaeology/SKILL.md:198`,
  `endurance-coach-n1-validation-campaign/SKILL.md:111`, and `endurance-coach-run-and-operate/SKILL.md:210`.
  **Note the audit gap this exposed:** `verify-runbook.sh` only greps `npm run <x>`, so the run-and-operate
  one (a bare-word ``archive:compact`` in its command catalog, no `npm run` prefix) was invisible to it — it
  had to be found by hand. `verify-runbook.sh` now exits 0, but a bare-word wrong command can still slip
  past it; grep skills for the raw script name too. Re-check:
  `bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/verify-runbook.sh`.
