# 07 — Race-target plausibility gate (the Birmingham 2026 lesson)

**Status: partially addressed.** Written 2026-07-11, the evening of the failure it describes;
corrected the same day — a per-leg race model DID exist (the dashboard's "Estimated race splits"
card, `estimateTriSplits`), and it was **28 seconds accurate on the legs it modelled**. Two things
failed around it: the swim leg was dropped (CSS unset) with only a fine-print note while the
headline still read as a race time, and nothing compared the card's number to the profile target.
The first failure is FIXED (same-day commit: open-water-pace swim fallback + a loud
"not a full-race time" warning when a leg is missing). The **gate** — comparing the model to
`target_time` and leading race-prep with any discrepancy — remains to build.

## The failure

Birmingham Triathlon 2026 (the season's A-race) carried a profile target of **"sub 2:00"** for an
Olympic-distance race. The athlete finished in **2:39:12 — a 39-minute miss — while executing
close to optimally** (even-paced bike at −0.4% decoupling, negative-split run, 1st of 8 in AG).
The target was not a stretch; it described a different athlete.

The dashboard's race-splits card modelled T1+bike+T2+run at **2:09:44**; the athlete's actual
modelled-legs total was **2:09:16** — the model was nearly perfect. But with no CSS set the swim
leg was silently omitted (headline "2:10 · over 50 km" — an Olympic is 51.5 km), so the card read
as a full-race prediction ~30 minutes fast, and the athlete reasonably took 2:10 as the number.

**And no part of the pipeline ever challenged the target.** The target lives in
`profile.local.yaml → races[].target_time` (athlete-authored, never validated); AI Endurance never
had it (`set-race-targets` is a standing open item); the splits card's 2:10 and the target's 2:00
were never compared; and every LLM race-prep report accepted "sub-2:00" verbatim — T-27d through
T-1d all organised pacing advice around it without once comparing it to the athlete's data (or to
the card's model). The coach's own guardrails ("label estimates as MODELs", "n=1 data over
priors") were applied to everything except the goal itself.

## The fix

A deterministic **race-time model** (pure function, no LLM) + a **gate in the race-prep flow**:

1. `predictRaceTime(state, profile, race)` → `{ total, legs: {swim, t1, bike, t2, run}, assumptions }`
   - **Swim:** CSS if set; else most recent open-water race/session pace from the .FIT archive; else
     flag "no swim model" loudly (that was true all season and stayed silent).
   - **Bike:** speed from a physics-lite power→speed MODEL off current FTP at a distance-appropriate
     intensity factor (Olympic ~0.85–0.90), with an explicit course-unknown error band. Normalised-power
     based, per the On The Edge decision.
   - **Run:** threshold pace × distance-appropriate factor + off-the-bike cost (~2–4%), heat-adjusted
     from forecast if available.
   - **Transitions:** athlete's own historical T1+T2 median (career-history), else 3:00 default.
   - Every leg carries its assumption and an error band; the output is labelled a MODEL.
2. **Gate:** every `race_prep` run compares `target_time` to the model. If the target sits outside
   the model's band by more than ~5%, the report MUST lead with the discrepancy (target X, model Y ± Z,
   what would have to be true to close the gap) instead of building pacing around the target. The
   prompt gets the model output as context; the deterministic readout also lands on the dashboard
   race card so the athlete sees it without asking.
3. **Post-race:** `predictRaceTime` vs official result is logged (career-history or decision log),
   so the model's own error is tracked over races — the model must earn trust the same way every
   other estimator here does.

## Why deterministic-first

Cost-aware LLM use is a repo convention: the model is pure maths from already-assembled state, so
the daily/dashboard path stays LLM-free; the LLM race-prep flow just *receives* the numbers. And a
deterministic function is testable — fixtures for each leg source, a test that the gate fires when
target and model diverge.

## Acceptance

- Unit tests: leg models from fixtures; gate fires at >5% divergence; degrades per missing source
  (no CSS → swim from archive pace → loud "no swim model").
- Golden check: Birmingham 2026 inputs (FTP 199 as-set, thr 4:43/km, observed swim pace) must
  predict within ~±4% of 2:39:12 — the race that motivated this spec is the first regression test.
- Docs: README race-prep section + this spec; `docs/commands.md` if a CLI probe is added.
