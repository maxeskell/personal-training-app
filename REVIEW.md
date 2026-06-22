# REVIEW.md — Staged Deep Review: Endurance Coach MCP

Single running record for the staged, gated review. Analysis stages 1 to 5 are read-only; code changes happen only in the Execution stage after explicit approval. Resume protocol: read this file first to rehydrate, then run the current stage.

## Review metadata
- Repo: `/home/user/personal-training-app`, branch `claude/wonderful-curie-rx3non`.
- Scale: ~25,063 lines of TypeScript across `src/`, ~89 `*.test.ts` files.
- Stage 1 method: 7 parallel read-only exploration subagents (one per subsystem), synthesised here. No live MCP tool was invoked, no code was run, nothing was modified.
- User answers so far: "Run it now (Stage 1)" (2026-06-22). `REVIEW.md` and `codebase-review-prompt.md` did not exist at session start (fresh ephemeral container); this file is created on first run as required.
- Tag convention: every factual claim is Confirmed (read in code, file:line) or Suspected (inferred). Findings ranked only from Stage 2 onward; Stage 1 is map + ledger.

---

## Stage 1: System map (bottom-up) + claims ledger

### 1. Boot, transport, tool registration

- Two transports share ONE `buildServer()` factory (`src/mcpServer.ts:189`). Confirmed.
  - **stdio**: `main()` over `StdioServerTransport` (`src/mcpServer.ts:786-809`); reroutes `console.log`→`console.error` so logs cannot corrupt protocol frames (`:790`). stdio enables all local writes: `buildServer({includeProfileWrite:true, includeFileAccess:true})` (`:793`). Started behind `isMain` guard (`:803-808`).
  - **HTTP (Streamable HTTP, path `/mcp`)**: `src/mcpHttp.ts`, stateless (`sessionIdGenerator: undefined`, fresh server+transport per request, `:181-188`,`:263-271`), 1 MB body cap (`:32`).
- HTTP auth, 3 modes via `COACH_MCP_AUTH` (default `token`): `token`/`none`→`runHttpRaw()` static bearer, constant-time compare (`serverAuth.ts:86-93`); `oauth`→ full OAuth 2.1 DCR+PKCE, scope `coach`, requires `COACH_MCP_PUBLIC_URL` or exits (`mcpHttp.ts:220-288`). Hardening: refuses token <16 chars (`mcpHttp.ts:75`), `auth=none` refuses non-loopback bind (`:149-153`), loud startup banner enumerates exposure incl. medical profile (`:87-125`). Confirmed.
- Launch: `npm run mcp` (stdio), `npm run mcp:http`, `npm run mcp:install` → launchd `com.endurance-coach.mcp` running `node --import tsx src/mcpHttp.ts`, forcing `oauth` + read-only unless `--allow-writes` (`scripts/install-mcp.sh:9-16,94-96`). Confirmed.
- Tool registration is explicit imperative `server.tool(name, desc, zodSchema, handler)` calls (no loop/manifest); canonical list = the sequence of calls in `mcpServer.ts` + the banner string (`:796-799`). Gating flags on `buildServer`: `includeWrites` (default true), `includeProfileWrite` (default false), `includeFileAccess` (default false). Confirmed.

### 2. Tool inventory + write-surface map (read-only-against-plan PROOF)

26 MCP tools. Compact inventory (full detail traced; file refs `src/mcpServer.ts`). Class key: RO = pure read; local-write = writes local disk only; cost = LLM call; AIE-write = mutates the plan.

- Pure RO (no write, no cost, no AIE): `get_state` (no-fresh), `splits`, `ftp_check`, `get_profile`, `list_reports`, `read_report`, `decisions`, `listening`, `cost`, `knowledge`, `list_files`, `read_file`.
- Read + local-write, no LLM: `sync` (reads AIE+Garmin, writes `data/state/*`, downloads .FIT), `insights` (writes insight log), `ingest_fit` (copies .FIT), `react_to_insight`, `retrospect`, `log_fuel`, `fuelling`.
- LLM flows (need `ANTHROPIC_API_KEY`, cost-logged): `fuel_review`, `ask`, `readiness`, `weekly`, `race_prep`, `deep_dive`, `season_arc` (deterministic if no key), `tune`, `research` (+web search), `session_feedback`. Most also write a dated report.
- Conditional write tools: `update_profile` (writes `profile.local.yaml`, rejects live numbers), `write_file`/`read_file`/`list_files` (repo I/O, secrets deny-list), `propose_adjustment` (LLM, logs proposal, NO AIE write), `confirm` (the ONLY AIE mutation), `decline` (local status).

**Write-surface table** (Confirmed):
- REMOTE → AIE plan: `aie.callRaw(tool,args)` at `src/guardrails/writeGate.ts:118` — the single remote-write site. Reachable only via `confirm()`.
- LOCAL disk: `fileAccess.ts:148` (write_file, contained+deny-list, off by default), `profile/update.ts:74` (profile yaml), `state/store.ts:45,48` (`data/state/<date>.json`, atomic temp+rename+lockfile), plus append-only stores: decision log, insight log, venue, weather, metric overrides, fuel log, session feedback, reports, knowledge/pending, cost log, advice embeddings, archive/FIT corpus.
- REMOTE non-plan: local LLM `/chat` + `/embeddings` POST (inference, no plan data), intervals.icu GET-only, Garmin MCP `tryCall` (generic passthrough, only ever called with `get_*`/download tools).

**Propose → confirm two-step** (`writeGate.ts`): `propose()` (`:41-61`) validates `tool ∈ AIE_WRITE_TOOLS`, logs a `proposed` record, does NOT call the API. `confirm(id)` (`:69-121`) runs under a cross-process lock, rejects status≠proposed / missing write / >7-day TTL, writes an `executing` claim, re-reads to win the race, THEN calls `aie.callRaw` at `:118` once (single-use). `assertNoDirectWrite()` (`:129-136`) is a static hard guard. 8 AIE write tools exist (setZones, changeWorkoutDate, skipWorkout, changeWorkoutAdvice, create Ride/Run/Swim/Strength).

**`aieClient.callRaw` has exactly two callers** (Confirmed by grep): `read()` (`:123-130`, which rejects any `WRITE_SET` tool BEFORE the network call, `:124`) and `WriteGate.confirmLocked()`. No other write reachability.

**VERDICT (Critical guarantee): "read-only against the AI Endurance training plan" is TRUE, conditionally.** The plan is read-only by default and mutated only through `propose → human confirm → WriteGate.confirm → callRaw` (`writeGate.ts:118`). Traced evidence: callRaw has only two callers; read() blocks writes pre-network; propose/decline never touch the API; intervals GET-only; Garmin only `get_*`; local LLM carries no plan mutation. Status: **Verified**.
- Suspected hardening gaps (do not break the AIE guarantee): `GarminClient.tryCall` (`garminClient.ts:60`) is a generic passthrough with no allow-list (today all callers pass read tools; not structurally constrained like `aie.read`). Anti-double-fire relies on `proper-lockfile` cross-process behaviour (not executed here).

### 3. External integrations (resilience + secrets)

