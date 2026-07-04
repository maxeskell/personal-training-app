---
name: endurance-coach-change-control
description: >
  Load this BEFORE making ANY code change to the Endurance Coach repo — it is the constitution for how
  work lands. Triggers: "can I commit this", "how do I ship", "is this gated", "what's the definition of
  done", "what are the rules here", "am I allowed to", classifying a change (display-only vs behavioural
  vs write-path vs schema vs config vs profile), before touching the write path / dashboard HTML / config
  (`config.ts`, `.env.example`) / `profile.local.yaml` / any AI Endurance write / the LLM coach flows /
  the wellbeing gate, "should this be behind a flag", "does this need a test", "which docs move with this
  code", "can I edit main directly", "my commits landed on main", worktree/branch hygiene, "should I
  hard-code a training rule", "can I override what AI Endurance says", "can I rebuild the load model".
  This skill OWNS the change-classification table, the definition of done, the four gates every change
  passes (green-before-commit, propose→confirm write gate, wellbeing gate, branch-then-ship), and the
  three unwritten discipline rules. It does NOT own the full ship.sh anatomy (see
  endurance-coach-run-and-operate), the incident chronicle (see endurance-coach-failure-archaeology), or
  the statistical acceptance bar (see endurance-coach-validation-and-qa).
---

# Endurance Coach — change control (the constitution)

**Use this when** you are about to change ANY code, config, doc, profile field, or write path in this
repo — to classify the change and route it through the right gate before you commit.
**Don't use this when** you need to *operate* the app (ship mechanics, services → `endurance-coach-run-and-operate`),
*diagnose a live break* (`endurance-coach-debugging-playbook`), check *whether a past fix already settled a
question* (`endurance-coach-failure-archaeology`), or prove a *statistical* finding
(`endurance-coach-validation-and-qa`, `endurance-coach-n1-validation-campaign`).

The repo is a **local-first, single-athlete AI endurance coach** at
`/Users/maxeskell/dev/personal-training-app` (TypeScript, ESM, Node ≥20, run via `tsx`; no database, flat
JSON under `data/`). Jargon defined once as it appears. Everything below is verified against the repo on
2026-07-04 — see **Provenance and maintenance** for the re-check commands.

---

## 0. The one-paragraph mental model

Every change lands the same way: **branch → make the change WITH its docs → run the green gate → commit →
ship.** Four gates stand in the way, and no change may route around any of them:

| Gate | What it protects | Where it lives |
|------|------------------|----------------|
| **Green-before-commit** | Nothing broken ships | `npm run typecheck && npm test` (must pass locally) |
| **Propose→confirm write gate** | No AI Endurance (AIE) write fires without explicit per-action confirm | `src/guardrails/writeGate.ts` |
| **Wellbeing gate** | No disordered-eating / restriction / acute-medical prompt reaches the LLM | `src/guardrails/wellbeing.ts` |
| **Branch-then-ship** | `main` is never edited directly; the deploy is gated | `scripts/ship.sh`; work on a feature branch |

If a change would weaken any of these four, **stop** — that is not a normal change, it is a change to the
constitution, and it needs the maintainer's explicit sign-off plus tests proving the guarantee still holds.

---

## 1. Classify the change FIRST

Before writing code, put the change in one of these buckets. The bucket decides the gate and the docs.
"Display-only" is the safe default — **new features are display-only unless explicitly asked** (CLAUDE.md,
CONTRIBUTING.md).

