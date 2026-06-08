# Insight Engine — Spec for the next layer (v1)

> **What this is.** Path B (M1–M6) delivers the *daily operating system*: readiness, weekly review,
> gated plan-adjust, race prep, scheduling, dashboard, decision log. It answers **"what do I do today,
> and why."** This layer answers a different question: **"what is my data telling me over weeks and
> months that I'd never spot myself — the trends, the brewing problems, the things a sharp coach would
> pull out?"** It is a *diagnosis and insight* layer, not another daily flow.
>
> Same stance as the rest of the system: **priors, not laws; my data outranks the textbook (n=1);
> defer to AI Endurance's model where it already computes something; propose, never auto-change;
> cite the data; trend over single point; no clinical claims; fuel to train.**

---

## 1. The gap this fills

A good coach looking at the same Garmin + AI Endurance data would routinely notice things the current
system doesn't compute:

- *"Your efficiency factor on the bike has climbed 6% over 8 weeks at the same heart rate — the aerobic
  work is paying off."*
- *"Your long-run aerobic decoupling is still 9% — your base isn't where it needs to be for a marathon;
  we hold easy volume before adding marathon-pace work."*
- *"Run training load jumped 40% week-on-week — that's exactly the spike that precedes injury, and
  you're in the marathon-off-tri window. Cap it."*
- *"You're drifting into the grey zone — 35% of your run time is tempo, not the 10–15% that works.
  Easy needs to be easier."*
- *"Your predicted Birmingham time has stalled for three weeks and sits 4 min above target — here's
  what's not moving."*
- *"Every time you sleep under 6.5h, your next-day session quality drops — for you specifically."*

None of these are daily calls. They're **pattern reads over a window**, and they're where a coach earns
their keep. This layer computes them.

---

## 2. Prioritised insight catalogue (what a pro coach mines)

Each insight is computed **deterministically in code** from the data, then **interpreted by the LLM**.
Organised by family; the ⭐ shortlist is the highest-value subset to build first.

### A. Aerobic efficiency & durability — *the signature coach metrics*
- ⭐ **Efficiency Factor (EF)** = normalised power (bike, or run power) ÷ average HR; pace÷HR for runs
  without power. Tracked per discipline over time. Rising EF at equal HR = aerobic engine improving.
- ⭐ **Aerobic decoupling (Pw:HR / Pa:HR)** — in long steady sessions, the % rise in HR-cost from first
  half to second half. <5% = strong aerobic base; >5% = base still building (Friel/Coggan). Trend it.
- **Durability / fatigue resistance** — decay of best 5-min power (or threshold pace) in the final
  quartile of long sessions, and after accumulated kJ/load. The modern differentiator (Maunder 2021,
  Jones 2024). Central to both the Olympic-tri and the marathon.
- **Cardiac drift** within sessions (HR rise at constant output).

### B. Training load, ramp & injury risk — *the safety net*
- ⭐ **CTL / ATL / TSB** (fitness / fatigue / form) from a daily load series. **Defer to AI Endurance if
  it exposes these; otherwise compute from per-activity External Stress Score (ESS) as a TSS proxy**
  (CTL = ~42-day EWMA, ATL = ~7-day, TSB = CTL−ATL). Track form trajectory into each race.
- ⭐ **Run-specific Acute:Chronic Workload Ratio (ACWR)** = 7-day run load ÷ 28-day run load. >1.3–1.5 =
  spike = injury risk. **This is the single most valuable detector for the marathon-off-tri injury
  window** the whole project flagged. Plus a hard weekly run-volume-jump cap.
- **Ramp rate** (ΔCTL/week) — >5–7/wk flags overreaching.
- **Training monotony & strain** (Foster) — daily-load mean ÷ SD across a week; high monotony precedes
  illness/overtraining.

### C. Intensity distribution (TID)
- ⭐ **Actual time-in-zone vs target** per discipline; detect **grey-zone creep** (too much tempo, not
  enough genuinely-easy or genuinely-hard). Protects easy-easy/hard-hard separation.
- **Easy-day discipline** — are easy sessions actually below aerobic threshold (HR/power)?

### D. Autonomic & recovery
- **HRV trend** (rMSSD 7d/28d) and **HRV coefficient of variation** — a falling CV/stable baseline =
  good adaptation; a suppressed-HRV cluster = pre-illness / non-functional overreaching (flag, don't
  diagnose).
- **RHR trend**, **sleep debt** (rolling sleep vs need), **recovery-score trajectory**.

