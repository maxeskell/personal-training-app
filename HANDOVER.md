# Handover — Endurance Coach (personal-training-app)

A practical guide to picking this project up cold: what it is, how it is built, how to run and operate
it, and where the bodies are buried. For the *why it exists* read
[`docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md`](./docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md);
for day-to-day usage read [`README.md`](./README.md); for the design rationale of the insight
layer read [`docs/specs/Insight_Engine_Spec.md`](./docs/specs/Insight_Engine_Spec.md).

---

## 1. What this is, in one paragraph

A **local-first AI endurance coach** for a single triathlete/runner. It pulls the athlete's plan, race
goals, season calendar and training metrics **live from [AI Endurance](https://aiendurance.com)** (over
MCP/OAuth) and, optionally, device data from **Garmin**, assembles them into one daily `AthleteState`,
and then *interprets* rather than re-plots: readiness verdicts, weekly reviews, race prep, gated
plan-adjustment proposals, deep single-session feedback, and an n=1 statistical insight engine. It runs
as a **CLI** plus a small **local web dashboard** you can open on your phone over Wi-Fi. The LLM
coaching layer is Anthropic Opus; everything deterministic (state assembly, insights, weather,
dashboard cards) makes **no** LLM calls. Nothing about the athlete's calendar is hard-coded — change
the goals in AI Endurance and the coaching follows on the next sync.

It is **single-user** and **local-first**: no multi-tenant backend, no database (flat JSON/JSONL under
`data/`), no accounts of its own. Secrets live outside the repo.

---

## 2. Get it running (zero to a verdict)

```bash
# 1. Build
npm install
cp .env.example .env            # defaults are correct for the public AI Endurance server
npm run typecheck && npm test   # 99 tests, all green, no network needed

# 2. Connect the required spine (one-time OAuth; opens a browser)
npm run auth:aie                # caches tokens in ~/.endurance-coach (0700)
npm run verify:reads            # exercises every read tool + confirms the write-gate
npm run state:today             # assembles + persists + summarises today's AthleteState

# 3. Coaching flows (need an Anthropic key)
export ANTHROPIC_API_KEY=sk-ant-...
npm run readiness               # green/amber/red verdict with cited drivers
npm run dashboard               # one-off glanceable HTML, opened in the browser

# 4. (Optional) the always-on dashboard
npm run serve                   # localhost only; prints a /pair?token=… link to open once
```

**Setting it up for a *different* athlete:** there is almost nothing to change in code. Name, age, sex,
thresholds, races and the season shape all come live from that athlete's AI Endurance account via
`npm run auth:aie`. The only athlete-specific config is in `.env`: `COACH_EQUIPMENT`, `COACH_UNITS`,
and the weather base (`COACH_WEATHER_LAT/LON`, `COACH_SWIM_MIN_WATER_C`, `COACH_WATER_TEMP_C`). Garmin
is off until you run its one-time auth and set `GARMIN_ENABLED=true` (see `.env.example`).

---

## 3. Code map

```
src/
├── cli.ts          Entry point: routes ~30 commands (readiness, weekly, race, propose/confirm,
│                   dashboard, deep-dive, ask, session, cost, backfill, fit-sync, doctor, …)
├── server.ts       Local dashboard HTTP server (GET / · /refresh · POST /ask · /confirm-proposal ·
│                   /insight-feedback · /pair). Binds 127.0.0.1 by default; COACH_LAN=1 opts into LAN.
├── serverAuth.ts   Pairing-token auth, timing-safe compare, Host-header allowlist (anti-DNS-rebind)
├── config.ts       Central config — all env-driven, secrets default to ~/.endurance-coach
├── health.ts       `doctor` checks: creds, Garmin token age, API key, AIE tool-drift; log redaction
├── notify.ts       Desktop notifications via macOS `osascript` (no-op off-Darwin)
├── mcp/            AI Endurance OAuth+HTTP client (aieClient) · Garmin stdio client (garminClient)
├── state/          AthleteState type + assemble.ts (the join) · store.ts (atomic daily persistence) ·
│                   baselines (CTL/ATL/TSB) · sync-gap detection · decision log (audit trail)
├── archive/        Long-history JSONL archive: backfill.ts (resumable) · store.ts (dedup-on-read +
│                   atomic compact) · fitSync.ts (.FIT summaries + raw stream auto-download)
├── insights/       ~30 deterministic detectors: correlations (lagged, FDR-controlled), change-point,
│                   brick decoupling, taper band, efficiency, fuelling, HRV/RHR monitoring, race splits
├── coach/          LLM narratives: readiness · weekly · race · ask · session feedback · plan proposals
│                   · dashboard.ts (HTML render; all text escaped)
├── llm/            Anthropic SDK wrapper (prompt-cached system prompt) · cost logging · local-LLM
│                   intent-routing fallback
├── guardrails/     WriteGate (propose→confirm two-step) · write validators · wellbeing screen
└── weather/        Open-Meteo fetch/cache · road-dryness model · week-ahead plan-vs-weather assessment
```