| Change type | What it is | Required gates / rules | Docs that move in the SAME commit | Example |
|---|---|---|---|---|
| **Display-only** | New card/field/CLI output that only *reads* assembled state; no new write, no new estimate | Green gate. Must degrade to "—" not crash. Dashboard text must be escaped (§3). | `README.md` if user-visible behaviour changes | Add a "last 7 days TSB trend" read-only card |
| **Behavioural (read/compute)** | New deterministic logic, detector, or LLM-flow behaviour | Green gate + **new unit test** (pure, fixture-driven, no network). Deterministic flows make **zero** LLM calls. Any estimate labelled `MODEL`/`estimate` with assumptions. | `README.md`; `docs/*` for the subsystem; `docs/specs/*` if a spec is source-of-truth | A new correlation detector; a change to a readiness narrative |
| **Config / flag** | New or changed env var | Parse+default in `config.ts` (the ONLY parser); commented entry in `.env.example`; a test if it gates behaviour | `.env.example` (required), `README.md`/`HANDOVER.md`. See `endurance-coach-config-and-flags`. | Add `COACH_FOO_MS` timeout |
| **Write-path (AIE mutation)** | Anything that could change the athlete's plan on AI Endurance | Green gate + goes through **`WriteGate.propose()`→`confirm()`** (§2). Only 3 tools are proposable. `changeWorkoutAdvice` content also runs the wellbeing screen. | `docs/specs/06-grounded-plan-proposals.md` / write-path specs | Draft a "move Thursday's ride to Friday" proposal |
| **Schema / persistence** | Change to `AthleteState`, the store, the decision log, or profile schema | Green gate + tests for the new shape. Persistence stays **atomic (temp+rename) + locked**. `Provenanced<T>` fields degrade to `null`, never crash. No live numbers in profile (§4). | `docs/data-sources.md`, `docs/profile.md`, relevant spec | Add a field to `AthleteState` |
| **Profile / gitignored user data** | New user-authored field in `profile.local.yaml` or a new local data file the user fills in | Ship a committed **template** + **guidance** + an **in-app nudge** in the same commit (§4). `test/profileQuestions.test.ts` keeps it honest. | `profile.example.yaml`, `README.md`, `SETUP.md`, optionally `profile/questions.ts` | Add a "shoe rotation" profile block |
| **LLM prompt / persona** | Coach persona, system prompt, effort level | Green gate. Keep the `CLINICAL_BOUNDARY` clause in every system prompt. Free-text prompts pass `screenNutritionPrompt` before the LLM. Effort tier stays cost-appropriate (deep flows `high`, cheap flows `medium`). | `coach-instructions.md`; `docs/*` | Tune the weekly-brief prompt |
| **Docs-only** | Doc fix with no code change | Green gate not required to *pass* new tests, but still branch + ship. Follow house style (§5). | The doc itself | Fix a stale command in `README.md` |

> If a change spans buckets (e.g. a behavioural change that also adds a flag), it must satisfy **every**
> bucket it touches. Miss a bucket's doc and the "code + docs move together" rule is broken.

---

## 2. The write gate — propose→confirm (summary; contract lives in architecture-contract)

**No AI Endurance write tool fires without an explicit, un-consumed confirmation.** This is invariant #1
of the whole system. `src/guardrails/writeGate.ts`:

- `propose()` only **LOGS** a proposal (`kind: "plan-adjust"`, `status: "proposed"`) to
  `data/decisions/log.jsonl` + an in-memory map. It fires **no** write. It rejects any tool not in
  `AIE_WRITE_TOOLS`.
- `confirm(id)` runs under a cross-process lock (`this.log.withLock`): reconstructs the proposal
  (in-memory or from the append-only log), **refuses if older than `PROPOSAL_TTL_DAYS` (7)**, appends an
  `executing` marker and re-reads to win the race, then calls
  `aie.callRaw(tool, args, { allowWrite: true })` — **the only call site in the codebase that passes
  `allowWrite: true`** — and marks it `executed`. Confirmation is single-use.
- `decline(id)` marks it `declined`.

**Scope trap — 8 write tools exist, only 3 are proposable.** `AIE_WRITE_TOOLS` (`src/mcp/aieClient.ts`)
lists 8 members (`setZones`, `changeWorkoutDate`, `skipWorkout`, `changeWorkoutAdvice`, and four `create*`
workout tools). But the coaching layer only ever proposes/validates **three**:
`PROPOSABLE_WRITE_TOOLS = ["changeWorkoutDate", "skipWorkout", "changeWorkoutAdvice"]`
(`src/guardrails/writeValidators.ts`). The `create*` tools and `setZones` are gated-as-writes but unused
by the coach flows. If you wire up a new write, add it to `PROPOSABLE_WRITE_TOOLS` **and** give it a
validator in `writeValidators.ts` **and** a test in `test/writegate.test.ts` — in the same commit.

**`changeWorkoutAdvice` also passes the wellbeing screen.** Its `advice` content runs
`screenNutritionPrompt` inside `validateWrite` — a write can't smuggle disordered-eating advice past the
gate.

Never add an "auto" mode, never call `aie.callRaw(..., { allowWrite: true })` from anywhere but the gate,
and never bypass the confirm step. (Full lifecycle contract → `endurance-coach-architecture-contract`;
propose/confirm CLI usage → `endurance-coach-run-and-operate`.)

---

## 3. The other hard invariants a change must preserve