### E. Consistency & periodisation fit
- **Planned-vs-completed** rate over time, longest streak, gap clustering.
- **Sport-balance vs phase** — swim/bike/run hours vs the periodisation plan (e.g. is swim/bike being
  *maintained not built* in Aug–Sep as intended?).

### F. Performance & goal tracking
- **Power/pace curve (MMP / peak-pace) evolution** across durations (5s/1min/5min/20min/60min) — shows
  *where* fitness is moving (sprint vs threshold vs endurance).
- **Threshold trend** (FTP / CSS / threshold pace) over time.
- ⭐ **Prediction-vs-goal** — AI Endurance's predicted race time vs target, trajectory, and confidence,
  with weeks-to-race. "On track for sub-X?" — and if not, which metric is the blocker.
- **Pacing discipline** — negative-split adherence in key sessions and races.

### G. Anomaly & n=1 correlation
- **Outliers** — HR/output mismatch, unexplained RHR spikes, missed-session clusters, weight-trend
  anomalies (hand off to the existing wellbeing guardrail).
- **n=1 responder analysis** — *for this athlete*, which inputs predict good sessions (e.g. does sleep
  <6.5h reliably precede a quality drop?), and which training stimulus moves fitness most.
- **Environmental** — pace/HR vs temperature, if available.

---

## 3. Data sources & what each insight needs (grounded in the verified API)

| Insight family | Primary data | Notes / gaps to confirm |
|---|---|---|
| EF, decoupling, durability, cardiac drift, MMP curve | `get{Cycling,Running,Swimming}ActivityDetail` time-series + best efforts | Token-heavy: pull at **low/medium** resolution, compute locally. Athlete **has run power** (`getUser.do_use_running_power`) → run EF via power, not just pace. |
| CTL/ATL/TSB, ramp, monotony, ACWR | Per-activity **ESS** from activity lists (date-ranged) | **Open: does AIE expose a load time series directly?** If yes, defer to it. If no, compute from ESS — **confirm ESS is TSS-equivalent / how it's normalised.** |
| TID, easy-day discipline | `getPlanProgress` (zone adherence) + activity detail zone distributions + `getUser` zones | Adherence already mapped in M2. |
| HRV/RHR/recovery trends | `getRecoveryModel` (rMSSD, RHR, orthopedic) + Garmin HRV/sleep | DFA α1 raw is **null** for this athlete → rely on EF/decoupling/HR, not α1-threshold. |
| Prediction-vs-goal | `getPrediction` + `getRaceGoalEvent` | Already pulled in M2/M4. Use confidence intervals + historical actual-vs-predicted. |
| Consistency, sport-balance | activity lists + `getPlannedWorkouts` history | Planned *history* is thin — may need to accumulate our own state over time. |

**History depth (open question):** activity lists return up to 40 recent **or a date range**. Backfill =
date-ranged list → activityIds → `*ActivityDetail` per id. Confirm how far back the date-range list
goes and the practical rate/token cost of bulk detail pulls.

---

## 4. Architecture (Layer N, on top of Path B)

```
                 ┌─────────────────────────────────────────────────────────────┐
 AIE detail +    │  Metrics library (deterministic, pure, unit-tested)          │
 activity lists ─┤   EF · decoupling · durability · ACWR · CTL/ATL/TSB · TID ·  │
 recovery model  │   HRV/RHR trends · MMP curve · monotony                      │
 Garmin history  └───────────────┬─────────────────────────────────────────────┘
                                  ▼
                 ┌────────────────────────────────┐    once: backfill 90–180d
                 │  Metrics store (data/metrics/)  │◄── then: incremental daily
                 │  derived time-series, provenance│
                 └───────────────┬────────────────┘
                                 ▼
                 ┌────────────────────────────────┐   each emits Findings:
                 │  Detectors (per insight family) │   {family, metric, value, trend,
                 │  loop-until-dry coverage        │    severity, evidence[], rec, confidence}
                 └───────────────┬────────────────┘
                                 ▼
                 ┌────────────────────────────────┐   LLM interprets Findings (NOT raw series);
                 │  Synthesis (cached persona+      │   prioritised coach narrative + deep-dive report
                 │  priors system prompt)          │   → findings can spawn GATED plan-adjust proposals
                 └────────────────────────────────┘
```

**Key engineering principles:**
1. **Compute locally, interpret with the LLM.** Activity-detail time-series are huge (full resolution
   18–125k tokens). The metrics library reduces a session to a handful of numbers; only those
   **Findings** (tiny) ever reach the model. This satisfies the §6 cost NFR and keeps the math correct
   and testable.
