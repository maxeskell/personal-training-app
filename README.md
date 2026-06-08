# personal-training-app — Endurance Coach

A personal AI endurance coach for one athlete building to **Birmingham Triathlon** (A, 11 Jul 2026),
then a run-focused block to **Loch Ness Marathon** (B, 27 Sep 2026), with **Alderford** (B, 6 Sep 2026)
handled deliberately. It reads the plan from **AI Endurance** and (optionally) device data from
**Garmin**, interprets rather than re-plots, and gives evidence-based, individualised coaching.

## Approach

Per the [Build Spec](docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md) §1 decision gate:

- **Path A first (current step):** a Claude Project + AI Endurance MCP + coach persona — ~80% of the
  value, zero code. See **[docs/setup-path-a.md](docs/setup-path-a.md)**.
- **Path B (queued):** a small local-first orchestrator, justified because all three §1 needs apply
  (scheduling, dashboard, decision log). See **[docs/path-b-plan.md](docs/path-b-plan.md)**.

## Running the code (M1 + M2)

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
npm run race -- "Loch Ness"   # …or a named race
npm run propose -- "move my long run off race week"   # gated plan-adjustment proposals
npm run confirm -- <id>       # apply a proposal (the ONLY path that writes to AI Endurance)
npm run decline -- <id>       # dismiss a proposal

npm run ping                  # unattended morning readiness: verdict + report + desktop notification
npm run dashboard             # glanceable Today/Week/Trends/Race HTML, opened in your browser
npm run decisions             # view the decision log (audit trail)
npm run decisions -- retro <id> "how it held up"   # add a retrospective to a decision

# Schedule the 06:00 ping (macOS launchd; cron fallback on Linux):
npm run schedule:install      # optional HH MM args, e.g. -- 6 30
npm run schedule:uninstall
```

The four flows (readiness / weekly / propose+confirm / race) are the product. Every write goes
through the gate: `propose` only logs proposals + trade-offs; nothing changes until you `confirm`.

Garmin is **optional** — leave `GARMIN_ENABLED=false` and the coach runs on AI Endurance alone.
To enable it, run the one-time `garmin-mcp-auth` (see `.env.example`) then set `GARMIN_ENABLED=true`.

Layout: `src/mcp/` (AIE OAuth client + Garmin stdio client), `src/state/` (AthleteState, store,
baselines, sync-gaps), `knowledge/sports-science.md` (priors for the M3 LLM layer).

## Health & security

```bash
npm run doctor      # creds, Garmin token age (~6mo expiry), API key, AIE tool-drift
```

Secrets stay local and out of git: AI Endurance OAuth tokens live in `~/.endurance-coach` (0700),
Garmin tokens in `~/.garminconnect`, your `ANTHROPIC_API_KEY` in `.env`. `data/`, `reports/`, `*.log`,
and token dirs are gitignored; token-shaped strings are redacted from logs and notifications.

## Specs (source of truth)

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