A change that breaks one of these is a **bug**, not a feature. Named so you recognise when you're near one:

- **Degrade, don't crash.** External fetches (Garmin, weather, local LLM) are best-effort with timeouts. A
  failure = a missing card/field with a note, **never** an error page or a hung flow. Every `AthleteState`
  field is `Provenanced<T>` (`{ value: T|null, source, note? }`) — a shape/tool error degrades ONE field
  to `null`.
- **Deterministic flows make ZERO LLM calls.** State assembly, insights, weather, dashboard cards,
  `check`, `cost`, `demo` — none call the LLM. Only the named coach flows (readiness/weekly/race/deep-dive/
  ask/session/etc.) call Opus. Adding an LLM call to a deterministic path is a regression.
- **Dashboard HTML is escaped.** All interpolated text goes through `escapeHtml` (`src/util/html.ts`);
  event handlers bind via `data-*` attributes, never quoted JS args. `test/dashboard.test.ts` asserts
  inline `<script>` blocks still parse after adversarial titles — keep it green.
- **Atomic + locked persistence.** State writes are temp-file + `rename`, guarded by `proper-lockfile`.
  `store.ts` strips `profile` (medical) + `dataCompleteness` before persisting. Don't add a write path that
  skips the lock or hits disk non-atomically.
- **Honest models.** Anything estimated (zones, splits, road dryness, predictions) is labelled
  `MODEL`/`estimate` in UI and docs, with assumptions stated. Unproven detector findings stay tagged
  `exploratory` until they pass the acceptance bar (→ `endurance-coach-validation-and-qa`).

---

## 4. No live numbers in committed / profile data (invariant #7)

`profile/schema.ts` `assertNoLiveNumbers()` **rejects** FTP/CSS/HRV/RHR/pace/CTL/ATL/TSB/TSS/VO2/
threshold/weight as numbers or numeric strings anywhere in the profile. Live numbers come **live** from
AIE/Garmin at question time; only **stable context** (body facts, kit, fuelling inventory + GI notes, race
targets) lives in `profile.local.yaml`. Hard-coding an athlete number in a committed file is the one thing
this repo refuses to do — the number goes stale and the coach lies. `test/profile.test.ts` and
`test/equipment.test.ts` enforce this.

**Adding a user-authored gitignored field** (a new block in `profile.local.yaml`, a new local data file):
ship ALL of these in the **same commit** (CLAUDE.md rule 5):
- (a) a committed **example/template** with placeholders (`profile.example.yaml` / `.env.example` pattern),
- (b) **`README.md` + `SETUP.md` guidance** on how to fill it,
- (c) an **in-app nudge** where one fits — an optional `profile/questions.ts` entry (surfaces in
  "Set up & improve → Finish setup") and/or a card empty-state hint.
- `test/profileQuestions.test.ts` asserts every question's dot-path field exists in `profile.example.yaml`
  — keep it green.

**Exempt** from the template rule: runtime-generated files (`data/`, `knowledge/pending/`, logs — the app
authors them, not the user) and secrets/tokens (`.env`, `*.tokens.json`, token dirs), which must **NEVER**
be templated with real values.

---

## 5. Definition of done — checklist for EVERY change

Run this list before you commit. It mirrors CLAUDE.md and CONTRIBUTING.md and applies without being asked.

```
[ ] On a feature branch, NOT main   (git branch --show-current  → not "main")
[ ] Code + docs moved together      (see the docs column in §1 for this change type)
    [ ] README.md updated if user-facing behaviour/command/card changed
    [ ] .env.example has a commented entry for every new env var
    [ ] docs/specs/* updated if a spec is source-of-truth for what changed
[ ] New logic has a unit test       (node:test, pure fn preferred, fixtures, NO network)
[ ] Green gate passes locally:
        cd /Users/maxeskell/dev/personal-training-app && npm run typecheck && npm test
[ ] Estimates labelled MODEL/estimate; missing data renders "—"; durations as h:mm
[ ] Gitignored user-authored data ships template + guidance + nudge (§4)  [if applicable]
[ ] No gate routed around: write gate, wellbeing gate, green gate all intact
[ ] Report honestly — if a test was skipped or is flaky, SAY SO; never present it as done
```

**Green before commit is literal.** The local gate IS the gate (`npm run ship` re-runs it and aborts on
red). As of 2026-07-04 the suite is **730 tests, 0 fail, ~6–8s, hermetic (no network)** — verify with
`npm test 2>&1 | tail -5`.

