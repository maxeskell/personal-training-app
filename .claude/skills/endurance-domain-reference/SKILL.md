---
name: endurance-domain-reference
description: >-
  The endurance-physiology knowledge pack for this repo — load it whenever you meet an endurance
  metric, term, or threshold and need to know what it MEANS, HOW it is computed here, and WHAT VALUES
  are normal. Triggers: CTL / ATL / TSB (fitness / fatigue / form / "training stress balance"), ESS /
  TSS ("external stress score"), EF / efficiency factor, aerobic decoupling / durability / DFA-α1 /
  "alpha1", FTP / functional threshold power, CSS / critical swim speed / "400/200 test", threshold
  pace, LTHR, zones / Z1-Z6 / TID / "time in zone" / "intensity distribution" / polarized / pyramidal,
  HRV / rMSSD / RHR / resting heart rate, monotony / strain / Foster, taper / peaking / periodisation /
  "two stacked peaks" / A-race / B-race, carb fuelling / "g/h" / glucose:fructose / gut training,
  dose-cycle / GLP-1 / days_since_dose / in_gi_trough / gi_trough, wellbeing / RED-S / under-fuelling /
  "race weight", W/kg, VO2max, ACWR. Also load it when interpreting a `readiness` / `weekly` /
  `deep_dive` / `splits` / insight-engine output, when a finding says "exploratory" vs "confirmed",
  or when working in `insights/` or `coach/` and needing the physiology behind the code. Don't load it
  for the STATISTICAL METHODS that prove a signal (Fisher-z CI, FDR, permutation nulls) — that is
  endurance-coach-proof-and-analysis-toolkit; don't load it for the code INVARIANTS / data flow — that
  is endurance-coach-architecture-contract.
---

# Endurance domain reference

**Use this when** you hit an endurance term or metric (CTL, EF, decoupling, CSS, TID, taper, dose-cycle,
carb g/h…) and need its plain meaning, where the repo computes it, the normal ranges this repo uses, and
the honest caveats — or when you are reading/writing `insights/` or `coach/` code and need the physiology.

**Don't use this when** you need the *statistical machinery* that proves an n=1 signal is real
(effective-N, Fisher-z CIs, Benjamini–Hochberg FDR, walk-forward, permutation nulls) — that lives in
`endurance-coach-proof-and-analysis-toolkit`; or the *code contracts* (Provenanced fields, the write
gate, data flow) — that lives in `endurance-coach-architecture-contract`; or the *go/no-go campaign* to
validate a detector — `endurance-coach-n1-validation-campaign`.

---

## Two domain doctrines that override everything below

These are not opinions. They are hard rules the codebase and coach persona are built on.

> **1. Priors, not laws — this athlete's n=1 data outranks the textbook.** Everything in
> `knowledge/sports-science.md` is a *population* prior (small samples, modest effects, big individual
> variation). Individual training response is roughly 50% heritable with 20–45% non-responders, so no
> a-priori dose-response model is trustworthy for one person. Where a prior disagrees with THIS athlete's
> own pulled data, **the prior yields.** See `knowledge/sports-science.md` header.

> **2. Defer to AI Endurance's model — never re-derive the load science, never overrule the platform.**
> The app *consumes* AI Endurance's (AIE's) FTP / CSS / thresholds / durability (DFA-α1) / predictions /
> recovery over MCP. It does **not** rebuild the calibrated dose-response model AIE owns, and it never runs
> a competing hard-coded ruleset against AIE's ML output. The sports science here is for *interpreting and
> sanity-checking* what AIE says, not overruling it without this athlete's own n=1 evidence. (Source:
> `coach-instructions.md`; treated as a hard rule — see `endurance-coach-change-control`.)

Jargon: **n=1** = a sample size of one athlete — the entire statistical problem here is drawing trustworthy
conclusions from a single person's noisy, self-correlated data.

---

## Glossary (term → definition → computed-in → caveat)

Every duration below shows as **h:mm**; a missing value renders **"—"**, never 0. All estimates are
labelled **MODEL/estimate** with assumptions stated — match that when you surface them.

