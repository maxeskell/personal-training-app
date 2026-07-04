---
name: endurance-coach-architecture-contract
description: >
  The load-bearing architecture and invariants of the Endurance Coach app — load this when you need to
  understand how data flows, what must never break, or where something is assembled/enforced before you
  design or change a feature. Triggers: "how does data flow", "where is X assembled", "what are the
  invariants", "what must not break", "is this safe to change", "why is this null / a '—' field", designing
  or reviewing a feature that touches state assembly, sources (AI Endurance / Garmin), the write path,
  persistence, the dashboard HTML, the LLM coach layer, or the profile; onboarding to the codebase; wanting
  the contract behind `assemble.ts`, `Provenanced<T>`, `WriteGate`, `escapeHtml`, `StateStore`, the
  propose→confirm write gate, degrade-don't-crash, deterministic-vs-LLM split, or "no live numbers in the
  profile". Keywords: AthleteState, assembleState, Provenanced, WriteGate, allowWrite, escapeHtml,
  StateStore, atomic + locked write, prompt cache no-op, claude-opus-4-8. NOT for live triage of a broken
  symptom (use endurance-coach-debugging-playbook), the env-var catalog (use endurance-coach-config-and-flags),
  the statistics internals (use endurance-coach-proof-and-analysis-toolkit / endurance-domain-reference), or
  the change/ship gate itself (use endurance-coach-change-control / endurance-coach-run-and-operate).
---

# Endurance Coach — architecture contract

**Use this when** you are designing or reviewing a change that touches the daily state, the data sources,
the write path, persistence, the dashboard HTML, or the LLM coach layer, and you need to know *what the
system guarantees and where those guarantees are enforced* so your change preserves them.

**Don't use this when** — a live thing is broken and you need to triage it (use
`endurance-coach-debugging-playbook`); you need the env-var catalog or a flag's meaning (use
`endurance-coach-config-and-flags`); you need the meaning/maths of a metric or the statistics internals (use
`endurance-domain-reference`, `endurance-coach-proof-and-analysis-toolkit`); or you're asking whether a
change may be committed/shipped (use `endurance-coach-change-control`, then `endurance-coach-run-and-operate`).

Jargon defined once, here:
- **AIE** = AI Endurance, the external coaching platform reached over **MCP** (Model Context Protocol, a
  tool-call protocol) with **OAuth**. It owns the training-load science (FTP, CSS, thresholds, predictions,
  recovery). We *consume* it; we never re-derive it.
- **AthleteState** = the one assembled daily object every downstream layer reads.
- **Provenanced<T>** = a value wrapped with where it came from: `{ value: T | null, source, note? }`.
- **Write gate** = the propose→confirm two-step that is the only path to mutating the AIE plan.

---

## The one-paragraph model

Local-first, single-athlete. Each day `assembleState()` reads AIE (the spine) plus optional Garmin, maps
what it recognises into typed **Provenanced** slots (unrecognised → `null`, never a crash), and produces one
`AthleteState`. `StateStore` persists it as a flat JSON file per day (no database). Three families of reader
consume it: **insight detectors** (`insights/`, deterministic statistics), the **LLM coach flows**
(`coach/`, the only callers of Anthropic Opus), and the **dashboard** (`coach/dashboard.ts`, HTML, all text
escaped). Any mutation of the AIE plan goes through the **write gate** and nothing else. Secrets live outside
the repo in `~/.endurance-coach`; personal data lives in a gitignored `data/`.

---

## The invariants table — what must not break

Every row is a contract a change must preserve. "Enforced in" is the file that makes it true; "Test you
didn't break it" is how to prove your change kept it.

