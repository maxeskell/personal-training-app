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
- [ ] **Flip creatine to `active` on 7 Sep (day after Alderford).** Decision 19 Aug: start 3–5 g/day
      post-race so the +1–2% water weight doesn't ride into the A-race — the supplements card's
      `proposed` entry carries the full note; this line is the trigger to flip it.
- [ ] **Run form — standing cues for every run + brick (from Birmingham race photos, 13 Jul 2026).**
      Surface these in run and brick session prep until habitual — the crossover is worst in the first km
      off the bike. (1) **Arm carriage:** hands cross the body's midline across the chest in nearly every
      run frame (Run-265/1356, Finish-320), rotating the torso and leaking energy. Cue: drive the *elbow*
      straight back, hands track front-to-back past the hips ("train tracks", hip-to-nipple), never crossing
      the sternum. (2) **Relax the hands:** fists clenched in several frames — soft hands (imagine holding a
      crisp); tension there travels up into the shoulders. Foot strike + posture already good, so this is the
      one run-economy lever from the photos. Add a mid-run cue reset, and one deliberately in the first km
      off the bike in bricks.
- [ ] **Bike position micro-cues (Birmingham race photos, 13 Jul 2026) — folds into the aero-position to-do below.**
      On the road bike in the drops the position is committed and low, but (1) **shoulders shrug up toward the
      ears** (Bike-245 front-on) — consciously drop/relax them to hold the position longer and unload the neck;
      (2) **the back rounds through the thoracic spine** instead of hinging from the hips — a flatter back off a
      bigger hip hinge is both more aero and a stronger power position. Test alongside any pad-drop / clip-on
      change on the fixed-power out-and-backs already planned.
