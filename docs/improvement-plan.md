# Endurance Coach — Improvement Plan

Sequenced roadmap from the staff review (`docs/engineering-review.md`). Each initiative has a full
PRD + engineering spec in `docs/specs/improvements/`. Ordering is by **risk-reduction per unit effort**,
with the release gate first.

## Release gate (do before trusting a live AI Endurance account or any non-`localhost` exposure)

These are the P0s. Until they're done, the safe operating mode is: server bound to `localhost`, and
**no `Apply to AI Endurance`** (review proposals, apply via CLI after eyeballing the args).

| # | Initiative | P0s it closes | Size |
|---|-----------|---------------|------|
| 1 | **Server security** | unauth `0.0.0.0` write/LLM endpoints; body limits; DNS-rebinding | S–M |
| 2 | **Write-path integrity** | unvalidated args; undocumented write tool; id collisions; structured-output validation; prompt-injection | M |
| 3 | **Dashboard rendering safety** | `'`/`\` escaping (feedback buttons live); HTML injection of LLM/race text | S |
| 4 | **Statistical validity** | FDR double-dip; dead fuelling path; ratio-on-signed-base; UTC bucketing; change-point claims | M |
| 5 | **Data integrity & reliability** | non-atomic state writes; JSONL corruption; nutrition mis-index; Garmin arg split; archive perf | M |

## Sequencing & rationale

1. **Spec 3 (Dashboard safety) first — smallest, ships today.** It's a live bug (apostrophe breaks the feedback buttons) and the cheapest P0. ~½ day. Removes an injection class and a fragility class in one pass.
2. **Spec 1 (Server security) next.** Flip the default bind to `localhost` immediately (one line), then layer pairing-token auth + `Host` allowlist + body caps. Unblocks safe phone use. ~1–2 days.
3. **Spec 2 (Write-path integrity).** The highest-trust item: arg validation + tool allowlist + UUID ids + structured-output guards + confirmation that shows the resolved workout, not JSON. Gate before anyone clicks `Apply`. ~2–3 days.
4. **Spec 4 (Statistical validity).** Fix the self-undermining stats so the confidence/FDR/"genuine shift" labels mean what they say; kill the dead fuelling path; local-date bucketing. ~2–3 days. (Also: add the missing unit tests for the CI/corr/change-point/FIT primitives — see §Test inversion.)
5. **Spec 5 (Data integrity & reliability).** Atomic state writes, JSONL append safety, nutrition index fix, archive caching, Garmin arg parsing, `/refresh` budget. ~2 days.
6. **Spec 6 (Grounded plan proposals)** — _feature_, not a gate. Answers "does it use all my data + goals + research?": feed the full insight picture + dynamic race goals/taper into the proposer; optional research citations. Do after Spec 2 (it depends on the validated write path). ~3–4 days.

## Cross-cutting workstream: invert the test pyramid

Tracked across all initiatives, not a separate phase. Definition of done for each spec includes unit tests
for the code it touches. Standing targets (highest risk, currently untested):
`fitParser.parseFit` (golden-file), `corrWithCi`/`bestLaggedCorr` (reference values), `changePointsOf`,
`loadModel`/`runLoadRamp`, `assemble` field-mapping + unit conversions (table-driven), `writeGate`
(propose→confirm→replay/decline), `server` routes (auth, body limit, write path). Add a **small-n (n≈60)**
monitoring test alongside the existing n=400 one.

## Sizing & suggested staffing

- One engineer, ~2.5–3 weeks for Specs 1–5 (the gate) including tests.
- Spec 6 is a product feature (~1 week) once the gate is closed.
- Specs 1/3/5 are independent and parallelizable; Spec 2 should land before Spec 6.

## Out of scope (acknowledged, deferred)

- Transitions / per-second biomechanics (data-blocked — needs a logged brick / raw `.FIT`).
- Migration off flat JSON to SQLite (only if query/scale needs grow; the schema-normalize-on-load
  approach is fine for now).