| # | Invariant | Enforced in | Test you didn't break it |
|---|-----------|-------------|--------------------------|
| 1 | **Every AIE plan write goes through the write gate** (propose→confirm). No other call site may mutate the plan. | `guardrails/writeGate.ts`; direct-write guard in `mcp/aieClient.ts` `callRaw()` (throws unless `opts.allowWrite`), and `read()` pre-rejects write tools. | `npm test` (`test/writegate.test.ts`); grep that `allowWrite: true` appears **only** in `writeGate.ts` (see re-verify below). |
| 2 | **`Provenanced<T>` everywhere.** Every `AthleteState` field is `{ value: T\|null, source, note? }`; a shape change or tool error degrades ONE field to `null`, never crashes. | `state/types.ts`; `state/assemble.ts` (try/catch per read → `raw[tool] = { error }`). | `test/assemble.test.ts`. Feed a malformed tool payload fixture → the slot is `absent()`, others intact. |
| 3 | **Degrade, don't crash.** Garmin, weather, local LLM are best-effort with per-call timeouts and an overall Garmin wall-clock budget. A failure = a missing card/field with a note, never an error page or a hung `/refresh`. | `assemble.ts` (`callG` skips remaining Garmin reads once `config.garmin.refreshBudgetMs` deadline passes); `retry.ts`. | Simulate a slow/failing Garmin fixture; assemble still returns a full state with Garmin slots `null`. |
| 4 | **Deterministic flows make ZERO LLM calls.** State assembly, insights, weather, dashboard cards make no Opus calls; only the named `coach/` flows do. | `insights/`, `weather/`, `coach/dashboard.ts` do not import the LLM client. | Grep: no `llm/client` / `CoachLLM` import under `insights/` or `weather/`, none in `coach/dashboard.ts` (re-verify below). |
| 5 | **Dashboard HTML is escaped.** All interpolated text → `escapeHtml`; handlers bind via `data-*` attributes, never quoted JS args. | `util/html.ts` `escapeHtml` (escapes `& < > " '`); used ~81× in `coach/dashboard.ts`. | `test/dashboard.test.ts` asserts inline `<script>` blocks still parse after adversarial titles. |
| 6 | **Atomic + locked persistence.** State writes are temp-file + `rename`, guarded by a cross-process lock on the state dir. `save()` strips `profile` (medical) and `dataCompleteness` before disk. `load()` shape-guards a corrupt/hand-edited slot back to `absent()`. | `state/store.ts` (`proper-lockfile`, `looksProvenanced`); decision log holds its own lock for the confirm critical section. | `test/store.test.ts`. Hand-corrupt a slot in a fixture → `load()` returns it as `absent()`, doesn't throw. |
| 7 | **No live numbers in committed/profile data.** FTP/CSS/HRV/RHR/pace/CTL/ATL/TSB/TSS/VO2/threshold/weight may not appear as numbers (or numeric strings) in the profile. Live numbers come live from AIE/Garmin at question time. | `profile/schema.ts` `assertNoLiveNumbers()` (exported, `src/profile/schema.ts:218`). | `test/profileQuestions.test.ts` + schema tests; add a numeric FTP to a profile fixture → assertion throws. |
| 8 | **Wellbeing is a hard gate.** `screenNutritionPrompt()` blocks acute-symptom / disordered-eating / restriction prompts BEFORE the LLM (called in `ask.ts`, and on `changeWorkoutAdvice` content in `writeValidators.ts`). `assessHealthRisk()` does a post-assembly co-occurrence check and refers, never diagnoses. `CLINICAL_BOUNDARY` (`coach/persona.ts`) is in every system prompt as defence-in-depth. | `guardrails/wellbeing.ts`; `coach/persona.ts`. | `test/wellbeing.test.ts`. A restriction/"race weight" prompt returns `blocked: true`. |

> A change that breaks any of these is a bug, not a trade-off. If you think you need to break one, that is a
> `endurance-coach-change-control` conversation first — and rows 1 and 8 (the write gate and the wellbeing
> gate) may never be routed around.

---

## The primary data flow

```
AIE (MCP/OAuth, the spine)  ─┐
                             ├─► assembleState()  ─►  AthleteState  ─►  StateStore.save()  ─►  data/state/YYYY-MM-DD.json
Garmin (optional, degradable)┘   (state/assemble.ts)  (Provenanced)     (atomic + locked)
                                                            │
                             ┌──────────────────────────────┼──────────────────────────────┐
                             ▼                              ▼                              ▼
                    insights/ (deterministic          coach/ (LLM flows,             coach/dashboard.ts
                    detectors + stats; NO LLM)         the ONLY Opus callers)         (HTML, all text escaped)
                             ▲
             archive/ (long JSONL history) widens trend detectors beyond the live ~40-activity / 60-day window
```

