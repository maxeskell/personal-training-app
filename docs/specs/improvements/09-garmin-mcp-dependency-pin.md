# Spec 9 — Garmin MCP dependency pin & liveness monitoring

**Status:** ✅ landed on `main` (2026-08-13) · **Priority:** P1 · **Size:** S · **Owner:** Max

## Problem
Garmin ingest was **silently dead for ~4 weeks (2026-07-17 → 2026-08-13)**. Every `.FIT` stream and daily-wellness
pull degraded to "AI Endurance only", and the dashboard's session cards fell back to the generic *"No raw .FIT for
this session… export it manually"* message — which lists three *guessed* causes, none of which was the real one.

**Root cause:** `garmin_mcp` is pinned to commit `d31de79` (`config.ts`), but its Python `mcp` SDK dependency was
**unpinned**. `garmin_mcp@d31de79` does `from mcp.server.fastmcp import FastMCP`; **mcp 2.0 removed that module**. When
uvx resolved mcp 2.0.0 (around the 2026-07-17 token re-auth / cache rebuild), the subprocess crashed on import:

```
ModuleNotFoundError: No module named 'mcp.server.fastmcp'
[garmin] connect failed — degrading to AI Endurance only: MCP error -32000: Connection closed
```

**Why it stayed invisible for a month:** `npm run doctor`'s only Garmin check was **token age**, which reads a file
mtime and never opens a connection — so it stayed `✓ token 27d old` through a total outage. Nothing looked at whether
Garmin actually connected, or whether its data had stopped arriving.

## Fixes (file:line)
1. **The repair — pin the SDK below 2.0** (`config.ts`): default `GARMIN_MCP_ARGS` now includes `--with mcp<2`, so uvx
   resolves mcp 1.29.x (which still ships `mcp.server.fastmcp`) against the pinned `garmin_mcp` commit. Verified: the
   import succeeds and the live tool list returns 126 tools incl. `download_activity_file`. `.env.example` documents why.
2. **Live liveness probe** (`health.ts` `garminLiveCheck()`, wired into `doctor` in `cli.ts`): when Garmin is enabled,
   `doctor` now **spawns the subprocess, lists tools, and checks for `download_activity_file`** — reporting `⚠
   unreachable — <reason>` (the redacted real error, e.g. the import crash), `⚠ old build (no download_activity_file)`,
   or `✓ connected, N tools`. This is the check that would have caught the outage on day one.
3. **Archive-freshness early-warning** (`health.ts` `garminFreshnessCheck()`, pure): warns when the newest archived
   Garmin *daily* record is > `GARMIN_STALE_WARN_DAYS` (3) old — daily wellness uploads every worn day, so a multi-day
   gap means a broken pipeline, not a rest week. Surfaced in `doctor` **and** fired as a desktop notification on the
   daily `ping`, so a future silent outage is caught in days without anyone running `doctor`.
4. **Failure reason exposed** (`mcp/garminClient.ts`): `GarminClient.lastError` captures the redacted reason of the most
   recent connect/tool failure, so the liveness probe can surface *why* rather than a bare "unavailable". (The client's
   `redactSecrets` import was moved to the `util/redact` leaf to keep `health → garminClient` acyclic.)

## Tests
`test/health.test.ts` covers `garminFreshnessCheck` (disabled → no check; fresh setup → info; within window → ok;
stale → warn incl. the date; exclusive boundary). `test/recover.test.ts` covers the recovery planner + the
no-network "all current" path. Full suite green.

## Auto-recovery (closing the loop — landed 2026-08-13)
Detection (above) tells you a source is behind; **recovery downloads the missing span automatically**. New
`src/archive/recover.ts`:
- `planGapRecovery(newestIso, today, staleDays, overlap)` — PURE: is a source stale, how big is the gap, and what
  date to backfill from (newest − overlap, re-fetching the last partial day). A `null` newest (fresh install) is
  *not* a gap — that's a cold-start `backfill`, not recovery.
- `recoverGaps()` — measures each source's lag (AI Endurance activities, Garmin daily, Garmin activities+streams)
  and, for any stale **and** reachable, backfills exactly the gap: `backfillActivities` for AIE, `backfillGarmin`
  for daily, `backfillGarminActivities` (incremental) + a gap-sized `syncFitSummaries` for activities/streams.
  Degrade-don't-crash: every source is independent and best-effort; it never throws. Unlike the fixed-window jobs
  (dashboard refresh = 5 latest, `fit-sync` = 25, `archive-heal` = ≤200 backlog), it's framed around *how far
  behind is this source now*, so a multi-week outage heals in one pass.
- Surfaced as `npm run catch-up` (`-- --stale-days N`) **and** wired into the morning ping: the daily heartbeat now
  auto-heals any gap and notifies on recovery — or, if a source is still unreachable with a real gap, warns.

So the full arc for a future outage: the live `doctor` probe + freshness check make it **visible**; the ping's
`recoverGaps` makes it **self-healing** the moment the connection returns.

## Follow-ups

- **Upstream still requires mcp<2 (checked 2026-08-13).** The latest `garmin_mcp` HEAD (`3610be6`) resolves mcp
  **1.29.0**, not 2.0 — upstream fixed the same crash by self-constraining `mcp<2` in its own deps, and still
  imports `mcp.server.fastmcp`. So there is **no mcp-2.x-compatible garmin_mcp yet**; `--with mcp<2` cannot be
  dropped by bumping. HEAD still ships `download_activity_file`, but we deliberately keep the `d31de79` pin (known-good,
  no reason to take upstream churn). Re-check when upstream actually migrates to the mcp 2.x API; only then bump the
  pin **and** drop `--with mcp<2` together. `--with mcp<2` is belt-and-suspenders regardless.
- **Re-checked 2026-08-24 (dependency-audit pass): unchanged.** Upstream HEAD is *still* `3610be6` (2026-08-04, no
  new commits), its `pyproject.toml` now self-constrains `mcp>=1.28.1,<2`, and it still imports
  `mcp.server.fastmcp` — so the decision above stands verbatim: keep `d31de79` + `--with mcp<2`. Noted for
  whenever the bump does happen, `d31de79..3610be6` also carries: a fix suppressing stdout during garminconnect
  login that could corrupt the MCP stdio stream (#205), Garmin Coach workout exposure (#243), cycling VO₂max in
  training status (#147), a profile-VO₂max fallback when trend history is missing (#240), and run-workout /
  nutrition write tools — worth taking together when upstream migrates to mcp 2.x.
- Consider a broader dependency-freshness audit cadence — this class of break (pinned app, unpinned transitive dep) is
  invisible until it fires. (A first pass on 2026-08-13 took the npm deps to latest: Opus 5, `@anthropic-ai/sdk` 0.116,
  TypeScript 7, MCP SDK 1.30, and `npm audit fix` for the transitive `hono`/`ip-address` advisories.)