- **AI Endurance (required spine, MCP over Streamable HTTP).** OAuth 2.1+PKCE via MCP SDK; tokens in `~/.endurance-coach` (`aie-tokens.json`/`aie-client.json`/`aie-verifier.txt`), token+verifier `0600`, dir `0700` (`oauthProvider.ts:91,96,189`); `aie-client.json` is `0644` (Suspected minor, non-secret). No client caching; live per call; snapshot is downstream (`StateStore`). Timeouts: `withTimeout` caps CONNECT only at `AIE_TIMEOUT_MS` default 20000 (`aieClient.ts:104-114`); **Suspected GAP**: per-tool `read()`/`callTool` calls NOT timeout-wrapped (`:118,139`). No 429 handling, no retry/backoff (Confirmed GAP). Malformed JSON: `JSON.parse` try/catch falls back to raw text (`payload.ts:19-23`); responses trusted as `any`, probed key-by-key, NO zod (Confirmed). Per-tool failures caught into `raw[tool]={error}` → partial state (`assemble.ts:74-78`). `callRaw` thrown error detail not run through `redactSecrets` (Suspected minor).
- **Garmin (optional, degradable).** Gated by `GARMIN_ENABLED` (default false, `config.ts:89`); spawns `uvx garmin-mcp` subprocess; auth out-of-band in `~/.garminconnect`. Every call `withTimeout` 25000 + overall 90000 wall-clock budget (`assemble.ts:105-107`). All failures → warn (through `redactSecrets`) + return null/`[]`/false, never throws. Genuinely optional: assemble proceeds AIE-only with `garminStale` set. Confirmed.
- **intervals.icu (alternative spine, read-only).** HTTP Basic (`API_KEY`:apiKey from `COACH_INTERVALS_API_KEY`), env-only. `AbortSignal.timeout` default 15000 per request; `Promise.allSettled` over 3 endpoints → per-slice degrade to `[]`, throws only if all 3 reject. Non-2xx (incl 429) throws, NO backoff/retry (Confirmed GAP). `res.json() as T`, no validation (`api.ts:29`); defensive mapper. Slice-failure warnings not redacted (Suspected minor).
- Cross-cutting: external JSON (AIE, Garmin, intervals) is universally trusted without schema validation; mitigated by defensive key-probing ("degrade, don't crash"). zod is used only for the local profile and the coach's own tool inputs.

### 3b. Weather + LLM clients

- **Weather**: Open-Meteo `api.open-meteo.com/v1/forecast`, no key (`forecast.ts:100`). Single fetch `AbortSignal.timeout` default 6000, NO retry (`forecast.ts:101`). Cache `data/weather.json`, served if <3h, on failure returns stale or undefined, never throws (`store.ts:27-37`). roadDry is a hour-by-hour water-film MODEL with calibrated-not-measured constants (`roadDry.ts:6-9`); **Suspected gap**: ride-card text not tagged MODEL (`assess.ts:203`) unlike water-temp which is (`:235-237`). water-temp is a damped air-temp drift MODEL, well-labelled (`waterTemp.ts:44-83`).
- **CoachLLM (`llm/client.ts`)**: Anthropic SDK, model `claude-opus-4-8` (`:16`), key from `ANTHROPIC_API_KEY`, effort default `high`, `thinking:{type:"adaptive"}`. Three shapes: `structured<T>` (4000 tok), `research` (streamed, `web_search_20260209`, max 6 uses, 8000 tok), `text` (streamed, 12000 tok). Every call cost-logged via `meter()`→`appendCostRecord`. **Suspected gap**: no caller-controlled timeout / explicit `maxRetries` (relies on SDK defaults; streaming is the only long-run mitigation). Throws on truncation/invalid JSON/missing field; callers degrade to "key not set" messages. NOTE: system prompt ~3k tokens is below Opus 4.8's 4096-tok cache minimum, so the `cache_control` marker is currently a no-op — every call pays full input price (Confirmed, `client.ts:8-11`).
- **localClient.ts**: OpenAI-compatible POST to local-llm-server (`http://localhost:8000/v1`, model `llama3.2:1b`), intent routing only, optional bearer, timeout 4000, throws on fail → `classifyIntent` falls back to regex. Enabled only when `COACH_LOCAL_INTENT=true`. Cost logged at $0.
- **haikuRouter.ts**: same intent classification on Anthropic `claude-haiku-4-5`, `maxRetries:0`, abort 4000. Selected by `COACH_INTENT_ROUTER=haiku`. Cost-logged at Haiku pricing.
- **embeddings.ts**: local Ollama `nomic-embed-text` for advice de-duplication, abort 30000, throws → caller falls back to per-source grouping. Enabled only when `COACH_ADVICE_CLUSTERING=true`.
- Cost-awareness CLAIM verified: deterministic flows (weather, regex intent, season digest) make NO LLM calls; effort medium = readiness/ask/session/fuel_review/tune, high = weekly/race/deep-dive/season/propose/research. Cost log `data/cost-log.jsonl` stores counts+dollars only, no prompt/PII (`costLog.ts:5-9`), local models forced $0. No API key logged/leaked; `redactSecrets` defence-in-depth. Confirmed. (Note tune/fuel_review run medium — see ledger contradiction C5.)

### 4. Insight engine (`src/insights/`) — calculation map

Primitives (`stats.ts`): population SD ÷n (A1); OLS slope n≥3 (A2); 2-pred OLS n≥6 (A3); lag-1 autocorr (A4); **Pearson r + autocorr-aware 95% CI** (`corrWithCi`, n≥10, VIF=(1+rx·ry)/(1−rx·ry), effN=max(4,n/vif), Fisher-z, significant iff CI excludes 0, `:115-160`); lag scan default lag 0-4 (A6); **Benjamini-Hochberg FDR default q=0.1** (`:210-220`); circular-shift permutation (mulberry32) (A9); trailing z window 42, needs ≥14 (A10). Confirmed.

Load model (`metrics.ts`): **CTL/ATL/TSB = Banister/Coggan impulse-response**, `ctlK=1−e^(−1/42)`, `atlK=1−e^(−1/7)`, EWMA, `tsb=ctl−atl`, seed=mean of first ≤7 days, needs ≥14 days, `rampPerWeek=ctl_last−ctl_{last-8}` (`:161-175`). Confirmed — standard constants. Run-load ramp baseline = mean prior ≤4 weeks (engine flags >50%/>25%). EF trend (avwatts/avhr, moving ≥40 min). **Durability trend consumes AIE's DFA-α1 percent field, NOT re-derived** (`:117-118,234-240`). Monotony/strain (Foster), monotony>2 flag. Intensity distribution vs ~80% easy. Surfacing gate minConfidence 0.5, score=severity×confidence.

Correlations (`correlations.ts`): n=1 lagged scans — load→recovery lag 1-3, HRV→load lag 0-1, RHR→recovery lag 0 (`:120-133`); surface iff |r|≥0.3; **multiple-comparisons: per-relationship p inflated by lagsScanned (Bonferroni step) then BH q=0.1; fdrPass = BH AND CI-significant; non-pass tagged "[exploratory — not FDR-confirmed]"** (`:156-165`). Anomaly z: RHR z>2 / HRV z<−2 — **single most-recent point vs whole-series mean → one point can fire** (`:137-150`, flag for Stage 2). sleep→next-day load gated n≥20 & |r|≥0.3, hardcoded `fdrPass:false`.

Change-point (`changepoint.ts`): binary segmentation, L2 cost, minSeg=7, needs n≥14, penalty=penaltyMult·var·log(n) (BIC-style); engine gates series length ≥21; findings only if last point within 21 days, **not significance-tested**, confidence 0.45.

Efficiency (`efficiency.ts`): EF~CTL+time MLR (FWL), needs ≥10 runs, `economyPer30d=b2·30`, reliable iff ciLow>0; labelled "apparent", heat not adjusted. Brick (`brick.ts`): same-day Run+Ride proxy, decoupling%, gated brickDays≥3 & freshRuns≥3, confidence scales with n. Taper (`taper.ts`): **descriptive only — no real finish times in feed**; band=mean past race-day TSB ± spread.

Zones (`zones.ts`, all `source:"derived"`): power Coggan %FTP edges, HR %LTHR edges, pace edges, swim/CSS edges; explicit AIE zones override. Power curve MMP (gaps→0, ~1Hz MODEL). Heat (`heat.ts`): EF~temp, needs ≥8 pts & range ≥4°C. Fuelling: weight+muscle decline OLS, needs ≥6 readings/≥21 days. Monitoring (`monitoring.ts`): backtested HRV/RHR early-warning, **walk-forward holdout (canHoldout iff usableDays≥50, 60/40 split) + K=400 circular-shift permutation + Bonferroni p·combosTried<0.05** — the most validation-heavy detector. Garmin native (ACWR ratio≥1.5 flag off single value; HRV/endurance/power-curve). Garmin trends vs trailingZ window 42, gated days≥21. Data quality plausibility scan (physio horizon 180d). Splits/projections: MAX_PROJECTED_GAIN 7%, BUILD_TAU_WEEKS 10, tri bike-speed Newton solve (Crr 0.005, CdA 0.32, ρ 1.225). Headline: **red requires a pattern not one point** (`headline.ts:68-82`).

