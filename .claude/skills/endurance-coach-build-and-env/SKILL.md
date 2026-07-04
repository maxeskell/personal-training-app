---
name: endurance-coach-build-and-env
description: >-
  Load when standing up the Endurance Coach from a fresh clone, or when the local
  toolchain / accounts won't come up. Triggers: "set up from scratch", "fresh clone
  won't build", "how do I get this running", "npm install fails", Node / tsx / TypeScript
  / ESM / "Node16 module resolution" errors, "typecheck fails", "npm test fails on a
  clean checkout", "npm audit" / esbuild advisory, connecting AI Endurance
  (`npm run auth:aie`, OAuth, `localhost:8765/callback`, "token cache", "aie-tokens.json",
  "can't do OAuth headless / on a cloud box / in a sandbox / no browser"), enabling
  Garmin (`garmin-mcp-auth`, uvx, Python 3.12, the pinned `Taxuspt/garmin_mcp@d31de79`
  commit, "6-month token expired", "download_activity_file missing"), the Claude
  desktop-app MCP breaking after a Homebrew node upgrade (`No such file or directory`,
  pinned Cellar path), ANTHROPIC_API_KEY setup, and "just show me the app" (`npm run demo`,
  no account/key). Do NOT load for: running/serving/deploying the dashboard or `npm run
  ship` (use endurance-coach-run-and-operate); the full env-var catalog or adding a flag
  (use endurance-coach-config-and-flags); live triage of a running instance's data
  problems (use endurance-coach-debugging-playbook).
---

# endurance-coach-build-and-env

**Use this when** you are bringing the coach up from zero — cloning, installing, getting `typecheck + test`
green, connecting AI Endurance (AIE) OAuth, optionally enabling Garmin, or unwedging a toolchain/account
problem that blocks setup.
**Don't use this when** the app already builds and you need to *run/serve/ship* it (see
`endurance-coach-run-and-operate`), look up an env var or add a flag (see
`endurance-coach-config-and-flags`), or triage a live data/OAuth failure on a running instance (see
`endurance-coach-debugging-playbook`).

Jargon, defined once:
- **AIE** = AI Endurance, the ML coaching platform this app reads its plan/thresholds/recovery from. The
  **data spine** — required.
- **MCP** = Model Context Protocol, the tool-call transport the app uses to reach AIE and Garmin.
- **OAuth** = the browser-based login that mints and caches AIE access tokens.
- **tsx** = the TypeScript runner this project uses instead of compiling first; `npm run *` scripts are
  `tsx src/…`.
- **ESM / Node16** = ES modules with Node16 module resolution (see `tsconfig.json`) — imports use `.js`
  extensions even for `.ts` files. `"type": "module"` in `package.json`.
- **uvx** = the one-shot runner from Astral's `uv` Python tool-manager, used only to launch the Garmin
  community connector.

> All commands below are copy-pasteable from anywhere — they `cd` into the repo first. The repo lives at
> `/Users/maxeskell/dev/personal-training-app` on the author's Mac.

---

## 0. What needs which account (read before you start)

| Thing | Required? | You need | Where the token/secret lands | Can it be done headless / on a cloud box? |
|---|---|---|---|---|
| **Node.js ≥ 20** | Yes | a local install | — | Yes |
| **AI Endurance (AIE)** | **Yes — the spine** | a paid AIE subscription + a browser login (`npm run auth:aie`) | `~/.endurance-coach/aie-tokens.json` (0600, dir 0700) | **No** — OAuth needs a browser + `localhost:8765` callback |
| **Anthropic API key** | Yes for AI write-ups; **no** for the dashboard/zones/health/demo | a key from `console.anthropic.com` | `.env` (`ANTHROPIC_API_KEY=`) or shell env | Yes |
| **Garmin** | Optional, degradable | `uv`/`uvx` + Python 3.12, then `garmin-mcp-auth` | `~/.garminconnect/garmin_tokens.json` (~6-month life) | Login needs a terminal + your Garmin creds; not truly headless |
| **`npm run demo`** | — | nothing (no account, no key, no network) | — | Yes |

> **Host-only setup is a hard limit.** The AIE OAuth flow opens a browser and waits for the redirect on
> `http://localhost:8765/callback` (confirmed `src/config.ts:79,85`). A cloud / sandboxed / remote agent has
> no browser and can't receive that callback, so it **cannot** complete AIE auth. An assistant running setup
> must pause at the browser logins and hand off to the human on the host machine. This is the standing weak
> point "setup is host-only" (see `endurance-coach-failure-archaeology`).

