# Path A — Claude Project setup (no code)

> This is the **first** thing to do, per the Build Spec §1 decision gate. It delivers ~80% of the
> value with zero code to maintain. Live with it, validate the four flows, *then* build Path B.

## Step 1 — Create the Claude Project
1. Go to **claude.ai → Projects → New Project**.
2. Name it e.g. **"Endurance Coach"**.

## Step 2 — Connect the AI Endurance MCP (required spine)
1. claude.ai → **Settings → Connectors → Add custom connector**.
2. URL: `https://aiendurance.com/mcp` (Streamable HTTP / SSE, MCP 2025-06-18).
3. Authorise via **OAuth 2.0** — grant `read` and `write` scopes.
4. Confirm the ~20 tools appear (e.g. `getUser`, `getPlannedWorkouts`, `getRecoveryModel`,
   `getPrediction`, `getPlanProgress`, `getNutritionModel`, plus the write tools).

## Step 3 — Load the coach persona
1. Open the Project → **Project instructions / custom instructions**.
2. Paste the full contents of [`specs/AI_Triathlon_Coach_Project_Instructions.md`](specs/AI_Triathlon_Coach_Project_Instructions.md).
3. Fill in the athlete block where it isn't auto-pullable (see Open inputs below).

## Step 4 — (Optional) Garmin MCP for the 5 gap metrics
Only if you want: sleep, Body Battery, Garmin Training Readiness, VO₂max/Training Status, weight trend.
- Use `python-garminconnect` + `garmin_mcp` (alt: `claude-garmin`). Local, your creds, handles MFA.
- **Treat as fragile and optional** — if it's down, the coach must degrade cleanly and proceed on
  AI Endurance alone. Pull **weight trend only**; ignore daily body-comp noise.

## Step 5 — Validate the four flows conversationally
- **Daily readiness** — "How am I today?" → green/amber/red + 1–2 line why, on a *trend*, not one bad night.
- **Weekly review** (Sun/Mon) — planned vs actual, load by sport, adherence, next-week focus. Leads with the takeaway.
- **Plan adjustment** — it proposes + trade-off; a write tool only fires on your explicit confirmation.
- **Race prep** — sharpens by event and time-to-race; **surfaces the Alderford decision and run-load caution.**

If these four work well for you, **you may be done** — no app needed. If scheduling / dashboard /
decision-log gaps bite (they do, per your answer), proceed to Path B (`docs/path-b-plan.md`).

---

## Open inputs (Build Spec §11)
- **Birmingham distance:** ✅ **Olympic / standard** (1.5 km swim · 40 km bike · 10 km run).
- **Alderford format:** ✅ **Olympic-distance triathlon** (not an open-water swim).
- **Athlete baselines:** _still needed_ — mostly from `getUser` / `getAvailability` once AIE is connected;
  ask for the rest (bike FTP W/kg, swim CSS, run threshold pace, recent race times, injury/niggle
  history, max hrs/week).

## Race calendar
- **A — Birmingham Triathlon (Olympic) — 11 Jul 2026** (priority; peak here).
- **B — Alderford Triathlon (Olympic) — 6 Sep 2026** → **DECISION (resolved):** it's a triathlon
  3 weeks before the goal marathon, so racing it hard compromises marathon taper/prep. Default:
  **hard-capped tempo effort / drop the intensity — don't race it.** (Build Spec §6.)
- **B — Loch Ness Marathon (road) — 27 Sep 2026** (run-focused block off the tri base).

**Shape:** one tri build to July → deliberate run block to the marathon. Maintain (don't build) swim/bike Aug–Sep. One peak, not two.
