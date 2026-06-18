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
| `npm run profile:init` | copy `profile.example.yaml` → `profile.local.yaml` (gitignored) and walk the required profile fields ([docs/profile.md](profile.md)) |
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
| `npm run listening` | engagement model: what you act on vs dismiss, plan adherence + plan changes |

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
| `npm run fit-sync` | download recent Garmin activity summaries + raw `.FIT` (also runs on dashboard Sync) |
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
