# SETUP.md — stand up your own instance

This guide is written so that **an AI coding assistant (Claude Code or similar) can follow it
end-to-end** to set the Endurance Coach up for *you*. Point your assistant at this repository and say:

> "Follow SETUP.md to set this up for me."

A human can follow it too. Steps marked **🧑 ASK** require a decision or secret only you can provide —
the assistant must stop and ask, never guess. Steps marked **▶ RUN** are commands. Steps marked
**✅ CHECK** are gates: do not continue until they pass.

> **Assistant: read this first.** This repo ships a `CLAUDE.md` describing the *original author's*
> machine path, training location and personal preferences (e.g. a specific swim venue and water-temp
> floor). **Those are NOT this user's values — do not reuse them.** Gather this user's own values in
> Step 3 and write them to `.env`. Never commit secrets or `.env`.

---

## What you'll end up with

A working local AI endurance coach: a CLI plus a local web dashboard you can open on your phone, fed
**live** from your own AI Endurance account (and optionally your Garmin). Setup is ~15 minutes, most of
it the two one-time browser logins.

## Step 0 — Prerequisites (🧑 confirm you have these)

| Need | Required? | How to check / get it |
|---|---|---|
| **Node.js ≥ 20** | Yes | `node --version`. Install from https://nodejs.org if missing. |
| **An AI Endurance account** | **Yes — the data spine** | https://aiendurance.com — you log in via browser in Step 4. Without it there is nothing to coach on. |
| **An Anthropic API key** | **Yes — for coaching** | https://console.anthropic.com → API keys. Needed for readiness/weekly/race/ask/etc. |
| **`uv`/`uvx` + Python 3.12** | Only if you enable Garmin | https://docs.astral.sh/uv/ . Skip if you won't use Garmin. |
| **macOS** | Only for extras | The CLI + dashboard run on Linux too; only desktop notifications and the auto-start installers are macOS-specific (they print a Linux equivalent and no-op elsewhere). |

## Step 1 — Get the code building

```bash
▶ RUN
git clone https://github.com/maxeskell/personal-training-app.git
cd personal-training-app
npm install
cp .env.example .env
```

```bash
▶ RUN   # sanity gate — needs no accounts, no network
npm run typecheck && npm test
```
**✅ CHECK:** typecheck is clean and all tests pass. If not, stop and report the failure — do not proceed.

## Step 2 — (Assistant) note the config surface

Everything personal is configured in `.env`; `.env.example` documents every knob with a comment. The
only things you'll set are: the Anthropic key, this user's units/equipment, their weather/training
base, and (optionally) Garmin and the local LLM. **Name, age, thresholds, races and the whole season
calendar come live from AI Endurance — never hard-code them.**

## Step 3 — Gather this user's settings and write `.env` (🧑 ASK each one)

Ask the user, then write the answers into `.env` (uncomment the relevant lines from `.env.example`):

1. **Anthropic API key** → `ANTHROPIC_API_KEY=sk-ant-...` (you can also export it in the shell instead
   of writing it to `.env`; never echo it back or commit it).
2. **Units / locale** → `COACH_UNITS` (e.g. `metric, UK` or `imperial, US`).
3. **Equipment** (optional, cosmetic) → `COACH_EQUIPMENT` (e.g. their watch/bike computer/scale), or
   clear it to drop the line.
4. **Training base for weather** → `COACH_WEATHER_LAT` / `COACH_WEATHER_LON` (where they ride/run/swim
   from). Default is the author's base in the UK — **change it.** Set `COACH_WEATHER_ENABLED=false` to
   skip the weather card entirely.
5. **Open-water swimming?** If yes: `COACH_SWIM_MIN_WATER_C` (their cold-water comfort floor) and
   `COACH_WATER_TEMP_C` (the latest posted venue temp — there is no public feed, so it's updated by
   hand). If they don't open-water swim, leave these unset.
6. **Garmin?** (optional, degradable) — ask if they want device data (HRV, training status, raw `.FIT`
   biomechanics). If yes, do Step 5a; if no, leave `GARMIN_ENABLED=false` (default) and the coach runs
   on AI Endurance alone.
7. **Local LLM intent routing?** (optional) — almost always leave `COACH_LOCAL_INTENT=false`; it's a
   micro-optimisation that needs the separate `local-llm-server`. Default off is correct.

## Step 4 — Connect AI Endurance (🧑 user does the browser login)

```bash
▶ RUN   # opens a browser for a one-time OAuth; caches tokens in ~/.endurance-coach (outside the repo)
npm run auth:aie
```
The user completes the login in the browser. Then:

```bash
▶ RUN
npm run verify:reads     # exercises every read tool + confirms the write-gate is closed
npm run state:today      # assembles + persists today's AthleteState, prints a summary
```
**✅ CHECK:** `verify:reads` reports the read tools working and `state:today` prints a real summary
(their name/threshold data from AI Endurance). If reads fail, re-run `npm run auth:aie`.

## Step 5 — First real coaching output

```bash
▶ RUN
export ANTHROPIC_API_KEY=sk-ant-...     # if not already in .env
npm run readiness                        # green/amber/red verdict with cited drivers
npm run dashboard                        # one-off glanceable HTML, opens in the browser
```
**✅ CHECK:** `readiness` prints a verdict and `dashboard` opens. **The user now has a working coach.**
Everything below is optional polish.

### Step 5a — (optional) enable Garmin

```bash
▶ RUN   # one-time Garmin login; saves tokens to ~/.garminconnect (~6-month lifetime)
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
```
Then set `GARMIN_ENABLED=true` in `.env` and re-run `npm run state:today`. Garmin is an *unofficial*
client — treat any flakiness as "degrade to AI Endurance," not an outage. Keep the pinned
`GARMIN_MCP_ARGS` commit from `.env.example` so raw `.FIT` auto-download keeps working.

## Step 6 — (optional) always-on dashboard + hands-free updates

```bash
▶ RUN   # localhost only; prints a one-time /pair?token=… link to open in the browser
npm run serve
```
To run it on phone-over-WiFi, start with `COACH_LAN=1 npm run serve` (still token-gated). To keep it
running and auto-updating (macOS launchd; the installer prints a Linux systemd/cron equivalent):

```bash
▶ RUN   # use the absolute path to THIS user's clone
cd /path/to/personal-training-app && npm run serve:install        # start at login + restart if it stops
cd /path/to/personal-training-app && npm run autoupdate:install   # fast-forward pull + restart on a timer
```

## Step 7 — Done & troubleshooting

```bash
▶ RUN
npm run doctor     # checks creds, Garmin token age, API key, AI Endurance tool drift
```

**Definition of done for setup:** `npm run typecheck && npm test` green · `npm run verify:reads` clean ·
`npm run readiness` prints a verdict · `npm run dashboard` opens. If the user enabled Garmin,
`npm run doctor` shows the Garmin token as valid.

**Common issues**
- *Reads fail / 401* → re-run `npm run auth:aie` (token expired or first-time).
- *LLM flows error "ANTHROPIC_API_KEY is not set"* → export it or put it in `.env`.
- *Garmin returns nothing* → check `npm run doctor` for token age; re-run `garmin-mcp-auth`.
- *Weather card missing* → set `COACH_WEATHER_LAT/LON`, or it's just disabled.

For how the system is built and operated, see [HANDOVER.md](./HANDOVER.md); for what each command does,
see [README.md](./README.md).
