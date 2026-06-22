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

## Quick start (humans)

On the Mac (or Linux box) that will host the coach:

```bash
git clone https://github.com/maxeskell/personal-training-app.git
cd personal-training-app
npm install
npm run demo          # see it work right now — fictional sample data, no account, no key
npm run setup         # guided wizard: writes your .env (Anthropic key, units, training location)
npm run auth:aie      # one-time browser login to AI Endurance
npm start             # run the coach; open the printed localhost link
```

That's the whole happy path — ~15 minutes, most of it the one browser login. **Everything below is
the same journey in detail**, plus prerequisites, costs, the optional athlete profile, Garmin and
troubleshooting. Read on only where a step needs it, or follow Step 0 onward straight through.

---

## Where to run this (important)

Run setup **on the machine that will host the coach** (e.g. your Mac), driven by a **local** assistant
(Claude Code running on that machine) or by hand — **not** a cloud / remote agent. Two steps are bound
to the local machine and a browser:

- **AI Endurance login** (`npm run auth:aie`) opens a **browser** and waits for the OAuth redirect on
  `http://localhost:8765`. A remote / sandboxed agent has no browser and cannot receive that callback.
- The **dashboard** binds `localhost` (LAN access is opt-in), so it is reached from the same machine.

So an assistant running this **must pause at the browser logins (Steps 4 and 5a) and hand off to you** —
it cannot click through OAuth itself.

**Network access:** the machine needs outbound HTTPS to `aiendurance.com` and `api.anthropic.com` (plus
Garmin if you enable it). On a locked-down network or inside a sandbox, allow-list those hosts first — a
`Host not in allowlist` / connection error from `npm run doctor` means egress is being blocked.

## What you'll end up with

A working local AI endurance coach: a CLI plus a local web dashboard you can open on your phone, fed
**live** from your own AI Endurance account (and optionally your Garmin). Setup is ~15 minutes, most of
it the two one-time browser logins.

## How the connections work (so the auth steps make sense)

Three external connections, each with its own login and token store — all kept **outside the repo**:

- **AI Endurance (required — the data spine).** Your plan, races, recovery model and thresholds. You log
  in once via browser (`npm run auth:aie`, Step 4) and the OAuth tokens cache in `~/.endurance-coach`. The
  coach *reads* this through AI Endurance's own connector — you don't host anything for it.
- **Anthropic API (required for the AI write-ups).** A key in `.env` (`ANTHROPIC_API_KEY`), used for the
  readiness/weekly/race/ask prose. The deterministic dashboard, zones and health checks need no key.
- **Garmin (optional).** Device data (HRV, training status, raw `.FIT`) via an *unofficial community*
  connector; login in Step 5a, tokens in `~/.garminconnect`.

These three are **inbound** — accounts the coach *reads from*. There's also a separate, **optional**
**outbound** piece, the **Coach Query Server**: the coach can expose *itself* so you can ask Claude
(Desktop / Code / Cowork) about your own data in chat ([docs/mcp-server.md](docs/mcp-server.md)). It's
**not needed** for the CLI or the dashboard — ignore it for setup and come back to it later if you want it.

## Step 0 — Prerequisites (🧑 confirm you have these)

| Need | Required? | How to check / get it |
|---|---|---|
| **Node.js ≥ 20** | Yes | `node --version`. Install from https://nodejs.org if missing. |
| **An AI Endurance account** | **Yes — the data spine** | https://aiendurance.com — you log in via browser in Step 4. Without it there is nothing to coach on. |
| **An Anthropic API key** | **Yes — for coaching** | https://console.anthropic.com → API keys. Needed for readiness/weekly/race/ask/etc. |
| **`uv`/`uvx` + Python 3.12** | Only if you enable Garmin | https://docs.astral.sh/uv/ . Skip if you won't use Garmin. |
| **macOS** | Only for extras | The CLI + dashboard run on Linux too; only desktop notifications and the auto-start installers are macOS-specific (they print a Linux equivalent and no-op elsewhere). |

### What it will cost you (know this before you start)

Nothing in *this repo* charges you, but two prerequisites above are paid third-party services and the AI
write-ups spend Anthropic tokens. Set expectations up front:

- **AI Endurance** — a **paid subscription you hold directly with them** (it's your plan/recovery/threshold
  data spine). You pay AI Endurance whatever their plan costs; nothing extra flows through this repo.