### `assembleState()` — THE join (`state/assemble.ts`)

1. **Start from `emptyState()`** — every slot pre-seeded `absent()` (`{ value: null, source }`). A field that
   never gets mapped stays `null` with its source tag; consumers can always read `state.<slot>.value`.
2. **Read the AIE spine** — a fixed list of read tools (`getUser`, `getPlannedWorkouts`, the three activity
   tools, `getRecoveryModel`, `getPlanProgress`, `getPrediction`, `getNutritionModel`, `getRaceGoalEvent`),
   each in its own `try/catch`. A failed read becomes `raw[tool] = { error }` — it does not abort the join.
3. **Map into typed slots** — `mapRecovery`, `mapNutrition`, `mapUser`, `mapZonesThresholds`, etc. Mapping is
   *defensive*: it extracts what it recognises and leaves the rest `null`. Raw payloads are kept in
   `state.raw` so the LLM layer can reason over fields not yet mapped (resilience to AIE tool-shape drift).
4. **Optional Garmin gap-fillers** — only if `garmin?.available`. Called **sequentially** (the Taxuspt MCP
   serves one request at a time) inside an overall wall-clock budget (`config.garmin.refreshBudgetMs`,
   default 90000 ms): once the deadline passes, remaining Garmin reads resolve to `null` so a slow tool can't
   hang `/refresh`. Garmin's own FTP/LT/max-HR win over the AIE-derived values where present; both are also
   kept un-merged in `thresholdsBySource` so the dashboard can show "AIE 250 W vs Garmin 235 W" side by side.
5. **Baselines** — `applyBaselines(computeBaselines(...))` over the trailing window (incl. today) fills the
   `*7dBaseline` derived slots.
6. **Sync-gap detection, manual swim-CSS fallback, metric overrides** — last word after all source mapping.
7. **Return** the state; the caller (orchestrator) attaches the in-memory `profile` and `dataCompleteness`
   before the coaching prompts. `StateStore.save()` **strips both** so medical data and the time-sensitive
   completeness readout never reach disk (invariant 6).

> AIE is the activity source of truth (it already ingests Garmin). Assemble deliberately does **not** fetch
> Garmin's activity list — passing an empty list to the sync-gap detector would false-flag every AIE
> activity as a gap. Cross-check is reserved for resolving a specific discrepancy.

### Why the load-bearing design decisions are the way they are

| Decision | Why (keep it this way unless the reason is gone) |
|----------|--------------------------------------------------|
| **Local-first, no DB** | Single athlete, one machine. Flat JSON is inspectable and git-diffable; the ceiling is fine at this scale. Swap for SQLite only if query needs actually grow (`store.ts` says so). |
| **Single AIE spine + optional Garmin** | AIE owns the calibrated load model; individual training response is ~50% heritable with 20–45% non-responders, so a solo-built a-priori load model would be worse. The app's edge is *interpretation + context + execution-grounded feedback*, not re-deriving load. Garmin is unofficial and fragile → optional and degradable by design. |
| **Provenanced everything** | So the coach can cite a source, and so we can tell a real signal from a black-box tiebreak or a degraded/absent source. Also the mechanism for invariants 2 and 3. |
| **Propose→confirm write gate** | No AIE write tool may fire without explicit, per-action human confirmation. There is no "auto" mode. See lifecycle below. |
| **Degrade, don't crash** | External systems (Garmin, weather, local LLM) are best-effort. A missing card with a note is always better than an error page or a blocked flow. |
| **Deterministic-vs-LLM split** | Cost + reproducibility. State, insights, weather and dashboard cards are pure/deterministic and make **zero** Opus calls; only the named coach narrative flows call the model. |
| **Prompt-cached persona (currently a no-op)** | The stable system prompt is marked `cache_control: ephemeral`, but at ~3k tokens it is below Opus 4.8's 4096-token cache minimum, so the marker does nothing today — every call pays full input price. It starts working automatically when the prompt grows past 4096; **no code change needed** (`llm/client.ts` header comment). Don't "fix" it. |
| **Escaped dashboard** | The dashboard renders athlete-authored text (titles, notes). All of it goes through `escapeHtml`; handlers use `data-*` attributes, not quoted JS args, so injected markup can't break out. |

