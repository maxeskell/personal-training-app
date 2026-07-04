---
name: endurance-coach-run-and-operate
description: >
  Load this to RUN, SERVE, DEPLOY, or OPERATE the Endurance Coach app — not to change its code. Triggers:
  "run the app", "start the dashboard", "serve the site", "deploy", "ship it", "npm run ship", "how do I
  deploy", "which runner is active", "is the dashboard running", "port 3000 in use / who's on 3000",
  "install the service", "serve:install", "launchd", "pm2", "cron", "scheduled jobs", "the morning ping",
  "fit-sync watch", "autoupdate", "auto-update hijacked my branch / commits landed on main", "where do
  outputs land", "what's in data/", "which files do I back up", "restart the dashboard", "the site is down",
  "run it on Linux", "the MCP server for Cowork", "kickstart the agent", or any question about the CLI
  command catalog (what does `npm run <x>` do), the ship flow's safety guards, the launchd/pm2/cron service
  table, or the data/ artifact map. Don't load this for: the change gate / definition-of-done / branch-then-
  ship RULES (use endurance-coach-change-control); the env-var catalog and flag meanings (use
  endurance-coach-config-and-flags); zero-to-green first-time setup, OAuth, Node/tsx install (use
  endurance-coach-build-and-env); triaging a specific live failure symptom (use endurance-coach-debugging-
  playbook); or measuring health with doctor/cost/probe (use endurance-coach-diagnostics-and-tooling).
---

# Run & operate the Endurance Coach

**Use this when** you need to run, serve, deploy, or operate the app on the Mac: start or restart the
dashboard, ship a branch to `main`, work out which process is serving port 3000, install/uninstall a
launchd or cron job, or find where an output file lands.

**Don't use this when** you need the *rules* of shipping (branch-then-ship, code+docs-together,
green-before-commit → `endurance-coach-change-control`), env-var meanings (→ `endurance-coach-config-and-flags`),
first-time build/OAuth setup (→ `endurance-coach-build-and-env`), a live failure to triage
(→ `endurance-coach-debugging-playbook`), or a health/cost/read measurement (→ `endurance-coach-diagnostics-and-tooling`).

**Jargon, defined once.** *launchd* = macOS's per-user service manager (`launchctl` is its CLI; a service
is a `.plist` "LaunchAgent"). *Agent/label* = one launchd service, named e.g. `com.endurance-coach.dashboard`.
*KeepAlive* = launchd restarts the process if it exits. *RunAtLoad* = start it at login/load. *pm2* = a
third-party Node process manager (an alternative to launchd, never run alongside it). *tsx* = the TypeScript
runner; the app runs source directly via `tsx`, so restarting a service = picking up the latest code (no
build step). *ship* = the deploy: gate → merge your branch into `main` → restart the dashboard → back up to
GitHub. *The Mac* = the author's machine at `/Users/maxeskell/dev/personal-training-app`; a **web/cloud
session cannot reach it** — that changes the deploy path (see "Web-session exception").

> **Absolute paths only.** Every command below is copy-pasteable from anywhere. This is a house rule
> (CLAUDE.md): never hand the user a bare `npm run …` that assumes a working directory.

---

## 1. The ONE canonical runner (do not give conflicting run commands)

The dashboard runs as **a single always-on launchd service**: `com.endurance-coach.dashboard`, port 3000,
`RunAtLoad`+`KeepAlive` (starts at login, restarts on crash). Installed **once** with `serve:install`. That
service — not an open terminal — serves the site. Treat it as the default in all advice.

| Way to run | What it is | When |
|---|---|---|
| `com.endurance-coach.dashboard` (launchd) | The **canonical** always-on service. Restarts on crash, starts at login. A `post-merge` git hook restarts it after any merge (incl. `npm run ship`). | Everyday / production. Install once. |
| `npm start` / `npm run serve` | **DEV-ONLY.** Foreground; dies with the terminal. Both are `tsx src/server.ts`. | Quick local dev *only*. **Never** alongside the service — a second process fights for port 3000. |
| `pm2` (`ecosystem.config.cjs`, `npm run pm2:start`) | An **alternative to** launchd (not extra). Auto-restarts, watches `src/` for changes. | A fallback runner *instead of* launchd. The two must **never both** manage the dashboard. |

