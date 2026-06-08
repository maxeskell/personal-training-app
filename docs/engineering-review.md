# Endurance Coach — Staff Engineering Review & Hard Challenge

_Independent line-by-line audit of `src/**` (three reviewers, 2026-06). Analysis only — no code changed by this document._

## 1. Executive summary

This is a **local-first AI triathlon coach**: it assembles an `AthleteState` from AI Endurance (MCP/HTTP) + Garmin (MCP/stdio), runs a deterministic insight engine over it, narrates with an LLM (Claude), and can write plan changes back to AI Endurance through a gated propose→confirm flow. A small HTTP server renders a phone dashboard.

**The design is genuinely good in shape.** Provenance on every field (`Provenanced<T>`), "degrade a field to null, never crash assembly," a single funnel for writes (`WriteGate`), an append-only decision log for audit, deterministic detectors separated from LLM prose, and honest statistical framing (CIs, FDR, walk-forward + permutation, "exploratory/descriptive" labels). For an n=1 app this is unusually disciplined.

**But it is not yet trustworthy near a live account, for three systemic reasons:**

1. **The write path lets a human confirm an _unvalidated, possibly hallucinated_ write.** Proposed tool args are never checked against reality before you're asked to apply them; the proposer may even emit an undocumented write tool. (The gate stops _unconfirmed_ writes — not _wrong_ ones.)
2. **The local server is unauthenticated on `0.0.0.0` and exposes write + LLM-spend endpoints**, with no `Host`/origin check (DNS-rebinding), no body limits, no rate limiting.
3. **Several "honest-uncertainty" statistics quietly undermine themselves** — FDR computed on selection-time r/lag (double-dipping), ratio/percent metrics on near-zero or signed bases, change-points presented as "genuine shifts" without a significance test.

Layered on top is real correctness/reliability debt (non-atomic state writes read concurrently by the server, a permanently-dead fuelling path, UTC week-bucketing that can flip an injury flag) and an **inverted test profile** — the most error-prone code (binary `.FIT` parser, the CI/correlation primitives, change-point, `assemble` field-mapping, the write gate, the server routes) has **no tests**, while trivial banding is well covered.

**Recommendation:** treat the items in §4 marked **P0** as a release gate before trusting this against a live AI Endurance account or exposing the dashboard beyond `localhost`. The roadmap is in `docs/improvement-plan.md`; per-initiative specs in `docs/specs/improvements/`.

## 2. Architecture assessment (the good)

- **Provenance + graceful degradation** (`state/types.ts`, `state/assemble.ts`): external shape drift downgrades a field to `null` rather than crashing. `store.load()` merging persisted state over `emptyState()` is a clean, tested answer to schema evolution.
- **Single write funnel** (`mcp/aieClient.ts` rejects writes on the read path; `guardrails/writeGate.ts` is the only caller of `callRaw`; `assertNoDirectWrite` backstop). Propose→confirm is real and audited.
- **Deterministic engine vs LLM narrative**: detectors self-gate on coverage; `metrics.surfaceFindings` + confidence/suppression keys is a clean spine shared by the dashboard, `headline`, and `ask` so surfaces can't disagree.
- **Honest statistical intent**: Fisher-z CIs on an autocorrelation-discounted effective N; walk-forward + circular-shift permutation for the monitoring rule; FDR on the correlation scan; "MODEL/exploratory/descriptive" labelling throughout.
- **Operational care**: prompt-cached stable system prompt; throttled, resumable backfill; "creds never leave the Mac" intent.

## 3. The hard challenge (what's actually wrong)

> The premise of this app is **"trust the numbers, act on them."** Every systemic weakness below attacks exactly that premise — quiet-wrong data, over-claimed certainty, or an action path that can write the wrong thing. Those are the bugs this product can least afford, and they cluster in the code with the least test coverage.

