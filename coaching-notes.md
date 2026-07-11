# Coaching notes — to-dos & decisions (NOT a data store)

> **This file is deliberately not a data cache.** Athlete data is *pulled live at question time*, never
> stored here — stored numbers go stale, and the repo's whole posture is "live numbers come live":
> - **Stable context** (body, kit, fuelling inventory + GI notes, race targets) lives in
>   `profile.local.yaml`, served by the `get_profile` MCP tool.
> - **Live numbers** (FTP, CSS, weight, HRV, load, the plan, the race calendar) come from AI Endurance /
>   Garmin via the MCP server (`npm run mcp`).
>
> What lives *here* is only what has no live source and doesn't go stale: **open questions / to-dos** and
> **decisions we've agreed**. It's committed so it travels with the repo — including a web checkout, where
> the MCP and the gitignored profile aren't reachable.

## To do
- [ ] **Set the bike threshold honestly (post-Birmingham).** The race falsified FTP 199 W: NP 217 W
      for 79 min at −0.4% decoupling, then a negative-split 10k. Update FTP in AI Endurance/Garmin
      toward ~215–220 W now (keep-higher rule), and book a proper test/openers week **post-Japan
      (Aug)** to set it properly — every zone, the whole 250 W bike-build arc, and next season's
      race models hang off this one number. (Also finally resolves which power meter feeds AIE.)
- [ ] **Swim CSS test (400/200) before Alderford (6 Sep).** Still unset — a whole season of swim
      training ran unstructured, and the race swim positive-split ~7% (2:07→2:21/100m by 500m block).
      One pool test, set CSS in AIE, and the swim finally gets a model + paced sets.
- [ ] **Revise Alderford target off the race-time model, not aspiration.** Profile still says
      "sub 2:00" for Alderford — same fantasy number Birmingham just disproved (2:39:12 while
      executing well). Honest Olympic target at current numbers ≈ **2:32–2:36 (MODEL)**; sub-2:00 at
      44 needs ~35-min-10k + ~250 W race watts — a different athlete. Update `profile.local.yaml →
      races[]` once agreed. See docs/specs/improvements/07-race-target-plausibility.md.
- [ ] **Winter wheel swap** — the Hunt 40mm deep aero wheels (30mm GP5000 S TR) are the *summer*
      everyday training wheel; switch back to the 32mm alloy wheelset (nominal-32mm GP5000) when winter
      conditions arrive, and back to the Hunts in spring. Pressures differ between the two — summer
      (30mm) ≈ 52 F / 60 R psi; winter (32mm, wetter roads) ≈ 48 F / 55 R psi (both MODELs, tune by feel).
- [ ] **Rehearse long-run liquid carb (once the running vest arrives)** — load PF 60 in the front soft
      flasks and practise drinking carb *on the run*, not just water. Closes the GLP-1 fuelling gap (run
      fuel should be liquid on a slowed gut) and the missed carb channel. Build the rate up gradually in
      long runs, and rehearse it **in the Tue–Thu GI-trough window** at least once, not only on fresh days,
      so it's race-realistic for the 70.3 run leg. Vest: Salomon Active Skin 8 (flasks included) was the pick.
- [ ] **Call Sportstest (0333 900 3330, Cannock) — price + book the two one-offs.** Get pricing for
      (a) the endless-pool **swim video analysis** and (b) the **cycling technique analysis** (motion
      capture / pedal-stroke + power-balance — book it *for the asymmetry question*: left heel-out/toe-in,
      knee tracking, platform offset L −9 mm / R +5 mm, late left power phase). Sensible window: **autumn
      2026** (post-Warwick, before the winter swim block). Also ask whether the annual bike assessment can
      run **on your own Rally pedals** — that's what makes the lab threshold map onto every ride you record.
- [ ] **Book the catch-up Medichecks panel for mid-Aug 2026 (w/c 10 Aug, post-Japan).** Morning, fasted,
      ≥48 h after the last hard session. Book before flying on 18 Jul so the slot exists when you land.
- [ ] **Book the annual testing week — last week of Feb, every year (first: Feb 2027).** Medichecks
      Ultimate Performance panel Monday morning (fasted, ≥48 h after last hard session) + Sportstest
      comprehensive **bike** physiological assessment (ramp + lactate thresholds + VO2max, own pedals)
      later the same week. Late Feb = vit-D trough, iron checked before the build, end-of-base repeatable
      state, zones set for the season, and the annual FTP data point for the 2028 short-vs-long gate.