| Term | Plain definition (zero-context) | Computed in (verify §Provenance) | Normal / repo thresholds | Caveat |
|---|---|---|---|---|
| **ESS** (External Stress Score) | AIE's per-session training-load number, ≈ a TSS-equivalent. Higher = more stressful session. | AIE feed (`external_stress_score`); mapped in `insights/metrics.ts:mapRichActivity` | Session-dependent; the raw input to the load model | It is **AIE's** number — consume, don't recompute. |
| **TSS** (Training Stress Score) | The classic TrainingPeaks load unit ESS stands in for. | — (AIE supplies ESS instead) | — | Used loosely as the mental model for ESS. |
| **CTL** (Chronic Training Load) = **fitness** | Slow 42-day exponential average of daily ESS. Rises with sustained training. | `insights/metrics.ts:loadModel` | ramp >7/wk fires "ramping fast" (comfort ~5–7) | A MODEL, not measured fitness. |
| **ATL** (Acute Training Load) = **fatigue** | Fast 7-day exponential average of daily ESS. Spikes after hard days. | `insights/metrics.ts:loadModel` | — | A MODEL. |
| **TSB** (Training Stress Balance) = **form** | CTL − ATL. Positive = fresh/tapered; negative = loaded. | `insights/metrics.ts:loadModel` | TSB < −25 fires "deep fatigue" | Not a performance guarantee; personalise via n=1 taper band. |
| **EF** (Efficiency Factor) | Aerobic economy proxy = average power ÷ average HR (or pace÷HR). Higher = more output per heartbeat. | `insights/metrics.ts:efTrend`; stream-level in `insights/fit.ts` | Only computed on steady sessions **≥ 40 min** (`movingSec ≥ 2400`) | Confounded by fitness, heat, drift — see economy caveat below. |
| **Aerobic decoupling** | How much EF fades from the first half to the second half of a long effort: `(EF_1st − EF_2nd) / EF_1st`, %. A durability/fade signal. | `insights/fit.ts:halfDecoupling` (per-second .FIT); brick proxy in `insights/brick.ts` | Flags at **> 5%** on efforts **≥ 60 min**; < 5% = strong aerobic base | > 5% can be fatigue, **heat**, or under-fuelling, not just poor durability. |
| **Durability** (DFA-α1) | AIE's aerobic-resilience %: how well thresholds hold late into a session, from heart-rate-variability fractal analysis (DFA-α1). | AIE feed; trended in `insights/metrics.ts:durabilityTrend` | Trend, not absolute | **Consume AIE's number, don't recompute.** Drop readings with high HRV artifact (see below). |
| **FTP** (Functional Threshold Power) | ~1-hour max sustainable cycling power (W). The bike anchor for zones. | AIE `thresholds` (live); **never** in profile | Athlete-specific | A live number — comes live from AIE, never cached/committed. |
| **CSS** (Critical Swim Speed) | Threshold swim pace, sec/100m, from a maximal 400 m + 200 m test: `(T400 − T200) / 2`. | `insights/sessionSplits.ts:computeCss` | Valid only if 400 pace/100m is slower than 200 pace/100m | READ-ONLY: the tool computes/recommends; **you set CSS in AIE yourself.** |
| **Threshold pace / LTHR** | Run threshold pace (sec/km) and lactate-threshold heart rate — the run anchors for zones. | AIE `thresholds` (live) | Athlete-specific | Live numbers, not cached. |
| **Zones / Z1–Z6** | Intensity bands derived from a threshold marker: power (%FTP), HR (%LTHR), pace (×threshold pace), swim (×CSS). | `insights/zones.ts:deriveZones` | See zone tables below | Derived bands are **Coggan models**, flagged `source:"derived"`; explicit AIE zones win. Run-power bands are indicative only. |
| **TID** (Time-in-zone / Intensity Distribution) | The easy/tempo/hard split of training time. | `insights/metrics.ts:intensityDistribution` | "easy" < 75% fires a grey-zone-creep watch; ~80% easy is the target | ~60–90% easy is the prior; **polarized is not proven superior to pyramidal** — don't dogmatise. |
| **HRV** (Heart-Rate Variability) | Overnight beat-to-beat variation (rMSSD), a recovery signal. Higher-vs-your-baseline = recovered. | AIE/Garmin feed; baseline in `state/baselines.ts` (7d mean); anomaly in `insights/correlations.ts` | Gate hard work on the **trend**, not one reading. Suppressed = < 85% of baseline (wellbeing) or z < −2 (anomaly) | Noisy; a single low night means little. |
| **RHR** (Resting Heart Rate) | Morning resting pulse. A rise vs baseline can precede illness/fatigue. | AIE/Garmin feed; baseline in `state/baselines.ts`; anomaly in `insights/correlations.ts` | Elevated = > baseline + 5 bpm (wellbeing) or z > 2 (anomaly) | Trend beats point. |
| **Monotony / Strain** (Foster) | Monotony = weekly mean load ÷ its SD (samey-ness); Strain = weekly load × monotony. High = illness/overtraining risk. | `insights/metrics.ts:monotonyStrain` | Monotony **> 2** fires a watch | Make easy days easier, hard days harder. |
| **Taper** | Cutting volume ~40–60% for ~2 weeks pre-A-race while holding intensity, to shed fatigue and raise form. | Descriptive n=1 band in `insights/taper.ts` | Personalised TSB band from past race days (descriptive) | We have **no actual finish times** in the feed — the band is descriptive, not "which TSB raced best". |
| **Periodisation** | Structuring the year: one build per peak; never two stacked peaks; cap B-races as tempo; watch the run-off-tri injury window. | Priors in `knowledge/sports-science.md` §7 + season-structure | See periodisation section | Priors applied to the **live** calendar (`getRaceGoalEvent`), never a fixed one. |
| **Carb fuelling (g/h)** | Carbohydrate intake per hour on long sessions. Under-fuelling hurts health and durability. | Priors in `knowledge/sports-science.md` §4; profile `carb_ceiling_g_per_hour` | ~90 g/h baseline; up to ~120 g/h gut-trained; glucose:fructose ~1:0.8 | **Never under-fuel.** The plan never exceeds the athlete's gut-trained ceiling. |
| **Dose-cycle** (GLP-1) | A weekly medication cycle: `days_since_dose`, `in_gi_trough`. Appetite suppression + training volume = under-fuelling risk. | `profile/schema.ts:computeDoseCycle` (from `dose_day` + `gi_trough_days`) | Computed per calendar day | The **prescriber owns the drug**; the coach works *around* it — schedules big fuelling-dependent sessions away from trough days. |
| **W/kg** | Power-to-weight ratio. A performance metric, but weight is a long-term trend only. | — (derived when shown) | — | Chasing W/kg via weight loss is **blocked** by the wellbeing gate. |
| **ACWR** (Acute:Chronic Workload Ratio) | Acute vs chronic load ratio; > ~1.5 is the most evidence-backed overreach/injury flag. | Garmin path `insights/garminHealth.ts` | > ~1.5 = flag | Demoted in favour of the run-load ramp guard for run injury. |