Engine entry `buildInsights(state, archive?, opts?)` (`engine.ts:443-647`) sequences all detectors, fills family confidence, sorts flag/watch/info, gates at 0.5. Stage-2 flags (single-point swing): anomaly z (C3), Garmin ACWR (M1), predictionFindings, TSB<−25/ramp>7 end-of-series values, current-week ESS.

### 5. Data flow, state, persistence, config (`src/state`, `config.ts`, `src/profile`)

- Flow: 10 AIE tools → `assembleState` maps typed `Provenanced` slots + raw under `state.raw` → optional Garmin gap-fill (budgeted) → baselines (7-day trailing mean from disk snapshots) → sync-gap → manual swim CSS → metric overrides. `StateStore.save` writes `data/state/<date>.json` (atomic temp+rename+lock), **stripping `profile` and `dataCompleteness` before disk** (`store.ts:44`); profile re-attached in-memory after save (`orchestrator.ts:142-146`). Confirmed.
- Persisted: `data/state/<date>.json`, metric-overrides.json, venue.json, decisions/insights JSONL, advice-embeddings, archive (activities/garmin/fit-summaries JSONL + activity-archive/ FIT corpus), fit-streams, weather.json, cost-log.jsonl, fuel-log.jsonl, session-feedback.jsonl, career-history.json, reports/*.md, knowledge/. Secrets in `~/.endurance-coach` (off-repo). Ephemeral: `state.profile`, `state.dataCompleteness`.
- **Confirmed quirk**: the `load` slot (CTL/ATL/TSB on AthleteState, `types.ts:212`) is declared but NEVER populated in `assemble.ts` (always null). CTL/ATL/TSB are computed live in the insight engine, not persisted on state. Flag for Stage 2/3.
- Baselines: simple arithmetic 7-day mean (not EWMA), source `derived`.
- Metric overrides: conditional `{when,use,ts}` — substitutes only while platform value still equals `when`; covers any `DisciplineThresholds` field incl `bikeFtpW` + vo2max. FTP discrepancy handling is separate: `mapGarminThresholds` (`assemble.ts:503-523`) keeps the HIGHER of Garmin device FTP vs prior AIE/test value and writes `bikeFtpNote` flagging the conflict — so Garmin 183 vs AIE 223 keeps 223 W and surfaces a note; both kept un-merged on `thresholdsBySource`. Confirmed.
- Config env-var table captured (see ledger Theme 8). Only required secret: `ANTHROPIC_API_KEY` (no default, but degrades gracefully, never hard-fails). **Silent-fabrication defaults flagged**: `COACH_WEATHER_LAT/LON` default to London 51.5074/-0.1278 (fabricates a location, `config.ts:193-194`); `COACH_EQUIPMENT` defaults to the original author's specific kit injected into the coaching prompt (`:276`); `COACH_UNITS` "metric, UK". NOT fabrications: `COACH_WATER_TEMP_C`/`COACH_SWIM_CSS` default undefined; FTP/thresholds have no hardcoded default.
- Profile: loaded `COACH_PROFILE_PATH`→`profile.local.yaml`→`profile.example.yaml`, zod `ProfileSchema` + `assertNoLiveNumbers` (rejects ftp/css/hrv/rhr/lthr/pace/ctl/atl/tsb/vo2/weight tokens with numeric values; height allowed; bloods/equipment exempt). `loadProfile` throws loudly; `loadProfileSafe` → null. Medical: `health.medication` + `computeDoseCycle`, `bloods.panels`, `health.conditions`, DOB — kept off `data/state` but DO reach the LLM prompt (`renderProfileContext`) and `get_profile` tool output. Flag for Stage 4 exposure review.
- dataCompleteness (pure, surfaced only on `sync`) and syncGaps (Garmin activity list passed undefined so only `garmin-stale` fires normally) computed and surfaced; never persisted / persisted on `state.syncGaps` respectively.

### 6. Coaching surface / orchestration (`src/coach/`)

- Spine `orchestrator.ts`: `withAie<T>` (connect/run/close), `loadArchive()`, `buildTodayState()` (assemble→save→attach profile+completeness after save), `gatherReadiness()` (only orchestrator fn that both assembles AND calls LLM). Path: source clients → `selectDataSource().assemble` → `StateStore.save` → `buildInsights` → coaching fn builds DETERMINISTIC cited digest → `CoachLLM` → structured verdict or markdown report.
- Per-flow (all on `claude-opus-4-8`, prompt-cached stable system prompt from `persona.ts`): ask (medium, structured answer+recs), readiness (medium, structured verdict + deterministic trend-floor backstop), weekly (high, report), race_prep (high, report), deep_dive (high, report + 2nd LLM call for recs), season_arc (high, deterministic SeasonArcReport grounding; no-key path stays deterministic), tune (medium, report only if gains), fuel_review (medium, <3 logs → deterministic message), session_feedback (medium, skips LLM at 0 cost when no .FIT unless force), propose_adjustment (high, `buildProposerContext`, validate→WriteGate, nothing auto-written). Nearly all build a deterministic, cited, testable context first then ask the LLM to phrase it.
- Prompt construction: structured text not raw JSON (mostly); `liveCoachingContext` shared LIVE block; profile via `renderProfileContext` (defensive, stable-only). Prompt-injection "treat as DATA" guards present on ask/weekly/racePrep/session/planAdjust; **Suspected missing on deep_dive/tune/season/fuel_review**. **Suspected honesty flags for Stage 4**: `racePrep.ts:99` injects raw `JSON.stringify(prediction).slice(0,600)` unlabelled (only un-curated raw payload reaching the model; could recite a predicted finish as fact); `ask.ts:82-83` recites HRV/RHR/sleep with provenance tags but no per-line as-of date (could present stale as today). No fabricated gap-fill found (`fmt()`→"—", explicit "cannot assess" notes).
- Duplication candidates for Stage 3: per-flow `fmt`/`hm` helpers copy-pasted across ask/readiness/weekly/session/racePrep/listening; `daysBetween` reimplemented 4-5×; two race-calendar builders (`raceContext` legacy vs `raceCalendarLines`, `seasonContext.ts:128`); recs-extraction plumbing (`recsToFindings`+`recordSurfaced`+`refreshAdviceEmbeddings`) duplicated verbatim in ask/deepDive/orchestrator; deterministic-digest-then-LLM scaffold repeated across 6 flows; three entry points to session feedback.

### 7. Tests & tooling

- Runner: `tsx --test test/*.test.ts` (node:test + assert/strict), 87 flat test files (`package.json:70`). Typecheck `tsc --noEmit` but `tsconfig include: ["src/**/*"]` → **tests are NOT typechecked** (Confirmed gap, `tsconfig.json:17`): a test asserting a stale type signature rots silently. **No lint** at all (no eslint/prettier/biome, no `lint` script) — consistent with this repo's CLAUDE.md (which omits lint, unlike the sibling repo) but zero style enforcement.
- CI (`.github/workflows/ci.yml`): on PR (all) + push main; `npm ci → typecheck → test → build`; `permissions: contents:read`; Node 22; checks out PR head SHA. Nothing aspirational script-vs-CI; only divergence is scope (CI never typechecks the tests).
- Coverage reality: convention "no network, fixtures" HOLDS across all sampled files (only loopback Express in `serverAuth.test.ts`; OAuth/MCP use in-memory transports; connectors inject mock fetch). Assertions are REAL not smoke for: stats (exact vs closed-form), statvalidity (true-lag found, multiplicity penalised), loadmodel (exact Banister constants), monitoring (permutation p<0.05 on signal, rejects noise, downgrades short series), detectors (exact thresholds), writegate (propose-no-write, confirm-gated, single-use, lock), oauth/hardening/persist, serverAuth (timing-safe, host-rebind, 401/413), mcphttp (read-only drops write tools), dataintegrity (atomic write, profile never persisted, corrupt JSONL skipped), dataQuality, FIT/TCX/PWX parsers, fitingest. XSS/escaping is GENUINELY tested: adversarial title `O'Brien "5x3'" \ </script><b>x</b>` escaped, handlers use `data-*` not quoted JS, script blocks re-parsed via `new Function()` (`dashboard.test.ts:14-59`).
- Under-tested / untested critical paths:
  - **`WriteGate.assertNoDirectWrite()` is dead in production** (Confirmed): defined + unit-tested (`writeGate.ts:129`, `writegate.test.ts:118-122`) but **zero call sites in `src/`** — the "hard guard against direct writes" is not wired into any write path. The test proves the function throws, not that the system routes through it. (Stage 3 dead-code + Stage 4 hardening item.)
  - Malformed weather API JSON not tested (`mapOpenMeteo` defends with `?? {}`/`?? []` but only well-formed input is exercised; `weather/store` degradation path has no test).
  - stdio MCP tool registration / read-only enforcement not asserted (HTTP path IS covered).
  - Shallow dashboard card rendering tests (presence/regex, not computed values).
