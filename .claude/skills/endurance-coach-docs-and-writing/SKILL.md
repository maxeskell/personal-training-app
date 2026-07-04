---
name: endurance-coach-docs-and-writing
description: >-
  Load when writing, updating, or reviewing any prose/documentation in the Endurance Coach repo, or
  deciding WHICH doc a change belongs in. Triggers: "update the docs", "which doc owns this", "code and
  docs move together", "did I update the right doc", writing or editing README.md / HANDOVER.md /
  CLAUDE.md / CONTRIBUTING.md / SETUP.md / docs/PRODUCT.md / docs/commands.md / docs/data-sources.md /
  docs/insight-engine.md / docs/mcp-server.md / docs/profile.md / a docs/specs/* spec / a
  docs/specs/improvements/* fix write-up; "house style", "how do we phrase this", labelling something a
  MODEL/estimate, showing missing data as "—", formatting a duration as h:mm, spelling out an acronym on
  first use, a critical-warning blockquote; adding or editing a profile question (which regenerates
  docs/profile-questions.md — never hand-edit that file); writing a spec skeleton or a HANDOVER-style
  known-issue entry; making a coaching claim sound honest rather than oversold. Do NOT load for the
  definition-of-done gate mechanics or the ship/commit rules themselves (use endurance-coach-change-control)
  or for public/marketing/novelty claims about the product (use endurance-coach-external-positioning).
---

# Endurance Coach — docs and writing

**Use this when** you are writing or editing any documentation or user-facing prose in this repo, deciding
which doc a change belongs in, matching the house voice, or adding a profile question (which regenerates a
doc). **Don't use this when** you need the *rules* about when docs must ship (the definition-of-done gate,
green-before-commit, branch-then-ship) — that is `endurance-coach-change-control` — or when you are making a
public/competitive/novelty claim about the product — that is `endurance-coach-external-positioning`.

The one rule everything here serves: **code and docs move together in the SAME commit.** A behaviour,
command, config, card, or schema change that ships without its doc update is an incomplete change, not a
follow-up. This is mandated by `CLAUDE.md` (§"Definition of done" #1) and `CONTRIBUTING.md` (§"Definition of
done" #1). This skill tells you *which* doc, *what* voice, and *how* — the gate that enforces it lives in
`endurance-coach-change-control`.

Jargon defined once (used below): **MODEL / estimate** = a computed value that is not a ground-truth
measurement (a zone, a split, a road-dryness call, a race prediction); house rule requires it be labelled so.
**Source-of-truth** = the doc that is authoritative for a topic; if code and that doc disagree, the doc is the
spec and the code is the bug (or vice-versa — reconcile, don't diverge). **h:mm** = hours:minutes duration
format (e.g. `1:30`, not `90 min` or `1.5h`). **"—"** (em dash) = the render for missing/unknown data, never
`0`.

---

## 1. Docs of record — the map

Every doc has one job and one update trigger. Touch the doc whose trigger your change hits; if a change hits
several, update all of them in the one commit.

| Doc | Purpose | Audience | Update when you change… | Source-of-truth for |
|---|---|---|---|---|
| `README.md` (~83 KB) | What it does + everyday usage | User / new reader | Any user-facing behaviour, command, card, flag, flow | User-facing behaviour |
| `CLAUDE.md` | Standing instructions / manifest for this repo | Claude + engineers | A standing rule, convention, or the run/ship model | The house rules (this repo's constitution) |
| `CONTRIBUTING.md` | Short how-to-work-on-it | External contributor | The definition-of-done, conventions, or setup summary | Contributor onboarding |
| `HANDOVER.md` (~17 KB) | Engineering handover (build/operate/design/known-issues) | Engineer inheriting it | A design decision, a config knob, an op runbook, a known issue | Engineering operation + known-issue log |
| `SETUP.md` | Stand up a NEW athlete's instance (assistant-followable) | New user + their AI assistant | The setup flow, a new secret/account, a new user-authored file | New-instance setup |
| `docs/PRODUCT.md` | One-page product + risk summary | Reviewer / stakeholder | What-it-is, data/privacy posture, risk register | Product one-pager |
| `docs/commands.md` | Full command reference, grouped by task | User | A CLI subcommand or npm script (add/rename/remove/behaviour) | The complete command surface |
| `docs/data-sources.md` | The spine adapter seam (`AthleteState` contract) | Engineer | The source seam, the `AthleteState` contract, a new spine | Data-source seam |
| `docs/insight-engine.md` | The n=1 analytics + engagement loop, in full | Engineer | A detector, a stat method, an engagement-loop behaviour | Insight-engine detail (moved out of README) |
| `docs/mcp-server.md` | The MCP tool surface | Engineer / Cowork user | An MCP tool, its args, or the exposure flags | MCP surface detail |
| `docs/profile.md` | The athlete profile (live vs stable split) | User / engineer | The profile shape or the live/stable boundary | Profile model |
| `docs/profile-questions.md` | Optional profile-field questions | User | **NEVER hand-edit — GENERATED.** See §5 | (generated view of `src/profile/questions.ts`) |

**Specs (`docs/specs/*`) are source-of-truth for what they cover** — when a spec defines the intended
behaviour, the spec is authoritative and code conforms to it (`CLAUDE.md` §"Definition of done" #1). Update
the spec in the same commit as the code when the spec is the source of truth for what changed.

| Spec | Source-of-truth for |
|---|---|
| `docs/specs/Endurance_Coach_BUILD_SPEC_for_Claude_Code.md` | The authoritative design + the Path A vs Path B decision gate |
| `docs/specs/AI_Triathlon_Coach_Project_Instructions.md` | The coach persona / system-prompt (fallback persona) |
| `docs/specs/Endurance_Coach_Integration_Spec.md` | Data-integration detail |
| `docs/specs/Insight_Engine_Spec.md` | The next-layer insight-engine design |
| `docs/specs/Fuelling_Spec.md` | The per-session fuelling engine + inventory schema + feedback loop |
| `docs/specs/Season_Arc_Spec.md` | The season-arc / periodisation design |
| `docs/specs/improvements/01..06` | A landed P0/P1 fix write-up (server security, write-path integrity, rendering safety, statistical validity, data integrity, grounded proposals) — **status-stamped** (`Status: ✅ landed on main …`); update the status line when the fix's scope moves |

**Living prose docs (prompts + priors, not code, but code+docs discipline still applies):**

| File | Purpose | Update via |
|---|---|---|
| `coach-instructions.md` | The default coaching prompt/persona shipped with the repo (a prompt, NOT athlete data) | Hand-edit; it's the shipped default brief |
| `knowledge/sports-science.md` | The coach's priors, loaded into every coaching prompt | **Not by hand for content** — refresh via `npm run research` → review → `npm run knowledge -- approve <file>` (§6). Carries a `> Last verified: YYYY-MM-DD` marker; `npm run knowledge` flags it stale after ~35 days |
| `coaching-notes.md` | Open questions/to-dos + agreed decisions — **NOT a data store** (no live numbers). Kept current as a by-product of coaching chats | Hand-edit during/after a coaching chat |

**Review artifacts (not everyday docs of record):** `REVIEW.md` and `REVIEW-HANDOVER.md` are the running
record + runbook of a staged deep code review. They were written in a cloud session and reference a
container path (`/home/user/personal-training-app`), not the Mac. Read them for review *history*; don't treat
them as the operate/setup docs, and don't copy their path.

---

## 2. "Which doc must I touch?" — decision aid

Run down this list; touch every doc whose row your change hits (same commit).

- **Added/renamed/removed a CLI subcommand or npm script?** → `docs/commands.md` (the full surface) **and**
  `README.md` §"Everyday commands" if it's a day-to-day one. If it's an MCP tool, also `docs/mcp-server.md`.
- **Added/changed an env var or flag?** → `.env.example` (a commented entry — see §4) **and** `README.md`
  and/or `HANDOVER.md §7 "Config knobs"`. (The flag *catalog* lives in `endurance-coach-config-and-flags`;
  this skill only says the doc must move with it.)
- **Changed user-visible behaviour of a flow or a dashboard card?** → `README.md` (the relevant section).
- **Changed a detector, a statistic, or the engagement loop?** → `docs/insight-engine.md`; if the design
  itself moved, `docs/specs/Insight_Engine_Spec.md`.
- **Changed the `AthleteState` contract or the source seam?** → `docs/data-sources.md`.
- **Changed the profile shape or the live/stable boundary?** → `docs/profile.md`; if you added an *optional
  profile field/question*, edit `src/profile/questions.ts` and regenerate `docs/profile-questions.md` (§5).
- **Changed a design decision, an operational runbook, or discovered a known issue/gotcha?** →
  `HANDOVER.md` (§5 decisions, §8 runbook, §9 known-issues).
- **Changed a standing rule / convention / the run-or-ship model?** → `CLAUDE.md`, and mirror the
  definition-of-done in `CONTRIBUTING.md` if that moved.
- **Landed a P0/P1 fix that has an improvements spec?** → update that `docs/specs/improvements/NN-*.md`
  status line.
- **Changed the setup flow, a required account, or a new user-authored file?** → `SETUP.md` (and the
  committed template + in-app nudge per `CLAUDE.md` §"Definition of done" #5).

When two docs cover the same thing, the **README** is the short front page and the **`docs/` page or spec**
is the full detail; the README should *link* to the detail, not duplicate it (e.g. `docs/insight-engine.md`
opens by saying it is "the detail moved out of the README"). Keep the split — don't let the README grow the
detail back.

---

## 3. House style — the voice checklist

Match this every time. Sources: `CLAUDE.md` §"Athlete preferences" + §"Honest models"; `CONTRIBUTING.md`
§"Honest models"; the existing docs. Blunt about engineering, careful about the athlete's health/safety.

- [ ] **Label every estimate a MODEL / estimate, with its assumptions stated.** Anything computed rather
      than measured — zones, splits, road dryness, race predictions, fuelling numbers — says so. Real repo
      phrasing: "anything estimated is labelled a MODEL" (`README.md`); "descriptive (a MODEL)". Never
      present a model output as a measured fact.
- [ ] **Absolute paths in every CLI instruction.** Copy-pasteable from anywhere:
      `cd /Users/maxeskell/dev/personal-training-app && npm run …` — never a bare `npm run …` that assumes a
      working directory (`CLAUDE.md` §"Talking to the user").
- [ ] **Durations as h:mm.** `1:30`, not `90 min`. Weekly totals render h:mm (`CLAUDE.md`).
- [ ] **Missing/unknown data renders "—" (em dash), never a misleading `0`** (`CLAUDE.md`).
- [ ] **Spell out an acronym on first use**, then use it: "External Stress Score (ESS)", "critical swim
      speed (CSS)", "time-in-zone (TID)". (Domain meanings live in `endurance-domain-reference`.)
- [ ] **Blockquotes (`>`) for critical warnings** — the load-bearing "do not do X" lines (see the
      `> Priors, not laws.` block in `knowledge/sports-science.md`, the `>` clinical-boundary block atop
      `README.md`).
- [ ] **No oversell.** Unproven stays labelled `open` / `candidate` / `MODEL` / `estimate`. A finding is
      "exploratory" until it is FDR-confirmed *and* its CI excludes 0 (the acceptance bar lives in
      `endurance-coach-validation-and-qa`); write it that way. Don't upgrade a hunch to a claim in prose.
- [ ] **Explain *why*, not just *what*.** The house voice states the reason a rule exists (e.g. why writes
      are gated, why priors yield to n=1). "Direct, opinionated, explains why."
- [ ] **Health/safety framing is careful, never diagnostic.** The coach refers, never diagnoses; fuelling is
      about eating *enough* for the work, never restriction. Keep that framing in any prose that touches
      wellbeing, weight, or symptoms. Never write prose that routes around the wellbeing gate
      (`guardrails/wellbeing.ts`) — e.g. never document a way to get a restriction/disordered-eating prompt
      past the screen.
- [ ] **Never document live athlete numbers.** FTP/CSS/HRV/RHR/pace/CTL/ATL/TSB/weight etc. come live from
      AI Endurance / Garmin at question time and go stale in a file. `profile/schema.ts`'s
      `assertNoLiveNumbers()` *enforces* this for the profile; extend the same discipline to prose — write
      "your FTP" / "pulled live", never a hardcoded number. (`coaching-notes.md` is explicitly NOT a data
      store for this reason.)

---

## 4. `.env.example` convention (the env catalog is a doc too)

Every new env var lands a commented entry in `.env.example` **in the same commit** (`CLAUDE.md` /
`CONTRIBUTING.md`). The file's own header states: "Copy to .env and fill in" and marks everything OPTIONAL
except `ANTHROPIC_API_KEY`. The established pattern is a commented `VAR=default` line with an inline `#`
comment explaining what it does and, where relevant, which file/dir consumes it:

```
# --- Subsystem name ---
# One or two lines saying what this knob does and its safe default. (src/…, docs/…)
# COACH_SOMETHING=default        # inline note: what it widens, and its safe/off default
```

Rules: leave it commented if it has a safe default (so a near-empty `.env` runs); only an actually-required
value (`ANTHROPIC_API_KEY=`) is left uncommented and blank. Never put a real secret or a live number in
`.env.example`. The *catalog* of what each flag does is owned by `endurance-coach-config-and-flags`; here,
just keep the commented entry present, accurate, and grouped under its subsystem header.

---

## 5. `docs/profile-questions.md` is GENERATED — never hand-edit it

`docs/profile-questions.md` is derived from `src/profile/questions.ts` so the CLI and the doc can't drift.
The file carries a banner on line 1:

```
<!-- GENERATED FROM src/profile/questions.ts — do not edit by hand. Regenerate: npm run profile:questions -- --write-doc -->
```

To add/change an optional profile question:

1. Edit `PROFILE_QUESTIONS` in `src/profile/questions.ts` (each entry: `area`, `field` dot-path, `question`,
   `why`). The `field` must be a real dot-path that exists in `profile.example.yaml`.
2. Regenerate the doc:
   ```
   cd /Users/maxeskell/dev/personal-training-app && npm run profile:questions -- --write-doc
   ```
3. Run the tests — `test/profileQuestions.test.ts` asserts (a) every `field` dot-path exists in
   `profile.example.yaml` (no phantom fields), and (b) `docs/profile-questions.md` on disk byte-matches the
   renderer (no drift). If you hand-edited the doc or forgot to regenerate, this test fails with
   "regenerate with: npm run profile:questions -- --write-doc".
   ```
   cd /Users/maxeskell/dev/personal-training-app && npm test
   ```

A new *user-authored* profile field also needs the template + guidance + in-app nudge per `CLAUDE.md`
§"Definition of done" #5 (a `profile.example.yaml` entry, README/SETUP guidance, and optionally a
`profile/questions.ts` entry that surfaces in the app). That gate is owned by `endurance-coach-change-control`.

---

## 6. `knowledge/sports-science.md` refresh (don't hand-write the content)

The priors file is loaded into every coaching prompt, so it must stay honest and dated. Content changes go
through the review-gated flow, not a manual edit:

```
cd /Users/maxeskell/dev/personal-training-app && npm run research          # web-searches recent thinking, drafts into knowledge/pending/
cd /Users/maxeskell/dev/personal-training-app && npm run knowledge          # shows freshness + digests awaiting review
cd /Users/maxeskell/dev/personal-training-app && npm run knowledge -- approve knowledge/pending/<file>   # folds it in under a dated section, bumps Last verified
```

`approve` is a deliberate CLI action (never an agent's automatic call). The file keeps a `> Last verified:
YYYY-MM-DD` marker; `npm run knowledge` flags it stale after ~35 days. Keep the "priors, not laws — n=1
outranks the textbook" framing intact (blockquote at the top). Editing the *prose framing/structure* by hand
is fine; folding in new *evidence* goes through `approve` so the dated provenance and sourcing hold.

---

## 7. Templates

### 7a. A `docs/specs/improvements/NN-*.md` landed-fix write-up (match the existing shape)

```markdown
# Spec N — <short title of the fix>

**Status:** ✅ landed on `main` (<date>) · **Priority:** P0|P1 · **Size:** S|M|L · **Owner:** <name/TBD>

## Problem
<What was wrong, concretely — the symptom and why it mattered. Blunt.>

## Fix
<What changed, and where (file:function). Why this approach over the alternatives.>

## Evidence / tests
<The test(s) that lock it (test/…), and how to reproduce the original failure.>
```

Keep the status line honest: `✅ landed` only once it is on `main` and green; otherwise `proposed` /
`in progress`. Improvements specs are the settled record — the live-triage view is
`endurance-coach-debugging-playbook` and the chronicle is `endurance-coach-failure-archaeology`.

### 7b. A `HANDOVER.md §9` known-issue entry

```markdown
- **<Issue name>.** <What breaks / the gotcha>, <the condition that triggers it>. **Workaround/fix:**
  <the exact command or discipline>. Status: <open | mitigated | settled>.
```

Blunt about the engineering risk; state the discriminating command. Cross-reference the debugging playbook
for the live check.

---

## 8. Before you commit a docs change — quick check

- [ ] The code change and every triggered doc are in the SAME commit (§2). If unsure whether a doc must
      ship, that gate is `endurance-coach-change-control`.
- [ ] House-style checklist (§3) passed on the new prose.
- [ ] If you touched a generated doc's source (`src/profile/questions.ts`), you regenerated (§5) and
      `npm test` is green.
- [ ] No live athlete numbers, no real secrets, no unlabelled estimates in the new prose.
- [ ] A README addition *links* to the detail doc rather than duplicating it.
- [ ] `npm run typecheck && npm test` green (the gate itself is owned by
      `endurance-coach-change-control` / `endurance-coach-validation-and-qa`; run it anyway before commit).

---

## Provenance and maintenance

Date-stamped **2026-07-04**. This skill cites doc names, generation commands, and house-style rules that can
drift. Re-verify with:

- **Docs of record still present / renamed:**
  `cd /Users/maxeskell/dev/personal-training-app && ls README.md HANDOVER.md CLAUDE.md CONTRIBUTING.md SETUP.md docs/*.md docs/specs/*.md docs/specs/improvements/*.md`
- **`docs/profile-questions.md` still generated (banner + regenerate command):**
  `cd /Users/maxeskell/dev/personal-training-app && head -1 docs/profile-questions.md`
- **The `--write-doc` flag still exists:**
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "write-doc" src/cli.ts`
- **The profile-questions drift test still enforces byte-match + no-phantom-fields:**
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "regenerate with\|GENERATED FROM\|no phantom" test/profileQuestions.test.ts`
- **Knowledge-refresh commands unchanged:**
  `cd /Users/maxeskell/dev/personal-training-app && npm run 2>/dev/null | grep -E "research|knowledge|profile:questions"`
- **`knowledge/sports-science.md` still carries a `Last verified:` marker + the ~35-day stale rule:**
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "Last verified" knowledge/sports-science.md; grep -n "35 days" README.md knowledge/sports-science.md`
- **House-style rules still stated where cited:**
  `cd /Users/maxeskell/dev/personal-training-app && grep -n "h:mm\|misleading zero\|labelled a MODEL" CLAUDE.md README.md`
- **`.env.example` header convention unchanged:**
  `cd /Users/maxeskell/dev/personal-training-app && head -12 .env.example`
- **Spec source-of-truth list current:**
  `cd /Users/maxeskell/dev/personal-training-app && sed -n '/^## Specs/,/^## Principles/p' README.md`
