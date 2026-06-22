<!-- GENERATED FROM src/profile/questions.ts — do not edit by hand. Regenerate: npm run profile:questions -- --write-doc -->

# Optional profile questions

These are the **optional** athlete-profile fields you can fill in whenever you like, each with a
plain-language question and a one-line reason it matters. **All of them are optional** — the coach
works fully without any of them. The *required* fields (identity, weekly hours, a first race) are
handled by `npm run profile:init` and aren't repeated here.

This page is generated from `src/profile/questions.ts` (the same data behind
`npm run profile:questions`), so the CLI and this doc can't drift.

## Three ways to answer any of them

- Rerun the guided intake:  npm run profile:init  (it pre-fills what your integrations hold).
- Edit profile.local.yaml directly (it's gitignored and never shared).
- Ask Claude to fill it in for you (e.g. via the get_profile MCP tool / your assistant).

## identity

| Field | Question | Why it matters |
|---|---|---|
| `identity.location` | What city/region do you train in? | Recorded for your reference and to label reports; the live weather card is driven by COACH_WEATHER_LAT/LON in .env, not this field. |
| `identity.height_cm` | What's your standing height (cm)? | Stable anthropometry kept for reference (and auto-filled from Garmin when enabled). Weight stays a live number, never stored here. |

## health

| Field | Question | Why it matters |
|---|---|---|
| `health.medication.name` | Are you on any regular medication the coach should work around? (name) | Surfaced in every coaching flow so advice is given AROUND your medication — the drug/dose/timing stay your prescriber's call, the coach just adapts to them. |
| `health.medication.dose_day` | Which weekday do you take it? | Drives the computed dose-cycle (days_since_dose): the coach keeps your hardest/longest sessions clear of the days the dose hits you hardest. |
| `health.medication.gi_trough_days` | Which weekdays are your typical GI / low-energy trough? | Feeds the dose-cycle's in_gi_trough flag, so the coach steers big fuelling-dependent sessions away from those days and watches for under-fuelling. |
| `health.medication.implications` | Any coaching implications of the medication you want noted? (free-text list) | Printed verbatim as 'Coaching implications' in the profile context block, so the coach factors them into every write-up. |
| `health.conditions` | Any ongoing health conditions to be aware of? (list of name/status/swim_impact) | Recorded for your reference and visible to Claude via get_profile; not yet pulled into the compact live coaching block. |
| `health.strength_sessions_per_week` | How many strength sessions do you do per week? | Recorded for your reference and visible via get_profile; not yet read by an automated flow. |
| `health.sleep` | Anything notable about your sleep pattern? (free text) | Recorded for reference; the coach's live sleep signal comes from Garmin (sleep score/hours), not this note. |

## bloods

| Field | Question | Why it matters |
|---|---|---|
| `bloods.panels` | Any blood-test panels worth recording? (dated snapshots: date, source, markers, flags, notes) | The latest panel's date, flags and notes surface in the live coaching block — with an age + re-test nudge once it's over a year old — and the full markers show via get_profile. Snapshots only, never treated as current; no training API holds your bloods. |

## biomechanics

| Field | Question | Why it matters |
|---|---|---|
| `biomechanics.leg_length_difference` | Do you have a leg-length difference, and what correction (run lift / bike shim) is in use? | Surfaced to the coach so run-load and injury notes account for it — e.g. flagging asymmetric load when ramping run volume. |
| `biomechanics.asymmetry` | Any left/right asymmetry or recurring one-sided niggle? | Added to the coaching context as an injury-watch note, so the coach is cautious about the loads that aggravate it. |
| `biomechanics.cleat` | Any cleat setup cue you want the coach to remember? (e.g. an angle adjustment) | The cleat cue is echoed in the coaching context as a bike-setup reminder tied to knee/foot comfort. |
| `biomechanics.mobility` | Any mobility limits worth recording? (hip flexion / internal rotation / hamstrings) | Recorded for your reference and visible via get_profile; not yet read by an automated flow. |
| `biomechanics.rehab` | Any ongoing rehab / prehab focuses? (list) | Recorded for your reference and visible via get_profile; not yet read by an automated flow. |

## availability

| Field | Question | Why it matters |
|---|---|---|
| `availability.rest_day` | Which weekday is your usual rest day? | Shapes the week in the coaching context, so the coach plans hard days and recovery around your fixed rest day. |
| `availability.fixed_sessions` | Any fixed weekly sessions (squad swim, club run, long-ride day)? | Listed in the coaching context so the coach builds the week around your immovable sessions instead of suggesting conflicts. |
| `availability.notes` | Anything else about your weekly availability? (free text) | Appended as an availability note the coach reads when shaping the week. |
| `availability.indoor_trainer` | Do you have an indoor trainer (turbo/smart bike)? | Recorded for your reference and visible via get_profile; not yet read by an automated flow (the weather card decides indoor/outdoor from your .env thresholds). |

## equipment

| Field | Question | Why it matters |
|---|---|---|
| `equipment.bikes` | What bikes do you ride (groupset, crank length, and each bike's as-raced weight incl. a bottle)? | Visible to Claude via get_profile. A bike's race_weight_g (grams, as-raced) also surfaces in the live coaching block, where the coach adds your live weight to it for total system weight — e.g. to size tyre pressure. |
| `equipment.power_meters` | Do you train with a power meter? (which) | Recorded for your reference and visible via get_profile; FTP/power numbers themselves stay live from AI Endurance/Garmin. |
| `equipment.wetsuit` | Do you have a wetsuit (and is it allowed for your races)? | Recorded for your reference and visible via get_profile; not yet read by an automated flow. |
| `equipment.run_shoes` | What run shoes are you in (rotation / race-day pair)? | Recorded for your reference and visible via get_profile; not yet read by an automated flow. |

## bike_fit

| Field | Question | Why it matters |
|---|---|---|
| `bike_fit.fits` | Do you have a bike-fit record (saddle height, reach, etc.)? | Recorded for your reference and visible to Claude via get_profile; not pulled into the compact live coaching block. |
| `bike_fit.report_file` | Is there a bike-fit report PDF in the project to reference? | A pointer kept for your reference; the coach doesn't open the file automatically. |

## fuelling

| Field | Question | Why it matters |
|---|---|---|
| `fuelling.carb_target_g_per_hour` | What's your carb target per hour by session type (e.g. long 80, sprint 0)? | Read into the coaching context as your per-session fuelling plan, so race/long-session advice references YOUR carb targets (the live nutrition ranges come from AI Endurance). |
| `fuelling.caffeine` | How do you use caffeine on race day? (your strategy) | Surfaced in the coaching context as your caffeine lever, so race-prep advice respects your own plan. |
| `fuelling.products` | What nutrition do you actually use? (gels, bars, drink mix, electrolytes, recovery, supplements — per-serving carbs/sodium/caffeine) | Powers the 'Fuelling — next session' dashboard card and the `fuelling` tool: per-session pre/during/after built from YOUR products, only when a session needs it. See profile.example.yaml → fuelling.products for the format. |

## races

| Field | Question | Why it matters |
|---|---|---|
| `races` | Any other races/targets to add beyond your first one? | Your race calendar is surfaced as 'Race targets' in every coaching flow so prep and periodisation track your real season (mirror target times into AI Endurance — read-only from here). |

## season_plan

| Field | Question | Why it matters |
|---|---|---|
| `season_plan.horizon_goal` | What's your multi-season horizon goal? (e.g. 'Ironman by 2028') | Anchors the /season page — the far target everything else builds toward; shown with a countdown and used to frame whether you're on track over years. |
| `season_plan.phases` | What are your season phases? (each: name, focus, until-date, CTL target as text e.g. '55') | Drives the /season page: it picks the phase whose until-date is still ahead, then grades your current chronic load (CTL) and consistency against that phase's target and focus. ctl_target is intent-as-text, never a live number. |