- **Anthropic API** — **pay-as-you-go per token**, billed by Anthropic on the key you provide. On a daily
  coaching cadence this is **roughly $5–10/month** in practice. Every call is logged locally — run
  `npm run cost` any time for today / 7-day / 30-day totals and a monthly projection.
- **The $0 path:** the dashboard, zones, health checks and weather make **no LLM calls and need no key** —
  you can run the coach display-only for free, and only spend when you ask for a readiness/weekly/race/ask
  write-up. (`npm run demo` shows the whole dashboard on sample data with no account and no key at all.)
- **Garmin, weather, the optional local-LLM server:** free.

You stay in control of spend: nothing runs on autoplay, the deterministic flows are free, and the cost log
is a purely local tally (it never sends anything anywhere).

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

> **Fast path (humans):** run **`npm run setup`** — an interactive wizard that asks for the key, units,
> training location and Garmin, writes `.env` for you, then offers to set up your **athlete profile**
> (Step 3a below) and prints the next steps. It's the one-command version of this section; skip to Step 4
> after it. (An assistant following this file should still gather the values explicitly below, since the
> wizard needs a terminal.)

Ask the user, then write the answers into `.env` (uncomment the relevant lines from `.env.example`):

1. **Anthropic API key** → `ANTHROPIC_API_KEY=sk-ant-...` (you can also export it in the shell instead
   of writing it to `.env`; never echo it back or commit it).
2. **Units / locale** → `COACH_UNITS` (e.g. `metric, UK` or `imperial, US`).
3. **Equipment** (optional, cosmetic) → `COACH_EQUIPMENT` (e.g. their watch/bike computer/scale), or
   clear it to drop the line.
4. **Training base for weather** → `COACH_WEATHER_LAT` / `COACH_WEATHER_LON` (where they ride/run/swim
   from). Default is the author's base in the UK — **change it.** Set `COACH_WEATHER_ENABLED=false` to
   skip the weather card entirely.
5. **Open-water swimming?** If yes: set `COACH_SWIM_MIN_WATER_C` (their cold-water comfort floor). The
   venue's **water temperature** has no public feed, so it's entered by hand — but the everyday way is the
   **water-temp box at the bottom of the dashboard's "Week ahead" card** (saves live to `data/venue.json`,
   no restart); once a reading is >7 days old the coach forecasts it (a damped air-temp-drift MODEL) and
   asks them to Confirm/Correct. `COACH_WATER_TEMP_C` in `.env` is only an optional *seed* used before the
   first reading — any confirmed reading wins over it, so you can leave it unset. If they don't open-water
   swim, leave both unset.
6. **Garmin?** (optional, degradable) — ask if they want device data (HRV, training status, raw `.FIT`
   biomechanics). If yes, do Step 5a; if no, leave `GARMIN_ENABLED=false` (default) and the coach runs
   on AI Endurance alone.
7. **`ask` intent routing** (optional) — `COACH_INTENT_ROUTER`. Leave `regex` (default, zero-cost) for
   most people. The cheap upgrade is `haiku` (a `claude-haiku-4-5` micro-call on the API key you already
   set — no extra server). Only pick `local` if you specifically want the separate `local-llm-server`.
8. **Deep session feedback** (optional) — `COACH_AUTO_SESSION_FEEDBACK`. Per-session feedback is
   generated automatically at sync and shown inline on the "Last session" card. Leave `on` (default —
   every recent session with its raw `.FIT`, one LLM call each), set `latest` (only the most recent
   session) to spend less, or `off` (generate on demand with `npm run session`). Needs `ANTHROPIC_API_KEY`.

### Step 3a — (optional) athlete profile

`.env` holds the machine's settings; your **athlete profile** holds the stable *human* context no API
can — biomechanics, kit/fit, medical notes, weekly availability and race targets. It lives in
`profile.local.yaml` (**gitignored**, never shared) and feeds the coaching flows and the `get_profile`
MCP tool. It's optional — the coach runs fine without it — and `npm run setup` already offers it as its
last step. To set it up (or redo it) on its own:

```bash
▶ RUN   # interactive — copies the template, then walks identity, availability and your first race
npm run profile:init
```