- Type safety: `strict:true`, NO `@ts-ignore`/`@ts-expect-error`/`eslint-disable` anywhere in `src/` (Confirmed — good posture). Concentrated risk: **`src/archive/backfill.ts` ~15 `as any` casts on untyped Garmin DTO ingestion** (lines 171-212), thinly tested; `state/store.ts:65` `as unknown as AthleteState` double-cast; `assemble.ts:738` and `fuelInventory.ts:146` casts (guarded by `Array.isArray`).
- Runtime confirmation NOT performed (read-only review). To confirm the tree is actually green, the user can run (offline, no API, no tokens): `cd /home/user/personal-training-app && npm run typecheck && npm test && npm run build`.

---

## Claims ledger (status assigned where Stage 1 evidence is conclusive; else deferred to later stages)

Grouped by theme. Status: Verified / Refuted / Unprovable-from-code / Defer (needs a later stage). Full per-claim table with verification approach lives in the synthesis; key falsifiable guarantees:

- **T1 Read-only / gated writes** — 1.1 only `WriteGate.confirm()` mutates AIE: **Verified** (`writeGate.ts:118`, callRaw two-caller proof). 1.2 propose writes nothing: **Verified** (`writeGate.ts:41-61`). 1.3 confirm single-use / replay-protected, 1.4 concurrency-safe, 1.6 bounded plan writes, 1.7 wellbeing-screened notes, 1.8/1.9 allowlist+workoutId validation: **Defer to Stage 2/4** (writeValidators not yet read line-by-line; tests exist). 1.11 `COACH_MCP_READONLY` drops write tools: **Verified** (`mcpServer.ts:636-638`). 1.14 update_profile/write_file local-only + live-number reject: **Verified**.
- **T2 Degrade, don't crash** — timeouts present (Garmin 25s/90s budget, AIE connect 20s, weather 6s, local 4s, embed 30s): **Verified**, with **two Suspected gaps**: AIE per-tool calls untimed; CoachLLM Opus calls untimed. 429/retry absent on AIE + intervals: **Confirmed gap**. Provenanced degrade-to-null: **Verified** (defensive mappers, no zod on external JSON).
- **T3 Cost-aware** — 3.1 deterministic flows no LLM: **Verified**. 3.2 effort tiers: **Verified with caveat** (tune/fuel_review run medium — see C5). 3.3 cost-logged, no prompt/PII: **Verified**. 3.10 system prompt prompt-cached: **Refuted in effect** — marker set but prompt < 4096-tok cache minimum so it is a no-op (`client.ts:8-11`).
- **T4 Honest models** — most estimates labelled (water-temp, CSS, listening, season CTL, Garmin black-box): **Verified**. **Suspected gaps**: road-dryness card text not MODEL-tagged (`assess.ts:203`); racePrep raw prediction blob unlabelled (`racePrep.ts:99`). 4.4 correlations FDR-confirmed: **Defer/contended** — code shows Bonferroni-on-lag-scan + BH (`correlations.ts:156-165`) but spec 04 lists "FDR double-dip" as OPEN (C7); Stage 2 must resolve whether the lag-scan multiplicity is genuinely corrected.
- **T5 Dashboard HTML escaped** — `escapeHtml` escapes `& < > " '` (`util/html.ts:3-4`): **Verified**; "script blocks still parse" test: **Defer to Stage 1.7 tests / Stage 4**.
- **T6 Server/privacy** — bind 127.0.0.1 default, token on mutating routes, host allow-list, body cap, `/health` info-only, file-access deny-list, secrets off-repo+redacted: largely **Verified** at config/code level; **C2 contradiction** to resolve (spec 01 "current behaviour" says HOST `0.0.0.0`, rest of docs say `127.0.0.1`) — must read `server.ts`.
- **T7 Profile live-number separation** — **Verified** (`schema.ts` no-live-numbers guard).
- **T8 numeric/behavioural** — water>13°C, gust 38/rain 40, weather London default, auto-sync 30m, forecast 3h, knowledge stale 35d, fuel_review ≥3 logs, swim CSS 60-240s, readiness red-downgrade, wellbeing screen: config values **Verified**; behavioural ones **Defer**.
- **T9 testing** — "99 tests all green, no network": **Defer to 1.7**. Self-flagged thin coverage (FIT parser, server.ts routes, full WriteGate path): honest, **Defer**.
- **T10 architecture** — local-first/no-DB, MCP=CLI=dashboard same engine, demo offline, models Opus+Haiku, nothing calendar hard-coded: **Verified** at structure level.

**Contradictions found in docs (carry into Stages 4/5):**
- C1: README lists `npm start` as everyday "run the coach" but CLAUDE.md bans it as dev-only (`README.md:52-53` vs `CLAUDE.md:48-50`).
- C2: spec 01 "current behaviour" HOST `0.0.0.0` vs `127.0.0.1` default claimed elsewhere — resolve against `server.ts`.
- C3: all 6 `docs/specs/improvements/*` headed "Status: proposed" but HANDOVER/PRODUCT say they "already landed on main" — code-vs-doc drift; check acceptance criteria vs code.
- C5: effort taxonomy (cheap=medium/deep=high) doesn't cleanly place tune/fuel_review (both medium).
- C6: `COACH_LOCAL_INTENT` vs `COACH_INTENT_ROUTER` — `=local` selects router but may not flip `localLlm.enabled`.
- C7: FDR "confirmed" honesty claim vs spec 04 open "FDR double-dip" finding (the Stage 2 soundness crux).
- C8: "99 tests" vs 90+ test files — stale count.
- Vague/unfalsifiable: "$5-10/month", "coach-quality", "~80% of the value zero code", Garmin "fragile", cold-load timings.

---

## Stage 1 conclusions + plan for Stages 2-5

**Headline conclusions (Stage 1, no ranking yet):**
1. The Critical guarantee holds: the AIE plan is read-only except through `propose → human confirm → WriteGate.confirm → callRaw` (`writeGate.ts:118`), proven by a two-caller trace on `callRaw`. **Verified.**
2. The insight engine is far more statistically careful than a typical n=1 hobby project: autocorrelation-discounted CIs, Bonferroni-on-lag + Benjamini-Hochberg FDR, walk-forward holdout + circular-shift permutation nulls, per-detector n-gates, "[exploratory — not FDR-confirmed]" labelling. This is the strongest reason the custom engine might earn its keep (revisit in Stage 5).
3. CTL/ATL/TSB use the standard impulse-response constants (`1−e^(−1/42)`, `1−e^(−1/7)`). Physiology baseline looks sound; Stage 2 verifies NP/IF/TSS/ramp/zones.
4. Seeds for later stages already located: dead `assertNoDirectWrite`, never-populated `load` state slot, road-dryness MODEL not UI-labelled, racePrep raw-prediction-blob injection, fabricated weather/equipment defaults, missing per-tool AIE + CoachLLM timeouts, no 429/retry, prompt-cache no-op (cost), medical/bloods reach prompt + `get_profile`, redaction parity gap, prompt-injection guards missing on 4 LLM flows, duplication (fmt/daysBetween/raceContext-legacy/recs-plumbing), 80+ npm scripts surface.
5. Doc-vs-code drift is real (C1-C8): specs marked "proposed" but claimed "landed", `npm start` guidance conflict, FDR honesty vs spec-04 open item.