> **CONTRIBUTING.md drift (known, 2026-07-04):** `CONTRIBUTING.md` §"Definition of done" still says
> "Open a PR; let CI go green" (the old GitHub-PR flow). The **live** flow per `CLAUDE.md` and `HANDOVER.md`
> is local-first `npm run ship` on the Mac (§6); GitHub is a backup mirror, not the deploy source. Follow
> `CLAUDE.md`. CI (`.github/workflows/ci.yml`) still runs on push to `main` as a backstop, but it is not
> the gate. If you touch `CONTRIBUTING.md`, reconcile this in the same commit.

---

## 6. Branch, then ship — the flow at a high level

**Never edit on `main`.** Work on a feature branch; Claude owns the deploy (the user runs no CLI for it).

**On the Mac (the normal case) — GitHub is a backup, not the deploy source:**
```bash
cd /Users/maxeskell/dev/personal-training-app && git checkout -b my-change   # branch first
#   …edit code + docs together, commit small imperative commits…
cd /Users/maxeskell/dev/personal-training-app && npm run ship                # Claude runs this after green
```
`npm run ship` (`scripts/ship.sh`): guards (refuses if you're on `main`, tree is dirty, or a merge/rebase
is in progress) → **local gate** (`npm test` + `npm run typecheck`, aborts on red) → `git merge --no-ff`
your branch → `main` (auto-aborts and returns you to your branch on conflict) → restarts the dashboard via
`launchctl kickstart -k` → pushes `main` to GitHub **as a backup** (a failed push warns but does NOT abort
— the local deploy is already live) → drops you back on your branch. **`npm run ship` is Mac-only.** Full
step-by-step anatomy and the service/runner details live in `endurance-coach-run-and-operate`.

**Web-session exception (GitHub-first).** A cloud/web container **cannot reach the Mac**, so you cannot run
`npm run ship` there. Instead: gate in-container (`npm run typecheck && npm test`), push, merge to `main`
on GitHub; the Mac picks it up on the next `git pull`. That pickup is only automatic if the **optional,
off-by-default** pull-based autoupdate is installed (`npm run autoupdate:install`) — do not assume it is.
Do not coach from a web session either — it can't reach the athlete's live data (CLAUDE.md).

---

## 7. The three unwritten discipline rules (each with its why)

These are not in a linter; they are the hard-won judgement calls that keep this project honest.

