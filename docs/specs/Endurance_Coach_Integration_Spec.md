# Endurance Coach — Data Integration & Interface Spec (v2)

**Athlete:** single user. **Targets:** Birmingham Triathlon (A, 11 Jul 2026) → run-focused block → Loch Ness Marathon (B, 27 Sep 2026); Alderford (B, 6 Sep 2026).
**Goal:** read the plan from AI Endurance and real-world device data from Garmin, reconcile *planned vs actual*, surface daily readiness, weekly review, plan adjustments, race prep.

> **v2 change of stance:** AI Endurance is the spine; Garmin is an *optional, degradable* add-on, not a co-equal dependency. AI Endurance already ingests Garmin and exposes a recovery model, so the marginal value of a separate Garmin client is narrow — weigh it against the cost of a brittle dependency before building it.

---

## 1. Architecture at a glance

```
AI Endurance MCP (remote, OAuth)  ──►  Claude (coach layer)  ──►  Coach interface
   plan of record + ML model            · interpret + reconcile     (Today / Week / Race)
                                         · readiness logic
Garmin (optional, via garmin_mcp) ┄┄►    · confirm-before-write
   fills 5 specific gaps only            (degrades cleanly if absent)
```

Solid line = required. Dotted = optional. The system must be fully useful on AI Endurance alone.

---

## 2. Data sources

### 2.1 AI Endurance — required spine (remote MCP, OAuth)
- `https://aiendurance.com/mcp` · Streamable HTTP / SSE · OAuth 2.0 (`read`,`write`) · MCP 2025-06-18. Add via Claude.ai → Connectors → custom connector.
- 20 tools. Read routinely: `getUser`, `getAvailability`, `getPlannedWorkouts`, `get{Cycling,Running,Swimming}Activity[Detail]`, `getRaceGoalEvent`, `getPrediction`, `getRecoveryModel` (cardio recovery, DFA α1, rMSSD, RHR trend, orthopedic recovery), `getPlanProgress`, `getNutritionModel` (fuelling ranges).
- Write (gate behind confirmation): `changeWorkoutDate`, `skipWorkout`, `changeWorkoutAdvice`, `create{RideRun,Swim,StrengthOther}Workout`, `setZones`.
- **Vendor dependency (real risk):** paid third party; the API evolves (its changelog already shows a removed tool). The system must tolerate a tool changing or disappearing, and must not hard-code assumptions a single tool's shape won't change.

### 2.2 Garmin — optional gap-filler (local MCP)
Connect this **only** for what AI Endurance doesn't expose:
1. Sleep (duration/stages/score) · 2. Body Battery · 3. Garmin Training Readiness · 4. VO₂max / Training Status · 5. weight **trend** from the Index scale.
- No official Garmin MCP. Use `python-garminconnect` + `garmin_mcp` (alt: `claude-garmin`). Local, logs in with your credentials, handles MFA.
- **Treat as fragile.** Garmin actively breaks unofficial clients; expect periodic auth failures and library updates. Because it's optional, a Garmin outage must degrade gracefully, never block the coach.
- **Body composition is mostly noise.** Day-to-day bioimpedance fat/muscle figures are unreliable. Pull **weight trend only**; ignore daily body-comp readouts.

---

## 3. Source-of-truth matrix

| Domain | Authoritative source | Notes |
|---|---|---|
| Planned workouts / structure | **AI Endurance** | it *is* the plan |
| Load model (fitness/fatigue/form) | **AI Endurance** | drives the plan |
| Race predictions | **AI Endurance** | ML model |
| Adherence by zone | **AI Endurance** | `getPlanProgress` |
| Recovery model (DFA α1, rMSSD) | **AI Endurance** | modelled, plan-aware |
| Completed-activity ground truth | **AI Endurance** (Garmin cross-check) | AIE already ingests Garmin; only reach to Garmin to resolve a discrepancy |
| Sleep | Garmin (if connected) | not in AIE |
| Body Battery / Training Readiness | Garmin (**tiebreak only**) | proprietary black boxes — directional, not gospel |
| VO₂max / Training Status | Garmin (if connected) | device estimate |
| Weight **trend** | Garmin Index (if connected) | trend only, secondary, never a daily target |

**Readiness rule (changed in v2):** drive the daily call on **interpretable** signals — HRV vs personal baseline, sleep, resting HR, recent load, AIE recovery model. Use Body Battery / Garmin Training Readiness as a *tiebreak* when the interpretable signals are ambiguous, not as primary inputs.

**Reconciliation:** trend beats single point. If an activity is in one source but not the other, flag a sync gap rather than acting on half a picture. If Garmin is stale/down, say so and proceed on AIE.

---

## 4. Coaching data contract
- **Daily readiness:** AIE recovery model + (if present) Garmin sleep/HRV/RHR → green/amber/red + one–two line why.
- **Weekly review:** `getPlannedWorkouts` + `getPlanProgress` + activities → load by sport, standouts, recovery + weight trend, next-week focus.
- **Plan adjustment:** read state → propose + trade-off → **on confirmation** call the write tool.
- **Race prep:** `getRaceGoalEvent` + `getPrediction`; sharpen by event and time-to-race. (Marathon block fuelling via `getNutritionModel` as adequate-fuelling ranges.)

---

## 5. Interface
**Default — Claude Project (recommended).** Connect AI Endurance to a Project, load the coach persona; the interface is conversational with on-demand panels. This gets you everything useful with no build. See the build spec for when a custom app is actually warranted.

**Later — local dashboard (only if you want glanceable/scheduled views):** Today (readiness + session), Week (planned vs actual by sport, adherence), Trends (CTL/ATL/TSB, HRV, weight trend), Race (countdown, predicted vs goal). Coaching prose still comes from Claude.

---

## 6. Risks & caveats
- **Garmin auth fragility** → optional by design; degrade cleanly, never guess silently.
- **Vendor dependency on AI Endurance** → tolerate API/tool changes; don't over-couple.
- **Black-box readiness scores** → tiebreak only.
- **Token cost** → default summary/low-resolution; escalate only for a specific session deep-dive.
- **Privacy** → Garmin creds local/encrypted, out of prompts/logs; AIE via revocable OAuth.

---

## 7. Open inputs
Birmingham distance (sprint/standard/middle); Alderford format; athlete baselines (mostly from `getUser`/`getAvailability`, ask for the rest).
