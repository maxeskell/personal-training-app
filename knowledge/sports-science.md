# Sports-science priors — living knowledge layer

> Last verified: 2026-08-19

> **Priors, not laws.** Population research = small samples, modest effects, big individual
> variation. For n=1, this athlete's own response data and the AI Endurance model are the authority.
> Where they disagree with a prior, **the prior yields.** Re-verify periodically (refs at bottom).
> These are consumed by the LLM core (M3) as context — they are NOT a hard-coded rules engine.

## 1. Intensity distribution
~60–90% easy volume with smaller threshold/high-intensity portions characterises successful endurance
athletes. "Polarized" is *proposed* but recent meta-analysis does **not** establish clear superiority
over pyramidal — both work. **Apply:** protect easy-easy/hard-hard separation; don't dogmatise the split.

## 2. HRV-guided intensity gating
Modest, mainly protective — clearest benefit is fewer non-responders by avoiding hard work when
unrecovered, not chasing a daily score. **Apply:** gate intensity by *trend*, not a single reading.

## 3. Durability / physiological resilience
Performance depends on how little fresh numbers decay over hours; trainable by low- and high-intensity
work and accumulated volume. **Apply:** quality late in long sessions / off the bike; value long-term
volume — it underpins both triathlon and marathon performance.

## 4. Carbohydrate fuelling
~90 g/h baseline for long sessions; up to ~120 g/h for trained athletes with gut training
(glucose:fructose ~1:0.8); higher availability may aid durability/economy. **Apply:** progressive
gut-training into race fuelling; rehearse in long sessions; **never under-fuel.**

## 5. Strength training
Improves running economy and cycling efficiency with little VO₂max change; supports durability and
fatigued-state performance; manage concurrent-training interference. **Apply:** protect 1–2 sessions
through the build; **don't cut first** when volume rises.

## 6. Tapering
~2 weeks pre-A-race cut volume substantially (~40–60%), hold intensity and frequency. A marathon
takes a shorter taper than a long-course tri. A B-race that's a capped tempo (see periodisation) gets
**no full taper** — don't bleed the goal race's prep for it.