- [ ] **Sweat-rate test** — gives a real ml/h + sodium figure so fuelling/hydration advice isn't a
      population MODEL. Protocol: weigh yourself (minimal/no clothing, towel-dry) before a ~60 min steady
      session; record fluid drunk during it; weigh again after. Sweat loss (L) ≈ (pre-kg − post-kg) +
      fluid drunk (L); rate = that ÷ session hours. Repeat once cooler / once warmer if you can. Note
      shirt salt-staining / sweat taste for a rough sodium read (a patch test is the accurate version).
      The field now exists — put the result in `profile.local.yaml → fuelling.preferences.sweat_rate_ml_per_hour`
      (and `sweat_sodium_mg_per_l` if known); the fuelling plan then uses your number instead of the MODEL.

- [x] **Fuel card solid/liquid balance preference — SHIPPED (Phase 1).** `fuelling.preferences.solid_liquid_split`
      (`liquid`|`even`|`solid`, bare or per-sport) now drives `planFuel` (`src/coach/fuelPlan.ts`); `even`
      alternates a cadence-sensible solid + liquid feed, and the free-text `prefs.notes` is echoed on
      fuelled sessions. Both the chat and the dashboard card read it (same engine). Max's profile set to
      `{ride: even, run: liquid}`. This is the template for "Channel A" (structured fact → profile →
      recompute → both surfaces).
- [x] **Phase 2 — coach↔dashboard decision loop ("Channel B") — SHIPPED.** The Claude coach walks the
      dashboard's cues + "discuss with coach" items (`agenda`), reaches a call with the athlete, records it,
      and the card reflects "✓ discussed with coach". One store (`data/decisions/log.jsonl`), gated writes
      unchanged. Pieces:
      - [x] (a) `agenda` MCP read tool — enumerates the exact dashboard items with stable keys (`src/coach/agenda.ts`).
      - [x] (b) `react_to_insight` carries a one-line `note` + stamps `via:"coach"`; `latestCoachDiscussions`
        extractor returns the latest coach outcome per key (`src/state/decisionLog.ts`).
      - [x] (c) scoped render: `discussedLineHtml` shows "✓ discussed with coach · date · outcome — note" on
        the reactable / applyable / task cards + coach recs (threaded via a `discussions` map, additive).
      - [x] (d) stable ids for `open_items` (string OR `{id,text}`); Max's profile migrated to ids.
      - Refine ideas (later): on the card, surface the discussed line in the open-item SUMMARY (currently in
        the `<details>` body); optional auto-fade of an agreed item after a cool-off (today it stays annotated).

## Decisions / things we've talked through
- **2026-07-11 — Birmingham (A-race) debrief: the target was the failure, not the athlete.**
  Result 2:39:12, 19th overall, **1st of 8 AG** (splits + .FIT data live in `data/career-history.json`
  and the race .FIT — not here). Execution was near-optimal: even bike, controlled run open,
  negative-split close. The "sub 2:00" target was never derivable from any data we hold; a
  race-morning model from the athlete's own numbers lands ~2:36–2:41.
  _Correction (same day, from Max): a per-leg model DID exist — the dashboard's "Estimated race
  splits" card predicted 2:09:44 for T1+bike+T2+run, and the modelled-legs actual was 2:09:16
  (28 s accurate) — but with CSS unset it silently dropped the swim, so its headline "2:10" read
  as a full-race time ~30 min fast. Fixed same day (second ship): swim falls back to recent
  open-water .FIT pace, and a plan with un-modelled legs warns "not a full-race time" on the
  headline. Fuelling: executed to plan, reported good — logged._
  Agreed consequences:
  (a) **targets must come from a data-derived race model before they're committed** (spec 07);
  (b) the race is a **certified ≥217 W NP for 79 min** data point — FTP/zones update, see To do;
  (c) swim gets structure only when CSS exists — test booked-by to-do above;
  (d) taper honesty: race-morning TSB was −6.8 (fresh-ish, not peaked) — a real A-race peak wants
  TSB ≥ 0; raise with AI Endurance before Alderford. App side, same day: multisport race .FITs now
  auto-fetch + expand per leg (they were silently skipped — the A-race was invisible to the granular
  layer), and the career page gained a hand-authored finishing-position field.
