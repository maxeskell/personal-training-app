# 07 — Race-target plausibility gate (the Birmingham 2026 lesson)

**Status: proposed (not built).** Written 2026-07-11, the evening of the failure it describes.

## The failure

Birmingham Triathlon 2026 (the season's A-race) carried a profile target of **"sub 2:00"** for an
Olympic-distance race. The athlete finished in **2:39:12 — a 39-minute miss — while executing
close to optimally** (even-paced bike at −0.4% decoupling, negative-split run, 1st of 8 in AG).
The target was not a stretch; it described a different athlete. A back-of-envelope model from the
athlete's own live numbers on race morning (swim ~2:00/100m observed pace, bike ~31 km/h at
raceable watts, run threshold 4:43/km + brick cost, transitions ~3:30) predicts **~2:36–2:41** —
the actual result was dead-centre in that band.

**No part of the pipeline ever challenged the number.** The target lives in
`profile.local.yaml → races[].target_time` (athlete-authored, never validated); AI Endurance never
had it (`set-race-targets` is a standing open item); and every LLM race-prep report accepted it
verbatim — T-27d through T-1d all organised pacing advice around "sub-2:00" without once comparing
it to the athlete's data. The coach's own guardrails ("label estimates as MODELs", "n=1 data over
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
