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
- [ ] **Winter wheel swap** — the Hunt 40mm deep aero wheels (30mm GP5000 S TR) are the *summer*
      everyday training wheel; switch back to the 32mm alloy wheelset (nominal-32mm GP5000) when winter
      conditions arrive, and back to the Hunts in spring. Pressures differ between the two — summer
      (30mm) ≈ 52 F / 60 R psi; winter (32mm, wetter roads) ≈ 48 F / 55 R psi (both MODELs, tune by feel).
- [ ] **Rehearse long-run liquid carb (once the running vest arrives)** — load PF 60 in the front soft
      flasks and practise drinking carb *on the run*, not just water. Closes the GLP-1 fuelling gap (run
      fuel should be liquid on a slowed gut) and the missed carb channel. Build the rate up gradually in
      long runs, and rehearse it **in the Tue–Thu GI-trough window** at least once, not only on fresh days,
      so it's race-realistic for the 70.3 run leg. Vest: Salomon Active Skin 8 (flasks included) was the pick.
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
- [~] **Phase 2+ — close the coach↔dashboard decision loop ("Channel B").** Let the Claude coach walk the
      dashboard's "This week" cues + "discuss with coach" items and write back the agreed/not-agreed
      outcome so the card reflects it. One store (`data/decisions/log.jsonl`), gated writes unchanged.
      - [x] (a) **`agenda` MCP read tool — SHIPPED.** Enumerates the exact dashboard items (coach recs +
        this-week cues + finish-setup + open items + races) with stable keys + current reaction, built on
        the same `buildSetupItems`/`latestAdviceFindings` the dashboard uses. `src/coach/agenda.ts`.
      - [ ] (b) extend `react_to_insight` to carry an outcome + one-line note (the "discussed & agreed, here's
        why" record), keyed by the card key.
      - [ ] (c) scoped render of that outcome on the dashboard card ("✓ discussed with coach · date · agreed").
      - [ ] (d) stable ids for `open_items` — CONFIRMED a real problem: the live agenda showed keys are the
        whole sentence normalised (`setup:open:book medichecks ultimate performance…`), so a reword orphans
        the outcome. Give each open_item an explicit short id (back-compat with plain strings).

## Decisions / things we've talked through
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
  the question is pinned to a specific Outlaw + your pulled weight/products.
