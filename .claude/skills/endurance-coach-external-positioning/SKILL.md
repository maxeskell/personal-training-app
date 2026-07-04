---
name: endurance-coach-external-positioning
description: >
  Load this before writing or reviewing ANY outward-facing claim about the Endurance Coach project —
  a release note, blog post, README pitch, changelog, conference talk, paper abstract, tweet, "is this
  novel?" question, or a competitive comparison against AI Endurance (AIE), TrainingPeaks, Humango,
  intervals.icu, Strava, or Garmin. Triggers: "is this novel / original / state of the art", "can we
  claim X publicly", "how do we compare to <platform>", "what's our differentiator / edge / moat",
  "write the launch / release / marketing copy", "positioning", "one-pager", "elevator pitch",
  "what must be proven before we say this", "reproducibility statement", "is this overselling", or
  editing docs/PRODUCT.md, README's positioning/non-goals sections, or the "Principles" list. Also load
  it whenever a draft is about to state a performance-prediction claim, a "better than <competitor>"
  claim, or an "n=1 causal proof" claim — those three are the ones most likely to overreach. Do NOT load
  this for the open research problems themselves (use endurance-coach-research-frontier) or the internal
  evidence-bar mechanics that decide when a finding is proven (use endurance-coach-research-methodology);
  this skill owns what may be SAID publicly and the gate a claim clears first.
---

# Endurance Coach — external positioning

**Use this when** you are writing or reviewing anything the outside world reads about this project
(release note, blog, README pitch, changelog, talk, paper, comparison table) and you need to know what
is genuinely novel, what is standard practice dressed up, what must be proven before it can be claimed,
and where this app is deliberately *worse* than the competition.

**Don't use this when** you want the open research problems themselves (→ `endurance-coach-research-frontier`)
or the internal mechanics of when a finding counts as proven (→ `endurance-coach-research-methodology`).
This skill decides **what may be said publicly and the gate every claim clears first** — it consumes the
evidence bar those siblings define; it does not redefine it.

**One rule above all: no oversell.** The house voice is honest to a fault. Anything unproven ships
labelled `MODEL` / `estimate` / `candidate` / `exploratory`. If a claim would embarrass the maintainer
when a skeptic checks it, cut it or downgrade it. A wrong public claim is worse than a modest one.

