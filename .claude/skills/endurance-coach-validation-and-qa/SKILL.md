---
name: endurance-coach-validation-and-qa
description: >-
  Load this when the question is "is this good enough to ship?" for the Endurance Coach repo —
  what counts as evidence, how to test a change, whether the suite is green, and where coverage is
  thin. Triggers: "how do I test this", "add a test", "write a unit test", "is the suite green",
  "npm test failing", "what counts as done / evidence", "acceptance threshold", "is this finding
  confirmed or exploratory", "should this insight ship", "coverage is thin here", "what's the CI
  contract", "does this need a test before I commit", "golden / invariant / certified set",
  "node:test", "tsx --test", "fixture", "faked client", "test inversion", "profileQuestions test",
  "dashboard script-parse test", "writegate propose/confirm test", "statvalidity", "monitoring
  validated vs exploratory". Also load before merging any behavioural change to decide if it carries
  the test its Definition-of-Done requires. DON'T load this for: the derivations of the statistics
  themselves (use endurance-coach-proof-and-analysis-toolkit), the go/no-go campaign to validate one
  n=1 detector end-to-end (use endurance-coach-n1-validation-campaign), the epistemics of
  turning a hunch into an accepted result (use endurance-coach-research-methodology), the
  change-classification / ship gate (use endurance-coach-change-control), or measurement tools like
  `npm run doctor` / `npm run cost` (use endurance-coach-diagnostics-and-tooling).
---

# Endurance Coach — validation & QA

**Use this when** you need to know what counts as *evidence* in this repo, how to write or run a test,
whether the suite is green, or whether a statistical finding is allowed to ship as "confirmed".

**Don't use this when** you need the *math* behind a statistic (→ `endurance-coach-proof-and-analysis-toolkit`),
the *step-by-step campaign* to validate one detector on this athlete's data (→ `endurance-coach-n1-validation-campaign`),
the *epistemics* of accepting a hunch (→ `endurance-coach-research-methodology`), the *change gate / ship
flow* (→ `endurance-coach-change-control` and `endurance-coach-run-and-operate`), or the *diagnostic tools*
like `doctor`/`cost`/`verify:reads` (→ `endurance-coach-diagnostics-and-tooling`).

Jargon, defined once: **hermetic** = a test that touches no network, clock-dependent state, or real
credentials — it runs identically anywhere. **Fixture** = hard-coded sample input built inside the test
(or a small committed file), used instead of a live fetch. **Faked client** = a stand-in for an external
client (AI Endurance, Garmin) that records what it was asked to do in a `calls` array so the test can
assert on it. **Provenanced field** = every `AthleteState` value is `{ value, source, note? }` so a
missing datum degrades to `null`, not a crash. **FDR** = false-discovery-rate control (Benjamini–Hochberg).

---

## 1. The definition of evidence (what "done" means here)

Two gates, both mandatory, both non-negotiable. A change is not done until BOTH are true.

| Gate | Rule | How you check it |
|---|---|---|
| **Green-before-commit** | `npm run typecheck` AND `npm test` pass locally, with no network. | Run both (below). Both must exit 0. |
| **New logic gets a test** | Any new pure function / detector / invariant ships with a `node:test` case in the *same commit*. Behavioural change without a test = not done. | Grep the diff for new logic; confirm a matching `test/*.test.ts` change. |

This is the QA half of the project's Definition of Done. The *classification* of a change (display-only
vs behavioural vs write-path vs schema) and the ship flow live in `endurance-coach-change-control`;
this skill owns the **evidence bar those gates enforce**.

> No change may route around these gates. "It typechecks" is not "it's tested". "The dashboard looks
> right" is not evidence — assert it in `test/dashboard.test.ts`.

Run the gate (copy-paste, absolute path):

```bash
cd /Users/maxeskell/dev/personal-training-app && npm run typecheck && npm test
```

Expected tail of `npm test` (as of 2026-07-04):

```
ℹ tests 730
ℹ pass 730
ℹ fail 0
ℹ skipped 0
ℹ duration_ms ~6000
```