---

## The write-gate lifecycle (contract form)

The write gate is `guardrails/writeGate.ts`. Two tool sets matter and they are **not** the same size:

- **`AIE_WRITE_TOOLS`** (`mcp/aieClient.ts:41`) — the full set of 8 write tools the platform exposes:
  `setZones`, `changeWorkoutDate`, `skipWorkout`, `changeWorkoutAdvice`, `createRideRunWorkout`,
  `createRideRunWorkoutAdvanced`, `createSwimWorkout`, `createStrengthOtherWorkout`. `WriteGate.propose()`
  refuses anything not in this set. The `create*` tools and `setZones` exist but are **not** used by the
  coaching layer today.
- **`PROPOSABLE_WRITE_TOOLS`** (`guardrails/writeValidators.ts:15`) — the 3 the coach may actually propose,
  each with arg-level validation: `changeWorkoutDate`, `skipWorkout`, `changeWorkoutAdvice`.

Lifecycle:

1. **`propose(p)`** — validates the tool is in `AIE_WRITE_TOOLS`, mints a `randomUUID`, and **only LOGS** a
   `DecisionRecord` (kind `plan-adjust`, status `proposed`, with the write `{tool, args}`) to the decision
   log plus an in-memory map. **It fires no write.** Arg validation (`validateWrite` in `writeValidators.ts`)
   runs before this: it checks the `workoutId` is a real scheduled session, bounds the magnitude (no moves
   into the past, none more than `MAX_FUTURE_DAYS` = 365 out, none stacked on/next to a race), and runs a
   `changeWorkoutAdvice` note through the wellbeing screen — so a hallucinated id or unsafe note never
   becomes confirmable.
2. **`confirm(id)`** — the only path to an actual write, run under an **exclusive cross-process lock** for the
   whole check-then-act:
   - Resolve the proposal from memory or, across CLI processes, reconstruct from the append-only log (must be
     status `proposed` with a recorded write).
   - **Refuse if stale**: older than `PROPOSAL_TTL_DAYS` (= 7 days) → throw; the plan may have changed, so an
     old `workoutId` could fire the wrong write. Re-propose to get a fresh one.
   - **Concurrency claim**: append an `executing` marker and re-read; if another confirm won the race, abort
     before any write fires (prevents double-fire across two processes/clicks).
   - Call `aie.callRaw(tool, args, { allowWrite: true })` — **the only call site in the codebase that passes
     `allowWrite: true`** — then mark `executed`.
3. **`decline(id)`** — marks `declined`; single-use.

Backstops: `callRaw()` throws on any write-set tool unless `allowWrite` is asserted (the direct-write guard),
and `read()` pre-rejects write tools outright. A write is fired **exactly once** (never retried — a re-issued
create/change could double-fire); reads are idempotent and retried on transient HTTP errors.

> If you are adding a feature that needs to change the plan, you do NOT write a new call site. You call
> `WriteGate.propose()` and surface the confirm to a human. Any code path that mutates the plan without going
> through `confirm()` is the single worst class of bug in this repo.

---

## Known weak points (stated plainly, so you don't trip over them)

These are documented residual risks, not surprises (HANDOVER §9, "Known issues, gotchas & roadmap"):

- **Setup is host-only.** OAuth waits on `http://localhost:8765` and the dashboard binds localhost — no
  headless/cloud onboarding. (Detail: `endurance-coach-build-and-env`.)
- **Garmin is an unofficial, fragile client** with ~6-monthly token expiry. Treat any breakage as "degrade to
  AIE", never an outage.
- **Concurrency is serialized, not parallel** — correct (locks + atomic writes) but not fast under contention.
- **Archive re-parse per request** — trend detectors re-read the JSONL/`.FIT` archive each time; a known perf
  cost, not yet cached.