It **pre-fills from your connected integrations** (best-effort): name and sex from AI Endurance,
units/timezone from the `.env` you just wrote, all upcoming races from your AI Endurance goals, a
**MODEL estimate** of weekly hours from recent training volume, and — when **Garmin is enabled** —
**date of birth and height** from Garmin's `get_user_profile`. It prints a summary, then asks **"Does
this look right? [Y/n]"**: **Y** keeps everything pulled and only asks for the required fields still
missing; **n** lets you override each (Enter keeps the pulled value). **Date of birth is only asked when
Garmin didn't supply it** (AI Endurance exposes age, not DOB). Best run **after Step 4** (AI Endurance
auth — and Garmin auth if you use it) so there's an account to pull from; before that — or if AI
Endurance is unreachable — it degrades to a full manual flow.

This writes `profile.example.yaml` → `profile.local.yaml` and validates the required fields; edit the
file afterwards to fill in biomechanics/kit/medical/fuelling (no integration holds those). **Never put
live numbers** (FTP, weight, paces, CSS, HRV, load) in it — those stay live from AI Endurance/Garmin,
and a schema guard rejects them if you try. Full schema and privacy detail: [docs/profile.md](docs/profile.md).

**Worth filling in: your fuelling inventory.** Under `fuelling.products` list the nutrition you actually
use (gels, bars, drink mix, electrolytes, recovery, supplements — per-serving carbs/sodium/caffeine);
`profile.example.yaml` carries a commented draft to copy. With it set, the dashboard's **"Fuelling —
week ahead"** card gives per-session pre/during/after guidance from *your* products (and stays quiet when
a session needs nothing), and `npm run fuelling` / the `fuelling` MCP tool do the same on demand. Until
you add it, the card shows a one-line nudge with the format, and the **"Finish setup"** card lists it as
an open item — nothing breaks, it's just an empty inventory waiting on you. See the
[Fuelling Spec](docs/specs/Fuelling_Spec.md) for the full picture.

**Worth filling in: each bike's race weight.** Under `equipment.bikes.<name>.race_weight_g` record the
bike *as you race it*, in **grams** — weigh it the way you ride (e.g. with one full bottle) and log the
grams (10 kg → `10000`). Grams, not kg, on purpose: a `weight_kg` is treated as your live bodyweight and
rejected, but a bike's own mass is stable kit. The coach reads it into the live coaching block and adds
your **live** weight to get total system weight (rider + bike) — the number tyre-pressure charts want.
`profile.example.yaml` carries a commented `felt:` block to copy.

**Worth filling in: any blood-test results.** Under `bloods.panels` record dated panels — `date`,
`source`, a free-form `markers` map (`name_unit: number`, e.g. `ferritin_ug_l: 70.2`), plus optional
`flags`/`notes`. This is the one place the profile keeps clinical numbers, on purpose: no training API
holds your bloods, so a dated snapshot is stable context. It's always treated as a *snapshot, never as
current* — the coach surfaces the latest panel with its age and nudges a re-test once it's over a year
old. `profile.example.yaml` carries a commented panel to copy. (Not medical advice — record what your
report/GP say; live numbers like HR still belong to AI Endurance/Garmin and are rejected here.)

For the optional fields worth filling in later — each with a plain-language question and a one-line
*why it helps the coach* — run `npm run profile:questions` (or read
[docs/profile-questions.md](docs/profile-questions.md)). All of them are optional.

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

> **Trust note (read before running).** `garmin-mcp-auth` runs a **third-party community tool**
> (`Taxuspt/garmin_mcp`) that logs into Garmin Connect on your behalf and stores your Garmin **session
> tokens** in `~/.garminconnect` (your credentials pass through it). Review the tool before running it,
> and keep the **commit pin** in `GARMIN_MCP_ARGS` so you stay on a known version. Tokens last ~6 months;
> when reads start failing, re-run this command. Garmin is entirely optional — skip it and the coach runs
> on AI Endurance alone.

## Step 6 — (optional) always-on dashboard + hands-free updates

```bash
▶ RUN   # localhost only; prints a one-time /pair?token=… link to open in the browser
npm start                  # alias for `npm run serve` — the everyday "run the coach" command
```
To run it on phone-over-WiFi, start with `COACH_LAN=1 npm start` (still token-gated). To keep it
running and auto-updating (macOS launchd; the installer prints a Linux systemd/cron equivalent):

```bash
▶ RUN   # use the absolute path to THIS user's clone — `service:install` does both at once
cd /path/to/personal-training-app && npm run service:install      # start at login + auto-update on a timer
#   (or the two granular installers separately: `npm run serve:install` and `npm run autoupdate:install`)
```

