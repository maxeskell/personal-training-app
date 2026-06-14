# personal-training-app — Endurance Coach

A personal AI endurance coach for one triathlete/runner. It reads the plan, **race goals and season
calendar live from AI Endurance** (`getRaceGoalEvent`/`getUser`) and (optionally) device data from
**Garmin**, interprets rather than re-plots, and gives evidence-based, individualised coaching. Nothing
about the calendar is hard-coded: change your goals in AI Endurance and the coaching follows on the next
Sync — the season shape (taper windows, don't-stack-peaks, a B-race that should be a capped tempo, the
injury window when a run goal sits off a triathlon base) is **derived from whatever races are set**.

## Run your own instance

Want this set up for yourself? **Point your AI coding assistant (Claude Code or similar) at this repo
and tell it to "follow [SETUP.md](./SETUP.md)"** — a step-by-step playbook it can execute end-to-end,
stopping to ask you for your own accounts, units and training base. Doing it by hand works too: SETUP.md
and the [Prerequisites](#prerequisites) below are written for both.

## Approach

Per the [Build Spec](docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md) §1 decision gate:

- **Path A first (current step):** a Claude Project + AI Endurance MCP + coach persona — ~80% of the
  value, zero code. See **[docs/setup-path-a.md](docs/setup-path-a.md)**.
- **Path B (queued):** a small local-first orchestrator, justified because all three §1 needs apply
  (scheduling, dashboard, decision log). See **[docs/path-b-plan.md](docs/path-b-plan.md)**.

## Prerequisites

- **Node.js ≥ 20** (`node --version`).
- **An AI Endurance account** — the required data spine. The coach reads your plan, races and metrics
  from it over MCP/OAuth; without it there is no state to coach on. (See https://aiendurance.com.)
- **An Anthropic API key** (`ANTHROPIC_API_KEY`) — required for the LLM coaching flows (readiness,
  weekly, race, propose, deep-dive, ask, session). The deterministic flows (verify, doctor, state,
  check, dashboard cards, weather) make no LLM calls and need no key.
- **Optional, all degradable:** Garmin (device data — see `.env.example`), a local LLM server (cheap
  intent routing — see the `local-llm-server` repo), Open-Meteo weather (free, no key). Each is
  best-effort: if it is absent or slow the matching card/field is simply omitted, never an error.
- **Platform:** developed on macOS; the CLI and dashboard run on Linux too. Only the desktop
  notifications and the `*:install` scheduler helpers are macOS-specific — they print a cron/systemd
  equivalent and no-op elsewhere.

> The shell examples below that start a service use `/path/to/personal-training-app` — substitute the
> directory where you cloned the repo.

## Running the code

```bash
npm install
cp .env.example .env          # defaults are fine for AI Endurance

npm run auth:aie              # one-time OAuth (opens browser); caches tokens in ~/.endurance-coach
npm run verify:reads          # exercises every read tool; confirms the write-gate
npm run state:today           # assembles + persists + summarises today's AthleteState

export ANTHROPIC_API_KEY=sk-ant-...   # for the LLM coaching flows (M3+M4)
npm run readiness             # green/amber/red verdict with cited drivers + wellbeing check
npm run weekly                # weekly review (takeaway-led) → dated report in reports/
npm run race                  # race-specific prep for the next race → dated report
npm run race -- "<race name>"  # …or target a named race from your live AI Endurance goals
npm run propose -- "move my long run off race week"   # gated plan-adjustment proposals
npm run act                   # surfaced (gated, feedback-aware) findings → grounded gated proposals
npm run confirm -- <id>       # apply a proposal (the ONLY path that writes to AI Endurance)
npm run decline -- <id>       # dismiss a proposal

npm run ping                  # unattended morning readiness: verdict + report + desktop notification
npm run dashboard             # one-off glanceable HTML, opened in your browser
npm run deep-dive             # insight-engine analysis (load/EF/durability/ramp/goal) → report
npm run ask -- "how were my long rides this month?"   # free-form Q&A over your data
npm run mcp                   # expose the coach over MCP (stdio) for Claude Desktop / Claude Code — see docs/mcp-server.md
npm run mcp:http              # …or over HTTP (localhost + auth) for Claude Cowork via an HTTPS tunnel — see docs/mcp-server.md
npm run session               # deep feedback on your last session — needs its raw .FIT, --force for summary-only (or: npm run session 2026-06-09)
npm run cost                  # token-cost report by flow (today/7d/30d/all + monthly projection); npm run cost 14 for a window
npm run probe                 # Phase-2: dump live Garmin tool surface + AIE detail samples → reports/ (for mapping)
npm run fit-sync              # archive recent Garmin activity *summaries* (temp/effort) — also runs automatically on dashboard Sync
npm run backfill              # archive full history (AIE + Garmin activities/daily) → data/archive/ (resumable)
npm run backfill:status       # archived counts + date ranges (distinct records, one per date/id)
npm run backfill:compact      # de-duplicate the archive files in place (housekeeping; safe to re-run)
npm run decisions             # view the decision log (audit trail)
npm run decisions -- retro <id> "how it held up"   # add a retrospective to a decision
npm test                      # unit tests for the insight/stat modules (node:test, no extra deps)
npm run check                 # fire-only health watch: macOS alert ONLY if a flag/early-warning fires

# Schedule the 06:00 ping (macOS launchd; cron fallback on Linux):
npm run schedule:install      # optional HH MM args, e.g. -- 6 30
npm run schedule:uninstall

# Proactive daily watch (fit-sync + fire-only check; notifies only when something fires):
npm run watch:install         # optional HH MM args, e.g. -- 7 30
npm run watch:uninstall
```

The four flows (readiness / weekly / propose+confirm / race) are the product. Every write goes
through the gate: `propose` only logs proposals + trade-offs; nothing changes until you `confirm`.

**Deterministic safety guardrails (not just prompt instructions):**
- **Fuel to train.** Restriction / deficit / "race weight" / "cut" / weight-target phrasings are screened
  in code *before* the model and redirected to adequate-fuelling targets. A **rapid or unexplained weight
  drop is flagged as a health concern on its own** (never gated behind other signals, never framed as a win).
- **Trend over single point.** The green/amber/red call applies a code-level floor: a `red` is downgraded
  to `amber` unless **two** interpretable signals are out of line *or* there's a multi-day deterioration —
  so one bad night can't flip the call. The morning snapshot also carries your weight as a trend-only line.
- **Observable unattended ping.** `ping` is idempotent per day (a re-fire won't double-notify or double-spend),
  records a success heartbeat, and **notifies you if it fails** instead of failing silently; `doctor` warns
  if the scheduled ping hasn't succeeded in over a day.

Garmin is **optional** — leave `GARMIN_ENABLED=false` and the coach runs on AI Endurance alone.
To enable it, run the one-time `garmin-mcp-auth` (see `.env.example`) then set `GARMIN_ENABLED=true`.

Layout: `src/mcp/` (AIE OAuth client + Garmin stdio client), `src/state/` (AthleteState, store,
baselines, sync-gaps), `knowledge/sports-science.md` (priors for the M3 LLM layer).

## n=1 analytics layer (data-scientist brief Q1–Q7)

The insight engine answers a set of pre-registered analytical questions (Q1–Q7, summarised below) with HONEST
uncertainty — autocorrelation-aware, effect-sizes-with-CIs, and every MODEL caveat attached. Each
detector self-gates and stays silent until there's enough of your own history behind it. Surfaced in
`deep-dive`, `ask`, and the dashboard Signals panel:

- **Rigorous correlations (Q1):** lagged cross-correlation (predictor at *t−k* → outcome at *t*) with a
  Fisher-z 95% CI computed on the *effective* sample size (discounted for serial dependence). Nothing is
  called real unless its CI clears 0 — the brief's #1 guardrail against naive-Pearson nonsense.
- **Validated monitoring rule set (Q1, Deliverable #3):** candidate HRV/RHR threshold rules selected on
  the earlier ~60% of your history and scored on the **held-out** later ~40%, with a circular-shift
  **permutation null** — a rule is only reported as skilful if it beats chance out-of-sample (else it's
  labelled exploratory). Runs against the **backfilled Garmin series** with **sleep score** as an
  outcome *independent* of the HRV/RHR predictors (falling back to the AIE recovery series, relabelled as
  concordance, when that history isn't there yet).
- **Change-point detection (§5):** dates genuine regime shifts in CTL, HRV and RHR (binary segmentation,
  L2 cost) so inflections can be tied to a training/illness/kit change, not smoothed away.
- **Brick decoupling (Q4):** run efficiency off the bike vs fresh — the triathlon-specific signal.
- **Taper target (Q6):** the race-day form (TSB) band that accompanied your best past races.
- **Economy vs fitness (Q5):** run EF residualised on CTL — separates real economy gains from "just fitness".
- **Fuelling red flag (Q7):** fires when weight *and* skeletal-muscle-mass trend down together (a
  under-fuelling stop-signal). A rapid weight drop on its own is separately flagged by the wellbeing
  guardrail above, even without muscle-mass data.
- **Stream-level (.FIT) analysis (§1)** — two layers, two sources:
  - **Thermal / effort** (per-activity temperature for the heat confounder, hot/cool-third HR, training
    effect) comes from `fit-sync`, which pulls Garmin's *parsed summary* (`get_activity_fit_data`). This
    now runs **automatically as part of dashboard Sync** (small, dedup'd) — and daily if you install the
    watch. No manual step.
  - **In-session biomechanics** (aerobic decoupling, cadence/GCT/vertical-osc decay) needs **raw
    per-second `.FIT` files** in `FIT_STREAMS_DIR` (default `data/fit-streams/`); the dependency-free
    parser decodes them in-process. These now **auto-download during Sync / `fit-sync`** (and on demand
    when you ask for deep session feedback) via `download_activity_file` — added to `garmin_mcp` on
    2026-06-10 and pinned in the default `GARMIN_MCP_ARGS`. On older builds, or for activities outside
    the sync window, export the original `.FIT` from Garmin Connect (Activity → ⚙ → *Export Original*)
    into that folder. See `.env.example`.

Every finding now carries a **confidence score**; only good-signal findings are surfaced, and the most
important also feed a multiple-comparisons guard: the exploratory correlation scan is **FDR-controlled**
(Benjamini–Hochberg, q=0.1), so a relationship is "confirmed" only if its CI clears 0 *and* it survives
FDR — otherwise it's labelled exploratory.

## Top insights box — your call (agree / disagree / ignore)

The dashboard leads with a **Top insights** card: the five strongest, non-dismissed findings ranked by
signal strength, each with **👍 Agree / 👎 Disagree / ✕ Ignore**. Every reaction is logged to the decision
log. **Disagree or Ignore hides that insight for ~2 weeks** and the coach (readiness/weekly/ask) reads your
feedback so it stops re-raising calls you've rejected; **Agree** keeps it active. Feedback posts to the
server's `/insight-feedback` endpoint — credentials never leave the Mac.

## Deep session feedback

`npm run session` (or the dashboard's **Last session** card → *Deep feedback*) gives coach-quality
feedback on a single session. The card also shows what the session was **meant to be** — the matching
planned workout (title, planned vs done time), or an explicit note when nothing in the plan matched. It
joins your **AI Endurance metrics** (power/HR/ESS/durability) with the
**.FIT biomechanics** (in-session cadence/GCT/vertical-osc drift, aerobic decoupling, temperature) and the
**archive thermal summary**, then reads it against your **prior comparable sessions** and that day's **TSB**
— so a dip in deep fatigue or heat isn't mistaken for lost fitness. It also reads your **upcoming 7 days
of planned sessions** and says what (if anything) this session should change ahead — suggestions only;
plan writes stay behind the gated two-step confirm. "What happened in my last run?" in the Ask box routes
here automatically — by a zero-cost regex fast-path, optionally backstopped by a **local LLM** (an
OpenAI-compatible Ollama wrapper, see the `local-llm-server` repo) that catches paraphrases the regex
misses ("break down Tuesday's ride"). Off by default; enable with `COACH_LOCAL_INTENT=true` +
`LOCAL_LLM_URL` in `.env`. It is used only for this low-stakes routing — coaching output always stays on
Opus, and any local-server failure falls back to the regex, never blocking the Q&A.

**The deep dive only runs with the session's raw `.FIT` stream** — without it there are no biomechanics
to read, so the LLM call is skipped (zero cost). The stream now **auto-downloads**: Sync / `fit-sync`
pulls recent ones into `data/fit-streams/`, and the *Deep feedback* button fetches a missing one on
demand (~10s) before analysing. The button only disappears (replaced by unlock instructions) when no
automatic path exists — Garmin off, an old `garmin_mcp` build, or no archived activity id — in which case
export the original `.FIT` manually (Garmin Connect → ⚙ → *Export Original*). To analyse from summary
data anyway: `npm run session -- --force`. Ask-box questions fall back to general Q&A instead.

## Token cost (know — and control — what you spend)

Every LLM call's token usage + dollar cost is logged locally (`data/cost-log.jsonl` — counts and cost only,
no prompt text). `npm run cost` reports spend by flow over today / 7d / 30d / all-time with a monthly
projection, and the dashboard carries an **API cost** card. To keep it down, the cheap, frequent flows
(`ask`, `readiness`, `session`) run at `effort: "medium"` while the deep flows (`weekly`, `race`,
`deep-dive`, plan proposals) stay `"high"`. Rates are configurable in `src/config.ts` (`COACH_PRICE_*`).

## Zones, thresholds & race splits

- **Zones & thresholds** card, grouped 🏊 swim / 🚴 bike / 🏃 run for clear separation, plus your headline
  numbers — **bike FTP (W and W/kg), run threshold pace + LTHR, swim CSS**. Pulled from `getUser`; where
  only thresholds are exposed, zones are derived with standard models (Coggan power, %-LTHR, %-threshold
  pace). **Bike HR zones** use your bike LTHR when the profile exposes one, else fall back to run LTHR
  with a visible note (bike LTHR typically sits a few bpm lower — treat zone tops conservatively).
  When Garmin's **power-duration FTP *estimate*** (in the Garmin scores card) sits materially below your
  configured bike FTP, the card flags the gap rather than leaving two conflicting numbers on the page:
  the MMP curve only sees power-equipped rides and revises up only on hard, sustained power efforts, so a
  low estimate is a floor, not a downgrade — your **configured FTP** is what drives the zones.
- **Estimated race splits** for every upcoming race:
  - **Run races**: AI Endurance's predicted finish broken into a per-segment pacing plan, shaped by your
    **durability trend** — improving durability earns a gentle negative split; weak/unknown durability gets
    a conservative start that protects against the late fade.
  - **Triathlons** (sprint/Olympic/70.3/IM, detected from the goal's name/type): per-leg
    swim/T1/bike/T2/run estimates from your **current numbers** — swim from CSS, bike from FTP at the
    format's standard intensity (power → flat-course speed via a physics model), run from your standalone
    Garmin run prediction with an off-the-bike penalty (threshold-pace fallback), plus fixed transition
    estimates. A leg whose input is missing (e.g. no CSS set) is named as missing, never invented.

  (Predicted times are MODEL estimates — the plan is a target, not a guarantee.)

## Online dashboard (view it on your phone over Wi-Fi)

A small local web server serves the live dashboard. **It is bound to `localhost` by default** and every
route (incl. the AI Endurance write path) requires a per-install **pairing token** — the server exposes
writes + LLM spend, so it is not left open. To reach it from your **phone on the same Wi-Fi**, set
`COACH_LAN=1`. Credentials never leave the Mac.

```bash
npm run serve                 # localhost only; prints a /pair?token=… link at startup
COACH_LAN=1 npm run serve     # also bind the LAN for phone access
```

**Week ahead — plan vs weather:** the dashboard joins your next 7 days of planned sessions with an
Open-Meteo forecast (free, no key) at your base (`COACH_WEATHER_LAT/LON` — a neutral default you override).
Each outdoor session gets a 🟢/🟡/🔴 verdict against your rules — **rides** want dry roads and gusts
under `COACH_RIDE_MAX_GUST_KMH`, with a best daylight ride window per day and a suggested
alternative day when the planned one is a washout; **runs** are green in any weather (heat/ice
noted); **open-water swims** are green except in forecast thunderstorms, with the water checked
against your `COACH_SWIM_MIN_WATER_C` (default 13°C) floor via the manually-updated
`COACH_WATER_TEMP_C` (no public feed exists). "Roads dry from ~HH:00" comes from an hour-by-hour
drying MODEL (rain wets the surface; time, temperature, sun and wind dry it) — an estimate to plan
around, not a guarantee. Indoor sessions (gym/strength) are listed as muted weather-n/a rows so the
card always mirrors the full week. The card shows **two timestamps**: "plan as of" (the sessions are
a snapshot from the last Sync — edits/deletions in AI Endurance appear after the next Sync) and the
forecast fetch time (re-pulled on Sync, or when older than ~3h). The card is display-only: plan
writes stay behind the gated propose → confirm flow.

**Pairing (one-time per device):** open the printed `http://<host>:3000/pair?token=<token>` link — it sets
an auth cookie, then the dashboard works normally. The token lives in `~/.endurance-coach/dashboard.token`
(override with `COACH_TOKEN`). The Host header is allow-listed (defeats DNS-rebinding) and request bodies
are capped. Hit **🔄 Sync latest data** to re-pull — or don't: the page renders instantly from the
last snapshot, and when that snapshot is older than `COACH_AUTOSYNC_MIN` (default 30) minutes it
kicks a background Sync on load and reloads itself when done, so plan edits made in AI Endurance
show up without button-pressing (set `COACH_AUTOSYNC_MIN=0` to disable). Concurrent syncs from two
devices share one pull.
The dashboard has an **"Ask your data"** chat box — type a question (e.g. *"am I overtraining?"*) and the
coach answers from your assembled state + insights, with the same guardrails as every other flow.

**Start it automatically when you turn the Mac on** (recommended — launchd, no extra install):

```bash
cd /path/to/personal-training-app && npm run serve:install     # starts at login + restarts if it stops
cd /path/to/personal-training-app && npm run serve:logs        # tail /path/to/personal-training-app/reports/server.log
cd /path/to/personal-training-app && npm run serve:uninstall   # stop auto-starting
```

Manual start (foreground, for dev): `cd /path/to/personal-training-app && npm run serve`

Alternative process manager (pm2): `npm i -g pm2 && npm run pm2:start && pm2 startup && pm2 save`.

**Hands-free code updates (never run git):** install the auto-updater and merged changes pull + restart
the dashboard on their own — you just use the app.

```bash
cd /path/to/personal-training-app && npm run autoupdate:install     # pulls every 15 min + at login, then restarts
cd /path/to/personal-training-app && npm run autoupdate:install -- 3600   # …or a custom interval (seconds)
npm run update                                                              # pull + restart right now, on demand
npm run autoupdate:uninstall                                                # turn it off
```

It's safe: **fast-forward only**, and it skips the pull entirely if you have uncommitted local edits, so it
can't clobber anything. Day-to-day you never touch git — and the dashboard's **🔄 Sync** button is unrelated
(it re-pulls your *training data*, not code).

> Note: on the LAN the dashboard is gated only by the per-install pairing token (there is no separate
> per-user login) — fine on a trusted home network. Don't expose port 3000 to the public internet; for
> remote access use a private tunnel (Tailscale/cloudflared), not port-forwarding.

## Interrogate your data from Claude (MCP server)

The coach is exposed as MCP tools — the *same engine* the CLI and dashboard use (assembled
AthleteState, the n=1 insight engine, the coaching flows and the gated write path). The computation
runs on your Mac, so it also sees the Garmin/archive/insight data a remote AI Endurance connector
can't. There are **two transports**, because clients differ:

```bash
cd /Users/maxeskell/personal-training-app && npm run mcp        # stdio — Claude Desktop / Claude Code (local, no port)
cd /Users/maxeskell/personal-training-app && npm run mcp:http   # HTTP  — Claude Cowork (needs a remote URL; bind localhost + tunnel)
```

- **Claude Desktop / Code (stdio, recommended):** add it to `claude_desktop_config.json` as
  `command: npm`, `args: ["run","mcp"]`, `cwd: /Users/maxeskell/personal-training-app`. No port, no exposure.
- **Claude Cowork (HTTP + OAuth):** Cowork's sandboxed cloud VM can't reach a local process and
  authenticates connectors via **OAuth, not a static token**. Open an **authenticated HTTPS tunnel**
  (cloudflared / Tailscale Funnel) to `127.0.0.1:8787`, then run the server in OAuth mode pointed at the
  public URL — `COACH_MCP_AUTH=oauth COACH_MCP_PUBLIC_URL=https://<tunnel> COACH_MCP_READONLY=true npm run mcp:http`.
  Add `https://<tunnel>/mcp` as a custom connector (it self-registers via dynamic client registration);
  Claude opens a consent page where you paste your **coach token** once to authorize. **Never** run HTTP
  mode without auth + a tunnel you control. For a hands-off setup — auto-start at login + a stable URL so
  you never touch a terminal — use `npm run mcp:install -- <https-url>` with a Tailscale Funnel
  (`tailscale funnel --bg 8787`); see [docs/mcp-server.md](docs/mcp-server.md) → *Always-on*.

Full step-by-step for both (incl. the macOS `npm`-on-PATH gotcha and tunnel commands) is in
**[docs/mcp-server.md](docs/mcp-server.md)**.

**Tools exposed** (read-first; the write path stays gated):

| Tool | What it does | Cost |
| --- | --- | --- |
| `sync` / `get_state` | assemble (or read) today's AthleteState — plan, recovery, HRV/RHR, weight, thresholds, zones | none |
| `insights` | run the n=1 insight engine: CTL/ATL/TSB & ramp, EF, durability, correlations, change-points, taper target, validated monitoring rules | none |
| `list_reports` / `read_report` | list and read the dated markdown reports under `reports/` | none |
| `decisions` | the decision-log audit trail (`filter=pending` for proposals awaiting a call) | none |
| `cost` | local token-cost report (today / 7d / 30d / all-time + monthly projection) | none |
| `ask` | free-form Q&A over your assembled state + insights | LLM (logged) |
| `readiness` / `weekly` / `race_prep` / `deep_dive` / `session_feedback` | the coaching flows, each also writing its dated report | LLM (logged) |
| `propose_adjustment` → `confirm` / `decline` | **the only write path** — `propose_adjustment` logs proposals + trade-offs and writes nothing; `confirm <id>` is the sole tool that mutates AI Endurance; `decline <id>` dismisses | gated write |

The LLM tools need `ANTHROPIC_API_KEY` in `.env` (the deterministic tools don't) and every call is
cost-logged like any other flow. Writes stay behind the same `propose → confirm` gate as the CLI:
no tool can silently change your plan — `confirm` requires an explicit, un-consumed proposal id.
Full wiring details and a privacy note are in **[docs/mcp-server.md](docs/mcp-server.md)**.

## Health & security

```bash
npm run doctor      # creds, Garmin token age (~6mo expiry), API key, AIE tool-drift, morning-ping heartbeat
```

Secrets stay local and out of git: AI Endurance OAuth tokens live in `~/.endurance-coach` (0700),
Garmin tokens in `~/.garminconnect`, your `ANTHROPIC_API_KEY` in `.env`. `data/`, `reports/`, `*.log`,
and token dirs are gitignored; token-shaped strings are redacted from logs and notifications.

## Specs (source of truth)

- [Product one-pager](docs/PRODUCT.md) — what it is, who it's for, data/privacy posture, risk register.
- [Setup guide](SETUP.md) · [Handover](HANDOVER.md) — stand up your own instance · operate/maintain it.
- [Build Spec](docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md) — decision gate + engineering plan (authoritative).
- [Project Instructions](docs/specs/AI_Triathlon_Coach_Project_Instructions.md) — the coach persona / system prompt.
- [Integration Spec](docs/specs/Endurance_Coach_Integration_Spec.md) — data-integration detail.
- [Insight Engine Spec](docs/specs/Insight_Engine_Spec.md) — **next layer**: deeper data-mining (EF, aerobic decoupling, run-load ACWR, CTL/ATL/TSB, TID, prediction-vs-goal) — the trends/issues a pro coach pulls out.

## Principles

Consistency beats heroics · trends over single points · defer to the platform's ML · propose, don't
auto-rewrite (every write gated) · fuel to train, never restriction · make the coach *less* necessary
over time · arrive uninjured and on/above predicted time.

## License

MIT — see [LICENSE](LICENSE).
