---
name: endurance-coach-config-and-flags
description: >
  Load this for ANY question about the Endurance Coach app's environment variables / feature flags /
  config knobs — "what does COACH_X do", "what is the default for AIE_MCP_URL / GARMIN_MCP_ARGS /
  COACH_MCP_TOKEN", "how do I add a new env var / flag", "which flags are experimental or dangerous",
  "why is medical data hidden on the MCP server", "how do I turn on LAN / phone access", "how do I
  expose the MCP server to Claude Cowork", "why won't the HTTP MCP server start (token too short)",
  "is COACH_DEPLOY_BRANCH dead code", "audit config drift / is a var undocumented", configuring
  weather (COACH_WEATHER_LAT/LON, COACH_SWIM_MIN_WATER_C), Garmin (GARMIN_ENABLED + the uvx pin),
  the intent router (COACH_INTENT_ROUTER / COACH_LOCAL_INTENT), MCP auth
  (COACH_MCP_AUTH / READONLY / PROFILE_WRITE / FILE_ACCESS / EXPOSE_MEDICAL), pricing overrides
  (COACH_PRICE_*), timeouts, or where config.ts parses each var. Also: "which file reads this env var",
  "why is config.ts not the only parser". Don't load for HOW to run/serve/ship the app (use
  endurance-coach-run-and-operate) or first-time build/OAuth setup (use endurance-coach-build-and-env).
---

# Endurance Coach — config and flags

**Use this when** you need the effect, default, consumer file, and safety class of any environment
variable / feature flag in this repo; when adding a new flag (the definition-of-done); or when auditing
whether config has drifted (a var read in code but undocumented, or documented but dead).

**Don't use this when** the task is *operating* the app (starting the dashboard, `npm run ship`, the
launchd services) → **`endurance-coach-run-and-operate`**; or *setting up from a fresh clone*
(Node/OAuth/Garmin auth) → **`endurance-coach-build-and-env`**. This skill is the catalog and the
add-a-flag/drift discipline, not the runbook.

Repo root everywhere below: `/Users/maxeskell/dev/personal-training-app`.

---

## Jargon, defined once

- **env var / flag** — a `NAME=value` line in `.env` (gitignored; copy from `.env.example`) or exported
  in the shell. The app reads it via `process.env.NAME`.
- **`config.ts`** — `src/config.ts`, the central typed config object. It is the *primary* parser: it
  reads most env vars, applies defaults, and exports a frozen `config`. A handful of files read
  `process.env` directly by design (listed below) — `config.ts` is not the *only* parser.