Jargon, defined once:
- **AIE** — AI Endurance (https://aiendurance.com), the paid platform that is this app's data spine. Its
  ML sets adaptive training volume, race-finish predictions, and a recovery model.
- **n=1** — statistics on a single athlete's own longitudinal data, rather than group averages.
- **CTL / ATL / TSB** — chronic / acute training load and training-stress balance (fitness / fatigue /
  form). Industry-standard impulse-response metrics; see `endurance-domain-reference`.
- **FDR** — false-discovery-rate control (Benjamini–Hochberg); **CI** — confidence interval.
- **Execution-grounded** — feedback keyed off how a session *actually executed* (from its raw `.FIT`
  stream), not off a self-reported readiness score.

---

## 1. Novel vs. known — the honest ledger

Verify each row against the file cited before you print it as a claim. "Novel" here means *novel in
combination or in rigour for a self-serve endurance tool*, not "no one has ever done this in a lab."

| Claim | Novel or known? | What's actually true | Where it lives (verify) |
|---|---|---|---|
| CTL / ATL / TSB, training zones, tapering, monotony/strain, ACWR ramp flags | **KNOWN** — standard sport-science, decades old | We compute them the textbook way (Banister τ=42/7). Do NOT frame these as our invention. | `src/insights/metrics.ts` |
| Race-finish **prediction** | **KNOWN, and NOT OURS** | We *consume* AIE's `getPrediction`; we do not build a competing predictor. See §4. | `src/coach/racePrep.ts:78`, `src/insights/splits.ts` |
| **Rigorous n=1 validation machinery** (autocorrelation-discounted effective-N, Fisher-z CI, Bonferroni-before-BH FDR, walk-forward + circular-shift permutation null) applied to one athlete's own data | **NOVEL in combination** for a self-serve tool | This is the crown jewel. A finding ships "confirmed" only if FDR-survived AND its CI excludes 0; else "exploratory". Monitoring rules ship "validated" only after walk-forward + permutation + Bonferroni. | `src/insights/stats.ts`, `correlations.ts`, `monitoring.ts` |
| **Execution-grounded post-session feedback** that drafts a gated plan change | **NOVEL vs AIE/Humango** | Their daily adaptation keys off readiness scores, not how the session *executed* from the raw `.FIT`. We read decoupling/TSB off the stream and draft the smallest edit. | README ~L331; `src/coach/deepDive.ts`, `planAdjust.ts` |
| **Explainable / cited coaching** — every readiness driver carries its signal + reading + source | **NOVEL as a shipped default** | `readiness` returns structured `drivers: {signal, reading, source}`; the "why" cites the data. | `src/coach/readiness.ts:8–20` |
| **Two-channel coach↔dashboard decision loop** (Channel B: coach walks dashboard cues, records the call, card shows "✓ discussed with coach") | **NOVEL** for this class of tool | Shipped. One audit store, gated writes. | `src/coach/agenda.ts`; `coaching-notes.md` "Phase 2 … SHIPPED" |
| Local-first, single-athlete, no-DB, gated-write architecture | **Distinctive, not a performance claim** | A design/privacy posture, not a coaching-quality claim. Frame it as a *posture*, not a *result*. | `docs/PRODUCT.md` |

**The one-line public differentiator (safe to say):** *"It doesn't re-plot your data or re-derive the
load model — it interprets what AI Endurance already knows for one athlete, grounds feedback in how each
session actually executed, and holds every statistical finding to an n=1 evidence bar (FDR + CI) before
it speaks."* Everything in that sentence is backed by a file above.

---

## 2. The claim gate — clear this before any public claim

Run this checklist against every outward sentence. If a box is unchecked, downgrade the wording or cut it.

- [ ] **Backed by a file or a proven finding, not a vibe.** Point at the `src/` line or the docs-of-record
      section. Positioning that isn't in `docs/PRODUCT.md` / `README.md` / `HANDOVER.md` is not yet a
      claim — make it true first (code+docs move together; → `endurance-coach-change-control`).
- [ ] **Statistical claims clear the internal evidence bar.** A "we found X predicts Y for this athlete"
      claim ships publicly only if the finding is **FDR-confirmed AND its CI excludes 0** (correlations),
      or **walk-forward + permutation + Bonferroni validated** (monitoring rules). Otherwise it's
      `exploratory` and must be *labelled* so, even in public. The bar's mechanics live in
      `endurance-coach-research-methodology`; the derivations in `endurance-coach-proof-and-analysis-toolkit`.
- [ ] **Estimates carry the `MODEL` / `estimate` label** with assumptions stated — in the copy, not just
      the code. This is a house rule (`docs/PRODUCT.md` "Honest models"), and it applies to public text too.
- [ ] **No "cure / diagnose / treat" language, ever.** The app *refers*, never diagnoses (wellbeing gate,
      `src/guardrails/wellbeing.ts`). Public copy inherits that: no health-outcome claims, no weight-loss
      framing, no "fixes overtraining". This is non-negotiable and may not be routed around.
- [ ] **Comparative claims are falsifiable and current.** "AIE/Humango don't do X" must name the specific
      X and be checkable (e.g. "their daily adaptation keys off readiness, not session execution"). Do not
      claim to be *better at* something we defer to them on (see §4).
- [ ] **Reproducibility is honoured** (§3) — anyone can rebuild-and-verify the deterministic layer with no
      account and no network.
- [ ] **Non-goals are not contradicted** (§5) — never imply multi-user, hosted, or medical scope.

> If a draft says the app *beats* AI Endurance / TrainingPeaks / Humango at **validated performance
> prediction**, stop. That claim is false by design — we defer to AIE there (§4). Rewrite it as "we
> interpret and pace *from* AIE's prediction," never "we predict better."

---

## 3. Reproducibility standard (what makes our claims checkable)

This is a genuine strength and safe to state publicly — but state it precisely.

| Property | Precise public wording | Verify |
|---|---|---|
| **Deterministic core** | "The statistical insight layer makes zero LLM calls — same inputs, same outputs." | `docs/insight-engine.md` L127 ("deterministic (no LLM, no cost)"); CLAUDE.md invariant |
| **Fixture-tested, no network** | "Tests are pure and use fixtures, never the network; you need no account to build, typecheck, or run the suite." | `CONTRIBUTING.md` ("tests are pure and use fixtures, never the network") |
| **Hermetic suite, green gate** | "N tests, run in seconds, hermetic." Fill N live — don't hardcode; as of 2026-07-04 it's **730 tests / ~6.3 s**. | `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 \| tail -5` |
| **CI contract** | "typecheck + tests + build run on every PR and on `main`." | `.github/workflows/ci.yml` |
| **No-account demo** | "A `npm run demo` renders the dashboard on bundled sample data, no account needed." | `package.json` `demo` script; `docs/PRODUCT.md` |
| **Cost transparency** | "Every LLM call is cost-logged locally (counts + dollars, never prompt text); `npm run cost` shows spend." | `src/llm/costLog.ts`; `npm run cost` |

Do NOT claim the *coaching narratives* are reproducible — those are LLM (Opus) prose and vary run-to-run.
Only the **deterministic insight layer + tests** are reproducible. Keep that boundary crisp in any copy.

---

## 4. Honest competitive framing — where we're worse, and why on purpose

The credibility of the whole pitch rests on being straight about this. Lead with a limitation and the
"we're novel here" claims land; hide them and every claim reads as marketing.

| Area | Who's ahead | The honest line to print |
|---|---|---|
| **Validated race-finish prediction** | **AI Endurance** | "We *defer* to AIE's ML for finish predictions and *pace from* them — we don't build a competing predictor." The taper detector even refuses to treat prediction−target as a performance measure because it has no actual finish times. (`src/insights/taper.ts:66–67`) |
| **The calibrated dose-response / load model** | **AI Endurance** | "We consume AIE's FTP/CSS/threshold/recovery; we do not re-derive the load science." Individual training response is ~50% heritable with 20–45% non-responders, so there is no solo-buildable a-priori model — our edge is *interpretation*, not re-derivation. (Doctrine: `coach-instructions.md` L16 "Defer to AI Endurance's model"; README "Principles": *defer to the platform's ML*) |
| **Live third-party integrations** | **TrainingPeaks / Strava / intervals.icu** | "TrainingPeaks and Strava have no self-serve personal API, so they aren't live sources here — the `/career` page reads their *offline exports*. intervals.icu was removed on 2 Jul 2026 to avoid its new paid tier." (README L36; → `endurance-coach-failure-archaeology`) |
| **Breadth / polish / multi-user** | **All of them** | "This is one athlete, local-first — not a hosted product." A posture, stated as a choice, not a shortcoming. |

**The non-competing stance is itself the position.** We do not run a competing hard-coded ruleset against
AIE's ML (that's a hard discipline rule; → `endurance-coach-change-control`). Publicly, that reads as:
*"complements your platform, doesn't fight it."* That is both true and the most defensible framing.

**Independence caveat to preserve in any accuracy claim.** When a monitoring finding is validated against
AIE's *recovery* score, it's labelled **"concordance, not independent prediction,"** because AIE recovery
is itself modelled from HRV/RHR — so an HRV rule predicting it would be tautological. Never publicly
upgrade a "concordance" result to "prediction". (`src/insights/monitoring.ts` L14–18)

---

## 5. Non-goals — the lines public copy must never cross

Straight from `docs/PRODUCT.md` "Limitations / non-goals" and README "Roadmap & non-goals". Any draft
that implies otherwise is wrong.

- **Not a multi-tenant SaaS, not a hosted service.** Single athlete, by construction — no database, no
  app accounts, no server the user doesn't run themselves.
- **Not a replacement for a human coach or a medical professional.** It refers; it does not diagnose or
  treat. No health-outcome or weight-loss claims.
- **Requires the user's own accounts for live flows** (AIE spine + Anthropic key; Garmin optional). Don't
  imply it works out of the box with no accounts — only the demo does.
- **Garmin is an unofficial, degradable client.** Don't market Garmin depth as a guaranteed feature.
- **macOS-oriented extras** (notifications, auto-start); core CLI + dashboard run on Linux with printed
  cron/systemd equivalents. Don't claim first-class cross-platform.

---

## 6. Two failure modes of positioning drafts (catch these in review)

1. **Overreach on the crown jewel.** "We *prove* what training moves this athlete" is a `candidate`
   frontier, **not** an achieved result — rigorous n=1 *causal inference* is the SOTA gap we're aiming at,
   not a shipped guarantee (→ `endurance-coach-research-frontier`). What ships today is validated
   *association* (FDR + CI) and *walk-forward-validated monitoring rules*, which is already novel. Claim
   the association machinery; label causal inference `open`/`candidate`.
2. **Borrowing AIE's credibility as our own.** Predictions, load model, adaptive volume are AIE's. Our
   claim is the *interpretation, cited explanation, execution-grounding, and n=1 validation* on top. Keep
   the line between "what the platform knows" and "what we add" visible in every comparison.

---

## Provenance and maintenance

Date-stamped **2026-07-04**. This skill cites files and numbers that drift; re-verify before quoting.
Ground truth is the repo, not this file.

| Fact | Re-verify command (run from repo root) |
|---|---|
| Test count / green suite (730 / ~6.3 s as of 2026-07-04) | `cd /Users/maxeskell/dev/personal-training-app && npm test 2>&1 \| tail -5` |
| "Defer to the platform's ML" is doctrine | `grep -n -i "defer to AI Endurance" /Users/maxeskell/dev/personal-training-app/coach-instructions.md` |
| Non-goals wording (single-athlete, not SaaS, not medical) | `grep -n -i "non-goal\|multi-tenant\|single athlete\|replacement for a human" /Users/maxeskell/dev/personal-training-app/docs/PRODUCT.md /Users/maxeskell/dev/personal-training-app/README.md` |
| We consume AIE prediction, don't re-derive it | `grep -n "getPrediction" /Users/maxeskell/dev/personal-training-app/src/coach/racePrep.ts; sed -n '60,70p' /Users/maxeskell/dev/personal-training-app/src/insights/taper.ts` |
| "concordance, not independent prediction" caveat | `grep -n -i "concordance" /Users/maxeskell/dev/personal-training-app/src/insights/monitoring.ts` |
| Cited-drivers structure in readiness | `grep -n "drivers" /Users/maxeskell/dev/personal-training-app/src/coach/readiness.ts` |
| Deterministic / fixture / no-network reproducibility | `grep -n -i "deterministic" /Users/maxeskell/dev/personal-training-app/docs/insight-engine.md; grep -n -i "fixtures, never the network" /Users/maxeskell/dev/personal-training-app/CONTRIBUTING.md` |
| Two-channel loop shipped | `grep -n -i "Channel B\|discussed with coach" /Users/maxeskell/dev/personal-training-app/coaching-notes.md` |
| intervals.icu removal date/reason | `git -C /Users/maxeskell/dev/personal-training-app log --oneline --all \| grep -i intervals` |
| `demo` / `cost` scripts still exist | `node -e "const p=require('/Users/maxeskell/dev/personal-training-app/package.json'); console.log(!!p.scripts.demo, !!p.scripts.cost)"` |

Sibling skills to route to (do not duplicate their content here):
- Internal evidence bar / when a finding is "proven" → `endurance-coach-research-methodology`
- Statistical derivations behind the claims → `endurance-coach-proof-and-analysis-toolkit`
- Open research problems / SOTA gaps → `endurance-coach-research-frontier`
- The change/ship gate a new positioning doc clears → `endurance-coach-change-control`
- Settled history (intervals.icu, autoupdate, removed detectors) → `endurance-coach-failure-archaeology`
- House-style / which doc owns a fact → `endurance-coach-docs-and-writing`