- **Test inversion** — thinner coverage on the `.FIT` parser, live `server.ts` routes, the full write-gate
  propose→confirm→replay path, and some statistical edge cases. Thicken there before adding surface area
  (detail: `endurance-coach-validation-and-qa`).
- **LAN dashboard is plaintext HTTP** when `COACH_LAN` is opted in — documented residual risk (detail:
  `endurance-coach-config-and-flags`).

For *why a past attempt at any of these was reverted or removed* (e.g. intervals.icu, the cut change-point
detector, the autoupdate HEAD-hijack), see `endurance-coach-failure-archaeology` — do not re-litigate a
settled decision from here.

---

## Where NOT to look here

- The env-var catalog, security-flag semantics, and config-drift checks → `endurance-coach-config-and-flags`.
- The meaning/ranges of CTL/ATL/TSB/EF/decoupling/etc. → `endurance-domain-reference`.
- The statistics internals (Fisher-z CI, effective-N, FDR, walk-forward, permutation nulls) →
  `endurance-coach-proof-and-analysis-toolkit`.
- The change classification and definition-of-done gate → `endurance-coach-change-control`; the ship/serve
  mechanics → `endurance-coach-run-and-operate`.
- Live triage of a broken symptom → `endurance-coach-debugging-playbook`.

---

## Provenance and maintenance

Verified against the repo on **2026-07-04** (branch `main`). Re-run these to check any fact that may drift:

```bash
cd /Users/maxeskell/dev/personal-training-app

# Invariant 1 — allowWrite:true appears ONLY in the write gate (expect a single file: writeGate.ts):
grep -rn "allowWrite: true" src/

# Invariant 1 — the proposable subset (expect: changeWorkoutDate, skipWorkout, changeWorkoutAdvice):
grep -n "PROPOSABLE_WRITE_TOOLS" src/guardrails/writeValidators.ts
# ...and the full 8-tool write set:
grep -n "AIE_WRITE_TOOLS = \[" src/mcp/aieClient.ts

# Write-gate TTL (expect PROPOSAL_TTL_DAYS = 7) and future-move bound (expect MAX_FUTURE_DAYS = 365):
grep -n "PROPOSAL_TTL_DAYS\|MAX_FUTURE_DAYS" src/guardrails/writeGate.ts src/guardrails/writeValidators.ts

# Invariant 4 — deterministic layers make no LLM calls (expect: no matches):
grep -rln "llm/client\|CoachLLM" src/insights/ src/weather/ src/coach/dashboard.ts || echo "clean"

# Invariant 5 — escapeHtml escapes & < > " ' (NOT backtick) and is used heavily in the dashboard:
sed -n '1,6p' src/util/html.ts
grep -c "escapeHtml" src/coach/dashboard.ts

# Invariant 6 — save() strips profile + dataCompleteness and locks the state dir:
grep -n "profile: _profile\|dataCompleteness\|lockfile.lock" src/state/store.ts

# Invariant 7 — the no-live-numbers guard exists and is exported:
grep -n "export function assertNoLiveNumbers" src/profile/schema.ts

# Invariant 8 — wellbeing screen + health-risk assessment:
grep -n "export function screenNutritionPrompt\|export function assessHealthRisk" src/guardrails/wellbeing.ts

# LLM model id + prompt-cache no-op note:
grep -n "readonly model\|4096-token cache" src/llm/client.ts

# Garmin wall-clock budget default (expect 90000):
grep -n "refreshBudgetMs\|GARMIN_REFRESH_BUDGET_MS" src/config.ts

# Suite is green + the count these docs cite (expect 730 as of 2026-07-04; timing varies):
npm test 2>&1 | tail -6
```

Volatile facts to re-check specifically: **test count 730** (2026-07-04), **model `claude-opus-4-8`**,
**Garmin budget 90000 ms**, **`PROPOSAL_TTL_DAYS` 7 / `MAX_FUTURE_DAYS` 365**, the **8 write tools / 3
proposable tools** split, and the **prompt-cache-is-a-no-op** claim (flips to active once the system prompt
exceeds 4096 tokens). Line-number citations (`schema.ts:218`, `aieClient.ts:41`, `writeValidators.ts:15`)
drift on edits — confirm with the greps above rather than trusting the numbers.