- **2026-07-06 — Annual testing rhythm + Sportstest one-offs.** Cost-capped at one paid round per year;
  Sportstest (Dr Garry Palmer's lab, Cannock — ~25 min away) is the testing venue.
  - **Annual, same slot every year: one "testing week", last week of February.** Bloods (Medichecks
    Ultimate Performance, Monday fasted) + Sportstest comprehensive **bike** physiological assessment in
    the same week. Bike, not run, because bike watts are the limiter and the lab lactate-threshold trend
    feeds the 2028 short-vs-long decision gate; run threshold comes free from Garmin/races between times.
    Sportstest's suggested 3–6-month retest cadence declined — once a year is the agreed spend.
  - **One-offs to start with (not recurring): swim endless-pool video analysis + cycling technique
    analysis.** Swim: CSS unset, technique = cheapest speed, and video shows what the shoulder does under
    load. Bike: taken *despite* the March 2026 J.Laverack fit because the motion-capture/pedal-balance data
    speaks directly to the documented left-side asymmetry. Their "weekly/bi-weekly coaching" upsell declined.
  - **Run 3D gait analysis deferred** — optional one-off before the 2027 run build (the injury window);
    only book if the budget's happy after the first two.
  - **Catch-up blood panel: AGREED IN (2026-07-06).** One off-cycle Medichecks panel mid-Aug 2026
    (post-Japan, rested) — last panel is Nov 2020 and tirzepatide 15 mg + 11–12 h/wk makes iron/B12/
    lean-mass markers worth the look now rather than in Feb. One-off; the annual rhythm still starts
    Feb 2027.
- **2026-06-27 — Brick fuelling rehearsal + standing solid/liquid preference.** Mon 29 Jun brick
  (3 h ride → 1 h run, day +1 after the Sunday dose — drug fresh, emptying slowed though not the
  Tue–Thu trough). Agreed framework (coaching guidance; exact grams worked live off pulled
  weight/products):
  - **Standing preference: a more even solid/liquid carb balance**, not the all-liquid/gel default —
    but solids go on the **bike** (hours 1–2, seated, gut freshest) and the **run stays liquid/gel
    only** (solids running on day +1 = GI risk). Day target ~80 g/h on the bike easing to ~55–60 on
    the run; push toward the 90 g/h ceiling only as tolerated.
  - **Bike (~78 g/h, ~45% solid):** PF drink-mix spine ~500 ml/h + Flapjax flapjack (split) and an
    OTE Anytime Bar in hrs 1–2, transitioning to OTE Super Gel / PF90 for hr 3 into the run.
  - **Bail rule:** if solids sit heavy (likely day +1), drop to the drink-mix + gel spine — getting
    it down comfortably beats forcing the split or the number.
  - The new kit makes this work: PF Carb & Electrolyte drink mix (liquid carb channel) + PF90 gel
    (single 90 g hit) — both 2:1, now in `profile.local.yaml → fuelling.products`.
  - **Open:** the dashboard fuel card doesn't yet model a solid/liquid split (it picks one sippable
    item). Make it honour the preference so the web app reflects this, not just the chat — see To do.
- **2026-06-25 — Right shoulder (rotator cuff) — standing rehab reminders.** No pain, but still
  uncomfortable. Agreed standing context (now in `profile.local.yaml`: `health.conditions` +
  `biomechanics.rehab`, and `strength_sessions_per_week` bumped to 3-4):
  - **Physio/gym rehab 3-4×/week** — keep it in the weekly routine, don't let it lapse on busy/travel weeks.
  - **Warm the shoulder up before every swim** — band external rotations + scapular activation before
    the first hard set (open-water Saturdays included).
  - **Discomfort during rehab is expected; a *return of sharp or recurring pain* is the stop signal** —
    back off and reassess with the physio rather than pushing through.
  - Swim impact currently none — keep it that way; don't ramp overhead/pull volume while it's still
    uncomfortable, and flag if freestyle volume starts to aggravate it.
- **2026-06-23 — 70.3 Outlaw fuelling.** Agreed the framework (coaching guidance, not athlete data):
  ~70–90 g/h, bias the bike and ease on the run, multi-transportable carb above ~60 g/h, eat to a clock,
  nothing new on race day, gut-train the rate up in long sessions. Exact grams to be worked out live once
  the question is pinned to a specific race + your pulled weight/products.
  - _Update 2026-07-03: the A-race is now **On The Edge 70.3** (~18 Jul 2027), not Outlaw — Outlaw was dropped. The
    fuelling framework above is race-agnostic and unchanged; just note On The Edge is a hillier course, so pace the
    bike (and its fuelling) off normalised power, not raw speed._