**Anti-sycophancy running tally (review-wide obligations):**
- Genuinely good, keep it: the propose/confirm write-gate AND the statistical-validity machinery (FDR + permutation holdout) — rare rigor for n=1.
- Belief formed then reversed: I expected the n=1 insight engine to be "noise dressed as signal"; Stage 1 shows real multiple-comparisons and out-of-sample discipline, so the skepticism must shift from "is there any rigor" to "is the rigor sufficient at the actual data volume and does the UI honour it." Carry into Stage 2.
- (Strongest-counterargument-to-top-recommendation obligation: due in Stage 5.)

**Plan for Stages 2-5 (order unchanged — Stage 1 did not force a reorder):**
- Stage 2 (soundness + physiology): per-insight n=1 verdict (Sound / Sound-with-caveats / Unsound / Cannot-tell), prioritising the single-point-swing flags (anomaly z, Garmin ACWR ratio≥1.5), change-point "not significance-tested" on short series, efficiency MLR at n≥10, taper descriptive band, and the FDR double-dip question (resolve C7 by reading the lag-scan multiplicity path end to end). Physiology: verify NP/IF/TSS, ramp, zone edges, CSS against standard models. Drift: confirm clean degradation for stale-marathon framing, FTP 183-vs-223 (mapped: keeps higher + note), unset swim CSS, blank race targets.
- Stage 3 (dead code + simplification): build the delete list (start with `assertNoDirectWrite`, unused `load` slot, duplicated helpers, legacy `raceContext`, unreferenced scripts/config/env), then name the single highest-leverage low-risk refactor. Interacts with any Stage 2 "unsound, cut" verdicts.
- Stage 4 (hardening + UX): timeouts/retries/redaction parity, Garmin allow-list, prompt-injection guard gaps, medical/profile exposure, road-dry label, racePrep raw JSON, prompt-cache cost no-op; UX of 26 tools (overlap/collision, lead-with-answer, "—"), common-journey friction, honesty cross-ref vs ledger.
- Stage 5 (strategy + kill list + bravest cut): does the build serve "coach me from my data, n=1, evidence-based"; cut a third; the bravest cut = custom engine vs AIE + a good system prompt (statistical rigor is the pro, surface size + n=1 limits the con); what's missing. Then consolidated, sequenced execution plan + self-grade.

**Open limitation for Stage 2 (blocking):** `profile.local.yaml` and `data/` are gitignored and absent in this fresh container, so I can assess the engine's n-GATES and degradation structurally but cannot see the ACTUAL sample size / data cadence the soundness lens is really about. Resolution options recorded for the user at the Stage 1 stop.

---

## Stage 2: Soundness + physiology correctness

Method: 3 read-only subagents (physiology maths exactness, soundness edge-checks, drift degradation). User chose structural assessment (real `data/` absent), so verdicts are about gates, formulas and surfacing, with "Cannot tell without real n" noted where it bites. Stage 1 fix landed on main (`8f37aad`); Stage 2 work continues on this branch.

### Physiology correctness (maths vs standard model)

Largely SOUND. The load model is mathematically faithful and the standard model is correctly chosen.
- CTL/ATL/TSB: `ctlK=1−e^(−1/42)`, `atlK=1−e^(−1/7)`, EWMA, `tsb=ctl−atl` (`metrics.ts:161-171`). Matches Banister/Coggan; code explicitly rejects the wrong `2/(τ+1)` EMA form (`metrics.ts:151-154`). Impulse = AIE `external_stress_score`, not recomputed (`metrics.ts:112,158`). Confirmed. Minor: TSB is same-day CTL−ATL vs TrainingPeaks' yesterday convention (1-day lag, `metrics.ts:171`); rampPerWeek assumes gap-free daily series (`metrics.ts:175`).
- No local TSS/IF computed anywhere (grep). NP (`fit.ts:144-159`) is the standard Coggan 30-sample rolling → mean of 4th powers → 4th root, "assumes ~1Hz, gaps dropped" (MODEL); used ONLY as display VI=NP/avgP (`session.ts:257`), never to derive IF/TSS. Confirmed.
- Zones (`zones.ts:32-42`): POWER_EDGES and HR_EDGES are exactly Coggan %FTP / %LTHR; run-power reuses cycling model (flagged approx); threshold absent → metric OMITTED, no default fabricated (`zones.ts:49-69`). CSS=(T400−T200)/2 with maximality/HR guards, returns error STRING not a number on invalid input (`sessionSplits.ts:131,128-164`). Confirmed sound.
- Tri bike split physics (`splits.ts:266-275`): correct steady-state `P=v(Crr·m·g+½ρ·CdA·v²)` Newton solve, plausible constants (Crr 0.005, CdA 0.32, ρ 1.225, +9kg). BUT reported as a bare POINT ESTIMATE, no CI/sensitivity (`splits.ts:308,354`), despite being the most input-sensitive calc. Diverges from the repo's own honest-models convention. Confirmed.

### Statistical soundness per insight (verdict)

- CTL/ATL/TSB, ramp, monotony/strain (Foster), TID vs 80/20: Sound (standard). Caveat: ramp jumpPct can inflate off one big session / low baseline (gated weeks≥3).
- Lagged correlations (`correlations.ts`): Sound with caveats, and more rigorous than typical n=1: autocorr-discounted effN, Bonferroni-on-lag-scan THEN Benjamini-Hochberg q=0.1, fdrPass = BH AND CI-excludes-0, non-pass tagged exploratory. **This resolves C7**: the lag-scan multiplicity IS corrected in code, so the "FDR-confirmed" label is honest and spec 04's open "FDR double-dip" item is stale doc, not a live bug. Residual caveat: it is associational, never causal at n=1, and effN flooring is crude.
- Monitoring rule set (`monitoring.ts`): Sound (most rigorous: walk-forward holdout ≥50 days, K=400 circular-shift permutation, Bonferroni). Circularity handled: in the AIE-recovery fallback predictors (HRV/RHR) and outcome (recovery) share the `recData` payload (`engine.ts:175-182`), but the code recognises and RELABELS this as "concordance, not prediction", tags `[dependent outcome]`, and prefers the independent Garmin sleep-score outcome when ≥60 days exist. Good design.
- Efficiency (FWL EF~CTL+time, n≥10, CI-gated): Sound with caveats (heat/route/pacing/device confounders; heat explicitly not adjusted, "apparent"). Durability (trends AIE DFA-α1, 5v5 split): Sound with caveats (black-box metric, noisy split can flip).
- Brick (`brick.ts`): UNSOUND AS A "BRICK" SIGNAL. Brick-day = ANY same-day Run+Ride by date only, no order/gap check (`brick.ts:31,45`), so a morning run + evening ride counts as a "brick". The decoupling% it reports is between two SEPARATE sessions, not run-off-bike fatigue. It IS labelled a proxy ("no within-leg timing") and gated brickDays≥3. Verdict: sound only as "same-day decoupling", mislabelled as brick.
- Taper (`taper.ts`): Sound with caveats (descriptive band from 1-3 past race-day TSBs, spread floor 5 if one race; risk it reads as a target).
- Change-point (`changepoint.ts`): Sound with caveats but mostly INVISIBLE. Binary segmentation, self-labelled "not significance-tested", confidence 0.45 < the 0.5 surface gate (`changepoint.ts:125`, `metrics.ts:58`) so it never reaches topFindings, only the raw `report.findings`/`report.changePoints` (deep_dive). Weak detector that mostly does not surface = soundness-low + Stage 3 dead-ish compute.
- Anomaly z (`correlations.ts:140-145`): Sound with caveats. Fires off the SINGLE most-recent value vs whole-series mean (population SD), severity "watch", confidence 0.55 ≥ gate, so a single bad HRV/RHR day DOES surface to the dashboard/topFindings (not promoted to a proactive alert). Defensible for morning readiness and labelled "one day isn't a trend", but a trailing-window baseline would be more honest.
- Prediction-vs-goal single snapshot (`engine.ts:423-437`): Sound with caveats, borderline. One platform predicted-vs-target reading creates a surfaced finding (confidence 0.7, watch/info) with NO trend requirement (`engine.ts:427`, gate `gapSec!=null`). A separate trend finding needs ≥6 history, but the single-snapshot one launders one noisy estimate into a "behind goal" line.
- Heat (≥8 pts, range ≥4°C), fuelling weight/muscle (≥6 readings/≥21 days, dual threshold), race-split projection (7% cap, tau 10wk, shows floor+best): Sound with caveats (projection constants are uncited heuristics).