---

## The load model math (Banister / Coggan impulse-response)

`insights/metrics.ts:loadModel`. CTL, ATL, TSB are **exponentially-weighted moving averages of daily ESS**,
using the impulse-response decay constant, NOT the technical-analysis EMA factor:

```
k = 1 − e^(−1/τ)          # impulse-response decay — what TrainingPeaks/AIE use
CTL_k = 1 − e^(−1/42) ≈ 0.0227      (τ = 42 days, chronic → "fitness")
ATL_k = 1 − e^(−1/7)  ≈ 0.1308      (τ = 7 days,  acute   → "fatigue")
CTL_today = ESS_today·k + CTL_yesterday·(1−k)      # same recurrence for ATL
TSB = CTL − ATL                                     # "form"
```

Why not the `2/(τ+1)` EMA factor? That form halves the effective time constant — a "42-day" CTL would
react like ~21 days — inflating TSB swings and the weekly ramp, and diverging from the numbers an athlete
cross-checks in AIE/TrainingPeaks. (Full derivation lives in `endurance-coach-proof-and-analysis-toolkit`.)

Guards worth knowing: needs **≥ 14 days** of data or returns `null`; seeds CTL/ATL from the **mean of the
first ≤7 days** (not day 0 alone, which would bias early form toward one atypical session);
`rampPerWeek` = ΔCTL over the last 7 days.