- [x] **Set FTP 225 W in BOTH AI Endurance and Garmin Connect — DONE (Max, 11 Jul evening).**
      Garmin side verified live via `ftp_check` (configured 225 W, read from Garmin); AIE side
      athlete-reported (the connector is read-only and can't see which engine set it). Zones on the
      watch recompute automatically (%FTP mode). Garmin's own MMP estimate reads 172 W — that's a
      floor, not a verdict: its curve only climbs on hard sustained power efforts, so expect it to
      lag until the post-Japan test block.
- [ ] **Strap-verified FTP test — MOVED post-Alderford, w/c 7 Sep (agreed 19 Aug 2026).** The pre-taper
      window closed (post-viral comeback + heatwave ate the w/c 10 Aug re-entry plan), so the already-
      agreed 40 km race-simulation ride settles RACE pacing (225 vs 200) before the taper, and the
      formal ramp/20-min strap test re-sets the three numbers properly the week after Alderford:
      (a) **FTP** (adjust 225 up/down to the test), (b) **max HR** (race wrist-HR hit 185 vs the set
      182 — strap-verify before touching), and (c) **bike LTHR** (currently 160 = the Birmingham
      79-min race average, so it's underset). Every zone and the 250 W build arc hang off these; one
      session closes all three.
- [x] **Swim CSS test (400/200) — DONE (measured ~14 Aug 2026): CSS 1:53/100m.** Set app-side via
      COACH_SWIM_CSS (AIE's API can't read UI-set CSS back); state, zones and the race swim model now
      run off a measured number, and the stale `swim-css-not-set` profile item was cleared (19 Aug).
- [x] **Alderford + Warwick targets set — DONE (agreed with Max, 11 Jul evening).** Both fantasy
      targets replaced in `profile.local.yaml → races[]`:
      - **Alderford: "2:34-2:38"** (MODEL: Birmingham 2:39:12 − adopted execution gains ≈ 2:36–2:37
        base; A-side needs the aero work to land; Japan caps the build at ~4.5 sharpen weeks; swim-leg
        model is ~5–7 min fat until CSS is set). Gate verdict now **in-range** (0.8% gap) — the red
        nag is gone and race-prep paces off the model.
      - **Warwick: "1:05-1:09"** — Max confirmed it's a **400 m POOL sprint**, so the target is built
        by hand (swim 7:30–8:00 + 20 k at 205–215 NP ≈ 35 min + 5 k at 4:25–4:35 + transitions), NOT
        from the splits model, which assumes a 750 m open-water sprint and therefore **wrongly flags
        this target implausible** on the dashboard. Known cosmetic false-flag; profile note documents it.
- [ ] **Teach the splits model pool-sprint formats (small).** A per-race format/distance override in
      `profile races[]` (e.g. `swim_m: 400`, pool: no wetsuit, faster T1 assumptions) so Warwick-style
      races model correctly and the target gate stops false-flagging them. Until then the Warwick
      "implausible" badge is expected noise.
- [ ] **Rally-on-Atom power offset test (10 min, post-Japan).** Fit the Rally pedals to the Wattbike
      Atom once, record the SAME 3×5-min steady session on the watch (Rally) and Wattbike Hub (Atom)
      simultaneously, and read the per-second offset. Why: the archive shows the two power sources have
      NEVER measured the same effort — every outdoor ride records Rally, indoor rides pair the Atom's
      own broadcast — so the offset is unmeasured. Until then, working assumption (MODEL, textbook):
      Atom reads ~1–3% LOWER than Rally; fine for zone work on either platform, prefer one platform
      consistently for threshold-precise blocks. This empirically finishes the power-provenance
      question (the profile's confirm-power-meter open item was resolved 11 Jul: Rally → Garmin → AIE,
      both platforms configured 225 W).
- [x] **Garmin device audit — DONE (Max, 11 Jul evening).** Weight/RHR/height aligned, Rally pedal
      battery swapped, beat-to-beat HRV logging ON (athlete-reported; the next .FIT will confirm — and
      hrv messages should now appear, which also helps the DFA-α1 sparsity). Deliberately NOT touched,
      as agreed: **max HR and bike LTHR wait for the strap-verified post-Japan test** (race wrist-HR hit
      185 vs set max 182; LTHR 160 was literally the 79-min race average). FTP 225 in both platforms:
      done the same evening — see the ticked to-do above.
- [ ] **(agreed 11 Jul) Aero position work on the current road bike — don't wait for the Speedform.** Race-file CdA
      fitted **~0.358 m²** (MODEL: 309 flat steady samples, light 8–9 km/h wind, Crr 0.004, 81 kg
      system) — hoods territory. Getting toward ~0.30 (clip-ons / pad drop / helmet) ≈ **2.5–3.5 min
      over a 40 km leg at the same watts** — the largest single time purchase in the whole race file.
      Validate any change with fixed-power out-and-backs; the autumn Sportstest bike session (below)
      can sanity-check the position.
- [ ] **(agreed 11 Jul) T1 drills before Alderford (6 Sep).** Birmingham T1: **69 s of 141 stationary** + a 185 m
      transition run. Rehearse suit-half-down-before-the-rack + flying mount — 20–30 s available.
      T2 was clean (39 s watch-side) — keep the flying dismount as-is.
- [x] **Pull the Results Base field splits — DONE (by Max, before 19 Aug 2026; finding not retained).**
      The pull happened but which leg separates 19th from the top 10 wasn't logged. If the winter
      swim-vs-bike emphasis question needs the number, re-pull post-season — it's 10 minutes.
- [ ] **Winter wheel swap** — the Hunt 40mm deep aero wheels (30mm GP5000 S TR) are the *summer*
      everyday training wheel; switch back to the 32mm alloy wheelset (nominal-32mm GP5000) when winter
      conditions arrive, and back to the Hunts in spring. Pressures differ between the two — summer
      (30mm) ≈ 52 F / 60 R psi; winter (32mm, wetter roads) ≈ 48 F / 55 R psi (both MODELs, tune by feel).
- [ ] **Rehearse long-run liquid carb — vest ARRIVED (confirmed 19 Aug 2026), rehearsal now live** —
      load PF 60 in the front soft
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
- [x] **Catch-up Medichecks panel — DONE (drawn 12 Aug 2026, fasted; results 13 Aug; panel + flags saved
      to `profile.local.yaml → bloods.panels`, the canonical store).** Headline: strong panel, 2020→2026
      trend emphatically good; one flag (lymphocytes 0.39) read as post-viral transient — full read +
      decisions in the 2026-08-18 Decisions entry below. Protocol miss for next time: drawn 11:41, outside
      the 6-10am cortisol window — the annual testing week (below) now specifies pre-10am.
- [ ] **Book the annual testing week — last week of Feb, every year (first: Feb 2027).** Medichecks
      panel Monday morning (fasted, **pre-10am** — that lands the in-window cortisol/T:C baseline the
      Aug 2026 panel missed; ≥48 h after last hard session; pick a panel that **includes CK** — the
      Ultimate Performance panel doesn't, the 2020 Well Man UltraVit did) + Sportstest
      comprehensive **bike** physiological assessment (ramp + lactate thresholds + VO2max, own pedals)
      later the same week. Late Feb = vit-D trough, iron checked before the build, end-of-base repeatable
      state, zones set for the season, the annual FTP data point for the 2028 short-vs-long gate — and it
      re-checks the Aug 2026 watch items (lymphocytes, active-B12 set point, folate, SHBG, winter vit D
      on ~400 IU/day).
- [x] **Sweat-rate test — DECLINED (Max, 19 Aug 2026).** Happy with the population MODEL; the hydration
      line keeps its honest estimate label. The setup-card question was down-ranked with a discussed-
      with-coach note (visible, not hidden). Reopen only if a hot race or hydration trouble makes the
      real number matter — the protocol lives in `docs/profile-questions.md` and the field
      (`fuelling.preferences.sweat_rate_ml_per_hour`) still exists if that day comes.

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
- **2026-08-19 — Triage session: bad weigh-in purged, proposal queue zeroed, open items closed down.**
  - **Erroneous 10 Aug weigh-in deleted.** The Index S2 reading (76.55 kg, body fat 0%, SMM 0 kg — a
    failed-impedance scale glitch) was stripped from `data/archive/garmin-daily.jsonl` (the row's
    sleep/HRV kept; backfill never re-fetches a present date) and Max deleted it in Garmin Connect
    too. Live state was never polluted (weight reads 71 kg from the AIE profile); the deep-dive's
    "0 kg SMM glitch" flag is cleared. The 7 Aug reading (72.79 kg / 20.6% / 30.6 kg SMM) stands as
    the latest real body-comp point.
  - **Pending proposals: 12 → 0.** CONFIRMED: cap Thu 20 Aug's Anaerobic Ride to aerobic/tempo
    (written to AIE — ACWR 1.6 HIGH + taper from ~24 Aug outweighed the normalized morning HRV/RHR).
    DECLINED: the 3 brick alternates (the already-applied Friday brick covers the rehearsal) and the
    8 stale June load-management proposals (sessions two months past).
  - **Creatine: start ~7 Sep, the day after Alderford** — not before, so the +1–2% water weight
    (~1 kg) doesn't ride into the A-race. The supplements entry stays `proposed` with the decision
    noted; flip to `active` on the day (to-do above).
  - **CSS test confirmed measured** (1:53/100m, ~14 Aug) — to-do ticked, `swim-css-not-set` profile
    item removed. **Strap FTP test moved post-Alderford** (w/c 7 Sep); the agreed race-sim ride owns
    pre-race pacing (see the re-scoped to-do).
  - **Closed as moot:** `set-race-targets` (AIE's API can't read UI-set targets back, so the app
    tracks `target_time` from the profile — chasing the AIE UI adds nothing; `ai_endurance_todo`
    marked resolved) and `wednesday-long-run-gi` (the 7.5–10 mg dose made the trough manageable —
    reopen only on evidence). **Declined:** sweat-rate test (population MODEL accepted).
  - **Knowledge layer current again:** the June digest approved (had sat pending 62 days), a fresh
    research run made the same day (~$0.40) and its digest approved. New priors: passive heat as an
    optional additive stimulus (never displacing a session), CWI kept away from adaptation-focused
    sessions, aero position beats kit but only measured (frontal area is a poor drag proxy), sleep
    as the first amber-day check. Taper (~2wk, −40–60% volume, hold intensity/frequency) and
    HRV-trend-gating priors reconfirmed unchanged.
  - **Profile tidied:** `power_meter_note` now records the settled Rally→Garmin→AIE provenance (it
    still claimed the FTP discrepancy was open); cleat-shim re-dated to post-Alderford; the
    `races-2027` + `gb-age-group` research records archived below (off the agenda's face), replaced
    by one slim book-the-2027-races item; Speedform stays open (no news from J.Laverack — chase
    post-season). Results Base splits pull marked done (finding not retained; re-pull post-season if
    the winter-emphasis question needs it); running vest confirmed arrived (liquid-carb rehearsal
    live).
- **2026-07 — 2027 race calendar DECIDED (archived here from profile `open_items`, 19 Aug 2026).**
  Outlaw DROPPED; On The Edge 70.3 (Compton Verney, LOCAL) is the A-race. A = On The Edge (~18 Jul,
  ✅ BOOKED & PAID — 2026 deferral; decision-gate diagnostic, read bike off normalised power on a
  hillier course). B = Grafman (~6 Jun, ✅ BOOKED & CONFIRMED, ATW, ~6wk dress rehearsal). C = ATW
  Mallory Park sprint (~27 Jun, optional sharpener — also a GB Euro sprint age-group QUALIFIER, but
  parked/not targeted in 2027). UK TRIATHLON LEAGUE campaign (best 3 of 4 count; only Sprint/Olympic
  UK Triathlon events qualify — On The Edge/Grafman/Mallory do NOT): Stratford sprint (~19 Apr,
  replaced Coventry Spring Sprint) + Birmingham sprint (~1 Aug, untapered, ~2wk post-A) + Alderford
  Oly (~5 Sep) + Warwickshire sprint (~3 Oct). BOOKING STATUS: A & B booked; the 4 league races +
  Mallory still UNBOOKED (entries open autumn 2026 → early 2027; no urgency, book as they open —
  the slim `book-2027-races` profile item tracks this). Do NOT book Outlaw or the Ultimate
  (Ultimate 150/100 are middle = no league points, and it clashes ~1wk before the A).
  - _Update 2026-09-01 (scheduled 2027-booking check) — PUBLISHED DATES now supersede the
    provisionals above. **A = On The Edge is Sun 25 JULY 2027, not ~18 Jul** (do3.co.uk) — one week
    later, which lands it on Outlaw's old 25 Jul weekend, so the 'On The Edge falls a week before
    Outlaw' half of the drop-Outlaw rationale is void (the already-paid/closer half still stands).
    Knock-ons: Grafman is now ~7wk out (was ~6), Mallory ~4wk out (was ~3), and the post-A league
    sprint sits 13 days after the A. **Stratford is Sun 18 Apr** (the ~19 Apr provisional was a
    Monday) and is now ✅ BOOKED. **The '~1 Aug Birmingham' league sprint is Sat 7 AUG 2027 and has
    been RENAMED 'West Midlands Triathlon'** — King Edward's, Edgbaston; UK Triathlon runs a
    SEPARATE 'Birmingham Triathlon' at Sutton Park (2027 TBA), so booking the wrong one is a live
    trap. Its sprint is 400m / 6k bike / 5k run — league points only, never a fitness read; entry
    was LIVE with limited spaces on 1 Sep 2026. Alderford, Warwickshire and Mallory 2027 dates all
    still UNPUBLISHED. League tally 1/4 booked (need ≥3 to place); Max is holding off booking until
    he can do several at once._
- **2026-07 — GB age-group pathway RESEARCHED & RECOMMENDED (archived here from profile
  `open_items`, 19 Aug 2026).** NATIONAL pathway (represent GB at Euro/World champs), SEPARATE from
  both the UK Triathlon League AND from Ironman 70.3 Worlds (Max's stated horizon_goal — that is an
  IRONMAN-brand slot, a THIRD thing; none of his current races are Ironman-branded, so they don't
  feed it either). Age group M45-49 for 2028. VERIFIED FACTS: membership = Core Triathlon England is
  enough (includes the GB race licence). Sprint/Standard = race a DESIGNATED qualifier, top-4 in AG
  and/or within 120% (Euro)/115% (Worlds) of AG winner, 4 slots/AG/race + roll-down. Middle/Long/
  AQUABIKE = NOT a set race — qualify by SUBMITTING a past result within 120% of AG winner (aquabike
  = swim+T1+bike of a middle tri; min 1.5k OW swim + 50mi bike); small fields drop you to a later
  cut-off (Q3). Register intent + £10 by 5pm the Fri before (sprint/std). 2028 qualifier calendar
  (2027 races) NOT published yet — Mallory is a perennial sprint qualifier (confirm 2027). CHALLENGE
  / CORRECTION of earlier take: (a) 'aquabike is the soft route' was WRONG for Max — aquabike
  ISOLATES his bike (the limiter), so the 120% bar is HARDER there, not easier. (b) The standard is
  % of winner, not deep roll-down, so 'smaller field = easier' doesn't hold. (c) BIKE IS THE GATE:
  at FTP ~199W (all-time 1hr ~215W) he is not near AG-qualifying pace at any Olympic-family
  distance; GB is bike-gated and realistically 2029+, not 2028. RECOMMENDATION: the most attainable
  route is MIDDLE-DISTANCE TRIATHLON by result submission — his 4:55-5:10 70.3 target plausibly sits
  ~within 120% of an M45-49 middle winner (his endurance offsets the bike deficit; sprint/standard/
  aquabike expose his weaknesses). So do NOT chase a qualifier in 2027 (keep it the diagnostic year;
  a full-effort Mallory sprint 3wk before the A hurts the A build). Instead, the FREE moves in 2027:
  (1) buy Core Triathlon England membership; (2) race Grafman/On The Edge for CLEAN swim+bike+run
  splits — Grafman is the better *submittable* middle result (bigger field, ex-champs venue);
  (3) BENCHMARK: pull real M45-49 middle-distance winner times from a recent GB champs and compute
  120% vs Max's projected time to size the true gap. Then IF the 2028 gate says SHORT, build 2028
  around a middle-distance submission (bike → 250W+ is the whole game). BENCHMARK (REAL DATA — 2025
  Europe Middle-Distance Champs, Pamplona, M45-49): AG winner 4:12:11 → 120% (Euro) cutoff = 5:02:37
  (caught ~27 of 39 finishers, ~70% of field); 115% (Worlds) cutoff = 4:50:01 (~top 20). Max's
  4:55-5:10 target STRADDLES the Euro line measured off the champs winner (4:55 ≈ 7.5min inside,
  5:10 ≈ 7min over). BUT qualification is measured off the SLOWER domestic-race AG winner, so at a
  home qualifier Max at target pace is comfortably inside 120% → Euro middle qualification is
  realistic IF he hits target time (which already assumes FTP→~240W). Worlds 115% is a stretch (even
  4:55 is ~5min over off this winner). Bike is the gate: champs front bikes 2:13-2:20/90k; Max's
  target bike is bottom-third of this field → the bike build IS the qualification plan; swim/run are
  fine. TIMELINE: 2028 if the build flies, 2029 more likely. NEXT DATA POINT: pull the M45-49 winner
  time at the DOMESTIC race Max would submit (Grafman) — that is the actual reference number. Verify
  all specifics on britishtriathlon.org. DECISION (Jul 2026): 2027 = UK Triathlon League + diagnostic
  year ONLY — NOT adding an Ironman 70.3 (3 middle-distance races in a season judged too much on the
  11-12h/wk ceiling + GLP-1 recovery). England/GB age-group AIMED AT 2028: use 2027 race times as
  the go/no-go signal; if the fitness is clearly there, race a proper qualifier in 2028 (Mallory
  sprint, or a big-field 70.3 middle submission). ADMIN ALREADY DONE: Max is an existing British
  Triathlon member and HOLDS AN ANNUAL RACE LICENCE (= Core/Ultimate tier), so eligibility is fully
  covered — the GB question is now PURELY performance, no paperwork left. (British Triathlon = the
  federation; Triathlon England is the home nation under it — one membership, not two.)
- **2026-08-18 — Aug 2026 catch-up bloods: read, saved, decided.** Panel (drawn 12 Aug, fasted, 11:41;
  results 13 Aug) saved to `profile.local.yaml → bloods.panels` with flags/notes — that's the canonical
  store. Headline: the 2020→2026 trend validates the tirzepatide + training era (trigs 1.34→0.77, HDL
  1.11→1.84, ferritin 70→140, vit D 68→84, testosterone 15.7→21.6, HbA1c/CRP flat) and shows **no
  low-energy-availability signature** — the thing the catch-up panel was booked to check. Agreed:
  - **Lymphocytes 0.39 read as post-viral transient.** Max felt rough post-Japan ("jet lag + something
    deeper — a bug makes sense in hindsight"); archive shows a rest day before the draw (no acute-exercise
    artifact); the lab's own transit-delay caveat applies; platelets low-normal fit the picture. The
    report's **4-week FBC recheck: DECLINED** by Max — coach recommended the ~£35 recheck once (taper
    morning 3–4 Sep), decision respected. **Reopen triggers (per the report): fever, mouth ulcers,
    swollen glands, recurrent infections, or another unexplained run-down spell → GP** (not a mail-order
    kit); otherwise the Feb 2027 annual FBC closes the loop.
  - **MMA test: DECLINED** (same call as 2020) — active B12 is a six-year stable set point (56→52);
    food-first, watched annually.
  - **No supplements at all currently (confirmed).** Vit D 84 = summer sun alone. Coach recommendation
    standing: **~400 IU/day vit D Oct–Mar** (standard UK winter guidance + the 2020 GP advice); the
    late-winter retest open item stays. B12/folate stay food-first — nutrient **density** matters on a
    GLP-1 appetite (eggs/dairy/fish/meat; greens/legumes).
  - **Comeback-block guidance (post-viral + heatwave, 19 days to Alderford):** intensity is earned —
    hard sessions only when feeling fully well; the pending post-Japan FTP test wants full health AND a
    cooler day (aim w/c 24 Aug — still clear of the taper).
  - **Supplement protocol now lives in the app (same day, follow-up ask):** new `supplements:` profile
    block + the Plan tab's deterministic "Supplements — what & when" card (active now / coming up /
    proposed / parked, counted off the race calendar). Agreed protocol: vitamin D3 400 IU/day Oct–Mar
    (active, seasonal); beetroot-nitrate race-week loading (active — buy Beet It Sport shots, the
    RE:GEN in the cupboard is the recovery variant); caffeine as the race-day lever (active; in-race
    dosing stays with fuelling). Creatine 3–5 g/day: **PROPOSED — discuss before starting** (best-evidence
    lean-mass case on a GLP-1; expect +1–2% water weight and a higher creatinine on future panels). XXL
    stack (beta-alanine / acetyl-L-carnitine / NitroX) confirmed lapsed → pruned from fuelling.products,
    kept in supplements as `lapsed` history.
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
  TSB ≥ 0; raise with AI Endurance before Alderford.
  _Same-evening addendum — AIE's HRV-based zone suggestion DECLINED._ AIE proposed zone ceilings
  (End<190 / Tempo<228 / Thr<269 / VO2<304) that all back out to **FTP ≈ 253 W** — its CP-model
  number wearing an HRV hat. n=1 evidence says no: today's race NP 217 W × 79 min (with reserve)
  makes ~217 a FLOOR; textbook Olympic bike IF (0.90–0.95) puts the ceiling ~228–241; all-time
  60-min mean-max is ~203 W avg (set today; the file claiming 363 W is corrupt run-power data).
  **Decision: FTP = 225 W** (low-central of the MODEL band 220–240 — under-pitched intervals
  complete, over-pitched ones poison the build) → zones End<169 / Tempo<203 / Thr<236 / VO2<270.
  Set in BOTH AIE and Garmin; re-test post-Japan and adjust to the test. App side, same day: multisport race .FITs now
  auto-fetch + expand per leg (they were silently skipped — the A-race was invisible to the granular
  layer), and the career page gained a hand-authored finishing-position field.
- **2026-07-11 (late) — power provenance + corrected-history read-through: NO plan changes needed.**
  Asked and answered with Max, read-only review then agreed tidy-ups:
  - **Power provenance settled:** every outdoor ride in the archive records the Rally pedals (FIT
    device scan, product 3578 on all ~20 recent power rides incl. the race); AIE reads Garmin; both
    platforms now configured 225 W — so plan → zones → outdoor execution is one Rally-based chain.
    Indoor rides pair the Wattbike Atom's own power (manufacturer 73 in the June indoor file); no
    dual-source ride exists, so the Rally↔Atom offset is unmeasured (test to-do above). Garmin's MMP
    *estimate* (172 W) is a floor that lags until hard sustained power efforts — ignore it.
  - **Corrected history vs the season plan:** strengthens, doesn't change it. The restored 70.3 PB
    **4:34:50 (Monster Middle 2012, age 30, ~220 h year)** age-grades to ≈5:02–5:11 at 45 (MODEL,
    ~1%/yr) — the 2027 On The Edge target 4:55–5:10 is now validated by his own younger self, not
    aspiration. Phase-1 FTP goal (199→~220 W by end-2026) already beaten (225 set, race-proven).
    Short-vs-long 2028 gate stays open by design — current form favours short (AG win at CTL ~50),
    history proves middle (two sub-4:40 70.3s on 220–360 h years).
  - **Dorney Lake 2:21:30 (2023) is a venue artifact** (pan-flat rowing basin, courses often measure
    short) — it stands as the Standard-distance PB in the career table but must never be used as a
    form benchmark; Birmingham 2:39:12 on a real course is the honest marker.
  - **Profile tidied same night (gitignored, no ship needed):** season-plan note refs refreshed
    (FTP 225 set Jul 2026 / all-time 60-min ~203 W guarded / 70.3 PB + age-grading); open items
    `ftp-discrepancy` and `confirm-power-meter` resolved + removed (evidence above); profile
    re-validated (loads clean, 8 open items remain).
- **2026-07-11 (evening) — race-file deep dive: ~4–6 min of execution headroom, no new fitness needed (MODEL).**
  Every message type in the race .FIT decoded; full 100-finding ranked report in
  `reports/2026-07-11-race-fit-deep-dive.md` (gitignored, regenerable from the .FIT). Adds to the
  morning debrief — and the best-60-min NP **inside the race was 220 W** (decoupling −0.4%), consistent
  with the FTP 225 decision above. **Race-execution protocol for Alderford** — status per item
  (Max, same evening): **ADOPTED — bike surge cap + run start pace** (plus the aero-work and T1-drill
  to-dos above, and the device audit now done). **Still proposed, not yet agreed: the swim-settle
  protocol and the muscular-endurance training bias** (the ME bias is an AI Endurance conversation for
  the post-Japan build anyway):
  - **Bike:** cap climb kicks at ~110% of target NP, soft-pedal the slow (<40 km/h) coasts, first
    5 min ≤200 W. Birmingham was ridden as **99 surges ≥300 W** (21.6% of the leg in Z6, anaerobic
    TE 3.1), the race-max HR (185) came at **minute 6 of the bike** on the first climb, and the final
    third faded 217→205 W *at falling HR* — legs, not heart. Target VI ≤1.05 (was 1.10).
  - **Run:** open at ~4:35/km from the mat. Run avg HR (158) sat BELOW the bike's (160) — inverted for
    an Olympic — form improved while accelerating (GCT/vertical-ratio both better in Q4), last 400 m
    4:09/km at HR 180. ~30–50 s free.
  - **Swim:** settle by minute 1, not minute 8 — Q1 was ~1:50/100 m true vs a 2:00 average, and the
    fade was stroke *length* (DPS −8.4% at constant 26 cyc/min), the hot-start signature. Even swim
    ≈ 20–40 s + a calmer bike start. The CSS test (to-do) gives it numbers.
  - **Training consequence (for the post-Japan build):** the one genuine fitness gap the file shows is
    **late-ride muscular endurance at race watts** — bias long rides toward sweet-spot with race-watts
    finishing blocks + brick tails. Raise with AI Endurance (propose→confirm), don't hand-edit the plan.
  - Also on file: L/R balance 49.8/50.2 with **no drift under race load** (the documented left-side
    asymmetry didn't show); torque effectiveness ~75/75; fuelling template validated (~60 g/h
    liquid-led, zero GI, dose-day 6 — bank it, next rehearsal is the 70.3 rate); anaerobic TE 3.1 ⇒
    2–3 easy days now (aligns with the Japan-transition plan); wrist-only HR all race (no strap), so
    HR trends are solid but single beats — including the 185 — want strap confirmation.
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
  - _Update 2026-07-03: the A-race is now **On The Edge 70.3** (Sun 25 Jul 2027 — date confirmed 1 Sep 2026; was pencilled ~18 Jul), not Outlaw — Outlaw was dropped. The
    fuelling framework above is race-agnostic and unchanged; just note On The Edge is a hillier course, so pace the
    bike (and its fuelling) off normalised power, not raw speed._
