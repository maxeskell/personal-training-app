# 11 — AI Endurance token loss (30 Aug 2026) and the re-auth path that couldn't see it

**Status:** ✓ phase 1 landed 2026-09-03 — the recovery command works again and a rejected token is
retired, never deleted; ✓ phase 1b same morning — reads bypass the SDK's output-schema check (see below) ·
**Open:** phases 2–4 below · **Opened:** 2026-09-02 · **Owner:** Max

## Symptom

On Wednesday 2 Sep the dashboard still said "Last session — 08-29 Swim" under a fresh-looking
"Data last updated Wed 2 Sep 2026, 20:56", and Today read "nothing planned (rest day)" on a day with a ride.
Every AI Endurance (AIE) slot in `data/state/2026-09-0{1,2}.json` was null with
`raw.get* = "authorization is missing or expired"`; `data/archive/activities.jsonl` stopped at 28 Aug;
`data/session-feedback.jsonl` stopped at the 29 Aug swim. No code had changed since 25 Aug.

## Root cause (three layers, each verified against the machine)

1. **The token file was gone.** `~/.endurance-coach/aie-tokens.json` was removed at 12:03:59 on Sat 30 Aug
   (directory mtime). The only code path that removes that file alone is the MCP SDK's `auth()` calling
   `invalidateCredentials('tokens')` after the token endpoint answered `invalid_grant` on a refresh
   (`@modelcontextprotocol/sdk` `client/auth.js`), which our provider turned into an `rm`. The client
   registration (`aie-client.json`, 8 Jun) was untouched, so the `'all'` branch never fired.