**Install / uninstall the canonical service (Mac):**
```
cd /Users/maxeskell/dev/personal-training-app && npm run serve:install     # starts at login + on crash; installs the post-merge restart hook
cd /Users/maxeskell/dev/personal-training-app && npm run serve:uninstall   # removes it + its hook
```
`serve:install` also installs a git `post-merge` hook that runs `launchctl kickstart -k …` so `git pull` /
a merge auto-restarts the dashboard onto the new code. It binds the LAN (`COACH_LAN=1`) and prints a one-time
pairing URL (`http://localhost:3000/pair?token=…`; token in `~/.endurance-coach/dashboard.token`).

**Restart the dashboard by hand** (rarely needed — the hook and `ship` do it):
```
launchctl kickstart -k "gui/$(id -u)/com.endurance-coach.dashboard"
```

### Which runner is actually live? (don't guess — look)
You cannot tell launchd from pm2 from `npm start` by reading a log line. Run this ONE diagnostic (or have
the user paste its output if you can't see the machine):
```
lsof -nP -iTCP:3000 -sTCP:LISTEN; launchctl list | grep -i endurance
```
- `lsof` line → the PID/command holding port 3000 (the actual server).
- `launchctl list | grep -i endurance` → which launchd agents are loaded (look for
  `com.endurance-coach.dashboard`). A `-` in the PID column = loaded but not currently running; a number =
  running; the last column is the last exit status.

> **Advise with exactly ONE command for the setup in front of you.** No menus of co-equal run methods, no
> "or pm2 also works" in the same breath as the service. If you can't see the machine, ask for the
> diagnostic output rather than inferring.

---

## 2. Deploy = `npm run ship` (Mac-only, Claude runs it — the user runs no CLI)

Deploying is Claude's job. After the green gate, Claude runs `ship` itself and reports honestly; only hand
the user a command if they ask. `ship` is `bash scripts/ship.sh` — **Mac-only, never from a web container.**

```
cd /Users/maxeskell/dev/personal-training-app && npm run ship            # ships the branch you're on
cd /Users/maxeskell/dev/personal-training-app && npm run ship -- <name>  # ships a named branch instead
```

### What `ship.sh` does, in order (verified against `scripts/ship.sh`, 2026-07-04)
1. **Resolve branch:** explicit arg wins, else the current branch. Deploy target = `COACH_DEPLOY_BRANCH`
   (default `main`) — **this env var is live**, read at `scripts/ship.sh:17`, *not* dead code.
2. **Guards (abort before any merge if any fail):**
   - Refuses if the branch to ship **is** the deploy branch ("ship a feature branch, not the deploy branch").
   - Refuses on **uncommitted changes** (`git diff` / `--cached` must be clean).
   - Refuses if the branch doesn't exist.
   - Refuses if a **merge or rebase is already in progress** (`MERGE_HEAD` / `rebase-merge` / `rebase-apply`) —
     so no half-finished state gets stranded on the deploy branch.
3. **Local gate (this IS the gate):** `npm test` then `npm run typecheck`. If either fails, `set -e` aborts
   before merging. **Nothing ships red.**
4. **Merge → main:** `git checkout main` then `git merge --no-ff <branch> -m "ship: merge <branch> into main"`.
   On **conflict** it runs `git merge --abort`, `git checkout <branch>`, and dies — you're back on your branch
   and **nothing was deployed** (it prints the `git rebase main` → re-ship recovery steps).
5. **Restart the dashboard:** `launchctl kickstart -k "gui/$(id -u)/com.endurance-coach.dashboard"`
   (the `post-merge` hook usually already did this; harmless if no managed dashboard is installed).
6. **Back up to GitHub (non-fatal):** `git push origin main`. **GitHub is a backup mirror, not the deploy
   source.** A failed push (offline, branch protection) does **not** abort — the local deploy is already
   live; it just warns how to push later.
7. **Return you to your branch** (`git checkout <branch>`).

You will land back on your feature branch after a successful ship, with the merge commit on `main`. Recent
`ship:` merge commits are visible in `git log --oneline` (e.g. `8389d6b`, `8c59604`, `b7998fe`).

### Web-session exception (GitHub-first)
A cloud/claude.ai container **can't reach the Mac**, so `npm run ship` is unavailable there. From the web:
gate in-container, push, merge to `main` on GitHub — and the Mac picks it up on a `git pull`. That pull-based
pickup is the **optional, off-by-default** autoupdate job (`npm run autoupdate:install`); only enable it if
you actually work from the web. See §3 for the autoupdate hazard.

> The full change-control rules behind ship (branch-then-ship, definition-of-done, code+docs-together,
> green-before-commit) live in **`endurance-coach-change-control`**. This skill covers the *mechanics*.

---

## 3. launchd / cron service table

Each service installs with `npm run <install script>` and uninstalls with the matching `:uninstall`. On
**Linux** every installer prints the equivalent `cron`/`systemd --user` line and **no-ops** (macOS-only
`.plist` installs). Logs land in `reports/*.log` (gitignored). Verified against `scripts/install-*.sh`,
2026-07-04.

| Label | Install / uninstall | Schedule (default) | Runs | Notes |
|---|---|---|---|---|
| `com.endurance-coach.dashboard` | `serve:install` / `serve:uninstall` | RunAtLoad + KeepAlive (always-on) | `npm run serve` (dashboard, port 3000) | **The canonical runner.** Binds LAN, installs the `post-merge` restart hook, prints the pairing URL. |
| `com.endurance-coach.morning` | `schedule:install [HH] [MM]` / `schedule:uninstall` | Daily **06:00** | `npm run ping` | Unattended morning readiness (verdict + report + desktop note). **On Sunday** `ping` also fires the weekly brief (`isSunday(state.date)` in `cmdPing`, `cli.ts`). |
| `com.endurance-coach.watch` | `watch:install [HH] [MM]` / `watch:uninstall` | Daily **07:30** (RunAtLoad false) | `npm run fit-sync` then `npm run check` | Downloads recent `.FIT`, then a **fire-only** `check` — notifies **only if** a flag/health early-warning fires; quiet otherwise. No LLM. |
| `com.endurance-coach.mcp` | `mcp:install <PUBLIC_URL> [--yes]` / `mcp:uninstall` | RunAtLoad + KeepAlive (always-on) | `node --import tsx src/mcpHttp.ts` (i.e. `mcp:http`) | The remote MCP HTTP surface for Cowork. Port **8787** (`COACH_MCP_PORT`). Installs with `COACH_MCP_AUTH=oauth`. Only works while your tunnel is up. Stop any manual `npm run mcp:http` first (it holds 8787). |
| `com.endurance-coach.healthcheck` | `healthcheck:install <PUBLIC_URL> [INTERVAL]` / `healthcheck:uninstall` | Every **1200 s** (20 min) + RunAtLoad | `npm run health-remote` | Pings the PUBLIC tunnel `/health`, alerts if the connector is down / needs re-auth. |
| `com.endurance-coach.autoupdate` | `autoupdate:install [INTERVAL]` / `autoupdate:uninstall` | Every **900 s** (15 min) + RunAtLoad | `scripts/autoupdate.sh` (`npm run update` on demand) | **OFF by default.** Pulls `COACH_DEPLOY_BRANCH` (default `main`), fast-forward only, restarts the dashboard on change. **The branch-hijack hazard — see below.** |
| `com.endurance-coach.backfill` | `backfill:install [CHUNK] [INTERVAL]` / `backfill:uninstall` | Every **1800 s** (30 min) + RunAtLoad | `npm run backfill -- --daily-only --chunk 200` | Resumable one-chunk-at-a-time history archive. Gentle on Garmin rate limits. Progress: `npm run backfill:status`. |
| `com.endurance-coach.archive-heal` | `archive:heal:install [CHUNK] [INTERVAL]` / `archive:heal:uninstall` | Every **21600 s** (6 h) + RunAtLoad | `npm run archive:heal -- --chunk 200` | Safety net that incrementally refreshes the durable activity archive (the forward hook handles real-time). |
| `com.endurance-coach.update-check` | `check:updates:install [WEEKDAY] [HOUR] [MIN]` / `check:updates:uninstall` | Weekly **Mon 09:00** | `npm run check:updates` | Alerts if deps/tooling are behind. |

**Convenience bundles:** `npm run service:install` = `serve:install` + `autoupdate:install`;
`npm run service:uninstall` = the reverse. Because autoupdate is off-by-default and carries the hazard below,
prefer installing `serve:install` alone unless you deliberately want web-first auto-pull.

**Uninstallers** just `launchctl unload` the plist and `rm` it (dashboard also removes its `post-merge` hook
if it's the one it installed). To confirm what's loaded: `launchctl list | grep -i endurance`.

### The autoupdate hazard (the costliest historical failure — cross-ref `endurance-coach-debugging-playbook`)
The autoupdate job's job is to pull the deploy branch and restart the dashboard so the Mac stays current
without you running `git`. Its danger: on a **clean tree**, `scripts/autoupdate.sh` will `git checkout` the
deploy branch (`main`) if you're parked on a feature branch — so a background timer can move HEAD off your
work. The current script (verified 2026-07-04) is **defensive**: it **skips entirely if the tree is dirty**
(uncommitted or staged changes present → "local changes present — skipping pull"), pulls **fast-forward only**,
and no-ops if not fast-forwardable. So committed, clean work is safe from *content* loss, but an uncommitted
work-in-progress on a feature branch plus a mistaken commit can still land on `main` if the timer switches
branches between your edits. **Fences (obey both):**
- **Do feature work in a git `worktree`**, or keep the autoupdate job **off** (default) while you work.
- **Re-check the branch before every commit:** `git branch --show-current`.

The settled incident write-up (what happened, why it's now fenced) lives in
**`endurance-coach-failure-archaeology`**; live triage of "my commits landed on main" is in
**`endurance-coach-debugging-playbook`**.

---

## 4. CLI command catalog (by use-case)

Every command is `tsx src/cli.ts <cmd>` behind an `npm run` alias (`package.json` scripts). LLM flows need
`ANTHROPIC_API_KEY`; deterministic flows (state, check, cost, dashboard render, demo) make **zero** LLM calls.
Full curated list: `npm run help`; every subcommand: `docs/commands.md`. Verified against `package.json` +
`src/cli.ts` command map, 2026-07-04.

**See it / run it locally**
| Command | Does |
|---|---|
| `npm run demo` | Render the dashboard from **built-in sample data** — no account / Garmin / API key needed. Best first look. |
| `npm run dashboard` | Generate + open the real glanceable Today/Week/Trends/Race view. |
| `npm start` / `npm run serve` | **DEV-ONLY** foreground dashboard (see §1 — do not run alongside the service). |
| `npm run state:today` | Assemble + persist + summarise today's `AthleteState` (deterministic; writes `data/state/…`). |

**Coach flows (LLM)** — `readiness`, `weekly`, `weekly:brief`, `race`, `deep-dive`, `season`, `tune`,
`fuelling`, `fuel-review`, `ask "<q>"`, `session [date]`, `research`, `listening`, `act`,
`ftp-check`. All `npm run <name>`. (Meanings are domain content → `endurance-domain-reference`.)

**Knowledge refresh (review-gated, not a coach narrative flow)** — `knowledge` shows freshness /
pending digests; `knowledge -- approve <file>` folds a digest into `knowledge/sports-science.md`. The
review gate is owned by **`endurance-coach-docs-and-writing`**.

**Gated writes (propose → confirm)** — the ONLY path that mutates AI Endurance:
| Command | Does |
|---|---|
| `npm run propose "<request>"` | Logs a gated plan-adjustment **proposal** (no write fires). |
| `npm run confirm <id>` | Applies a proposal (single write call, under lock). |
| `npm run decline <id>` | Dismisses a proposal (single-use). |
| `npm run decisions [pending \| retro <id> "<note>"]` | View the audit log / pending proposals / add a retrospective. |

> **Never route around the gate.** No command should mutate AI Endurance except `confirm`. The gate's
> contract is owned by **`endurance-coach-architecture-contract`**; the discipline by
> **`endurance-coach-change-control`**.

**Ops / health / data** — `ping` (morning readiness), `check` (fire-only watch, no LLM), `cost [days]`
(local token-cost report), `doctor` / `verify` / `probe` / `health-remote` (diagnostics →
**`endurance-coach-diagnostics-and-tooling`**), `fit-sync [n]`, `backfill [from]`, `backfill:status`,
`backfill:compact`, `archive:heal`, `career:build` (rebuild power-curve/career history — needs
`--tp <trainingpeaks.csv>` + `--fit-dir`; a bare run drops bests/trajectory).

**Setup / auth** (first-time → **`endurance-coach-build-and-env`**) — `setup`, `profile:init`,
`profile:questions`, `auth:aie`, `help`.

---

## 5. data/ artifact map (what lands where)

Everything the app writes goes under `data/` (gitignored — `.gitignore:34`). Configurable via
`COACH_DATA_DIR` (default `<repo>/data`, `config.ts:326`). Verified against the live tree + code paths,
2026-07-04.

| Path | Contents |
|---|---|
| `data/state/YYYY-MM-DD.json` | Daily `AthleteState` snapshots (deterministic assembly; `profile`/medical + `dataCompleteness` are stripped before persisting). |
| `data/archive/*.jsonl` | Long-history backfill (AIE activities + Garmin daily), dedup-on-read. |
| `data/activity-archive/by-year/*` + `manifest.jsonl` | Durable, dedup'd raw activity files (the archive of record). |
| `data/fit-streams/*.fit` | Hot recently-downloaded raw `.FIT` streams (for per-session decoupling / power curve). |
| `data/brief/` | Daily-brief snapshots. |
| `data/weekly-brief/` | Sunday weekly-brief snapshots (created on first Sunday run). |
| `data/decisions/log.jsonl` | The decision/audit trail — every gated proposal/confirm/decline. |
| `data/cost-log.jsonl` | Per-call LLM cost log (ts/operation/model/tokens/cost — **never** prompt or response text). |
| `data/session-feedback.jsonl` | Per-session deep-feedback records. |
| `data/insights/` | Cached insight-engine outputs. |
| `data/venue.json` | Confirmed open-water venue temp (drifted MODEL between confirmations). |
| `data/weather.json` | Cached weather. |
| `data/career-history.json` | Built career/power-curve history (`npm run career:build`). |
| `data/fuel-log.jsonl` | Logged nutrition (created when you first log fuel). |
| `data/metric-overrides.json` | Manual metric overrides. |

**Secrets live OUTSIDE the repo** in `~/.endurance-coach/` (`COACH_SECRETS_DIR`, `config.ts:323`, dir mode
`0700`): `aie-tokens.json`, `aie-client.json`, `aie-verifier.txt`, `dashboard.token` (`0600`), `mcp.token`,
`mcp-oauth.json`. Garmin tokens live in `~/.garminconnect`. **Never** commit or template these.

**Logs** land in `reports/*.log` (gitignored): `server.log`, `ping.log`, `watch.log`, `mcp.log`,
`healthcheck.log`, `autoupdate.log`, `backfill.log`, `archive-heal.log`, `update-check.launchd.log`.

---

## 6. Backups & recovery

- **Only `data/` is irreplaceable.** Code is on GitHub; `~/.endurance-coach/` tokens are re-obtainable by
  re-running `npm run auth:aie` (host-only OAuth). The one thing you cannot regenerate is the accumulated
  history in `data/archive/` + `data/activity-archive/` + `data/fit-streams/` + `data/state/`.
- **Back up `data/`** (and, if you want to avoid re-auth, `~/.endurance-coach/`) — both are gitignored, so
  git does NOT protect them. A time-machine/rsync of `data/` is the real disaster recovery.
- **GitHub is a code backup, not a data backup.** `ship` pushes `main` to GitHub as a mirror; that mirror
  contains no `data/` and no secrets.
- **Recover a hijacked/lost branch:** the code is committed — `git reflog` / `git branch --show-current` /
  `git log --oneline`. Live triage steps → **`endurance-coach-debugging-playbook`**.

---

## 7. Linux fallback (brief)

There is no macOS launchd on Linux. Every `*:install` script detects non-Darwin and **prints the equivalent
`cron` or `systemd --user` line, then exits 0** without installing anything. Run the underlying command
yourself from that line, e.g. the dashboard as `cd /Users/maxeskell/dev/personal-training-app && npm run serve`
with `COACH_HOST=0.0.0.0 COACH_PORT=3000` under a `systemd --user` service; the morning ping as a cron entry
`0 6 * * * cd <repo> && npm run ping`. pm2 (`npm run pm2:start`) also works cross-platform as the runner.

---

## Provenance and maintenance

Verified against the repo on **2026-07-04** (branch `main`). Re-run these to confirm each drift-prone fact:

- **CLI catalog / npm scripts:** `sed -n '11,91p' /Users/maxeskell/dev/personal-training-app/package.json`
  and the command map at `grep -n "const commands" /Users/maxeskell/dev/personal-training-app/src/cli.ts`.
- **ship.sh anatomy + `COACH_DEPLOY_BRANCH` is live:**
  `grep -nE "COACH_DEPLOY_BRANCH|merge --no-ff|kickstart|push origin|npm test|typecheck" /Users/maxeskell/dev/personal-training-app/scripts/ship.sh`.
- **Service labels + schedules/defaults:**
  `grep -nE 'LABEL=|StartInterval|StartCalendarInterval|INTERVAL=|CHUNK=|Hour|Minute|RunAtLoad|KeepAlive' /Users/maxeskell/dev/personal-training-app/scripts/install-*.sh`.
- **Autoupdate is defensive (skips dirty tree, ff-only, switches to deploy branch):**
  `sed -n '18,53p' /Users/maxeskell/dev/personal-training-app/scripts/autoupdate.sh`.
- **Sunday ping → weekly brief:** `grep -n "isSunday" /Users/maxeskell/dev/personal-training-app/src/cli.ts`.
- **MCP HTTP default port 8787:** `grep -n "COACH_MCP_PORT" /Users/maxeskell/dev/personal-training-app/src/config.ts`.
- **data/ + secrets paths:** `grep -nE "dataDir|secretsDir" /Users/maxeskell/dev/personal-training-app/src/config.ts`
  and `find /Users/maxeskell/dev/personal-training-app/data -maxdepth 2 -type d`.
- **Which-runner diagnostic still current:**
  `grep -n "lsof -nP -iTCP:3000" /Users/maxeskell/dev/personal-training-app/CLAUDE.md /Users/maxeskell/dev/personal-training-app/README.md`.
- **Canonical-runner language in README:** `grep -n "canonical way to run" /Users/maxeskell/dev/personal-training-app/README.md`.