## Step 6a — (optional) Career history (the `/career` tab)

The dashboard's live state only knows the recent past. The **Career & PBs** page (`/career`, linked
top-left of the dashboard) shows the *long view* — your full **race log**, **lifetime bests vs current
form**, and an all-time-vs-recent **power curve**. Because that history is a multi-year archive, it lives
in a **gitignored** file, `data/career-history.json`, that you build once from your own exports. The
committed `career-history.example.json` shows the exact shape if you'd rather hand-write it.

```bash
▶ RUN   # use absolute paths to YOUR exported files; every flag is optional (missing input = empty section)
cd /path/to/personal-training-app && node scripts/build-career-history.mjs \
  --intervals /abs/path/activities.json \     # intervals.icu activities export (last-90d + season bests)
  --tp        /abs/path/activities_tp.csv \    # a TrainingPeaks summary CSV (all-time bests, 2011+)
  --power     /abs/path/power_curve.json \     # intervals power-curve export (mean-maximal watts)
  --races     /abs/path/career-races.json \    # YOUR curated race list (names/locations) — see below
  --season    2026                             # season year for the "Season" column (default: this year)
```

- **Races are pass-through and author-owned** — the script does **not** scrape official results. Put your
  race list (date, type, event, location, optional recorded result) in the `--races` file (a JSON array;
  the `races` block of `career-history.example.json` is the template). Re-running without `--races` keeps
  the races already in the output file.
- **Bests + power curve are auto-computed** from `--intervals` / `--tp` / `--power`, with GPS/calibration
  outliers dropped (honest models). Locations you don't mark `"confidence":"confirmed"` are treated as
  approximations in the UI.
- Set `COACH_CAREER_PATH` if you keep the file somewhere other than `data/career-history.json`.

## Step 6b — (optional) Season arc (the `/season` strategic review)

The **Season arc** page (`/season`, linked top-left of the dashboard) is the multi-season strategic layer —
*where am I in the multi-year build, am I building or stalling, what's this phase's focus, what's the risk* —
for rebuilding toward 70.3 → Ironman. It's deterministic (no LLM, no cost) and reads three things you
already have: your **career trajectory** (from Step 6a's `career-history.json`), your **live CTL** (from your
synced state), and a **multi-year plan you write** in `profile.local.yaml`:

```yaml
season_plan:
  horizon_goal: "Ironman by 2028"
  target_date: "2028-07-01"
  phases:
    - name: "Rebuild base"
      focus: "raise the aerobic floor; set swim CSS; strength 2–3×/wk"
      until: "2026-12-31"
      ctl_target: "55"          # TEXT target (intent), not a live number
    - name: "Threshold shift"
      focus: "20–60 min power; consolidate 70.3"
      until: "2027-12-31"
      ctl_target: "70"
    - name: "IM build"
      focus: "durability + volume"
      until: "2028-06-30"
      ctl_target: "85"
notes: "raise the year's floor, not the week's ceiling; defend consistency"
```

- The **active phase** is the first whose `until` is still ahead. `ctl_target` is **text** (e.g. `"55"` or
  `"55-60"`) — a numeric CTL would be rejected by the no-live-numbers guard, exactly like a race `target_time`.
- Everything's optional: with no `season_plan` the page still shows your CTL, trajectory and lever checklist,
  and explains how to add the plan. See `profile.example.yaml` → `season_plan` and
  `docs/specs/Season_Arc_Spec.md`.
- For a written strategic write-up (not just the page), run
  `cd /Users/maxeskell/personal-training-app && npm run season` — one high-effort, cost-logged LLM call
  (needs `ANTHROPIC_API_KEY`), saved to `reports/`; without a key it prints the deterministic digest.

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
- *`Host not in allowlist` / can't reach AI Endurance or Anthropic* → your network or sandbox is
  blocking outbound access; allow `aiendurance.com` and `api.anthropic.com`.
- *LLM flows error "ANTHROPIC_API_KEY is not set"* → export it or put it in `.env`.
- *Garmin returns nothing* → check `npm run doctor` for token age; re-run `garmin-mcp-auth`.
- *Weather card missing* → set `COACH_WEATHER_LAT/LON`, or it's just disabled.

For how the system is built and operated, see [HANDOVER.md](./HANDOVER.md); for what each command does,
see [README.md](./README.md).