---

## Zone bands (derived — Coggan models, flagged `source:"derived"`)

`insights/zones.ts`. Explicit zones from AIE (`getUser`) always override these; run-power bands are
indicative (Coggan cycling model reused; Stryd run-power differs).

| Discipline | Basis | Edges (× threshold) | Labels |
|---|---|---|---|
| Power (bike & run) | % FTP | 0, .55, .75, .90, 1.05, 1.20, 1.50 | Z1 Recovery · Z2 Endurance · Z3 Tempo · Z4 Threshold · Z5 VO2 · Z6 Anaerobic |
| Heart rate | % LTHR (Coggan) | 0, .81, .90, .94, 1.00, 1.06 | Z1 Recovery · Z2 Endurance · Z3 Tempo · Z4 Threshold · Z5 VO2 |
| Run pace | × threshold pace (higher sec = slower = easier) | .90, .97, 1.03, 1.10, 1.20, 1.45 | Z5 VO2 · Z4 Threshold · Z3 Tempo · Z2 Endurance · Z1 Easy |
| Swim | × CSS pace | .90, .97, 1.03, 1.12, 1.30 | Fast · Threshold · Tempo · Easy |

Bike HR falls back to run LTHR when bike LTHR is unset (bike LTHR usually a few bpm lower → dashboard flags
the fallback, treat zone tops conservatively).

---

## Decoupling & EF validity windows (don't read these outside their window)

- **EF** (`efTrend`) is only computed on steady-aerobic sessions **≥ 40 min** (`movingSec ≥ 2400`) with
  both power and HR present. Below that, EF is noise — don't trend it.
- **Within-session decoupling** (`fit.ts:halfDecoupling`) needs a per-second `.FIT` stream and ≥ 30 valid
  power/HR pairs per half; the finding only fires on efforts **≥ 60 min** and **> 5%**. Above ~5% points to
  fatigue / heat / under-fuelling. It uses power if available, else speed.
- **Brick decoupling** (`insights/brick.ts`) is an HONEST same-day proxy, not true off-the-bike decoupling:
  a "brick day" = a Run + a Ride logged on the same date (run assumed off the bike); it compares run EF on
  brick days vs fresh-run days. True T1/T2 timing and within-leg decoupling need stream data the summary
  feed lacks. Confidence is capped and the proxy caveat is stated — label it as such.
- **Swim decoupling/pace** ignores rests/floats: an open-water rep cruises ~0.6–0.8 m/s, rests drop below
  ~0.1 m/s, so a **0.3 m/s** floor (`SWIM_ACTIVE_MIN_SPEED_MS`) gates the drift maths so a long float
  doesn't read as a giant late "cadence drop".

**Economy caveat (EF ~ CTL + time).** `insights/efficiency.ts` residualises EF on BOTH fitness (CTL) and
time via a two-predictor regression, and only CLAIMS an economy gain when the time coefficient's 95% CI
excludes 0 — and even then labels it **"apparent"**, because CTL and time are collinear and EF here is
**not heat-adjusted** (a hot training block can masquerade as an economy loss). The regression internals
(`mlr2`, Frisch–Waugh–Lovell) live in `endurance-coach-proof-and-analysis-toolkit`.

---

## CSS from a 400/200 test