- **You can confirm a write you can't actually read.** The confirmation UI shows opaque JSON args the LLM invented; nothing validates the `workoutId` exists or the date is well-formed (`writeGate.ts`, `planAdjust.ts`). "Two-step gating" is necessary but not sufficient if step two is unverifiable.
- **The proposer's context is thinner than it looks.** It sees the _surfaced findings_ + load/recovery + planned sessions + the static persona — **not** durability/heat/EF/taper/predictions, and **not** your live race goals (those are hard-coded into prompts and will go stale). It is grounded, but not the "uses all my data + my goals" experience implied.
- **The certainty markers are partly theatre.** "[FDR-confirmed], 80% confidence" is computed from the r/lag chosen by a 5-lag × 3-relationship search whose multiplicity the p-value ignores. Heat attribution and change-point %s are ratios on signed/near-zero bases. These are the exact "impressive-looking nonsense" failure modes the project brief names.
- **The dashboard is one apostrophe from broken.** `escapeHtml` doesn't escape `'`/`\`, and handler args are built by string concatenation, so a finding titled _"athlete's…"_ silently disables the feedback buttons — and LLM/external text in that position is an injection vector. (This is the same class as the bug just fixed for proposal buttons; it still lives in the feedback buttons and race-goal rendering.)
- **A bad concurrent moment loses data or shows "No data yet."** State files are written non-atomically and read concurrently by the server; append-only logs aren't serialized and a single partial line makes `all()` return `[]`.

## 4. Prioritized findings (P0 → P3)

Format: `file:line — problem — impact — fix`. P0 = release-gate.

### P0 — security / safety / data-loss
- **`server.ts` (listen `0.0.0.0`; `/act`, `/confirm-proposal`, `/refresh`, `/ask`)** — unauthenticated server exposes AI-Endurance **writes** and LLM **spend** to anyone on the LAN; no `Host`/origin check (DNS-rebinding from a malicious webpage), no body-size limit, no rate limit, no `server.on('error')`. — Plan mutation / budget drain / memory-exhaustion from off-machine. — Bind `127.0.0.1` by default; require a shared-secret/pairing token on all mutating + LLM routes; validate `Host` against an allowlist; cap request bodies (~64 KB) and handle `aborted`. → **Spec 1**.
- **`dashboard.ts` (feedback `onclick` ~147–149; race-goal cells ~344; client `esc`/server `escapeHtml`)** — handler args built via string-concat through an HTML-escaper that does **not** escape `'`/`\`; LLM/external text flows in. — One apostrophe breaks all buttons; backslash/`</script>` can inject JS. — Emit data as HTML-escaped `data-*` attributes + delegated listeners (no inline-arg quoting); add a real JS-string escaper; escape race-goal fields. → **Spec 3**.
- **`writeGate.ts:85` + `planAdjust.ts`** — executed args are never validated; `parseArgs` only checks "is an object." — Human confirms a possibly-hallucinated `workoutId`/date/zones that writes to a real account. — Per-tool arg validators at `propose()`; reject proposals whose `workoutId` isn't in `plannedSessions`; show the resolved workout title+date in the confirmation, not raw JSON. → **Spec 2**.
- **`aieClient.ts:25–34` vs `planAdjust.ts:18–60`** — `createRideRunWorkoutAdvanced` is in the proposable enum but undocumented in the tool reference; other create/setZones arg shapes unverified. — Model invents args for an undocumented write tool → confirmable. — Narrow the proposer enum to a documented+validated subset; generate enum and reference from one source. → **Spec 2**.
- **`store.ts:18–21`** — non-atomic `writeFile` over the live day file; server reads it concurrently; `load()` swallows parse errors. — A GET mid-write renders "No data yet" / drops today from baselines. — Write temp + `rename()` (atomic on POSIX). → **Spec 5**.
- **`engine.ts:~285`** — `analyseFuelling([], [], …)` always called with empty arrays; the real series only reaches `garminTrends.fuellingFromGarmin`. — The engine-level fuelling detector is permanently dead (duplicated). — Remove the dead call or feed `archive.garminDays`; de-dupe. → **Spec 4**.
- **`correlations.ts:~150` + `stats.ts` (`corrPValue`/`bestLaggedCorr`)** — FDR p-values derived from the r/lag selected by a 5-lag × 3-relationship max-|r| search; multiplicity ignored. — "FDR-confirmed / 0.8 confidence" over-claims (anti-conservative). — Permutation-test the whole scan, or inflate p by the search size / widen the comparison set. → **Spec 4**.