### Drift handling (known season drift)

3 of 4 degrade cleanly; 1 does not.
- FTP discrepancy (Garmin 183 vs AIE 223): CLEAN. Keeps the higher configured FTP, writes `bikeFtpNote` (`assemble.ts:515-518`), surfaced as a dashboard ⚠ (`dashboard.ts:625`) and in ftp_check (`ftpSource.ts:71`). Zones derive from the kept FTP.
- Unset swim CSS: CLEAN. Swim zones gated `if(swimCssSecPer100>0)` → omitted, no default fabricated; `parseManualSwimCss(undefined)→undefined` (`zones.ts:68`, `assemble.ts:479-484`, `config.ts:53-62`).
- Blank race targets: CLEAN. `racePrep.ts:67-74` returns explicit "No race goals are set... Do NOT invent races", `TARGET: —`; `liveCoachingContext` prints "(no upcoming races set)".
- **Stale "marathon" framing: NOT CLEAN (laundered).** Hardcoded "marathon" framing in deterministic insight `detail` strings (`engine.ts:282,291,377,385`; `garminHealth.ts:42,82`) and in the cached system prompt persona (`persona.ts:57`: "the athlete is building a marathon off a triathlon base"), gated only on a DATA TREND, never on whether a marathon is on the live `getRaceGoalEvent` calendar. For an athlete whose season is three triathlons and no marathon, a run-load spike emits user-facing text naming a marathon that is not on the calendar. Surfaced via `buildInsights` to the dashboard (`server.ts:122,243`) and the `insights` MCP tool (`mcpServer.ts:310`). Note: `coach-instructions.md:33,43` (which OVERRIDES persona.ts as the live system prompt) phrases it correctly as a conditional, so the persona leak bites only the fallback brief; the engine detail strings always leak. Distance lookups using "marathon" as one of many distances (`engine.ts:188-189`, `splits.ts:218,230,242`) are legitimate and fine.

### Findings ranked

- HIGH-1 (Confirmed): Stale "marathon" framing laundered into live deterministic output + persona system prompt (`engine.ts:282,291,377,385`; `garminHealth.ts:42,82`; `persona.ts:57`). A known-drift guarantee ("degrade, don't invent") is REFUTED here. Blast radius: every run-load/durability/ACWR finding + the fallback system prompt. Closest thing to Critical this stage: it can steer LLM coaching toward a goal that does not exist.
- HIGH-2 (Confirmed): Brick decoupling on a same-day proxy with no order/gap check (`brick.ts:31,45`) mislabels between-session variance as brick fatigue, surfaced as a finding a triathlete acts on. Tempered by honest "proxy" labelling.
- MED-3 (Confirmed): Prediction-vs-goal single-snapshot finding surfaces at confidence 0.7 with no trend requirement (`engine.ts:427`).
- MED-4 (Confirmed): Anomaly z single-point surfaces (`correlations.ts:140-145`, conf 0.55, population SD, whole-series-mean baseline).
- MED-5 (Confirmed): Tri bike split reported as a bare point estimate, no uncertainty on the sensitive CdA/Crr/mass inputs (`splits.ts:308,354`).
- MED-6 (Confirmed): Change-point computes on short autocorrelated series, self-labelled not-significance-tested, suppressed from top findings (0.45<0.5) yet present in deep_dive (`changepoint.ts:125`, `metrics.ts:58`).
- LOW: TSB same-day-vs-yesterday convention; rampPerWeek gap-free assumption; efficiency/durability confounders; taper band from 1-3 races; projection constants uncited.

### Positives to keep (anti-sycophancy) + belief reversed

- Keep: correct `1−e^(−1/τ)` decay with an in-code defence against the wrong form; no fabricated TSS/IF (load = platform ESS); exact Coggan zone edges; threshold-absent OMITS not fabricates; CSS returns error strings not numbers; monitoring circularity recognised and relabelled "concordance not prediction"; correlations correct lag-scan multiplicity; FTP/swim-CSS/race-target drift all degrade cleanly.
- Belief reversed this stage: I suspected (via C7) that the "FDR-confirmed" correlation claim was laundered/over-claimed. Stage 2 reverses that. The code applies Bonferroni-on-the-lag-scan before BH, so the label is honest and spec 04 (which lists the double-dip as "open") is the stale artefact, not the code.

### How this updates the kill list + plan

- Stage 3 cut/fix candidates seeded by soundness: brick same-day proxy (relabel to "same-day decoupling" or gate to true off-bike runs needing FIT timing), change-point (raise rigor or cut, since it mostly does not surface).
- Stage 4 honesty fixes: gate "marathon" wording on `classifyRace`/live calendar (as `seasonContext.ts:114-122` already does for season shape) and fix `persona.ts:57`; add an uncertainty band to the tri bike split; add a trend/as-of guard or down-rank the single-point prediction and anomaly findings.
- Stage 5 doc reconciliation: spec 04 (FDR double-dip) is stale and should be marked done; C3 spec-status drift confirmed again here.
- Order for Stages 3-5 unchanged.

Stage 2 STOP: reported in chat; awaiting "continue" for Stage 3 (dead code + simplification) or redirect.

---

## Stage 3: Dead code, simplification, refactoring

Method: 3 read-only subagents (dead-code sweep across exports/modules; dead deps/scripts/env/config; duplication + refactor targets). Stage 2 landed on main (`4a16b65`); Stage 3 work continues on this branch. Headline: the codebase is remarkably clean. There is very little dead code and zero dangling deps/scripts/env/config. The bulk that Stage 5 might cut is feature SCOPE, not cruft.

### Dead-code delete list

True dead exports (delete, with their tests):
- `assertNoDirectWrite` (`guardrails/writeGate.ts:129`): Confirmed dead in production. Only references are the definition and `test/writegate.test.ts:118-122`. The live write path uses `WriteGate.propose/confirm/decline`, never this static guard. It is documented as a "hard guard against direct writes" but is wired into nothing, so it is a false safety net. Decision pending: delete, OR wire it into the write path so the guard is real (Stage 4 hardening choice).
- `decodeFitFromResult` (`insights/fitParser.ts:237`): Confirmed dead (definition + `test/fitparser.test.ts` only).

Unnecessary `export` (keep code, drop the keyword; functions are used in-file):
- `byCategory` (`coach/fuelInventory.ts:157`), `highSpecificityAlarm` (`coach/readiness.ts:133`), `presentInterpretableCount` (`coach/readiness.ts:146`), `applyLag` (`insights/stats.ts:163`), `lag1Autocorr` (`insights/stats.ts:88`). Lower-confidence same pattern: `reactionOf` (`decisionLog.ts:180`), `dateLabel` (`weather/assess.ts:75`), and the `garminTrends.ts` detectors (`stressTrend:73`, `bodyBatteryRecharge:93`, `sleepArchitecture:112`) which are called only via the same-file `garminTrendFindings` aggregator (likely exported for unit testing, so leave them).

Latent-dead DATA slot (this is a real bug, not just dead code):
- `AthleteState.load` (`state/types.ts:212`) is READ in production for a CTL sparkline (`cli.ts:448`, `mcpServer.ts:534`, `server.ts:653`, all `s.load.value?.ctl`) but is ASSIGNED only in `demo/sampleData.ts:155`. `assemble.ts` never populates it, so it stays `absent()` and **all three live reads always yield undefined**: the CTL sparkline silently never renders outside the demo. Fix: either populate `state.load` from `loadModel` during assemble, or remove the slot plus its three readers. Promote to Stage 4 (degrade-honestly: a feature that never fires should not pretend to exist). Confirmed.