`insights/sessionSplits.ts:computeCss`. CSS pace per 100 m = **(T400 − T200) / 2** (both times in
seconds). Validity guard: a genuine maximal pair has the 400 **slower per 100 m** than the 200
(`T400 > 2·T200`); when it isn't, at least one effort wasn't maximal and the result is flagged unreliable
rather than invented. `--t400`/`--t200` (or the `splits` MCP tool's `t400`/`t200`) compute it with no
`.FIT` at all. READ-ONLY: set the resulting CSS in AIE yourself.

---

## Periodisation priors (apply to the LIVE calendar, never a fixed one)

Races come live from `getRaceGoalEvent`; the app derives a SEASON SHAPE block from these priors
(`knowledge/sports-science.md`):

- **A lower-priority race a few weeks before a higher-priority one = capped tempo, not a race.** Racing it
  hard that close compromises the A-race's taper/prep → default hard-capped tempo / drop intensity.
- **A run goal built off a triathlon base = an injury window.** Swim/bike volume spares the legs, so
  running-specific orthopedic load has been low; ramping run volume concentrates that load fast → cap
  weekly run-volume increases, watch niggles early (monitor `getRecoveryModel.orthopedic.run`). The code
  backstop is the run-load ramp guard (`insights/metrics.ts:runLoadRamp`), which flags a big week-on-week
  jump vs a trailing baseline.
- **Don't stack two peaks.** One build per peak; if two A-races sit close, peak for one and carry fitness.
- **Heat:** UK summer is usually mild — only consider heat prep if the forecast shows a genuine heatwave
  near race day. Don't prescribe acclimation by default.
- **Taper:** ~2 weeks pre-A-race cut volume ~40–60%, hold intensity + frequency. A marathon takes a
  shorter taper than a long-course tri. A capped-tempo B-race gets **no full taper**.

Jargon: **A-race** = the season's key goal race; **B-race** = a lower-priority race used as training/prep;
**build** = a block of progressively rising load before a peak.

---

## Fuelling & the dose-cycle

**Carb fuelling** (`knowledge/sports-science.md` §4): ~90 g/h baseline on long sessions; up to ~120 g/h for
gut-trained athletes (glucose:fructose ~1:0.8); higher availability may aid durability/economy. Progressive
gut training into race fuelling; rehearse in long sessions; **never under-fuel.** The athlete's gut-trained
ceiling is `preferences.carb_ceiling_g_per_hour` in the profile (e.g. 90) — the plan never exceeds it.

**Dose-cycle (GLP-1 medication).** `profile/schema.ts:computeDoseCycle` derives, per calendar day, from the
profile's `health.medication.dose_day` (+ optional `gi_trough_days`):

- `days_since_dose` = whole days since the most recent dose weekday (0 on dose day),
- `in_gi_trough` = whether today's weekday is a configured GI-trough day.

The coach reasons *around* this: it keeps the hardest/longest, most fuelling-dependent sessions clear of
the days the dose hits hardest, and watches for under-fuelling (appetite suppression + training volume).
**The prescriber owns the drug; the coach never advises on the medication itself.** Returns `null` when no
`dose_day` is set. The GLP-1 field is user-authored profile data — its template + guidance live in
`profile.example.yaml` (see `endurance-coach-config-and-flags` for profile fields).

---

## Wellbeing is a HARD gate, not a prior (never route around it)

`guardrails/wellbeing.ts` is deterministic code, not LLM judgement. Two jobs, and NO domain reasoning may
bypass them (see `endurance-coach-change-control`):

1. **`screenNutritionPrompt()`** — a pre-LLM screen that BLOCKS three prompt classes before the model sees
   them: (a) acute medical symptoms → stop & refer; (b) disordered-eating cues → non-judgmental support
   referral; (c) restriction / "race weight" framing → redirect to adequate fuelling. Each returns a
   category-appropriate `redirect` the caller surfaces instead of forwarding the prompt.
2. **`assessHealthRisk()`** — a post-assembly **co-occurrence** check (never a diagnosis, no RED-S label,
   never treats weight loss as a win). Signals, over a trailing window:

   | Signal | Threshold |
   |---|---|
   | Rapid/unexplained weight loss | trend down **> 2%** over the window |
   | Suppressed HRV | today **< 85%** of 7-day baseline (`hrv < hrvBase*0.85`) |
   | Poor sleep | window average **< 6.5 h** |
   | Rising RHR | today **> baseline + 5 bpm** |

   3+ co-occurring → **raise** (gentle referral); 2 → **watch**; a **rapid weight drop alone** → watch on
   its own (never gated behind a second signal — "a weight drop is a health signal, not a win"). Defence in
   depth: the `CLINICAL_BOUNDARY` clause in `coach/persona.ts` is in every system prompt.

Domain rule: **weight is a long-term trend, secondary, never a daily target.** Body composition is the one
place a "loss" can be a health flag — `insights/fuelling.ts` only flags when weight AND bioimpedance muscle
mass fall *together* over ≥3 weeks (BIA muscle is noisy → a "worth a look" nudge, not a measurement claim).

---

## "Confirmed" vs "exploratory" — the domain reader's shorthand

When an insight/finding is labelled **exploratory** it means the signal did **not** clear the statistical
acceptance bar (e.g. a correlation whose CI spans 0, or one that didn't survive FDR; a monitoring rule
without enough data for walk-forward). **Confirmed** means it did. Do not read an exploratory finding as
established. The bar itself — effective-N, Fisher-z CIs, FDR (Benjamini–Hochberg q=0.1) before which the
lag scan is Bonferroni-inflated, walk-forward + permutation nulls — is NOT this skill's job:

- The **methods/derivations** → `endurance-coach-proof-and-analysis-toolkit`.
- The **go/no-go campaign** to validate a detector → `endurance-coach-n1-validation-campaign`.
- The **acceptance/evidence bar** as a QA gate → `endurance-coach-validation-and-qa`.
- The **code invariants** (Provenanced fields, degrade-don't-crash, the write gate) →
  `endurance-coach-architecture-contract`.

Anomaly quick reference (`insights/correlations.ts`): fires only with ≥ 14 points, using a population-SD
z-score of the most recent value vs the series — **RHR z > 2** (illness early-warning) or **HRV z < −2**
(possible non-functional overreaching).

---

## Provenance and maintenance

Date-stamped **2026-07-04**, branch `main`. Verify from the repo root
`cd /Users/maxeskell/dev/personal-training-app` before quoting any number — the repo is ground truth, not
this file.

Re-verification commands (run the exact one when a fact may have drifted):

```bash
# Load-model decay constants τ=42/7 and the ≥14-day / 7-day-seed guards:
grep -n "exp(-1 / 42)\|exp(-1 / 7)\|< 14\|slice(0, Math.min(7" src/insights/metrics.ts

# EF ≥40-min window, decoupling >5% / ≥60-min, swim active-speed floor:
grep -n "2400\|> 5\|>= 60\|SWIM_ACTIVE_MIN_SPEED_MS" src/insights/fit.ts src/insights/metrics.ts

# Zone edges (Coggan power/HR/pace/swim):
grep -n "POWER_EDGES\|HR_EDGES\|PACE_EDGES\|SWIM_EDGES" src/insights/zones.ts

# CSS formula (T400−T200)/2 + maximal-pair guard:
grep -n "t400Sec - t200Sec) / 2\|t400Sec <= 2 \* t200Sec" src/insights/sessionSplits.ts

# Dose-cycle derivation (days_since_dose / in_gi_trough):
grep -n "days_since_dose\|in_gi_trough" src/profile/schema.ts

# Wellbeing thresholds (>2% weight, 0.85 HRV, 6.5h sleep, +5 bpm RHR):
grep -n "0.02\|\* 0.85\|< 6.5\|+ 5" src/guardrails/wellbeing.ts

# Anomaly z-thresholds (>2 / <-2) and ≥14 points:
grep -n "zsc > 2\|zsc < -2\|v.length < 14" src/insights/correlations.ts

# TID easy<75 / TSB<-25 / ramp>7 / monotony>2 finding thresholds:
grep -n "easyPct < 75\|tsb < -25\|rampPerWeek > 7\|monotony > 2" src/insights/engine.ts

# LLM model id:
grep -n "readonly model" src/llm/client.ts

# Sports-science priors (carb g/h, taper %, TID, periodisation) + last-verified date:
grep -n "Last verified\|g/h\|40–60\|two stacked" knowledge/sports-science.md
```

Volatile facts to re-check: `knowledge/sports-science.md` carries its own `Last verified:` marker (2026-06-18
at time of writing; `npm run knowledge` flags it stale after ~35 days). The LLM model id (`claude-opus-4-8`)
and any AIE field names can change with a platform update. If a `grep` above returns nothing, the code moved
— treat this skill's citation as stale and re-locate the fact before trusting it.