**Primary data flow.** `state/assemble.ts` is the heart: it calls AI Endurance (required) and Garmin
(optional, time-budgeted) read tools, normalises each field into a `Provenanced<T>` (value + source +
note) so external shape drift degrades to `null` instead of crashing, and produces one `AthleteState`.
`state/store.ts` persists it atomically as `data/state/YYYY-MM-DD.json` (temp file + `rename`). The
insight engine and the coach flows read that state; the dashboard renders it; `archive/` holds the
decade-deep history the trend detectors need. **Every mutation back to AI Endurance goes through
`guardrails/WriteGate`** — `propose` only logs a proposal + trade-offs; nothing changes until
`confirm`.

---

## 4. External dependencies & required accounts

| Service | Required? | Configured by | If absent |
|---|---|---|---|
| **AI Endurance** (MCP/OAuth) | **Yes — the spine** | `AIE_MCP_URL` (default `https://aiendurance.com/mcp`); `npm run auth:aie` caches tokens in `~/.endurance-coach` | No state can be assembled; the app has nothing to coach on |
| **Anthropic API** | **Yes for LLM flows** | `ANTHROPIC_API_KEY` (env/`.env`) | LLM flows (readiness/weekly/race/propose/deep-dive/ask/session) error cleanly; deterministic flows (verify/doctor/state/check/dashboard cards/weather) still work |
| **Garmin** (unofficial MCP) | Optional, degradable | `GARMIN_ENABLED=true` + one-time `garmin-mcp-auth`; tokens in `~/.garminconnect` (~6-month life) | All Garmin fields null; coach runs on AI Endurance alone; HRV/RHR/thermal insights go quiet |
| **`ask` intent routing** | Optional | `COACH_INTENT_ROUTER=regex` (default) `\| haiku \| local` | A model miss/error falls back to the zero-cost regex; never blocks Q&A |
| **local-llm-server** (Ollama wrapper) | Optional, degradable | `COACH_INTENT_ROUTER=local` (or legacy `COACH_LOCAL_INTENT=true`) + `LOCAL_LLM_URL` | `ask` intent routing falls back to a zero-cost regex; never blocks Q&A |
| **Open-Meteo** (weather) | Optional, degradable | `COACH_WEATHER_*` (free, no key) | The "Week ahead — plan vs weather" dashboard card is simply omitted |

Intent routing (`src/coach/intent.ts`) has three strategies via `COACH_INTENT_ROUTER`: **`regex`** (default,
zero-cost), **`haiku`** (a cheap `claude-haiku-4-5` micro-call on the existing `ANTHROPIC_API_KEY` —
`src/llm/haikuRouter.ts`, cost-logged from the Haiku price table, no extra server — the recommended
upgrade), and **`local`** (the separate **local-llm-server**, a small OpenAI-compatible FastAPI/Ollama
wrapper in `maxeskell/local-llm-server`). All degrade to the regex on error; coaching output always stays
on Opus. The local server is not required and has its own `HANDOVER.md`.

---

## 5. Key design decisions and why

- **One athlete, local-first, no database.** Flat JSON/JSONL under `data/` (gitignored). Simple to
  reason about, back up, and inspect; no infra to operate. The tradeoff is no concurrency story beyond
  atomic file writes (see §9).
- **Every write is gated (propose → confirm).** The coach can *suggest* plan changes but the only code
  path that mutates AI Endurance is `WriteGate.confirm()` on a previously-logged, validated proposal.
  This is the core safety invariant — keep it.
- **Degrade, don't crash.** Garmin, weather and the local LLM are all best-effort with hard timeouts
  and an overall Garmin wall-clock budget; a slow/missing dependency yields a missing card with a note,
  never an error page or a hung `/refresh`.
