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
- **Garmin (optional).** Device data (HRV, training status, raw `.FIT`) via an *unofficial community* MCP;
  login in Step 5a, tokens in `~/.garminconnect`.

> **This is not the same as the coach's *own* MCP server.** Separately and optionally, the coach can
> *expose itself* as an MCP server so Claude (Desktop / Code / Cowork) can query your data in chat — that's
> [docs/mcp-server.md](docs/mcp-server.md), and it is **not needed** for the CLI or the dashboard. "AI
> Endurance MCP" = the spine the coach reads; "the coach's MCP server" = an optional way to ask Claude
> about your data. Different things.

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
5. **Open-water swimming?** If yes: `COACH_SWIM_MIN_WATER_C` (their cold-water comfort floor) and
   `COACH_WATER_TEMP_C` (the latest posted venue temp — there is no public feed, so it's updated by
   hand). If they don't open-water swim, leave these unset.
6. **Garmin?** (optional, degradable) — ask if they want device data (HRV, training status, raw `.FIT`
   biomechanics). If yes, do Step 5a; if no, leave `GARMIN_ENABLED=false` (default) and the coach runs
   on AI Endurance alone.
7. **`ask` intent routing** (optional) — `COACH_INTENT_ROUTER`. Leave `regex` (default, zero-cost) for
   most people. The cheap upgrade is `haiku` (a `claude-haiku-4-5` micro-call on the API key you already
   set — no extra server). Only pick `local` if you specifically want the separate `local-llm-server`.

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
units/timezone from the `.env` you just wrote, all upcoming races from your AI Endurance goals, and a
**MODEL estimate** of weekly hours from recent training volume. You confirm each (Enter keeps it) or
override it, and are only *asked* for what no integration holds — **date of birth is always asked**
(AI Endurance exposes age, not DOB). Best run **after Step 4** (AI Endurance auth) so there's an account
to pull from; before that — or if AI Endurance is unreachable — it degrades to a full manual flow.

This writes `profile.example.yaml` → `profile.local.yaml` and validates the required fields; edit the
file afterwards to fill in biomechanics/kit/medical/fuelling (no integration holds those). **Never put
live numbers** (FTP, weight, paces, CSS, HRV, load) in it — those stay live from AI Endurance/Garmin,
and a schema guard rejects them if you try. Full schema and privacy detail: [docs/profile.md](docs/profile.md).

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