Script-only module (not runtime dead, but not part of the app): `powerCurve.ts` exports (`bestAvgPower`, `meanMaximalCurve`) are consumed only by `scripts/build-career-history.ts` + tests. Keep, but note it is build-tooling, not the running engine.

Do-not-delete (reachable via dispatch/registration, would look dead to a naive sweep): all insight detectors aggregated in `engine.ts buildInsights()`; all MCP handlers registered in `mcpServer.ts`; all CLI flows dispatched in `cli.ts`/`cli/dataCommands.ts`; dashboard/server render functions; `screenWellbeingPrompt` alias; schema-version consts. The prior hint about `powerCurveAtDurations` was spurious (no such symbol exists).

### Dead deps / scripts / env / config

Nothing dead. Every dependency is imported, every `tsx src/cli.ts <cmd>` has a handler (`cli.ts:1043-1087`), every `bash scripts/*.sh` target exists, every env var read in `config.ts` maps to a consumed field, and `.env.example` matches (vars not in `config.ts` are read by `server.ts`/archive/shell by design, not drift). Only intentional duplicates: `start`/`serve` (both `src/server.ts`), `pm2:*` (documented launchd alternative). This is a genuine positive: the surface is large by scope, not by accumulation of cruft.

### Duplication + refactor targets

- `fmt(n,d)` (`n==null ? "—" : n.toFixed(d)`) is BYTE-IDENTICAL in `coach/weekly.ts:15`, `session.ts:32`, `readiness.ts:39`, `ask.ts:42`, while the canonical one is already exported at `dashboardHelpers.ts:176`. Survivor: the exported one.
- `num/str/obj/arr` unknown-to-typed coercers re-derived in ~10 files (`metrics.ts:77`, `taper.ts:37`, `backfill.ts:34`, `fitSync.ts:62`, `forecast.ts:43`, `intervals/map.ts:17,22`, `profile/context.ts:16-20`, `seasonArc.ts:101`, `fuelInventory.ts:49-56`, `careerHistory.ts:115`), canonical `asNumber` already at `state/payload.ts:29`. Biggest duplication by volume; subtle `|null` vs `|undefined` divergence is a latent-bug source. Survivor: one coercion module.
- `daysBetween` reimplemented ~7× (`seasonContext.ts:30` exported, `racePrep.ts:13`, `seasonArc.ts:87`, `seasonNudge.ts:9`, `listening.ts:128`; near-twins `horizon.ts:18`, `dataQuality.ts:67`). `garminInner` duplicated as local `inner` in `backfill.ts:144` (canonical `payload.ts:68`).
- Legacy `raceContext` (`seasonContext.ts:129`, self-flagged "kept for planAdjust + its test") vs richer `raceCalendarLines` (`:75`). Survivor: `raceCalendarLines`; migrate `planAdjust` + its test, delete `raceContext`. Textbook negative-rent.
- Recs-extraction trio (`recsToFindings` → `InsightLog.recordSurfaced` → `refreshAdviceEmbeddings`) verbatim in `ask.ts:167-169`, `deepDive.ts:128-130`, `orchestrator.ts:191-193`. Extract `surfaceRecommendations(recs, source, surface)` into `coach/adviceRecs.ts`.

Type safety: `archive/backfill.ts:171-216` (~14 `as any` on untyped Garmin DTO) is the one real hotspot and the best candidate for a zod boundary parser (zod is already a dep). `store.ts:65`, `assemble.ts:738`, `fuelInventory.ts:146` casts are guarded/benign. No `@ts-ignore`/`@ts-expect-error`/`eslint-disable` anywhere; `strict:true`. Over-engineering: `dashboard.ts` (1413 lines) is big but cohesive (not bad abstraction); the coercer proliferation is the clearest negative rent.

Target structures for the worst offenders: (A) one coercion + date + format util (`util/coerce.ts` or extend `payload.ts`) absorbing `asNumber/num/str/obj/arr`, `daysBetween`, `garminInner`, retiring the ×7 and ×10 duplications at once; (B) `archive/garminDto.ts` zod schemas parsed once after `garminInner`, replacing backfill's `as any` cluster; (C) `surfaceRecommendations` helper.

### Single highest-leverage, lowest-risk refactor

Delete the 4 duplicate `fmt` copies and import the already-exported `fmt` from `dashboardHelpers.ts:176`. The copies are byte-identical to a canonical export already used elsewhere, so zero behaviour change, no new module, no API decision, fully covered by the existing typecheck/test gate. Highest dup removed per unit of risk. (The coercion-helper consolidation is higher TOTAL leverage but carries a `null`-vs-`undefined` convention decision, so it ranks second on risk.)

### Sequencing + interaction with Stage 2

Deletion/un-export and the `fmt` + coercion consolidations come first (they shrink and de-risk the surface before Stage 4 hardening). The Garmin zod boundary parser (B) doubles as a Stage 4 hardening item (it removes the one unchecked-external-JSON hotspot). Stage 2 soundness cut-candidates (brick same-day proxy, change-point) are NOT dead code, they are reachable; they belong to the Stage 5 kill-list as scope/quality decisions, not Stage 3 deletes. The `load`-slot fix is the one item that is both dead-code cleanup and an honesty fix (a silently-empty feature).

### Positive + belief reversed

Positive to keep: the codebase has almost no dead code and zero dangling deps/scripts/env/config under a strict-typed, no-escape-hatch build. That is unusual discipline. Belief reversed this stage: I expected a 25k-LOC solo project to carry significant dead weight to cut; it does not. So Stage 5's "cut a third" must target FEATURE SCOPE (does this feature earn its keep), not code cruft, because the cruft is not there.

Stage 3 STOP: reported in chat; awaiting "continue" for Stage 4 (hardening + UX) or redirect.

---

## Stage 4: Hardening + UX + honesty

Method: 3 read-only subagents (security/hardening; coaching-surface UX; honesty cross-reference vs the claims ledger). Two findings I verified personally (the Critical-candidate and a correction to my own Stage 3 claim). Stage 3 landed on main (`7decdfb`); Stage 4 continues on this branch.

### Hardening, ranked