2. **Why the refresh token was dead.** The unified log shows exactly one job in that window — the 20-min
   `health-remote` probe at 12:03:57, inside a 2-second DarkWake while the Mac slept with the lid closed
   since the evening before. Its probe carried an expired bearer, got a 401 on `initialize`, refreshed, and
   was refused. The refresh token had most plausibly been rotated away by the **06:01:52 morning ping**, which
   launched in another 2-second DarkWake, was suspended mid-request, then logged
   `AI Endurance connect timed out after 20000ms` and exited — the rotated token's reply was never saved.
   The same "06:00 connect timeout → next run re-auth needed" signature precedes **all three** token losses
   (1 Jul, 25 Aug, 30 Aug 2026). A server-side revocation by AIE would end in the identical deletion and
   cannot be excluded locally (MODEL; only AIE's token logs separate the two).
3. **Why nobody noticed for three days.** (a) The assemble path "continues on partial data" and saved a state
   with every AIE slot null and a fresh `assembledAt`, so the page looked current and the Set-up card's
   staleness item (keyed on sync age ≥ 72 h) never fired. (b) The 1 Sep ping "succeeded" — readiness GREEN on
   Garmin trend alone — so the doctor heartbeat stayed green; the catch-up saw AIE only 4 days behind and
   stayed silent; the weekly brief ran on empty data. (c) The deep health probe only `connect()`s, and AIE
   answers `initialize`/`tools/list` **without** a token, so the probe reported `aie=ok` for the last ~30 h and
   the macOS notifications stopped. (d) For the same reason `npm run auth:aie` would have printed
   "✓ Connected … Tokens cached" and written **no token** — the documented recovery was a no-op.

## What landed (phase 1, this branch)

- `src/mcp/oauthProvider.ts`: `invalidateCredentials('tokens'|'all')` **retires** the file to
  `aie-tokens.revoked-<time>.json` (0600) instead of `rm`; `saveTokens` is atomic (tmp + rename) and adds
  `saved_at`; one `[aie-oauth] <iso> pid=<pid> event=saved|invalidated(...) refresh=<8-hex fingerprint>` audit
  line per event (no secrets); one authorization flow at a time (`redirectToAuthorization` is idempotent, a
  mid-flow `saveCodeVerifier` keeps the first verifier, the loopback listen error rejects cleanly); the
  browser launcher and log sink are injectable for tests.
- `src/mcp/aieClient.ts`: `ensureAuthorized()` — one `getUser` read; a 401 in the interactive flow waits for
  the browser, exchanges the code, reconnects and repeats the read; `withoutSseGet()` answers the SDK's
  background event-stream GET with a local 405 so it can never start a second authorization; after a
  `ReauthRequiredError` further calls on that connection fail fast (no more 16 discovery round-trips + verifier
  rewrites per assemble).
- `src/health.ts`: `aieHealthProbe` does the read (injectable client; `reauth_needed` on
  `ReauthRequiredError`/`UnauthorizedError`); `fileChecks` lists retired copies; the "auto-refreshes" claim is gone.
- `src/cli.ts`: `auth:aie` prints "✓ authorized" only after `ensureAuthorized()`; `doctor` gains an
  "AI Endurance live read" line.
- Tests (`test/aieclient.test.ts`, `test/connectorhardening.test.ts`): headless/interactive `ensureAuthorized`,
  the SSE shim, retire-not-delete + atomic save + audit line, single-flow redirect, probe verdicts. Docs:
  README, `.env.example`, `docs/commands.md`, `docs/data-sources.md` (token lifecycle), HANDOVER, the
  debugging-playbook skill.

## Phase 1b — the read path was broken too (found by the new live-read line, 3 Sep 10:30)

The first `npm run doctor` after re-auth reported `AI Endurance live read ⚠ failed: MCP error -32600: Tool
getUser has an output schema but did not return structured content`. A probe (raw `tools/list` +
`tools/call`) showed AI Endurance now declares an `outputSchema` on **all 27 tools** while still answering
with text-only `content` — and MCP SDK ≥1.30's `Client.callTool()` throws on that combination for every
tool. With a valid token, every read would still have failed and the state would still have been all-null.
`AieClient.callOnce` now issues the raw `tools/call` request (`client.request(..., CallToolResultSchema)`),
which returns the same `content[].text` JSON the app has always parsed (`state/payload.ts extractJson`, which
prefers `structuredContent` whenever a server sends it, so nothing changes if AIE starts returning it).

## Still open (the plan; see the 2 Sep review)

- **Phase 2 — make the outage visible on every surface.** A per-source health block on `AthleteState`
  (`sources.aie = { ok, error, lastGoodAt }`) computed in `assembleState`; a top-of-page dashboard banner
  ("AI Endurance disconnected since <lastGoodAt> — run …") and honest Today/Last-session text when the plan
  and activities are unknown (not "rest day"); `Data last updated` split into assembled / AIE synced / Garmin
  synced; the MCP `get_state` stale warning keyed on source health, not the date; the ping records a
  *degraded* heartbeat (doctor shows it) when every AIE read failed; `recoverGaps` treats an unreachable AIE
  as stalled regardless of gap size; healthcheck notifications deduped (on change + one daily reminder).
- **Phase 3 — stop the sleep-split refresh.** Wrap the scheduled jobs in `caffeinate -i` and/or schedule a
  real wake (`pmset repeat wakeorpoweron … 05:58`), let the CLI drain an in-flight refresh before exiting,
  and give the token endpoint POST its own abort/timeout. Verify rotation empirically from the audit lines
  after re-auth (fingerprint changes per save ⇒ rotation confirmed).
- **Phase 4 — regenerate what was written blind.** After re-auth: `npm run catch-up`; re-assemble
  2026-09-0{1,2}; regenerate the 2026-08-24 weekly brief (its `bySportMin {}` / `ctl null` snapshot is now the
  baseline for the next week-over-week delta); let the sync backfill session readouts for the 30 Aug, 31 Aug
  and 2 Sep rides. Also: the readiness LLM call has exceeded its 120 s budget five times in `ping.log`
  (the 2 Sep ping died on it) — retry once or raise the unattended budget.