---

## 1. Zero-to-green sequence (the happy path)

Run these in order. Stop at the first failure and report it honestly — do not proceed past a red gate.

```bash
# 1. Clone + install (Node ≥ 20 required; check with: node --version)
cd /Users/maxeskell/dev && git clone https://github.com/maxeskell/personal-training-app.git
cd /Users/maxeskell/dev/personal-training-app && npm install

# 2. Create your .env from the documented template
cd /Users/maxeskell/dev/personal-training-app && cp .env.example .env

# 3. THE GREEN GATE — needs no accounts, no network. Must pass before anything else.
cd /Users/maxeskell/dev/personal-training-app && npm run typecheck && npm test
```

**✅ Gate check:** typecheck is clean and every test passes (**730 tests, ~6.2s, hermetic/no-network** as of
2026-07-04 — re-verify with the command in Provenance). If either is red, **stop and report** — this gate is
the project's green-before-commit contract; do not work around it.

```bash
# 4. See it work immediately on bundled sample data — no AIE account, no API key, no network:
cd /Users/maxeskell/dev/personal-training-app && npm run demo
```

`npm run demo` renders the whole dashboard on synthetic data (`buildDemoWindow` in `src/cli.ts`) so a
stranger can evaluate the app with zero credentials. It is the fast confidence check that the build works.

```bash
# 5. Configure .env. Fast path (needs a real terminal / TTY):
cd /Users/maxeskell/dev/personal-training-app && npm run setup
```

`npm run setup` is an interactive wizard (`src/setup.ts`) that writes `.env` for you: Anthropic key, units,
weather lat/lon, Garmin y/n, then offers the athlete-profile intake. If there is no TTY (e.g. you are an
assistant), it prints guidance and exits — set the values by hand in `.env` instead. The three most people
set: `ANTHROPIC_API_KEY`, `COACH_UNITS`, `COACH_WEATHER_LAT`/`COACH_WEATHER_LON`. Full env catalog and how
to add a flag: `endurance-coach-config-and-flags`.

```bash
# 6. Connect AI Endurance — one-time browser login (HOST-ONLY; hand off to the human here).
cd /Users/maxeskell/dev/personal-training-app && npm run auth:aie
```

On success `auth:aie` prints `✓ Connected to AI Endurance — N tools exposed`, warns on any expected-but-absent
tool (API drift), and confirms tokens are cached in `~/.endurance-coach`. Future runs are non-interactive
until the token expires (it auto-refreshes).

```bash
# 7. Confirm the reads work and the write-gate is closed, then assemble today's state:
cd /Users/maxeskell/dev/personal-training-app && npm run verify:reads
cd /Users/maxeskell/dev/personal-training-app && npm run state:today
```

You now have a working coach. To make it always-on (the dashboard service, scheduled jobs) go to
`endurance-coach-run-and-operate`. Do not start `npm start`/`npm run serve` as your "run" model — that is
dev-only and detailed in the run-and-operate sibling.

---

## 2. The Anthropic key — what breaks without it

The key is **not** needed to build, test, run the demo, serve the dashboard, or run zones/health/weather —
those make zero LLM calls. It is only needed for the AI write-ups (readiness, weekly, race, ask, session,
deep-dive, season narrative). Missing-key behaviour is graceful, not a crash: LLM CLI flows print
`ANTHROPIC_API_KEY is not set. This flow needs the LLM core.` and exit (`src/cli.ts:100`); the `season` flow
degrades to a deterministic digest (`src/cli.ts:467`). Set it in `.env` as `ANTHROPIC_API_KEY=sk-ant-…` or
export it in the shell — never echo it back, never commit it.

Cost expectation (from SETUP.md / HANDOVER): **roughly $5–10/month** MODEL/estimate on a daily coaching
cadence. Every call is cost-logged locally (`npm run cost`); the log never leaves the machine.

---

## 3. Enabling Garmin (optional, degradable)

Garmin is an **unofficial community** connector and the most fragile dependency in the stack. Skip it unless
the athlete wants device data (HRV, training status, raw per-second `.FIT` biomechanics). It degrades
cleanly: with it off or broken, the coach runs on AIE alone.

```bash
# Prereq: uv/uvx + Python 3.12 (https://docs.astral.sh/uv/). Then one-time login:
uvx --python 3.12 --from git+https://github.com/Taxuspt/garmin_mcp garmin-mcp-auth
# Then flip the flag and re-assemble:
#   set GARMIN_ENABLED=true in /Users/maxeskell/dev/personal-training-app/.env
cd /Users/maxeskell/dev/personal-training-app && npm run state:today
```

