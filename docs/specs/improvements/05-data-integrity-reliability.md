# Spec 5 — Data integrity & reliability

**Status:** proposed · **Priority:** P0/P1 · **Size:** M · **Owner:** TBD

## Problem
The persistence and ingestion layers have several quiet-data-loss / quiet-wrong-data bugs that the "trust the
numbers" premise can least afford, plus reliability/perf gaps on the live `/refresh` path.

## Findings → fixes (file:line)
1. **Non-atomic state writes** (`state/store.ts:18–21`): `writeFile` directly over the live day file while the server
   reads it concurrently (`renderLatest → recent → load`); `load()` swallows parse errors → a GET mid-write renders
   "No data yet" / drops today from the baseline window. **Fix:** write to `….tmp` then `rename()` (atomic on POSIX).
2. **JSONL corruption / log loss** (`state/decisionLog.ts:42`, `archive/store.ts`): appends are unserialized; a crash
   mid-write leaves a partial line, and one unparseable line makes `readJsonl`/`all()` throw → `[]` (the entire audit
   log / archive vanishes for consumers). **Fix:** per-line `try/catch` (skip bad lines, count them), and serialize
   appends through a single in-process queue (or `O_APPEND` + write whole lines atomically).
3. **Nutrition mis-index** (`assemble.ts:~319`): falls back to `min(1, len-1)` when today's date isn't found → applies
   yesterday's/tomorrow's fuelling ranges as today's (esp. across a TZ boundary). **Fix:** match by date; if absent,
   leave `nutritionTargets` absent.
4. **Garmin arg split** (`config.ts:30–33`): `GARMIN_MCP_ARGS.split(" ")` breaks any arg containing a space. **Fix:**
   accept a JSON array (or shell-aware split).
5. **Archive re-reads** (`server.ts`): `loadArchive()` re-parses the full JSONL on every request, multiple times per
   flow. **Fix:** load once per request and pass down; cache by file mtime.
6. **No `/refresh` budget** (`assemble.ts`): 14 sequential Garmin calls × 25 s = ~6 min worst-case with the route held
   open. **Fix:** overall wall-clock cap for the Garmin phase; return partial state past the cap (it already degrades per-call).
7. **OAuth callback leak** (`mcp/oauthProvider.ts`): callback server not closed on `waitForCode` timeout. **Fix:** close
   server + reject on timeout.
8. **Schema versioning** (`state/store.ts`): normalize-on-load is good; add an explicit `schemaVersion` to persisted
   records so future migrations are detectable rather than inferred.
9. **Unit-conversion consistency**: centralize `gramsToKg` / pace / °F→°C / the lactate ×10 normalisation in one
   `util/units.ts`; `assemble` guesses while `backfill` assumes — same metric can be stored in different units by path.
10. **Duplicate archive records** (`archive/backfill.ts:139`, `archive/store.ts`): `backfillGarmin` reads the set of
    already-archived dates *once* at the start, then appends — not atomic. Two overlapping runs (a manual `backfill`
    while the scheduled `--daily-only` grind fires, or a re-run after a partial append) each see a date as "missing"
    and both write it, so `garmin-daily.jsonl` accrues duplicate dates. Consumers (`engine.ts`, `correlations.ts`,
    `garminTrends.ts`) read the raw series with no dedup, so a duplicated day is double-weighted in rolling baselines /
    z-scores. **Fix (done):** dedup-by-key on read in `ArchiveStore` (last write wins — one record per date/id), an
    `archive-compact` command (`npm run backfill:compact`) that physically rewrites each file (tmp + `rename`), and
    `summary()` now reports distinct counts so `backfill:status` no longer reads as more days than the calendar holds.

## Acceptance criteria
- A `GET /` issued during a `save()` always returns a fully-rendered page (never "No data yet" due to a torn read).
- A decision log with one corrupt line still returns all the good records (count of skipped lines logged).
- Nutrition targets are never shown for a non-matching date.
- `GARMIN_MCP_ARGS` with a quoted path spawns correctly.
- `/refresh` returns within the configured Garmin budget even if one tool is slow.
- A `garmin-daily.jsonl` with duplicate dates loads as one record per date (last write wins); `archive-compact`
  rewrites it to the deduped set and is a no-op on a clean file.

## Test plan
- `store`: write/replace under simulated concurrent read (read returns last complete content, never partial).
- `decisionLog`/`archive`: inject a partial line → `all()` returns the good records; round-trip append ordering.
- `archive`: duplicate dates/ids → loaders return one record per key (last write wins); `compact()` shrinks the file
  and is idempotent on a second run.
- `assemble`: nutrition date-miss → absent; unit conversions table-driven (grams/kg, m/s/pace, °F/°C, ×10).
- units util: property tests for idempotence/ranges.

## Risks
- `rename()` semantics differ on Windows, but this is a macOS/Linux tool; document.