- **Cost-aware LLM use.** Deterministic flows make zero LLM calls. Cheap/frequent flows run at
  `effort: "medium"`, deep flows at `"high"`, the system prompt is prompt-cached, and every call's
  token usage + dollar cost is logged locally (`npm run cost`).
- **Honest models.** Estimated outputs (zones, race splits, road dryness, predictions) are explicitly
  labelled MODEL/estimate in the UI and docs, with assumptions stated. The insight engine reports
  effect sizes with CIs and FDR control rather than naive correlations.
- **Provenance everywhere.** Each assembled field knows its source and a caveat, so the coach can cite
  drivers and so schema drift degrades gracefully.
- **Dashboard output is escaped.** All interpolated text goes through `escapeHtml`; handlers bind via
  `data-*` attributes. Tests assert the inline script still parses.

---

## 6. Quality gates (keep these green)

- `npm run typecheck` → `tsc --noEmit`, clean.
- `npm test` → `node:test` suite (currently **99 tests**, pure, no network). New logic adds tests.
- `npm run build` → `tsc` compiles.
- **CI** (`.github/workflows/ci.yml`) runs typecheck + test + build on every PR and push to `main`.
- **Honest coverage note:** the deterministic detectors (insights, weather, season context, cost,
  store, archive, server auth) are well-tested. **Thinner coverage** sits on the hand-rolled binary
  `.FIT` parser, the live `server.ts` routes, the full `WriteGate` propose→confirm→replay path, and
  some statistical edge cases. Treat this "test inversion" as the standing priority — thicken coverage
  there before adding surface area.

---

## 7. Config knobs

All in `.env` (see `.env.example` for the full, commented set). The ones you will actually touch:

| Env var | Default | Effect |
|---|---|---|
| `AIE_MCP_URL` | `https://aiendurance.com/mcp` | The AI Endurance MCP endpoint (rarely changed) |
| `ANTHROPIC_API_KEY` | _(unset)_ | Required for LLM flows |
| `GARMIN_ENABLED` | `false` | Turn on the optional Garmin gap-filler |
| `GARMIN_MCP_ARGS` | pinned `garmin_mcp` commit | Keep the pin ≥ `d31de79` or raw `.FIT` auto-download degrades to manual export |
| `COACH_INTENT_ROUTER` | `regex` | `ask` intent routing: `regex` (default) · `haiku` (cheap API micro-call) · `local` (local-llm-server) |
| `COACH_LOCAL_INTENT` | `false` | Legacy alias selecting the `local` router (equivalent to `COACH_INTENT_ROUTER=local`) |
| `COACH_WEATHER_LAT` / `LON` | `51.5074` / `-0.1278` | Weather base (neutral default — set your own) |
| `COACH_WATER_TEMP_C` | _(unset)_ | Optional SEED for the open-water temp; live readings are confirmed in the dashboard's water-temp box (data/venue.json) and a stale one is forecast (air-temp drift MODEL) to confirm — any reading wins over this |
| `COACH_HOST` / `COACH_PORT` | `127.0.0.1` / `3000` | Dashboard bind address/port |
| `COACH_LAN` | _(unset)_ | `=1` binds `0.0.0.0` for phone access on the LAN (token still required) |
| `COACH_AUTOSYNC_MIN` | `30` | Stale-snapshot auto-sync threshold; `0` disables |
| `COACH_EQUIPMENT` / `COACH_UNITS` | this athlete's kit / `metric, UK` | The only athlete identity AI Endurance doesn't expose |
| `COACH_SECRETS_DIR` / `COACH_DATA_DIR` | `~/.endurance-coach` / `./data` | Where tokens / daily state live |
| `COACH_PRICE_*` | published Opus rates | Cost-log pricing only (never sent anywhere) |

---

## 8. Operations / runbook

**Where things live (none of it in git):**
- AI Endurance OAuth tokens → `~/.endurance-coach/` (0700); dashboard pairing token →
  `~/.endurance-coach/dashboard.token` (0600).
- Garmin tokens → `~/.garminconnect/` (~6-month lifetime).
- Daily state → `data/state/`; long history → `data/archive/*.jsonl`; cost log →
  `data/cost-log.jsonl`; decision/audit log under `data/`; reports + server log → `reports/`.

