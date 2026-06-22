# Command reference

Everything the coach can do. Most days you only need the handful in the README's
[Everyday commands](../README.md#everyday-commands); this is the complete surface, grouped by what
you're trying to do. All commands are run from the repo root.

The first few groups (**setup → daily coaching → dashboard → plan changes → analysis**) are the product
you use day to day. The later groups (**device sync, MCP server, hands-free automation, maintenance**) are
**operations: set up once, then rarely touched** — skip them until you need them. Many `*:install`
commands are macOS launchd helpers that print a Linux cron/systemd equivalent and no-op elsewhere.

> The LLM flows (readiness, weekly, race, deep-dive, tune, research, ask, session, propose) need
> `ANTHROPIC_API_KEY`. The deterministic ones (demo, state, dashboard, check, cost, listening, decisions,
> verify, doctor) make **no LLM call** and need no key.

## First-time setup
| Command | What it does |
|---|---|
| `npm install` | install dependencies |
| `npm run setup` | **guided wizard** — asks for key/units/location/Garmin and writes `.env` for you (the one-command version of editing `.env` by hand); also offers the profile intake |
| `npm run profile:init` | copy `profile.example.yaml` → `profile.local.yaml` (gitignored) and walk the required profile fields — **pre-filled from your connected integrations** (name/sex from AI Endurance, units/timezone from `.env`, all upcoming races from your AIE goals, a MODEL estimate of weekly hours, and DOB + height from **Garmin** `get_user_profile` when enabled). Prints a summary then a **[Y/n] confirm** — Y keeps the pull and asks only for the required gaps, n drops into per-field override. DOB is only asked when Garmin didn't supply it. Degrades to a full manual flow if AI Endurance is unreachable. **Re-running on an existing profile MERGES** — hand-entered biomechanics/medication/equipment/fuelling/notes are kept, only integration-sourced fields are refreshed (never rebuilt from the template) ([docs/profile.md](profile.md)) |
| `npm run profile:questions` | list the **optional** profile fields you can fill whenever you like — each with a plain-language question and a one-line *why it changes your coaching* (deterministic, no LLM). `-- --write-doc` regenerates [docs/profile-questions.md](profile-questions.md) from the same source ([src/profile/questions.ts](../src/profile/questions.ts)) |
| `npm run auth:aie` | one-time AI Endurance OAuth (opens a browser); tokens cached in `~/.endurance-coach` |
| `npm run verify:reads` | exercise every read tool and confirm the write-gate is closed |
| `npm run state:today` | assemble + persist + summarise today's AthleteState |
| `npm run doctor` | health check: creds, Garmin token age, API key, AI Endurance tool drift |

## Daily coaching
| Command | What it does |
|---|---|
| `npm run readiness` | green/amber/red verdict with cited drivers + a wellbeing check |
| `npm run weekly` | weekly review (load by sport, adherence, trends, next-week focus) → dated report |
| `npm run race` / `npm run race -- "<name>"` | race-specific prep for the next (or a named) race → report |
| `npm run ask -- "<question>"` | free-form Q&A over your data + insights |
| `npm run session` / `npm run session 2026-06-09` | deep feedback on one session (needs its raw `.FIT`; `--force` for summary-only) |
| `npm run splits` / `npm run splits 2026-06-09 --sport swim` | per-interval splits (laps/lengths) from a session's raw `.FIT`; for a swim test also a CSS estimate (400/200, with a maximal-effort confidence check). `--t400 6:20 --t200 3:00` computes CSS straight from times (no `.FIT` needed). Read-only — set CSS in AI Endurance yourself |
| `npm run ingest-fit` / `npm run ingest-fit <path>` | manual-export fallback: report the watched `.FIT` streams dir, or validate + copy in an exported `.FIT` (Garmin Connect → Export Original) so `splits` / `session` can read it |
| `npm run ftp-check` | bike-FTP source diagnostic — configured FTP vs Garmin's power-duration estimate, the gap, recent power coverage, and how to resolve it; read-only (verify/apply in AI Endurance yourself) |
| `npm run check` | fire-only health watch — alerts only if a flag / early-warning fires (no LLM) |

## Dashboard & phone
| Command | What it does |
|---|---|
| `npm run demo` | render the dashboard from built-in sample data (no account/key/network) |
| `npm start` | run the coach — alias for `npm run serve` (the everyday "run it" command) |
| `npm run dashboard` | generate + open a one-off glanceable view (add `--share` for a redacted screenshot view) |
| `npm run serve` | run the always-on local dashboard (localhost; prints a `/pair?token=…` link) |
| `COACH_LAN=1 npm run serve` | also bind the LAN so a phone on the same Wi-Fi can open it (still token-gated) |

## Plan changes (gated — the only path that writes to AI Endurance)
| Command | What it does |
|---|---|
| `npm run propose -- "<request>"` | draft plan adjustments — logs each proposal + trade-off + an id; writes nothing |
| `npm run act` | turn surfaced (gated, feedback-aware) findings into grounded proposals |
| `npm run confirm -- <id>` | **apply** a proposal — the only command that mutates AI Endurance |
| `npm run decline -- <id>` | dismiss a proposal |

## Deeper analysis
| Command | What it does |
|---|---|
| `npm run deep-dive` | insight-engine analysis (load/EF/durability/ramp/goal) → report |
| `npm run season` | multi-season strategic review: CTL arc / phases / structural levers → report (also the `/season` page; deterministic digest with no API key) |
| `npm run listening` | engagement model: what you act on vs dismiss, plan adherence + plan changes |

## Fuelling
| Command | What it does |
|---|---|
| `npm run fuelling` | per-session pre/during/after from the nutrition you log in `profile.local.yaml` (`fuelling.products`) — deterministic, only what a session needs ("water's fine" for short/easy). The dashboard shows just the **next** session; this prints the week |
| `npm run fuel-review` | learning review over your fuel log: observed carb/hr tolerance, what sits well per sport, caffeine/timing, suggested profile tweaks (needs ≥3 logged sessions; wellbeing-screened) |

## Marginal gains & keeping knowledge current
| Command | What it does |
|---|---|
| `npm run tune` | weekly marginal gains: the smaller, easy-to-action tweaks (not "train more") → report |
| `npm run research` | monthly web-grounded digest of new training/gear thinking → a review proposal (gated) |
| `npm run knowledge` | knowledge-layer freshness + pending digests |
| `npm run knowledge -- approve <file>` | fold an approved digest into the coach's priors |

## Feedback, audit & cost
| Command | What it does |
|---|---|
| `npm run decisions` | view the decision log (audit trail of calls, feedback, proposals) |
| `npm run decisions -- retro <id> "<note>"` | add a retrospective to a logged decision |
| `npm run cost` / `npm run cost 14` | token-cost report by flow (today/7d/30d/all + monthly projection; or an N-day window) |

## Device data & history (Garmin)
| Command | What it does |
|---|---|
| `npm run fit-sync` | download recent Garmin activity summaries + raw `.FIT` (also runs on dashboard Sync; auto-archives each `.FIT`) |
| `npm run archive:import -- --from <dir>` | import an activity-file export (`.fit`/`.tcx`/`.pwx`/`.gpx`, gz ok) into the durable `data/activity-archive/`, deduped; no `--from` → status |
| `npm run archive:backfill` (`-- --chunk N`) | pull raw `.FIT` for your whole Garmin history into the archive — resumable, throttled, skips already-archived |
| `npm run backfill` | archive full history (AI Endurance + Garmin) → `data/archive/` (resumable) |
| `npm run backfill:status` | archived counts + date ranges |
| `npm run backfill:compact` | de-duplicate the archive files in place (safe to re-run) |
| `npm run probe` | dump the live Garmin tool surface + AIE detail samples → `reports/` (for mapping) |

## Use the coach from Claude (MCP server)
| Command | What it does |
|---|---|
| `npm run mcp` | expose the coach over MCP (stdio) for Claude Desktop / Claude Code — see [docs/mcp-server.md](mcp-server.md) |
| `npm run mcp:http` | …or over HTTP (localhost + auth) for Claude Cowork via an HTTPS tunnel |
| `npm run health-remote` | probe the public tunnel `/health` and alert if the connector is down/needs re-auth |

## Hands-free automation (macOS launchd; prints a Linux cron/systemd equivalent)
| Command | What it does |
|---|---|
| `npm run ping` | unattended morning readiness: verdict + report + desktop notification |
| `npm run schedule:install` (`-- HH MM`) | schedule the daily `ping` (e.g. `-- 6 30`); `schedule:uninstall` to remove |
| `npm run watch:install` (`-- HH MM`) | proactive daily watch (fit-sync + fire-only check); `watch:uninstall` to remove |
| `npm run serve:install` / `serve:uninstall` | keep the dashboard server running at login |
| `npm run autoupdate:install` / `autoupdate:uninstall` | fast-forward pull + restart on a timer |
| `npm run mcp:install` / `mcp:uninstall` | run the MCP HTTP server as a background service |
| `npm run healthcheck:install -- <https-url>` | schedule the remote `/health` probe |
| `npm run backfill:install` / `backfill:uninstall` | nightly history archive |
| `npm run update` | one-off fast-forward pull + restart |

## Maintenance & development
| Command | What it does |
|---|---|
| `npm run help` | the curated everyday commands (a short version of this page) |
| `npm test` | unit tests (node:test, no network) |
| `npm run typecheck` | TypeScript typecheck |
| `npm run build` | compile to `dist/` |