- HIGH H-1 (Confirmed, I verified the path myself). `ingest_fit` takes a caller-supplied absolute `path`, is registered in the ALWAYS-ON `buildServer()` block (not behind `includeFileAccess`, `mcpServer.ts:260-268`), and `ingestFitFile` does `existsSync`/`readFileSync` on it with NO containment or deny-list (`fitIngest.ts:68-72`). On the HTTP/Cowork surface a token-holder gets a file-existence + parse-verdict oracle ("file not found" vs "not a decodable .FIT") for any path the process can read, bypassing the deny-list `read_file`/`write_file` deliberately enforce. I rank this HIGH, not Critical (the subagent's call): it needs the bearer/OAuth token (not unauthenticated), discloses existence not contents, and only on the opt-in HTTP surface. Fix: route `src` through `resolveSafePath`/restrict to the streams dir, and gate the `path` arg behind `includeFileAccess`.
- HIGH H-2 (Confirmed). Medical/bloods/medication reach the LLM prompt (`profile/context.ts:45-106,194-211`) and the full profile JSON is dumped by `get_profile`, which is registered unconditionally on HTTP (`mcpServer.ts:283`). `COACH_MCP_PROFILE_WRITE`/`COACH_MCP_FILE_ACCESS` gate writes/raw-files only, NOT this medical READ, so it is on-by-default on any HTTP deployment. The bearer/OAuth token is adequate for the documented single-user private tunnel, but there is no defence-in-depth and no opt-in mirroring profile-write. Fix: add `COACH_MCP_EXPOSE_MEDICAL` (default false) dropping medical lines/markers from the prompt block and `get_profile` on HTTP.
- HIGH H-3 (Confirmed). AIE per-tool `callRaw` has no timeout; only connect/reconnect is bounded (`aieClient.ts:138-148` vs `:104-114`). A hung upstream tool call after connect stalls every read/flow/`confirm` indefinitely. The required spine is the one client without a per-call cap (Garmin/intervals/weather all have one). Fix: pass `{timeout: config.aie.timeoutMs}` to `callTool` or wrap in `withTimeout`.
- HIGH H-4 (Confirmed). No 429/rate-limit/backoff on any external call (`intervals/api.ts:28`, `weather/forecast.ts:101`, `aieClient.callRaw`, `CoachLLM`). A transient 429/503 fails the whole flow. Partial mitigation: the Anthropic SDK retries by default; the source HTTP clients do not. Fix: bounded retry-with-jitter on 429/5xx + Retry-After, 2-3 attempts.
- MED H-5: CoachLLM has no caller-side timeout (`client.ts:53-66,97-136`); combined with H-3 there is no end-to-end deadline on an LLM flow. Fix: `Promise.race` vs `COACH_LLM_TIMEOUT_MS`.
- MED H-6: prompt-injection "treat as DATA" guard is on ask/weekly/racePrep/session/planAdjust but MISSING on deep_dive/tune/season/fuel_review (`deepDive.ts:93-104`, `tuneUp.ts:29-38`, `seasonNarrative.ts:34-52`, `fuelReview.ts:58-73`). fuel_review forwards the user's own per-session notes verbatim. Exploitability is low-med (single-user, own data) but it is an inconsistency with five guarded flows that also write reports. Fix: prepend the same guard line.
- MED H-7: AIE/intervals error detail is thrown unredacted (`aieClient.ts:145`, `intervals/api.ts:28`) and reaches MCP output + logs; only Garmin/two CLI paths use `redactSecrets`. Low likelihood of token echo, but the utility exists and is not applied on the spine. Fix: `redactSecrets` over the thrown message + `mcpHttp.ts:191`.
- MED H-8: `update_profile` writes to `COACH_PROFILE_PATH` with no containment (`update.ts:49-52`); operator-misconfig hazard, and a remote profile-write caller supplies the content. Fix: assert target resolves inside the repo/allow-listed dir.
- LOW H-9: Garmin `tryCall` is a generic passthrough with no allow-list (`garminClient.ts:60-71`); latent footgun, no untrusted path today. LOW H-10 (positive): the HANDOVER esbuild advisory is stale; `esbuild@0.28.1` in the lockfile is past the fix and dev-only. Other top deps are recent with no reasoned-critical advisories.
- POSITIVE (keep): zod-typed tool args throughout, `read_report` basename traversal guard (`reports.ts:55-57`), `parseClock` numeric validation, 1 MB body cap, constant-time bearer compare, non-loopback `auth=none` refusal, short-token refusal.

### UX of the coaching surface

- Overlap/collision: ask vs insights vs deep_dive vs readiness (HIGH: nothing signposts that `insights` is the no-LLM primitive, `deep_dive` the LLM narrative of the same metrics, `ask` a router that can silently re-route into session feedback, `ask.ts:136-142`); weekly vs season_arc vs deep_dive vs tune (MED-HIGH horizon ambiguity, only `tune` is well-disambiguated); get_state vs sync (MED staleness trap, near-identical output, freshness only weakly signalled); fuelling/fuel_review/log_fuel (clean). Minor: react_to_insight vs retrospect.
- Output shape: readiness/ask/weekly lead with the answer and are coach-ready (`formatReadiness` mcpServer.ts:163-177 exemplary). insights/sync/get_state are metric-WALL dumps with a header then ~14-30 lines and no headline takeaway (`deepDive.ts:45-83`, `mcpServer.ts:81-107`); the assistant must summarise them. "—" discipline is honoured everywhere.
- Journeys: "how am I today" = readiness, 1 call, medium LLM, low staleness (trap: an assistant picking get_state gets a stale snapshot with no cue). "should I swap tomorrow" = readiness → propose_adjustment (high-effort) → confirm, 2-3 calls; discoverability gap: nothing points to propose_adjustment from readiness/ask, so the assistant may answer conversationally and never move the session. "prep me for the race" = race_prep, 1 call high-effort, degrades well when no race set.
- Error messages: unusually good and actionable (no key, no state, no .FIT with 3 escape hatches, no race goal); only the pass-through AIE/timeout errors are semi-opaque (`aieClient.ts:109,145`).
- Concrete fixes: prepend the already-computed `coachHeadline` as line 1 of `insights`; add a staleness cue to `get_state` + `summarizeState`; add "use-when / cost" tags to ask/weekly/deep_dive/season_arc descriptions.

### Honesty (cross-ref claims-ledger Theme 4)

- HIGH (the dominant honesty debt). The original author's race context is hard-coded into DETERMINISTIC output, firing regardless of the live AIE calendar: "marathon-off-tri" framing in `engine.ts:282,291,377,385`, `garminHealth.ts:42,82`, `fit.ts:298`; "the July tri and September marathon taper" (specific events/dates) in `taper.ts:89`; and the readiness persona rule "the athlete is building a marathon off a triathlon base" in `persona.ts:57`. `seasonContext.ts:60,112-122` already conditions this correctly on the live calendar, so the engine/persona are the outliers. Type A+B; violates honest-models AND the SETUP promise that the marathon context is the original author's only. Broader than Stage 2 found (now 6+ files). Fix: gate the wording on `classifyRace`/`deriveSeasonShape`, or strip the race-specific tail and let the live context block supply it.
- HIGH: `racePrep.ts:99` injects raw `JSON.stringify(prediction).slice(0,600)` into the prompt, unlabelled, truncated mid-JSON; the model can recite a predicted finish as fact. Fix: format into named fields with a MODEL + as-of tag.
- MED: road-dry ride-card `reason` carries no per-line MODEL tag (`assess.ts:198-205`) while water-temp does; downgraded because the dashboard footer adds a card-level drying-MODEL caveat (`dashboard.ts:604`). MED: tri bike split is a point estimate with no ± (`splits.ts:308`); downgraded by the card-level "A MODEL" label (`dashboard.ts:843`).
- LOW-MED: `deepDive.ts:78` prints a default confidence `(f.confidence ?? 0.6)*100` as a hard "60%", reading as a computed figure. Fix: omit the % when confidence is undefined.
- MED (Suspected): `Provenanced<T>` has source+note but no timestamp (`types.ts:18-23`); a stale snapshot recites HRV/RHR/recovery as "live" with only the global header date as anchor. Mitigated by the get_state header and dashboard freshnessLine. Fix: optional `asOf` for clock-skewed fields.
- POSITIVE (keep): the render/dashboard layer is the convention's strongest implementation (per-card MODEL tags, freshness lines, "—" discipline, site-wide disclaimer). The honesty debt sits in the deterministic insight/prompt builders, not the UI.

### Correction to my Stage 3 claim (anti-sycophancy)

Stage 3 said the unused `AthleteState.load` slot means "the CTL sparkline silently never renders". Verified and corrected: the main dashboard "Load & trends" sparkline reads `ins.load.series` (populated by `loadModel`, works; `dashboard.ts:193-196`). Only the SEASON-ARC CTL trend reads `s.load.value?.ctl` per snapshot (`cli.ts:447-449`), which `assemble.ts` never populates, so it filters to empty and degrades to "—" (honest, not a fake value). So: the `load` slot is genuinely dead data (Stage 3 correct) but the impact is a non-functional season-arc CTL trend showing "—", NOT a broken dashboard feature and NOT a honesty violation. I overstated the blast radius; this is the corrected version.

### How this updates the plan

Stage 4 yields the concrete execution items. Highest-priority security fix: contain/gate `ingest_fit` (H-1). Highest-priority correctness+honesty fix: de-hardcode the marathon/July/September race context across the 6+ deterministic builders (the dominant honesty debt). Cheap parity fixes: prompt-injection guard on the 4 unguarded flows (H-6), redaction on the AIE/intervals error path (H-7). The timeout/retry cluster (H-3/H-4/H-5) hardens the spine. UX fixes are description + headline reshapes with no logic change. The `load`-slot item drops from "broken feature" to "dead slot + cosmetic season-arc trend" (wire it up or remove it). Order for Stage 5 unchanged.

Stage 4 STOP: reported in chat; awaiting "continue" for Stage 5 (strategy, kill list, bravest cut, consolidated execution plan) or redirect.