**The commit pin matters.** The app spawns the connector via `uvx` pinned to
`Taxuspt/garmin_mcp@d31de7980d652289e5368637261fcd17aa2c7d90` (confirmed `src/config.ts:117-120`, env var
`GARMIN_MCP_ARGS`). That commit added `download_activity_file` (raw per-second `.FIT` download, 2026-06-10).
Consequences:
- On a **build older than `d31de79`**, the stream/biomechanics layer degrades to manual export (Garmin
  Connect → activity → ⚙ → Export Original into `data/fit-streams/`). Not a crash — a missing card with a note.
- Pinning also forces `uvx` to rebuild its cached env, so the tool appears **without** a manual
  `uvx --refresh`. Bump the pin deliberately, not casually.

**The ~6-month token.** Garmin tokens live at `~/.garminconnect/garmin_tokens.json` and last ~6 months.
`npm run doctor` warns once the token passes **150 days** old (`GARMIN_REAUTH_WARN_DAYS`, `src/health.ts:29`)
so a silent break is caught early. Re-auth with the same `garmin-mcp-auth` command. If a coach flow returns
Garmin-null, first suspect an expired token — this is triage, covered in `endurance-coach-debugging-playbook`.

---

## 4. Known traps at setup / build time

| Symptom | Cause | What to do |
|---|---|---|
| `npm run auth:aie` hangs / "no browser" / on a cloud box | OAuth needs a browser + `localhost:8765` callback; a headless/sandbox agent can't do it | **Host-only.** Hand off to the human on the Mac. Not fixable remotely. |
| `Host not in allowlist` / connection error from `npm run doctor` | outbound HTTPS to `aiendurance.com` / `api.anthropic.com` is being blocked (locked-down net or sandbox) | allow-list those hosts (plus Garmin's if enabled) for egress |
| `npm test` / `typecheck` red on a **fresh** clone | usually Node < 20, or `npm install` didn't complete | `node --version` (need ≥ 20); re-run `npm install`; then re-run the gate |
| ESM / "cannot find module './x'" for a `.ts` file | Node16 module resolution: imports must use the `.js` extension even for `.ts` sources | import `./x.js`, not `./x` or `./x.ts` (see `tsconfig.json`: `module`/`moduleResolution` = `Node16`) |
| `npm audit` flags esbuild | old, dev-only transitive advisory via `tsx` | **Already resolved** — lockfile is on `esbuild@0.28.1`, `npm audit` reports **0 vulnerabilities** (as of 2026-07-04). Keep it clear on dependency bumps; it never shipped to production (dev-only). |
| Garmin sync returns null / no biomechanics | token expired (~6mo), or `garmin_mcp` build predates `d31de79` (no `download_activity_file`) | re-run `garmin-mcp-auth`; confirm the pin; or export originals manually. Triage: `endurance-coach-debugging-playbook`. |
| **Claude desktop app** MCP dead: `No such file or directory` | the desktop-app config (`~/Library/Application Support/Claude/claude_desktop_config.json`) pinned a **versioned** node path (`/opt/homebrew/Cellar/node/<ver>/bin/node`) that a Homebrew node upgrade deleted | repoint to the stable symlink `/opt/homebrew/bin/node`, then **full quit + reopen** the desktop app (it caches the config in memory and re-clobbers external edits at least once). See the callout below. |

### Desktop-MCP node-path breakage (real incident, 2–3 Jul 2026)

The Claude **desktop app** spawns the coach's MCP via `bash -c cd <repo> && exec <node> --import tsx
src/mcpServer.ts`. Its config had pinned a version-specific Cellar node path; a Homebrew upgrade deleted the
old Cellar dir and every desktop launch failed. **Fix: use the symlink `/opt/homebrew/bin/node`** (follows
upgrades, won't rebreak). Gotchas:
- **Only the desktop app was affected.** The repo's committed `.mcp.json`, the launchd
  `com.endurance-coach.mcp` service, and Claude Code all use PATH-resolved `node`, so a node bump does **not**
  break them. If only the desktop surface is dead, suspect this config file first.
- The app caches the config in memory and re-clobbers an external file edit at least once, so the fix only
  takes effect after a **full quit + reopen** (or edit via the app's MCP settings UI). This file is the
  user's local desktop config, **outside the repo** — no commit/ship needed.

---

## 5. Where secrets and state actually live

Nothing sensitive is in the repo. Setup produces:

| Path | Contents | Perms |
|---|---|---|
| `~/.endurance-coach/aie-tokens.json` | AIE OAuth tokens (auto-refreshed) | `0600` (dir `0700`) |
| `~/.endurance-coach/aie-client.json`, `aie-verifier.txt` | OAuth client reg + PKCE verifier | `0600` |
| `~/.garminconnect/garmin_tokens.json` | Garmin tokens (~6mo life) — only if Garmin enabled | (owned by `garmin-mcp-auth`) |
| `/Users/maxeskell/dev/personal-training-app/.env` | Anthropic key + local config | — |
| `data/` (in-repo, **gitignored**) | assembled state, archive, cost log, decisions — the app writes it | — |

The secrets dir defaults to `~/.endurance-coach` and is overridable with `COACH_SECRETS_DIR`
(`src/config.ts:323`). The runtime `data/` artifact map (state, archive, cost-log, decisions) belongs to
`endurance-coach-run-and-operate`.

---

## 6. Fast reference — the setup npm scripts

| Command | What it does | Needs |
|---|---|---|
| `npm install` | install deps (Node ≥ 20) | Node ≥ 20 |
| `npm run typecheck && npm test` | the green gate (typecheck + 730 hermetic tests) | nothing |
| `npm run demo` | dashboard on bundled sample data | nothing |
| `npm run setup` | interactive `.env` wizard | a TTY |
| `npm run auth:aie` | one-time AIE OAuth (host-only, browser) | AIE account + browser |
| `npm run verify:reads` | exercise every AIE read tool; confirm write-gate closed | AIE auth |
| `npm run state:today` | assemble + persist today's AthleteState | AIE auth |
| `npm run doctor` | health check: AIE token, API key, Garmin token age, AIE tool drift | — |

`npm run doctor` is the quickest post-setup sanity check; how to read its full output lives in
`endurance-coach-diagnostics-and-tooling`.

---

## Provenance and maintenance

**As of 2026-07-04.** Ground truth is the repo, not this file. Re-verify drift-prone facts with:

```bash
# Node engine requirement (expect: "node": ">=20")
cd /Users/maxeskell/dev/personal-training-app && node -e "console.log(require('./package.json').engines)"

# Test count + hermetic pass (expect ~730 pass, ~6s, 0 fail as of 2026-07-04)
cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 | tail -6

# esbuild pinned version + audit clean (expect 0.28.1 and "found 0 vulnerabilities")
cd /Users/maxeskell/dev/personal-training-app && grep -A2 '"node_modules/esbuild"' package-lock.json | grep version | head -1
cd /Users/maxeskell/dev/personal-training-app && npm audit 2>&1 | tail -2

# AIE OAuth callback port (expect 8765) and secrets dir default
cd /Users/maxeskell/dev/personal-training-app && grep -n "AIE_OAUTH_PORT\|/callback\|secretsDir:" src/config.ts

# Garmin uvx commit pin (expect …@d31de7980d652289e5368637261fcd17aa2c7d90 …)
cd /Users/maxeskell/dev/personal-training-app && grep -n "Taxuspt/garmin_mcp@" src/config.ts

# Garmin re-auth warning threshold (expect 150) and token filename (aie-tokens.json)
cd /Users/maxeskell/dev/personal-training-app && grep -n "GARMIN_REAUTH_WARN_DAYS" src/health.ts
cd /Users/maxeskell/dev/personal-training-app && grep -n "aie-tokens.json" src/mcp/oauthProvider.ts

# Setup scripts still exist (setup / auth:aie / demo / verify:reads / state:today)
cd /Users/maxeskell/dev/personal-training-app && node -e "const s=require('./package.json').scripts; ['setup','auth:aie','demo','verify:reads','state:today','typecheck','test'].forEach(k=>console.log(k, '=>', s[k]||'MISSING'))"
```

If any of these drifts, fix the fact here in the same spirit as the code+docs-move-together rule (see
`endurance-coach-change-control`). Cross-referenced siblings: `endurance-coach-run-and-operate` (serve/ship),
`endurance-coach-config-and-flags` (env catalog + adding flags), `endurance-coach-debugging-playbook` (live
triage), `endurance-coach-diagnostics-and-tooling` (`doctor` output), `endurance-coach-failure-archaeology`
(host-only-setup + desktop-MCP incidents).