## 7. Periodisation guardrail
One tri build → one run block; **never two stacked peaks**; maintain (don't build) swim/bike Aug–Sep.

---

## Season-structure priors (apply to the LIVE calendar, never a fixed one)
The athlete's races come live from `getRaceGoalEvent`; the app derives and supplies a SEASON SHAPE
block. These are the priors behind that derivation — apply them to whatever the current calendar is:
- **A lower-priority race a few weeks before a higher-priority one = capped tempo, not a race.** Racing
  it hard that close compromises the goal race's taper/prep. Default: hard-capped tempo / drop intensity.
- **A run goal built off a triathlon base = injury window.** Swim/bike volume spares the legs, so
  running-specific orthopedic load has been low; ramping run volume concentrates that load fast.
  **Cap weekly run-volume increases, watch niggles early** — monitor `getRecoveryModel.orthopedic.run`.
- **Don't stack two peaks.** One build per peak; if two A-races sit close, peak for one and carry fitness.
- **Heat:** UK summer is usually mild — only consider heat prep if the forecast shows a genuine heatwave
  near race day. Don't prescribe acclimation by default.

## Wellbeing (hard limits — enforced in code at M3, not just prose)
Fuel to train; use AIE nutrition *ranges*. **Never** recommend deficits/restriction/"race weight."
Weight is a **trend**, secondary, never a daily target. **No clinical-syndrome detection** — if multiple
risk signals co-occur (rapid/unexplained weight loss, suppressed HRV + poor sleep, rising RHR, low
energy), raise gently and refer to a professional; don't label RED-S, don't treat loss as a win.

## How this file is maintained
This is loaded into **every** coaching prompt, so edits here update the coach everywhere. Refresh cadence
is tracked by the `Last verified:` marker above (`npm run knowledge` flags it stale after ~35 days). To
refresh: `npm run research` drafts a **web-grounded digest** of recent developments into
`knowledge/pending/` — a *proposal you review*, never auto-applied. After reading it,
`npm run knowledge -- approve <file>` folds it in under a dated section and bumps the verified date. The
review step is deliberate: priors still yield to this athlete's n=1 data, and nothing here is a hard rule.

## References (verify periodically)
- Stöggl & Sperlich 2015; Sperlich et al. 2023; Silva Oliveira et al. 2024 (POL not clearly superior).
- HRV-guided training meta-analyses 2021 (Manresa-Rocamora et al.).
- Maunder et al. 2021; Jones 2024 (resilience); Matomäki et al. 2023.
- Thomas/Erdman/Burke 2016; Jeukendrup 2014; Viribay et al. 2020; Hearris et al. 2022.
- Llanos-Lagos et al. 2024/2025; Eihara et al. 2022; Van Hooren et al. 2024 (concurrent training).
- Bosquet et al. 2007; Mujika & Padilla (tapering).

## Approved research update — 2026-08-19

# Research digest — 2026-06-18 (PROPOSED — review before applying)

_Drafted by the monthly research flow with web search. Nothing here is active until you approve it
(`npm run knowledge -- approve <file>`), at which point it's folded into the priors and the coach
uses it. Treat as a starting point — verify sources, and remember your own data outranks the textbook._
I'll research recent developments across the key topic areas. Let me run several focused searches.
Good material on fuelling and durability. Let me now cover gear and other priors.
Let me check for recent strength-training and intensity-distribution developments.
Here's a review proposal based on developments in the past ~12 months. It's a digest for your approval — not a rewrite of the file.

---

# Knowledge refresh — proposal (drafted 2026-06-18)

## 1. Carbohydrate fuelling — **CONFIRMS + tightens prior #4**
A 2026 *Journal of Nutrition* contemporary-perspectives review supports the current ceiling: 
contemporary research suggests that the upper limit of CHO intake could increase from 90 to 120 g/h (at least for trained participants), considering that both exogenous and whole-body rates of CHO oxidation can be increased with these higher ingestion rates.
 Crucially, it draws a line under the social-media arms race — 
although field observations report a trend for endurance athletes to consume 120–200 g/h, the efficacy of such doses is not yet substantiated by current scientific research.
 Same review notes higher intakes 
may also modulate important physiological determinants of performance (e.g., durability and economy) across cycling, marathon running, and ultraendurance exercise.

- **Proposed prior:** Keep ~90 g/h baseline, up to ~120 g/h for trained athletes with gut training (1:0.8 glu:fru). **Apply:** treat 120 g/h as the evidenced ceiling; the 150–200+ g/h seen in the pro peloton is unproven for performance — don't chase it, and rehearse anything new in long sessions. Higher availability plausibly aids durability/economy.
- **Source:** "From Metabolism to Medals," *J Nutr* (pub. Feb 2026), CC-BY — https://jn.nutrition.org/article/S0022-3166(26)00091-X/fulltext · **Confidence: high.**

## 2. Durability / physiological resilience — **CONFIRMS prior #3, adds "trainable" nuance**
The concept matured into review-level work this year. Jones' 2025 review frames resilience/durability as increasingly central and 
considerations of training for resilience, alongside other more established physiological determinants of performance, will likely be important in the long-term development of successful endurance athletes.
 A 2025 methodological review cautions that measurement isn't standardised yet: 
the construction of the fatiguing protocol affects durability profiles, with greater relative intensity and duration resulting in more marked deterioration of baseline measures.

- **Proposed prior:** No change to the principle; add that durability is *trainable* (volume + appropriately fatigued quality work) but lab/field profiling is not yet standardised — treat any single durability "number" cautiously.
- **Source:** Jones 2025, *Scand J Med Sci Sports* (sms.70032); Hunter et al. 2025, *Exp Physiol* 110:1612–1624. · **Confidence: high (concept), moderate (how best to train/measure it).**

## 3. Strength training — **STRENGTHENS prior #5 (now with a durability mechanism)**
A new RCT directly tests the durability angle you already coach: in 28 well-trained male runners, 
adding strength and plyometrics training to a programme of endurance running improved RE durability and substantially increased high-intensity TTE at the end of a 90 min run in the heavy intensity domain.
 Practitioner syntheses add that 
these benefits do not require excessive lifting volume or hypertrophy-focused programming.

- **Proposed prior:** Keep "protect 1–2 sessions, don't cut first." **Add:** the payoff is biggest *late in long efforts* (economy holds under fatigue), so maintain heavy/plyometric strength through a marathon build rather than dropping it as run volume climbs — low volume is enough.
- **Source:** Zanini, Folland, Wu & Blagrove 2025, *Med Sci Sports Exerc* 57(7):1546–1558. · **Confidence: high** (caveat: well-trained *male* runners, n=28).

## 4. Super-shoes / advanced footwear — **NEW (gear)**
A 2026 meta-analysis of 14 crossover trials found 
statistically significant reductions favoring plated shoes for running economy, metabolic cost, oxygen consumption
 — translating to ~2–3% economy and roughly ~1% marathon benefit on flat roads. But it's surface-specific: a 2025 trail study found 
adding a carbon plate to trail shoes offered no metabolic benefit on level ground and actually increased energy cost by ~2% during uphill running.
 The plate effect is also partly confounded by foam — 
when midsole material and geometry were matched, plate insertion generally favored lower metabolic demand, suggesting an LBS-specific component.

- **Proposed prior (new):** Super-shoes are worth it for road racing and key road sessions (~1–4% economy), but the benefit is highly individual and **surface-dependent** — limited or negative off-road/uphill. **Apply:** rotate race-day shoes, run-in before racing, and test n=1 economy/comfort rather than assuming a gain.
- **Source:** Kobayashi et al. 2026, *Front Sports Act Living* 7:1710224 (CC-BY); Jaboulay & Giandolini 2025, *Footwear Science* 17(1):19–27. · **Confidence: high (road), moderate (trail/uphill).**

## 5. Tyre width & pressure — **NEW (gear)**
The road-cycling consensus has shifted to wider tyres at lower, optimised pressures, but it's a *system* call. On real roads, 
30mm tires often show slightly lower rolling resistance than 28mm tires—assuming both are run at optimized pressures
, because lower pressure cuts vibration losses. Aerodynamics pulls the other way and depends on the rim: 
if your rim's external width is optimized for 28mm tyres, moving to 30mm can create a shape mismatch, airflow separation increases, potentially raising drag.
 For a flat, smooth tri/TT course at speed, narrower can still edge it aerodynamically.
- **Proposed prior (new):** For UK roads/long-course tri, 28–30mm tubeless at correctly-calculated (not max) pressure is a sensible default; match tyre to rim width and prioritise a supple casing. **Apply:** use a pressure calculator and the athlete's own weight/surface; don't inflate to the sidewall max. Smooth, fast TT courses may justify going slightly narrower.
- **Source:** Multiple 2025–26 industry/lab tests (Cyclingnews, BikeRadar, BicycleRollingResistance, Cyclist). · **Confidence: moderate** — these are largely manufacturer/media tests, not peer-reviewed, and highly setup-specific.

## 6. Training-intensity distribution — **REFINES prior #1 (level-dependent)**
New syntheses keep undermining any "polarized is king" dogma and add an athlete-level nuance. A 2025 scoping review concluded that 
in athletes from trained to world-class, POL and PYR models were generally more effective than threshold and block training, while in trained and developmental athletes all TID models can be effective.
 A 2025 meta-analysis reportedly found 
among elite endurance athletes the polarised approach appears marginally more effective than the pyramidal model, while in recreational athletes the relationship reverses.

- **Proposed prior:** Keep "both work; protect easy-easy/hard-hard separation; don't dogmatise." **Add:** TID should scale to level — at sub-elite/recreational level almost any well-applied distribution drives adaptation, so prioritise consistency and adherence over chasing a specific split.
- **Source:** Rivera-Köfler et al. 2025, *J Strength Cond Res* 39(3):373–385; Rosenblatt et al. 2025 (meta-analysis, via expert summary). · **Confidence: moderate–high** (direction is consistent; effect sizes small and the elite/recreational reversal is one finding).

---

**Reviewer notes (weigh personally):** (a) The 120 g/h ceiling is a *population* evidence cap, not a target — your own gut tolerance and the AIE ranges still govern; don't read "200 g/h in the Tour" as a prescription. (b) Gear items #4–#5 lean on manufacturer/media testing and are strongly setup- and surface-specific — exactly the kind of n=1 call to test yourself (run-in shoes, real pressures on your roads) before trusting a headline watt/percent. (c) The TID elite-vs-recreational reversal comes partly from a meta-analysis I could only confirm via a secondary summary — treat the *direction* as solid, the magnitude as soft. None of these override your own response data or the AI Endurance model; they're updated priors, not rules.

## Approved research update — 2026-08-19

# Research digest — 2026-08-19 (PROPOSED — review before applying)

_Drafted by the monthly research flow with web search. Nothing here is active until you approve it
(`npm run knowledge -- approve <file>`), at which point it's folded into the priors and the coach
uses it. Treat as a starting point — verify sources, and remember your own data outranks the textbook._
I'll run searches across the topic areas before drafting.
# Knowledge refresh — proposal (drafted 2026-08-19)

*Review-only. Nothing active until approved. Priors yield to this athlete's n=1 data and the AI Endurance model.*

## 1. Heat adaptation — **CHANGE to the "Heat" season-structure prior**
Passive heat exposure now has a plausible *performance* (not just heat-tolerance) mechanism: a 2025 *Journal of Physiology* study in endurance runners reports long-term passive heat acclimation raising VO₂max via haematological and cardiac adaptation. **Proposed prior:** keep "don't prescribe acclimation by default for mild UK races," but stop treating heat work as *only* hot-race prep — a low-cost passive block (post-session sauna/hot bath) is a defensible optional adaptation stimulus in a build, provided it never displaces a session or compromises hydration and sleep. **Apply:** optional, additive, never mandatory; drop it the moment it dents next-day readiness.
- **Source:** Jenkins et al. 2025, *J Physiol* — https://doi.org/10.1113/JP289874 · **Confidence: moderate** (single study, small n, mechanism-led).

## 2. Heat + substrate use — **NEW (supporting note to #1)**
Four weeks of heat acclimation lowered carbohydrate oxidation in trained runners during submaximal exercise in the heat. **Proposed prior:** heat adaptation shifts substrate use as well as thermoregulation — relevant only if a race day is genuinely hot; it does **not** justify training low or trimming fuelling. **Apply:** if a heat block happens, fuelling targets stay unchanged.
- **Source:** *Front Physiol* 2025;16:1581594 — https://doi.org/10.3389/fphys.2025.1581594 · **Confidence: moderate.**

## 3. Cold-water immersion — **NEW (recovery)**
A 2026 network meta-analysis compares CWI protocols across resistance, endurance and team-sport contexts, reinforcing that the *dose* (temperature × duration) and the *timing relative to adaptation goals* decide whether CWI helps; a 2025 network meta-analysis addresses dose specifically for exercise-induced muscle damage. **Proposed prior:** CWI is a short-term *feel-better/repeat-performance* tool, not an adaptation tool — reasonable in a race block or between same-day efforts, best avoided in the hours after key strength or adaptation-focused sessions. **Apply:** use around racing/congested days; keep it away from strength work in a build.
- **Source:** *BMC Sports Sci Med Rehabil* 2026 — https://doi.org/10.1186/s13102-026-01653-5; *Front Physiol* 2025;16:1525726 — https://doi.org/10.3389/fphys.2025.1525726 · **Confidence: moderate** (I could verify scope, not effect sizes — see reviewer notes).

## 4. TT/tri position aerodynamics — **NEW (gear)**
CFD work on individual time-trial positions found the lowest drag came from raising the hands/arms while narrowing the elbows, worth an ~11% drag-area reduction in the modelled case, and — importantly — that reducing frontal area did **not** automatically reduce drag; roughly half of rider drag came from the legs. **Proposed prior:** position beats kit for free speed on the bike leg, but frontal area is a poor proxy for drag — changes must be measured, and any aero gain is worthless if it costs sustainable power or run legs. **Apply:** test position changes (field/CdA or repeatable course), rehearse in long rides before racing in it.
- **Source:** *Sports Engineering* 2025 — https://doi.org/10.1007/s12283-025-00495-7 · **Confidence: moderate** (CFD, elite-rider models, no power-output trade-off measured).

## 5. Tapering — **CONFIRMS prior #6, no new evidence this window**
Nothing stronger than the existing meta-analytic base surfaced in the last 12 months. **Proposed prior:** unchanged — ~2 weeks pre-A-race, cut volume ~40–60%, hold intensity and frequency; shorter for a marathon than long-course tri; no full taper for a capped-tempo B-race.
- **Source:** Wang et al. 2023, *PLOS One* 18(3):e0282838 — https://doi.org/10.1371/journal.pone.0282838 · **Confidence: high** (and stable — this one probably doesn't need re-checking monthly).

## 6. HRV-guided gating — **CONFIRMS prior #2, flagged as a stale evidence base**
Still nothing newer than the 2021 meta-analyses; the 2025–26 material is vendor and practitioner content, not new synthesis. **Proposed prior:** unchanged — modest, mainly protective; gate intensity by *trend* vs personal baseline, never a single reading. **Apply:** treat platform readiness scores as directional; the AI Endurance recovery model plus HRV trend leads.
- **Source:** Manresa-Rocamora et al. 2021 systematic review with meta-analysis — https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8507742/ · **Confidence: high for the prior, low that the literature has moved.**

## 7. Sleep as the primary recovery lever — **NEW (recovery, low weight)**
A 2025 multidimensional review restates sleep's physiological and molecular role in performance and recovery. **Proposed prior:** sleep duration/regularity is the highest-yield recovery intervention available and outranks any recovery gadget or supplement; a poor night is *information* for the readiness call, not a reason to write the day off. **Apply:** when readiness is amber, check sleep and load before reaching for interventions.
- **Source:** *J Clin Med* 2025;14(21):7606 — https://www.mdpi.com/2077-0383/14/21/7606 · **Confidence: low–moderate** (narrative review, no new effect estimates — treat as framing, not evidence).

---

**Reviewer notes (weigh personally):** Search coverage this cycle was **partial** — the fuelling (120 g/h ceiling), durability, strength, footwear, tyre and TID priors were last examined in the June 2026 digest and were *not* re-verified here, so treat them as carried forward rather than freshly confirmed. Items 3 and 7 I could confirm by scope and title but not by effect size, so the direction is usable and the magnitude is soft; item 4 is CFD on elite-rider geometry, which says nothing about *your* CdA or what a position costs you off the bike. Item 1 is a single small study with an appealing mechanism — exactly the profile that tends not to replicate, so if you try passive heat, treat it as an experiment judged on your own HRV/sleep/session quality, and drop it if those slide. Nothing here changes fuelling: heat adaptation lowering carbohydrate oxidation is a physiological observation, not a licence to fuel less.