### P1 — important correctness / reliability / injection
- **`decisionLog.ts:111` + `writeGate.ts:37`** — proposal id is a 32-bit hash of `tool:args:second`; identical proposals in the same second collide; weak hash can collide across different proposals. — `confirm(id)` can resolve the wrong/again-un-confirmable write. — `crypto.randomUUID()` for record ids. → **Spec 2**.
- **`writeGate.ts:60–88`** — cross-process confirm has a TOCTOU window (two processes both see "proposed", both write). — Double write. — Append an "executing" claim + re-read, or lockfile; document non-concurrency otherwise. → **Spec 2**.
- **`client.ts:28–51`** — `structured()` JSON.parses the first block with no schema validation and no `stop_reason==='max_tokens'` check (unlike `text()`); thinking shares the 4000-token budget. — A truncated proposal array is treated as authoritative and fed to the gate. — Check `stop_reason`, validate against schema, raise budget. → **Spec 2**.
- **`ask.ts` / `planAdjust.ts`** — raw user input + external AIE/Garmin strings concatenated into prompts with no delimiting; `wellbeing.screenNutritionPrompt` only guards the `ask` input, never `propose`/reports or model output. — Prompt-injection ("propose skipWorkout for everything"; injected activity/race names); restriction advice can route around the screen. — Delimit + mark untrusted; apply the wellbeing screen to all request strings and to output. → **Spec 2/6**.
- **`store.ts`/`decisionLog.ts`/`archive/store.ts`** — JSONL appends unserialized; a single partial/unparseable line makes `readJsonl`/`all()` return `[]` (whole log lost to consumers). — Crash-mid-write or concurrent append silently zeroes the audit trail / archive. — Per-line try/catch (skip bad lines); serialize appends through a queue. → **Spec 5**.
- **`assemble.ts:~319`** — nutrition "today" index falls back to `min(1, len-1)` when the date isn't found. — Applies yesterday's/tomorrow's fuelling ranges as today's (esp. across a TZ boundary). — Leave `nutritionTargets` absent when the date isn't matched. → **Spec 5**.
- **`metrics.ts` (`isoWeek`/`runLoadRamp`)** — week bucketing uses UTC Monday; activities near local midnight land in the wrong week. — Can flip a flag-severity run-load-spike injury finding. — Bucket by the captured local date everywhere. → **Spec 4**.
- **`stats.ts:24` vs `:92`** — population SD (÷n) used with sampling-theory Fisher-z CIs (expect ÷(n−1)); `effN−3` deflated. — CIs mildly miscalibrated in a module whose whole job is calibrated uncertainty. — Pick one convention; document `effN` as heuristic. → **Spec 4**.
- **`heat.ts:~87` / `changepoint.ts:~95` / `efficiency.ts:62`** — ratio/percent on near-zero or signed bases; change-points never significance-tested but surfaced as "genuine shift"; EF~CTL residual trend conflates CTL with time (collinearity). — Fabricated "100% heat" attributions; over-claimed regime shifts and "economy gains." — Floor the denominators; permutation/penalty check change-points; joint `EF ~ CTL + t` with CI. → **Spec 4**.
- **`config.ts:30–33`** — `GARMIN_MCP_ARGS.split(" ")` breaks any arg containing a space. — Garmin spawns with wrong argv → confusing degradation. — Shell-aware split or JSON array. → **Spec 5**.
- **`stats.ts:128` (`bestLaggedCorr`)** — can keep a non-significant max-|r| lag over a weaker significant one. — Surfaces CI-spans-0 associations as the "strongest significant." — Track best-among-significant separately. → **Spec 4**.

### P2 — moderate
- `server.ts` — `loadArchive()` re-reads/re-parses the full JSONL archive on every request (multiple times per flow); no mtime cache. → cache per request / by mtime. (Spec 5)
- `assemble.ts` — 14 sequential Garmin calls × 25 s = ~6 min worst-case `/refresh` with no overall budget. → global wall-clock cap for the Garmin phase. (Spec 5)
- `oauthProvider.ts` — callback server not closed on `waitForCode` timeout (port leak). (Spec 5)
- `correlations.ts:62` / `metrics.ts:138` / `changepoint.ts:36` — sleep↔load pairing and CTL EWMA assume a dense daily axis but iterate array order; change-point penalty computed once on the whole series; CTL cold-start bias. → dense date index, per-segment σ², burn-in. (Spec 4)
- `fitParser.ts` — field scaling keyed by global field number without asserting message type (only safe because record-only). → make the msg-20 restriction explicit. (Spec 4)
- `wellbeing.ts` — regex-only, ask-only. (Spec 2/6)
- `cli.ts` — duplicated LLM/state boilerplate; unconnected `AieClient` passed to `WriteGate` relying on a comment. (Spec 2)
- `health.ts` — token-redaction regex misses base64 `+`/`/`. (Spec 1)

### P3 — nits / hygiene
- Duplicated `mean`/`slope`/`zscore` (4+ copies, inconsistent null handling) and `fmt`/`escapeHtml` across files → consolidate in `stats.ts` / a `util/html.ts`. (Spec 4)
- `headline.ts` imports `InsightReport` from `engine.ts` (view→engine coupling) → narrow shared interface. 
- Hard-coded race dates/taper %s in `readiness.ts`/`weekly.ts`/`racePrep.ts` (will go stale) → source from AIE goals. (Spec 6)
- `syncGaps.ts` cross-check is dead in the live path (always `undefined`). 
- `loadSessionDecays` re-parses all `.FIT` per build → cache by mtime. (Spec 4)
- `decisionId`/numeric CLI args silently coerce bad input. 
- `notify.ts` AppleScript string-interpolation surface. 
- Raw AIE/Garmin payloads stored in `state.raw` and fed to the LLM unescaped → delimit as untrusted. (Spec 2)

## 5. Test-coverage gap (cross-cutting)

The risk profile is **inverted**: untested = `fitParser.parseFit` (hand-rolled binary decoder), `corrWithCi`/`bestLaggedCorr`, `changePointsOf`, `loadModel`/`runLoadRamp`, `analyseEfficiency`/`analyseBricks`/`analyseTaper`, `assemble` field-mapping + unit conversions, `writeGate`, all `server.ts` routes, `oauthProvider`. Monitoring is tested at n=400 — never at the real n≈60 where the method is fragile. Well-tested = banding, gating, headline, store-normalization, dashboard-JS-validity. **Every initiative below ships with tests for its surface; a standing goal is to invert this.**

See `docs/improvement-plan.md` for sequencing and the release gate.