- **safety class** (this skill's column): **production** = safe default, meant to be tuned; **advanced**
  = works but you must know what you're doing (local LLM, embeddings, tunnels); **security** = widens the
  attack surface if set — safe default is OFF/localhost.
- **MODEL / estimate** — anything computed, not measured. Not relevant to raw config, but weather
  thresholds below *feed* a MODEL (road-dryness, water-temp drift).

---

## The one rule that catches most config bugs

`config.ts` reads MOST vars, but **these files read `process.env` directly** (verify with
`grep -rlE 'process\.env\.' src`):

| File | Vars it reads directly | Why not in `config.ts` |
|---|---|---|
| `src/server.ts` | `COACH_PORT`, `COACH_LAN`, `COACH_HOST`, `COACH_ALLOWED_HOSTS` | Server-bind concerns; server.ts owns the socket |
| `src/serverAuth.ts` | `COACH_TOKEN`, `COACH_MCP_TOKEN` | Token loading (env → persisted file fallback) |
| `src/health.ts` | `ANTHROPIC_API_KEY` | Liveness probe checks key presence |
| `src/llm/client.ts`, `src/llm/haikuRouter.ts` | `ANTHROPIC_API_KEY` | Guard: is an LLM call even possible |
| `src/archive/activityArchive.ts` | `COACH_ARCHIVE_DIR` | Archive path, derived from `config.dataDir` |
| `src/insights/fit.ts` | `FIT_STREAMS_DIR` | Stream dir, derived from `config.dataDir` |
| `src/cli/dataCommands.ts` | `COACH_ARCHIVE_HEAL_CHUNK` | CLI-flag fallback for `archive:heal` |
| `scripts/ship.sh`, `scripts/autoupdate.sh` | `COACH_DEPLOY_BRANCH` (shell `${…:-main}`) | Deploy scripts, not TypeScript |

> **Drift trap (settled 2026-07-04):** a prior scan flagged `COACH_DEPLOY_BRANCH` as *dead code*. It is
> **not** — it is read by `scripts/ship.sh:17` **and** `scripts/autoupdate.sh:17`
> (`DEPLOY_BRANCH="${COACH_DEPLOY_BRANCH:-main}"`). The scan only grepped `src/*.ts`. **Any config-drift
> check MUST include `scripts/` and the direct-reader files above, not just `config.ts`.**

---

## Full env catalog (67 vars, as of 2026-07-04)

`.env.example` and code agree exactly (66 `process.env.*` in `src`+`scripts`, plus shell-only
`COACH_DEPLOY_BRANCH`, = 67; every one is documented in `.env.example`). **`ANTHROPIC_API_KEY` is the
only var most people need** — everything else has a safe default and the app runs with an almost-empty
`.env`. "Consumed at" = the file/line to open. Line numbers may drift — re-verify with the grep in
Provenance.

### AI Endurance — the required spine (production)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `AIE_MCP_URL` | `https://aiendurance.com/mcp` | `config.ts:76` | AIE MCP endpoint. Rarely changed. |
| `AIE_OAUTH_PORT` | `8765` | `config.ts:79` | Loopback port for the OAuth redirect (`http://localhost:<port>/callback`). |
| `AIE_TIMEOUT_MS` | `20000` | `config.ts:83` | Hard cap (ms) on a connect OR one AIE tool call. A headless flow fails fast with "run `npm run auth:aie`" rather than hanging on a browser it can't open. The interactive `auth` wait is exempt. |
| `COACH_RETRY_ATTEMPTS` | `3` | `config.ts:106` | Attempts (incl. first) for transient 429/5xx on **read-only** spines (AIE reads, weather). Writes are NEVER retried. Non-numeric → 3. |

### Anthropic LLM + pricing (production)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | _(unset)_ | `llm/client.ts:47`, `health.ts:44`, `haikuRouter.ts:24` | **The one required var for LLM flows** (readiness/weekly/race/ask/session/…). Deterministic flows (state, doctor, dashboard cards, weather, cost) make zero LLM calls and need no key. |
| `COACH_LLM_TIMEOUT_MS` | `120000` | `config.ts:93` | Wall-clock cap (ms) on an INTERACTIVE coach LLM call. Long STREAMED flows (weekly/race/deep-dive/research) get **3×** this via `longTimeoutMs` (`config.ts:97`). |
| `COACH_PRICE_INPUT` | `5` | `config.ts:136` | Opus input $/million tokens — **cost-log accounting only, never sent anywhere.** |
| `COACH_PRICE_OUTPUT` | `25` | `config.ts:137` | Opus output rate. |
| `COACH_PRICE_CACHE_WRITE` | `6.25` | `config.ts:138` | 5-min-TTL cache-write rate (1.25× input). |
| `COACH_PRICE_CACHE_READ` | `0.5` | `config.ts:139` | Cache-read rate (0.1× input). |
| `COACH_PRICE_HAIKU_INPUT` | `1` | `config.ts:148` | Haiku input rate (intent-router micro-calls). |
| `COACH_PRICE_HAIKU_OUTPUT` | `5` | `config.ts:149` | Haiku output rate. |
| `COACH_PRICE_HAIKU_CACHE_WRITE` | `1.25` | `config.ts:150` | Haiku cache-write. |
| `COACH_PRICE_HAIKU_CACHE_READ` | `0.1` | `config.ts:151` | Haiku cache-read. |

### Garmin — optional, degradable (production, off by default)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `GARMIN_ENABLED` | `false` | `config.ts:113` | Turn on the optional Garmin gap-filler. Requires `=== "true"`. |
| `GARMIN_MCP_COMMAND` | `uvx` | `config.ts:117` | Spawn command for the `Taxuspt/garmin_mcp` stdio server. |
| `GARMIN_MCP_ARGS` | pinned commit `d31de79…` | `config.ts:118` | uvx args. **Pinned to the commit that added `download_activity_file` (raw .FIT download).** Keep the pin ≥ `d31de79` or raw-.FIT auto-download degrades to manual export. Bump deliberately. |
| `GARMIN_TIMEOUT_MS` | `25000` | `config.ts:124` | Hard cap (ms) on any single Garmin call. |
| `GARMIN_REFRESH_BUDGET_MS` | `90000` | `config.ts:127` | Overall wall-clock budget for the whole Garmin phase of one `/refresh`; past it, remaining Garmin reads are skipped (degrade to AIE-only) so one slow tool can't hang a sync. |

### `ask` intent router + local LLM (advanced, off by default)
Coaching output ALWAYS stays on Opus; the router only decides single-session vs general routing and
degrades to zero-cost regex on any error.
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `COACH_INTENT_ROUTER` | `regex` | `config.ts:160` | `regex` (zero-cost) · `haiku` (cheap `claude-haiku-4-5` micro-call on your existing key) · `local` (Ollama). Unknown → falls to the `COACH_LOCAL_INTENT` legacy check. |
| `COACH_LOCAL_INTENT` | `false` | `config.ts:163,173` | Legacy alias: `true` ⇒ router `local` AND enables the local client. **`COACH_INTENT_ROUTER=local` alone selects the router but leaves the client OFF** — it degrades to regex until `COACH_LOCAL_INTENT=true`. |
| `LOCAL_LLM_URL` | `http://localhost:8000/v1` | `config.ts:175` | OpenAI-compatible Ollama wrapper base URL (incl. `/v1`; trailing slash trimmed). |
| `LOCAL_LLM_API_KEY` | _(empty)_ | `config.ts:177` | Bearer token; empty = server auth disabled. |
| `LOCAL_LLM_MODEL` | `llama3.2:1b` | `config.ts:178` | Router model. |
| `LOCAL_LLM_TIMEOUT_MS` | `4000` | `config.ts:180` | Fall back to regex past this. |

### Advice clustering — embeddings de-dup (advanced, off by default)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `COACH_ADVICE_CLUSTERING` | `false` | `config.ts:193` | Sync-time pass embeds "Coach's recommendations" and collapses the same idea phrased differently. Off render path; degrades to per-source grouping. |
| `LOCAL_LLM_EMBED_MODEL` | `nomic-embed-text` | `config.ts:197` | Embedding model (must be pulled in Ollama). |
| `COACH_ADVICE_CLUSTER_SIMILARITY` | `0.86` | `config.ts:199` | Cosine threshold (0–1) above which two recs are "the same idea". |
| `LOCAL_LLM_EMBED_TIMEOUT_MS` | `30000` | `config.ts:206` | Generous — a cold model load (~10–20 s) should complete, not skip clustering. |

### Weather + water (production)
Coordinates default to London (a neutral placeholder — set your own). Thresholds encode the athlete's
stated preferences; they feed MODELs (road-dryness, week-ahead verdicts), not raw config output.
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `COACH_WEATHER_ENABLED` | `true` | `config.ts:216` | `false` drops the "Week ahead" card entirely (requires `!== "false"`). |
| `COACH_WEATHER_LAT` | `51.5074` | `config.ts:217` | Weather base latitude. **Set to where you train.** |
| `COACH_WEATHER_LON` | `-0.1278` | `config.ts:218` | Weather base longitude. |
| `COACH_WATER_TEMP_C` | _(unset)_ | `config.ts:220` | Optional **SEED** only for the open-water temp. The live way is the dashboard water-temp box → `data/venue.json`; any confirmed reading (or a >7-day-old one forecast by air-temp drift, a MODEL) **wins over this var.** |
| `COACH_SWIM_MIN_WATER_C` | `13` | `config.ts:221` | Open-water comfort floor (°C). |
| `COACH_RIDE_MAX_GUST_KMH` | `38` | `config.ts:222` | Ride-comfort gust threshold. |
| `COACH_RIDE_MAX_RAIN_PROB` | `40` | `config.ts:223` | Ride-comfort rain-probability threshold (%). |
| `COACH_WEATHER_TIMEOUT_MS` | `6000` | `config.ts:224` | Open-Meteo fetch cap; past it the card degrades to a note. |
| `COACH_SWIM_CSS` | _(unset)_ | `config.ts:233` | Manual swim CSS (Critical Swim Speed) fallback, pace per 100 m — accepts `m:ss` (`1:52`) or bare seconds (`112`), gated 60–240 s/100 m. A CSS that comes through from AIE always wins. |

### Dashboard behaviour (production)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `COACH_AUTOSYNC_MIN` | `30` | `config.ts:239` | A page load with a snapshot older than this many minutes kicks a background sync. `0` disables. |
| `COACH_DAILY_BRIEF` | `true` | `config.ts:247` | The "brief" layer of the Today card (what-changed-since-yesterday diff). `false` hides it (requires `!== "false"`). No LLM. |
| `COACH_AUTO_SESSION_FEEDBACK` | `on` | `config.ts:265` | Deep session feedback throttle: `on` (every recent session with raw .FIT — **one LLM call each**) · `latest` (only the most recent) · `off` (on-demand `npm run session`). |
| `COACH_CAREER_PATH` | `data/career-history.json` | `config.ts:257` | Data file for the read-only `/career` page (built by `npm run career:build`). Missing file → empty-state (degrade-don't-crash). |

### Athlete identity + storage (production)
| Var | Default | Consumed at | Effect |
|---|---|---|---|
| `COACH_EQUIPMENT` | `Garmin Forerunner 970, Edge 1040, Index scale` | `config.ts:314` | Device kit AIE `getUser` doesn't expose. Clear to drop the kit line. |
| `COACH_UNITS` | `metric, UK` | `config.ts:315` | Unit preference (e.g. `imperial, US`). |
| `COACH_TZ` | _(unset)_ | `config.ts:19` | IANA timezone for "today". Precedence: `COACH_TZ` → profile `identity.timezone` → `Europe/London`. Set only to override the profile (e.g. travelling). |
| `COACH_SECRETS_DIR` | `~/.endurance-coach` | `config.ts:323` | Where OAuth tokens live (outside repo, 0700). |
| `COACH_DATA_DIR` | `./data` | `config.ts:326` | Where daily `AthleteState` + artifacts persist (gitignored). |
| `COACH_ARCHIVE_DIR` | `data/activity-archive` | `activityArchive.ts:32` | Durable dedup'd raw-activity archive (kept separate from `fit-streams` so it never slows the dashboard). Derived from `COACH_DATA_DIR` if unset. |
| `COACH_ARCHIVE_HEAL_CHUNK` | `200` | `dataCommands.ts:266` | Max .FIT files `npm run archive:heal` pulls per run (CLI `--chunk` overrides). |
| `FIT_STREAMS_DIR` | `./data/fit-streams` | `insights/fit.ts:28` | Raw .FIT streams for within-session signals (decoupling, temperature, run biomechanics). Derived from `COACH_DATA_DIR` if unset. |
| `COACH_PROFILE_PATH` | _(unset)_ | `config.ts:21,333` | Override the athlete-profile file. Default resolution: `profile.local.yaml` → `profile.example.yaml`. |
| `COACH_SOURCE` | `ai-endurance` | `config.ts:340` | The training-data spine. `ai-endurance` is the only supported value today; unknown falls back to it. |
| `COACH_DEPLOY_BRANCH` | `main` | `ship.sh:17`, `autoupdate.sh:17` | Branch the deploy/auto-update tracks. **NOT dead — see the drift trap above.** |

### Security-relevant flags — safe defaults are all OFF / localhost
> **These widen the attack surface. Read the "widens" column before flipping one.** The dashboard and
> the MCP HTTP surface can reach AIE *writes* and spend LLM budget, so exposure is not cosmetic.

| Var | Default | Consumed at | Widens what (turned on) | Guard that still holds |
|---|---|---|---|---|
| `COACH_LAN` | off (`!= "1"`) | `server.ts:64` | Binds `0.0.0.0` so a phone on the same Wi-Fi can reach the dashboard (else localhost only). | Per-install token still required; Host header allow-listed to the machine's own LAN IPs (`server.ts:69–80`, anti-DNS-rebind). |
| `COACH_HOST` | `127.0.0.1` (or `0.0.0.0` if `COACH_LAN=1`) | `server.ts:65` | The interface the dashboard binds. | — |
| `COACH_ALLOWED_HOSTS` | _(empty)_ | `server.ts:79` | Extra allowed `Host` values (e.g. a stable Tailscale IP/MagicDNS name) so one URL survives reboots. Needs `COACH_LAN=1`. | Static allow-list; anything else is rejected. |
| `COACH_TOKEN` | random, persisted `<secretsDir>/dashboard.token` (0600) | `serverAuth.ts:15` | Sets the dashboard's per-install secret explicitly. | Unset is safest — a strong random token is auto-generated. |
| `COACH_MCP_TOKEN` | random, persisted `<secretsDir>/mcp.token` (0600) | `serverAuth.ts:35` | Sets the MCP HTTP bearer token. **Must be ≥16 chars in `token`/`oauth` mode or the server refuses to start** (`mcpHttp.ts:77,136–144`). | Unset auto-generates a strong one. |
| `COACH_MCP_AUTH` | `token` | `config.ts:302` | `token` (static bearer) · `oauth` (OAuth 2.1 DCR+PKCE, required by Claude Cowork) · **`none` = no auth — only behind a private tunnel you fully trust.** | `oauth` requires `COACH_MCP_PUBLIC_URL`. |
| `COACH_MCP_READONLY` | `false` | `config.ts:281` | `true` = **drops** propose/confirm/decline (the gated write tools) from the HTTP surface → reads only. Turning it ON is *safer*, not wider. | — |
| `COACH_MCP_PROFILE_WRITE` | `false` | `config.ts:285` | `true` = expose `update_profile` on the HTTP/Cowork surface (a REMOTE session can write `profile.local.yaml`). Always on for local stdio. | Validated: the no-live-numbers guard (`profile/schema.ts assertNoLiveNumbers`) rejects FTP/weight/HRV/etc. either way. |
| `COACH_MCP_FILE_ACCESS` | `false` | `config.ts:291` | `true` = expose `read_file`/`write_file`/`list_files` on the HTTP/Cowork surface. Always on for local stdio. | Hard-scoped to the repo; a secrets deny-list (`.env*`, `*.token(s)`/keys, `.git/`, `node_modules/`) is enforced regardless — secrets are never readable/writable. |
| `COACH_MCP_EXPOSE_MEDICAL` | `false` | `config.ts:296` | `true` = expose medical context (medication + dose cycle, blood panels, DOB) on the HTTP/Cowork surface (via `get_profile` + the coaching prompt). **Withheld by default so a bearer-token holder on the remote surface can't read it.** Always ON for local stdio / CLI / LAN dashboard (your own data on your own machine). | Set once at startup (`mcpHttp.ts:135`). |
| `COACH_MCP_HOST` | `127.0.0.1` | `config.ts:279` | Interface the MCP HTTP server binds (keep localhost; the tunnel reaches it). | — |
| `COACH_MCP_PORT` | `8787` | `config.ts:280` | Local MCP HTTP port. | — |
| `COACH_MCP_PUBLIC_URL` | _(unset)_ | `config.ts:305` | Public HTTPS tunnel URL. **REQUIRED when `auth=oauth`** (the OAuth issuer must be publicly reachable, not localhost). Also read by `npm run health-remote`. | — |

**Why medical is hidden on the MCP server:** the HTTP/Cowork surface is internet-reachable through a
tunnel and only guarded by a bearer token. Medical detail is more sensitive than training data, so it is
**opt-in per install** — never leaked by default to a remote holder of the token. Local stdio/CLI/LAN run
as the user, on the user's own data, so medical is always on there.

---

## How to add a new flag (definition of done — all in ONE commit)

Adding a knob is a "config change" per `CLAUDE.md`; code and docs move together. Do **all** of these on a
feature branch (never on `main` — see `endurance-coach-change-control`):

- [ ] **Parse + default in `src/config.ts`** — the primary parser. Only read `process.env` directly in
      another file if it genuinely belongs to that subsystem's boundary (server bind, token load, LLM-key
      guard, path derivation) — match the existing direct-reader pattern, don't invent a new one.
- [ ] **Commented entry in `.env.example`** — every new var, with a one-line comment stating default +
      effect + safety note. This is the catalog; the drift check below asserts parity.
- [ ] **Doc it** — `README.md` (user-facing behaviour) and/or `HANDOVER.md §7` "Config knobs" table if
      it's a var people will touch. (Docs map → `endurance-coach-docs-and-writing`.)
- [ ] **Add a test if it gates behaviour** — see `test/config.test.ts` (precedence), `test/thresholdParse.test.ts`
      (`COACH_SWIM_CSS` parser) for the pattern: pure, fixture-driven, no network. (Test conventions →
      `endurance-coach-validation-and-qa`.)
- [ ] **Security class:** if the flag widens exposure (a new remote surface, a new write path, a bind
      change), default it OFF, document what it widens AND the guard that still holds, and never let it
      route around the propose→confirm write gate or the wellbeing gate.
- [ ] **Green gate:** `npm run typecheck && npm test` pass before commit.

---

## Config-drift audit (run these — don't eyeball)

Run from the repo root. These are the exact one-liners; a fuller `config-drift.sh` lives in
**`endurance-coach-diagnostics-and-tooling`** (which ships the scripts) — use that for CI-style checks.

```bash
cd /Users/maxeskell/dev/personal-training-app

# 1) Vars READ in code (src + scripts, incl. shell) but MISSING from .env.example — must print nothing.
comm -23 \
  <( { grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*' src scripts | sed 's/process\.env\.//'; \
       grep -rhoE 'COACH_DEPLOY_BRANCH' scripts; } | sort -u ) \
  <( grep -oE '^#?[[:space:]]*[A-Z_][A-Z0-9_]*=' .env.example | tr -d '#= ' | sort -u )

# 2) Vars DOCUMENTED in .env.example but never read in code (possible stale) — must print nothing.
comm -13 \
  <( { grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*' src scripts | sed 's/process\.env\.//'; \
       grep -rhoE 'COACH_DEPLOY_BRANCH' scripts; } | sort -u ) \
  <( grep -oE '^#?[[:space:]]*[A-Z_][A-Z0-9_]*=' .env.example | tr -d '#= ' | sort -u )

# 3) Count — expect 67 on both sides (66 process.env in TS + shell-only COACH_DEPLOY_BRANCH).
{ grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*' src scripts | sed 's/process\.env\.//'; echo COACH_DEPLOY_BRANCH; } | sort -u | wc -l
grep -oE '^#?[[:space:]]*[A-Z_][A-Z0-9_]*=' .env.example | tr -d '#= ' | sort -u | wc -l
```

> **The `scripts/` grep is load-bearing.** Dropping it re-creates the `COACH_DEPLOY_BRANCH` "dead code"
> false positive. A config-drift check that only looks at `src/*.ts` is wrong.

---

## Cross-references (don't duplicate — go here)

| Need | Skill |
|---|---|
| Start/serve/ship the app, launchd services, the `lsof … ; launchctl list` runner diagnostic | `endurance-coach-run-and-operate` |
| Fresh-clone build, Node/tsx, AIE OAuth (`auth:aie`), Garmin `garmin-mcp-auth` + the uvx pin | `endurance-coach-build-and-env` |
| The change gate / definition-of-done rationale, branch-then-ship, the write gate | `endurance-coach-change-control` |
| `config-drift.sh` / `verify-runbook.sh` scripts, `npm run doctor` interpretation | `endurance-coach-diagnostics-and-tooling` |
| Test conventions for a flag's test, CI contract | `endurance-coach-validation-and-qa` |
| Which doc a config change must touch, house style | `endurance-coach-docs-and-writing` |
| The propose→confirm write-gate invariant a flag must not bypass | `endurance-coach-architecture-contract` |

---

## Provenance and maintenance

- **Verified against the repo on 2026-07-04** (branch `main`). Line numbers in `config.ts` and the
  direct-reader files are from that snapshot and drift on edits — re-verify before quoting a line.
- **Re-verify the catalog is complete (66 TS vars + 1 shell = 67):**
  `cd /Users/maxeskell/dev/personal-training-app && grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*' src scripts | sed 's/process\.env\.//' | sort -u | wc -l` (expect 66) — the +1 is shell-only `COACH_DEPLOY_BRANCH`.
- **Re-verify no config drift:** run the two `comm` one-liners in "Config-drift audit" above — both must
  print nothing (last checked 2026-07-04: clean, both sides 67).
- **Re-verify `COACH_DEPLOY_BRANCH` is live (not dead):**
  `grep -rn 'COACH_DEPLOY_BRANCH' scripts` (expect hits in `ship.sh` and `autoupdate.sh`).
- **Re-verify a var's default/consumer:** `grep -n 'VARNAME' src/config.ts .env.example` and, for
  direct-readers, `grep -rn 'process.env.VARNAME' src scripts`.
- **Re-verify the direct-reader set (files reading `process.env` besides config.ts):**
  `grep -rlE 'process\.env\.' src | sort`.
- **Re-verify the MCP token min-length guard (≥16):** `grep -n 'MIN_TOKEN_LEN' src/mcpHttp.ts`.
- **Re-verify the no-live-numbers guard behind `COACH_MCP_PROFILE_WRITE`:**
  `grep -n 'assertNoLiveNumbers' src/profile/schema.ts`.
- Nothing here overrides `CLAUDE.md`, `CONTRIBUTING.md`, or `HANDOVER.md`; where they disagree with this
  skill, the repo wins — fix this file.