If `fail` is non-zero, you are not green. If `skipped` is non-zero, something was silently disabled —
investigate, don't ignore. A flaky or skipped test must be called out honestly (CONTRIBUTING.md §5),
never presented as done.

---

## 2. Test conventions (imitate these exactly)

- **Framework:** Node's built-in `node:test`, run via `tsx` (no Jest, no Vitest). The npm script is
  literally `tsx --test test/*.test.ts` (see `package.json`).
- **Count / speed:** **730 tests, ~6s, all hermetic** (verified 2026-07-04 via `npm test`). No network,
  no real credentials, no wall-clock dependence. (Note: `HANDOVER.md` §6 still says "600+ tests" — that's
  stale; the live count is authoritative, re-check with the command in §7.)
- **Pure functions + fixtures.** Prefer testing a pure function over a stateful flow. Build inputs
  inline; never fetch.
- **External clients are faked with a `calls` array.** The canonical pattern (from
  `test/writegate.test.ts:21`):

  ```ts
  function fakeAie() {
    const calls: Array<{ tool: string; args: unknown }> = [];
    return { calls, callRaw: async (tool: string, args: unknown) => { calls.push({ tool, args }); return { ok: true }; } };
  }
  // …then assert on it:
  assert.equal(aie.calls.length, 0, "propose must never call the API");
  ```

  The `calls` array *is* the evidence: it proves a write did or didn't fire, exactly once, with the
  right args.
- **Temp dirs for anything that writes.** State/log tests point `config.dataDir` at a fresh
  `mkdtemp(join(tmpdir(), …))` (see `test/writegate.test.ts:13`) so they never touch real `data/`.
- **Imperative, invariant-describing names.** `"WriteGate.propose() logs a proposal but fires NO write"`,
  not `"test propose"`. The name states the invariant being pinned.
- **ESM imports** with `.js` extensions in specifiers even though sources are `.ts` (e.g.
  `import { WriteGate } from "../src/guardrails/writeGate.js"`). That's the ESM/tsx convention here.

Add-a-test skeleton:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { thingUnderTest } from "../src/path/to/module.js";

