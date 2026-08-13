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
stale → warn incl. the date; exclusive boundary). Full suite green (803 tests).

## Follow-ups (open)
- When a `garmin_mcp` commit that targets mcp 2.x lands, bump the pin **and** drop `--with mcp<2` together.
- Consider a broader dependency-freshness audit cadence — this class of break (pinned app, unpinned transitive dep) is
  invisible until it fires.
