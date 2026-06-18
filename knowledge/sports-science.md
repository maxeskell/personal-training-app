# Sports-science priors — living knowledge layer

> Last verified: 2026-06-18

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