2. **Defer to AI Endurance's model.** If AIE exposes load/fitness/form or efficiency, consume it — only
   compute what the platform doesn't surface. Don't run a competing load model that can disagree with it.
3. **A Finding is the unit.** Severity `info | watch | flag`; every Finding carries its evidence + source
   tags and a trend (direction + magnitude over a stated window), never a bare single value.
4. **Insights propose, never apply.** A `flag`-severity Finding can generate a **gated** plan-adjust
   proposal through the existing `WriteGate` (propose → confirm). No autonomous plan changes.
5. **n=1 is the authority.** Correlations and responder analysis use *this athlete's* history; priors
   only set the starting hypothesis.

**New surfaces:**
- `npm run deep-dive` → dated markdown report (the prioritised insight narrative).
- A **"Signals"** panel on the dashboard (top flags + key metric sparklines).
- Optional weekly auto-run (reuse the launchd scheduler), feeding the weekly review.
- `npm run insights pending` → flags that haven't been actioned.

---

## 5. Guardrails (carried forward — non-negotiable)

- **No clinical claims.** "Suppressed-HRV cluster + rising RHR" → *flag and suggest easing / a check-in*,
  never "overtraining syndrome" or "RED-S." Re-uses the existing wellbeing co-occurrence logic.
- **Fuel to train; weight is a trend, never a target.** Performance-decay or low-energy findings route to
  adequate-fuelling language and, if risk signals co-occur, a gentle professional referral.
- **Write-gate.** Findings may *propose*; only an explicit `confirm` writes to the plan.
- **Cost discipline.** Backfill once, increment daily; low/medium detail resolution; cache; only Findings
  to the LLM. Log what was sampled vs skipped (no silent truncation).
- **Cite data + trend, not point.** Minimum-data thresholds before a Finding is allowed to fire
  (e.g. ≥3 long sessions before a decoupling trend; ≥28 days before ACWR).

---

## 6. Acceptance criteria

1. Computes **EF, aerobic decoupling, run-specific ACWR, CTL/ATL/TSB (or defers to AIE), and TID** from
   real data — each as a **trend over a window** with cited evidence and source tags.
2. **Flags the run-load ramp for the marathon window specifically** (ACWR > threshold or weekly-jump cap
   breached → `flag` + a gated proposal to cap it).
3. **Prediction-vs-goal** read with weeks-to-race and the blocking metric named.
4. Distinguishes **signal from noise** — honours minimum-data thresholds; never fires on a single point;
   uses n=1 history.
5. A `flag` can create a **gated** plan-adjust proposal; nothing changes without `confirm`.
6. Every Finding **cites its data + source**; **no clinical labels**; weight handled as trend only.
7. **Token cost bounded** — metrics computed locally; only Findings reach the LLM; sampling logged.

---

## 7. Milestones

- **N1 — Metrics library + backfill.** Pure functions (EF, decoupling, durability, ACWR, CTL/ATL/TSB,
  TID, HRV/RHR trends, MMP curve) with **unit tests on known inputs**; history backfill + incremental
  metrics store. *Resolve the open data questions first (§3).*
- **N2 — Detectors + Findings.** One detector per family; severity + evidence; loop-until-dry coverage.
  **Build the run-load injury detector first** — highest value, directly serves the goal-race risk.
- **N3 — Synthesis + surfaces.** `deep-dive` report, dashboard "Signals" panel, weekly auto-run,
  findings → gated proposals.
- **N4 — Anomaly + n=1 correlation.** Responder analysis, outlier detection, environmental.

**Non-goals:** medical diagnosis; replacing AI Endurance's model; auto-changing the plan; multi-user.

---

## 8. Open questions to resolve before N1 (be honest about these)

1. **Does AI Endurance expose a load/fitness/form time series** (CTL/ATL/TSB or equivalent) via any tool,
   or only per-activity ESS? Determines whether we *consume* or *compute* load.
2. **ESS semantics** — is it TSS-equivalent and how normalised? Needed for a valid CTL/ATL model.
3. **Activity-detail history depth & cost** — how far back can we enumerate activityIds, and what's the
   real token/rate cost of backfilling detail for ~150 days? Sets the backfill strategy and resolution.
4. **Garmin HRV/sleep history depth & rate limits** for trend windows.
5. **Run-power consistency** — is run power present on enough sessions to use for run EF, or do we fall
   back to pace:HR?

A short spike against the live API answers all five and turns this spec into an N1 build plan.