### 7.1 Don't overrule the platform
Never run a **competing hard-coded ruleset** against AI Endurance's ML model. AIE already sets adaptive
volume, predictions, and a recovery model. Use the sports science to **interpret and sanity-check** what
AIE says — never to overrule it **without this athlete's own n=1 evidence**.
*Why:* the platform's model is calibrated; a solo hand-coded rule that contradicts it is usually just
noise dressed as authority. Source: `coach-instructions.md` line 16 ("Defer to AI Endurance's model where
it already has an opinion… Don't run a competing hard-coded ruleset against it") — treated here as a **hard
rule**. (n=1 = a sample size of one athlete, i.e. this athlete's own data.)

### 7.2 Never re-derive the load science
Keep **consuming** AIE's FTP/CSS/threshold/predictions/recovery via MCP. Do **not** rebuild the calibrated
dose-response / load model the platform owns.
*Why:* individual training response is ~50% heritable with 20–45% non-responders — there is **no
solo-buildable a-priori load model** that would be more right than AIE's. The app's edge is
**interpretation + context + execution-grounded feedback**, NOT re-deriving load. `knowledge/sports-science.md`
priors are consumed as LLM context, explicitly **"NOT a hard-coded rules engine"** (line 8). If you feel
the urge to write a CTL/ATL formula that overrides AIE, that's the smell this rule exists to catch. (The
app *does* compute Banister CTL/ATL/TSB for its own trend detectors — that's descriptive interpretation of
AIE's per-session load, not a competing prescription. Detail → `endurance-domain-reference`.)

### 7.3 Worktree / branch-check hygiene — the costliest failure fenced off
> **⚠ THE AUTOUPDATE LAUNCHD JOB CAN YANK YOU OFF YOUR BRANCH — the worst hazard on the real Mac.**

`com.endurance-coach.autoupdate` runs `scripts/autoupdate.sh`, which on a **clean tree** does
`git checkout <deploy-branch>` (default `main`) + fast-forward pull + the `post-merge` restart hook. During
a past session it **twice** silently moved HEAD from a feature branch back to `main` mid-task, so
edits/commits landed on local `main` instead of the branch (REVIEW-HANDOVER.md §2, "worst hazard on the
real Mac"). Note: `autoupdate.sh` now refuses to touch the tree if you have **uncommitted** changes (line
21) — but a **clean** tree still gets switched to the deploy branch, so a committed feature branch can be
abandoned under you.

**Defence (do both):**
```bash
# 1. Do feature-branch work in a separate git worktree — the autoupdate only touches the PRIMARY dir on main:
git worktree add /Users/maxeskell/ptapp-wt <branch>
ln -s /Users/maxeskell/dev/personal-training-app/node_modules /Users/maxeskell/ptapp-wt/node_modules
#    …commit + push from the worktree, then:  git worktree remove /Users/maxeskell/ptapp-wt

# 2. Re-check the branch RIGHT BEFORE every commit/push:
git branch --show-current      # must NOT print "main"
```
In a fresh ephemeral container with no launchd this doesn't bite — but **assume it does on the Mac.** Live
triage of "my commits landed on main" → `endurance-coach-debugging-playbook`. The settled incident record
→ `endurance-coach-failure-archaeology`.

---

## 8. Quick reference — what routes where

| You want to… | Do this |
|---|---|
| Know if a change is allowed / how to commit it | This skill — classify (§1), run the DoD checklist (§5) |
| Actually run `ship` / manage services / see the ship.sh anatomy | `endurance-coach-run-and-operate` |
| Fix a live break (port fight, OAuth 401, commits on main, "—" fields) | `endurance-coach-debugging-playbook` |
| Check if a fix/removal is already settled (intervals.icu, load model, autoupdate) | `endurance-coach-failure-archaeology` |
| Understand invariants / data flow / the write-gate contract in full | `endurance-coach-architecture-contract` |
| Add/audit an env var or flag | `endurance-coach-config-and-flags` |
| Meet the test/acceptance bar; add a test | `endurance-coach-validation-and-qa` |
| Prove an n=1 statistical finding | `endurance-coach-n1-validation-campaign`, `endurance-coach-proof-and-analysis-toolkit` |
| Follow house doc style / know which doc owns a fact | `endurance-coach-docs-and-writing` |

---

## Provenance and maintenance

Written **2026-07-04** against `main` at commit `8389d6b`. Re-verify the drift-prone facts with these exact
commands (run from `/Users/maxeskell/dev/personal-training-app`):

| Fact stated here | Re-verify command |
|---|---|
| Test count "730 tests, 0 fail" | `npm test 2>&1 \| tail -5` |
| Green gate scripts exist | `npm run typecheck --silent >/dev/null; grep -E '"(test\|typecheck\|ship)":' package.json` |
| Write gate: only 3 proposable tools | `grep -n 'PROPOSABLE_WRITE_TOOLS' src/guardrails/writeValidators.ts` |
| 8 tools in `AIE_WRITE_TOOLS`; only-callsite `allowWrite` | `grep -n -A10 'AIE_WRITE_TOOLS = \[' src/mcp/aieClient.ts; grep -rn 'allowWrite: true' src/` |
| `PROPOSAL_TTL_DAYS = 7` | `grep -n 'PROPOSAL_TTL_DAYS' src/guardrails/writeGate.ts` |
| `assertNoLiveNumbers` rejects live numbers | `grep -n 'assertNoLiveNumbers' src/profile/schema.ts test/profile.test.ts` |
| Wellbeing screen name + write-path hook | `grep -n 'screenNutritionPrompt' src/guardrails/wellbeing.ts src/guardrails/writeValidators.ts` |
| ship.sh guards + `COACH_DEPLOY_BRANCH` read at line 17 | `sed -n '17,53p' scripts/ship.sh` |
| autoupdate.sh checks-out deploy branch on clean tree | `sed -n '20,38p' scripts/autoupdate.sh` |
| "Don't overrule the platform" source line | `grep -n 'competing hard-coded ruleset' coach-instructions.md` |
| Autoupdate-HEAD-hijack hazard doc | `grep -n 'YANK YOU OFF YOUR BRANCH' REVIEW-HANDOVER.md` |
| CONTRIBUTING.md still says "Open a PR" (drift) | `grep -n 'Open a PR' CONTRIBUTING.md` |
| Named invariant tests present | `ls test/ \| grep -E 'writegate\|profileQuestions\|dashboard\|wellbeing'` |
| Current HEAD commit for this stamp | `git log --oneline -1` |