test("thingUnderTest: <the invariant this pins, in plain words>", () => {
  const input = /* fixture built inline — no network */;
  const out = thingUnderTest(input);
  assert.equal(out.value, expected, "why this must hold");
});
```

Run just your new file while iterating:

```bash
cd /Users/maxeskell/dev/personal-training-app && npx tsx --test test/yourfile.test.ts
```

Note: there is **no coverage tool wired up** (no `c8`/`nyc` in `package.json` as of 2026-07-04). Coverage
is judged by the test-inversion priority below, not a percentage.

---

## 3. The CI contract

CI is `.github/workflows/ci.yml`. It is the backstop, not the gate — **the local green is the gate**
(CLAUDE.md); GitHub is a backup mirror. CI runs on every `pull_request` and on `push` to `main`:

| Step | Command |
|---|---|
| Install | `npm ci` |
| Typecheck | `npm run typecheck` |
| Test | `npm test` |
| Build | `npm run build` (`tsc -p tsconfig.json`) |

- **Node 22** (`actions/setup-node@v4`, `node-version: "22"`). Local dev only needs Node ≥20, but CI
  pins 22 — a feature that needs a newer runtime must still pass on 22.
- **Least privilege:** `permissions: contents: read` only.
- **Checks out the PR head SHA**, not the default merge ref (`ref: ${{ github.event.pull_request.head.sha || github.sha }}`).
  This exists because web/Claude-Code branch pushes can leave the merge ref stale; pinning to the head
  SHA makes CI test exactly what's on the branch. If CI ever looks like it tested the wrong tree, this
  is why it usually *doesn't*.

Note `npm run build` runs in CI but is not in the local pre-commit gate — if you touch anything the
compiler could reject on a full build (not just `--noEmit`), run it locally too.

---

## 4. Test-inversion priority (where to add coverage first)

This repo is **deliberately better-tested on deterministic detectors than on some load-bearing paths** —
HANDOVER.md §6 calls this "test inversion" and names it the *standing* coverage priority. Thicken here
BEFORE adding new surface area:

| Under-covered area | Why it's thin | Why it matters |
|---|---|---|
| Hand-rolled binary `.FIT` parser (`insights/fitParser.ts`) | Binary decoder, awkward to fixture | It's the only source of within-session power/decoupling (AIE's list exposes no `activity_id`) |
| Live `server.ts` routes | HTTP surface, harder to unit-test | Dashboard + `/refresh` flow the athlete actually uses |
| Full WriteGate propose→confirm→**replay** path | Cross-process, lock-guarded | The ONLY barrier between an LLM proposal and a live AIE mutation |
| Some statistical edge cases (`insights/stats.ts`) | Boundary conditions (tiny n, degenerate series) | A wrong stat ships a false "confirmed" finding |

If you are adding a *new* detector or route, first ask whether the existing thin area it sits in wants a
test more than your new thing wants a feature.

---

## 5. The named invariant tests (the "golden set")

These tests pin invariants that a refactor could silently break. Know them; extend them; don't delete
them. (These are the QA anchors — the invariants themselves as *contracts* live in
`endurance-coach-architecture-contract`.)

| Test file | What it certifies | Anchor |
|---|---|---|
| `test/profileQuestions.test.ts` | Every profile-question `field` dot-path exists in `profile.example.yaml` (no phantom fields); the generated `docs/profile-questions.md` matches the renderer (no hand-edit drift) | `:51`, `:109` |
| `test/dashboard.test.ts` | Every inline `<script>` still parses as valid JS after adversarial finding/goal titles (the XSS guard); handlers bind via `data-*`, no undefined/NaN | `:38`, `:60` |
| `test/writegate.test.ts` | propose() logs but fires NO write; confirm() writes exactly once; single-use; a declined/stale proposal can't be confirmed; concurrent confirms serialize to one write | `:26`–`:124` |
| `test/statvalidity.test.ts` | A significant lag beats a stronger non-significant one; pure noise yields ~no FDR confirmations; heat gives no attribution when EF change is within noise (<2%) | `:6`, `:19`, `:30` |
| `test/monitoring.test.ts` | A real HRV→sleep signal validates out-of-sample; pure noise validates nothing; a short series is labelled exploratory, never "validated" | `:14`, `:34`, `:49` |
| `test/dataintegrity.test.ts` | The decision log skips a corrupt line instead of losing the whole log (JSONL resilience) | `:47` |

If your change touches the write path, the dashboard render, the profile questions, or the stats, the
matching test above must still pass **and** should gain a case for your new behaviour.

---

## 6. The statistical acceptance bar (practical)

The insight engine's honesty depends on two hard gates. A finding either **clears the bar and ships as
"confirmed"**, or it is **labelled "exploratory"** — there is no third state and no eyeballing. The
*derivations* of these tests are in `endurance-coach-proof-and-analysis-toolkit`; the *end-to-end
campaign* to run them on a specific detector is `endurance-coach-n1-validation-campaign`; the
*epistemics* (pre-registration, adversarial refutation) are `endurance-coach-research-methodology`. This
section is only the **acceptance rule** you check a shipped finding against.

**A correlation is "confirmed" only if** it survives FDR **AND** its 95 % CI excludes 0. In code
(`insights/correlations.ts:162`):

```ts
c.fdrPass = pass[i] && c.significant;   // Benjamini–Hochberg survived AND CI excludes 0
```

Otherwise it is auto-labelled `[exploratory — not FDR-confirmed]`. Load-bearing details, all verified:

| Rule | Value | Where |
|---|---|---|
| Minimum sample for any correlation CI | `n < 10` → `null` (no finding) | `stats.ts:127` |
| CI method | Fisher-z on **effective N** (autocorrelation-discounted), back-transformed at ±1.96·SE | `stats.ts:144`–`151` |
| Multiplicity on a lag scan | p is **Bonferroni-inflated by #lags** *before* Benjamini–Hochberg | `correlations.ts:158` (`corrPValue × lagsScanned`) |
| FDR level | Benjamini–Hochberg, **q = 0.1** | `stats.ts:210`, `correlations.ts:159` |

**A monitoring rule ships as `validated: true` only if** it clears walk-forward + permutation +
Bonferroni. In code (`insights/monitoring.ts:201`):

```ts
if (te.outcomes >= 8 && te.fires >= 4 && te.youdenJ > 0 && pAdj < 0.05) best = perf;
```

| Rule | Value | Where |
|---|---|---|
| Walk-forward requires | ≥ 50 usable days; else **in-sample / exploratory only** | `monitoring.ts:152` (`canHoldout = usableDays >= 50`) |
| Permutation null | circular-shift the holdout outcome, **K = 400**, deterministic seed | `monitoring.ts:235` |
| Selection multiplicity | permutation p **Bonferroni-adjusted by `combosTried`** (best-of-N candidates) | `monitoring.ts:200`–`201` |
| Independence preference | prefer an INDEPENDENT outcome (Garmin sleep score) over AIE recovery (derived from HRV/RHR → relabelled "concordance, not independent prediction") | `monitoring.ts` outcome selection + `evidence` string |

> If a finding would ship as "confirmed"/"validated" without meeting the exact thresholds above, that's
> a QA failure — it must degrade to "exploratory", not squeak through.

Acceptance discipline for **deterministic outputs generally**: the output is a pure function of the
input, so the test asserts the *exact* rendered/computed result on a fixture — not a fuzzy "looks
plausible". Examples in the golden set: h:mm formatting, "—" for missing data (never a misleading zero),
the ×2%/×10× guards, escaped HTML. If you can't assert an exact expected value, you don't yet understand
the output well enough to ship it.

---

## 7. Provenance and maintenance

Written 2026-07-04. Re-verify any drifting fact with the exact command below (all read-only, run from
`cd /Users/maxeskell/dev/personal-training-app`).

| Fact | Re-verify command |
|---|---|
| Test count / green / skipped (§1, §2) | `npm test 2>&1 \| tail -8` |
| Test runner is `tsx --test test/*.test.ts` (§2) | `grep '"test"' package.json` |
| No coverage tool wired (§2) | `grep -E 'c8\|nyc\|coverage' package.json \|\| echo "none"` |
| CI: Node 22, checkout head SHA, typecheck+test+build (§3) | `sed -n '1,40p' .github/workflows/ci.yml` |
| Test-inversion priority text (§4) | `grep -n -A4 'test inversion' HANDOVER.md` |
| profileQuestions field-exists + doc-drift invariants (§5) | `grep -n 'test(' test/profileQuestions.test.ts` |
| dashboard script-parse XSS guard (§5) | `grep -n 'syntactically valid JS\|break handlers' test/dashboard.test.ts` |
| writegate propose/confirm/single-use invariants (§5) | `grep -n 'test(' test/writegate.test.ts` |
| Correlation confirmed = FDR ∧ CI-excludes-0 (§6) | `grep -n 'fdrPass' src/insights/correlations.ts` |
| Min n=10 for a correlation CI (§6) | `grep -n 'n < 10' src/insights/stats.ts` |
| Benjamini–Hochberg default q=0.1 (§6) | `grep -n 'q = 0.1\|q=0.1' src/insights/stats.ts` |
| Monitoring "validated" gate thresholds (§6) | `grep -n 'outcomes >= 8' src/insights/monitoring.ts` |
| Walk-forward ≥50-day holdout gate (§6) | `grep -n 'canHoldout' src/insights/monitoring.ts` |
| Permutation K=400 (§6) | `grep -n 'K = 400\|K=400' src/insights/monitoring.ts` |

Known stale reference to correct, not propagate: **HANDOVER.md §6 says "600+ tests"** — the live count
(730, 2026-07-04) is authoritative; cite the `npm test` output, not the doc.