**Run the dashboard as a service (macOS launchd):**
```bash
cd /path/to/personal-training-app && npm run serve:install    # start at login + restart if it stops
cd /path/to/personal-training-app && npm run serve:logs       # tail reports/server.log
cd /path/to/personal-training-app && npm run serve:uninstall  # stop auto-starting
```
On Linux the installer prints the equivalent `systemd --user` / cron line and no-ops. `pm2` is an
alternative (`npm run pm2:start`).

**Keep the code current (never run git by hand):**
```bash
cd /path/to/personal-training-app && npm run autoupdate:install   # fast-forward pull every 15 min + at login, then restart
cd /path/to/personal-training-app && npm run update               # pull + restart right now
```
The auto-updater is **fast-forward only** and **skips the pull entirely if there are uncommitted local
edits**, so it cannot clobber work in progress.

**Health & routine maintenance:**
- `npm run doctor` — checks creds, **Garmin token age** (re-auth before the ~6-month expiry), API key,
  and AI Endurance tool drift. Run it when something stops returning data.
- `npm run cost` — spend by flow (today/7d/30d/all + monthly projection).
- `npm run backfill` / `backfill:status` / `backfill:compact` — grow and housekeep the history archive.
- **Backups:** the only irreplaceable local state is `data/` (and the token dirs, which can be
  regenerated by re-auth). Back up `data/` if the history matters.

**Scheduled automation (all optional, macOS launchd with printed cron fallback):**
`npm run schedule:install` (06:00 readiness ping), `npm run watch:install` (daily fit-sync +
fire-only health check), `npm run backfill:install` (history grind).

---

## 9. Known issues, gotchas & roadmap

- **Setup must run on the host machine.** `npm run auth:aie` opens a browser and waits for the AI
  Endurance OAuth redirect on `http://localhost:8765`, and the dashboard binds `localhost` — so a
  remote / headless / cloud agent cannot complete onboarding. Drive setup with a local assistant (or by
  hand) on the machine that will host the coach; see [SETUP.md](./SETUP.md).
- **Garmin is an unofficial client.** It scrapes Garmin Connect via a pinned community MCP, is
  rate-limited and occasionally fragile, and its tokens expire ~6-monthly. It is optional by design —
  treat any Garmin breakage as "degrade to AI Endurance," not an outage.
- **Concurrent writes.** State writes are atomic (temp + `rename`) AND serialized by a cross-process
  lock (`proper-lockfile` on the state dir), so the dashboard autosync and a cron `update` can't
  interleave to last-writer-wins; `load()` also shape-guards each slot, dropping a corrupt/hand-edited
  one back to `absent()`. The decision log holds its own lock for the confirm critical section.
- **Demo / no-account mode shipped.** `npm run demo` renders the dashboard on bundled sample data with
  no account or API key, so a stranger can evaluate the app. The live flows still need real accounts.
- **`npm audit`** flags a high-severity advisory in **esbuild** — a *dev-only* transitive dependency
  (via `tsx`), and the advisories are Deno/Windows-dev-server specific, so runtime risk here is
  negligible. `npm audit fix` clears it; keep it clear.
- **Deeper technical debt** remains: test inversion on the parser/server/write-gate, a few statistical
  edge cases, duplicated small utilities, and the perf of re-parsing the archive per request. The
  earlier security/integrity initiatives (server auth + localhost default, write-path arg validation,
  dashboard escaping, FDR multiplicity, atomic writes, grounded proposals) have already landed on `main`.

---

## 10. Git / workflow

- New work goes on a branch (`git checkout -b <name>`), small imperative commits, a PR, CI green, then
  merge. `main` is the deployable line the auto-updater pulls.
- Enable **Settings → "Automatically delete head branches"** so merged branches don't accumulate.
- Repo: `github.com/maxeskell/personal-training-app`. License: MIT (see `LICENSE`).
- The companion `maxeskell/local-llm-server` is an optional dependency with its own handover doc.

## Project background — Path A → Path B (moved from the README)

Per the [Build Spec](docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md) §1 decision gate:

- **Path A:** a Claude Project + AI Endurance MCP + coach persona — ~80% of the value, zero code.
- **Path B (this repo):** a small local-first orchestrator, justified because all three §1 needs apply
  (scheduling, dashboard, decision log).

This history lived at the top of the README; it was moved here in the Phase 1 onboarding-simplification
pass so the README leads with what the tool *does* for a newcomer, not how it came to be.
