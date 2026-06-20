# Fuelling Spec — per-session guidance + learning loop

Source of truth for the fuelling feature: capture the athlete's own nutrition, give **per-session
pre/during/after guidance**, and **improve it over time** from logged outcomes. Display-first and
local-first; no AI Endurance write path is involved (the inventory is stable athlete context, the log is
a local file).

## Governing rule

**Only surface what's needed.** A short/easy session returns `needed:false` ("water's fine"); a pre,
during or after section appears *only* when a threshold is crossed. The feature earns its place by staying
quiet. Everything estimated is labelled a **MODEL** with its assumptions, consistent with the rest of the
app (zones/splits/predictions). It is fuelling guidance, **not medical advice**, and never strays into
restriction/weight-loss territory (the wellbeing screen guards the one LLM surface).

## Data model

### Inventory — `profile.local.yaml → fuelling.products[]`
Stable context, so it lives in the gitignored profile (not a live AI Endurance/Garmin field). Parsed
permissively (`src/coach/fuelInventory.ts`) — a malformed entry is skipped, never throws; nothing is
invented. Per-serving fields; field names are chosen to pass the profile's no-live-numbers guard
(`carbs_g`, `sodium_mg`, `caffeine_mg`, `protein_g`, `fluid_ml` — none are live-metric key segments).

| field | meaning |
|---|---|
| `name` (req) | product name |
| `brand` | brand |
| `category` | `drink_mix \| gel \| chew \| bar \| real_food \| electrolyte \| recovery \| nitrate \| caffeine \| supplement` — inferred from the name when omitted |
| `serving` | human label, e.g. "1 bar (120 g)" |
| `carbs_g` / `sodium_mg` / `caffeine_mg` / `protein_g` / `fluid_ml` | per serving |
| `timing` | any of `[pre, during, after, daily]` — inferred from category when omitted |
| `notes` | free text |

### Preferences (learned) — `fuelling.preferences`
- `carb_ceiling_g_per_hour` — the gut-trained per-hour cap; the plan never exceeds it.
- `caffeine_cutoff_hour` — local hour after which caffeine is avoided (steers to caffeine-free tabs).

### Feedback log — `data/fuel-log.jsonl` (gitignored)
Append-only JSONL, same discipline as the cost/decision/session-feedback logs (`src/coach/fuelLogStore.ts`).
One record per tap: `{ date, sport, outcome: good|rough|bonked|skipped, carbTargetGPerHour?, planned?, note?, loggedAt }`.
Best-effort writes; a torn line is skipped on read; collapses to the latest outcome per `(date,sport)`.

## The deterministic engine (`src/coach/fuelPlan.ts`) — NO LLM

`planFuel(input) → FuelPlan` is pure and runs at render time (dashboard-card discipline). Inputs: sport,
duration, title (→ intensity), `isKey`, bodyweight (live, for per-kg amounts), forecast `tempC`, start
hour, the inventory and prefs.

- **Intensity** inferred from the title: `hard` (interval/tempo/threshold/race/…), `easy`
  (easy/recovery/Z1–2/…), else `endurance`.
- **Carb/hr target** (`carbTargetGPerHour`), capped by the learned ceiling:
  - `< 75 min` and not hard → **0** (water's fine)
  - `75–150 min` → ~**45** g/h (endurance) / ~**60** g/h (hard)
  - `> 150 min` or a key effort ≥90 min → ~**75** g/h
- **During** appears when carbs are needed, or fluid/sodium matters (≥60 min, or ≥45 min in heat). Picks a
  product combo to hit the carb total (`chooseCarbCombo`), suggests ~500–750 ml/hr (more in heat), and an
  electrolyte tab — **caffeine-free** when the session is past the caffeine cutoff.
- **Pre** appears for a key, long (endurance ≥90 min) or hard (≥75 min) session: a carb top-up (~1–2 g/kg)
  1–3 h before, **nitrate** ~2–3 h before for key endurance (if owned), and **caffeine** ~45–60 min before
  a quality effort (skipped if it's past the cutoff).
- **After** appears for a key/long (≥90 min)/hard session: protein (~0.3 g/kg) in the 30–60 min window,
  plus carbs after a depleting session (it's honest that a protein-led recovery product needs carbs added).
- **Honest about gaps:** with no carb product the plan still gives the g/h target and says real food covers
  it (the athlete's current stack has no during-carb drink-mix/gels).

`buildWeekFuelPlans(sessions, ctx)` maps the upcoming plan (`upcomingPlanned`) → `FuelPlan[]` (skips
Strength). Heat comes from the weather card's per-day `tempMaxC`; key dates from A-priority race goals.

## Surfaces

- **Dashboard card** (`src/coach/fuelCard.ts`, "Fuelling — next session") — shows ONLY the soonest
  upcoming session (the user doesn't want the whole week here): pre/during/after as one tight line each,
  or a single "water's fine" line, with a one-tap 👍/👎 (`/fuel-feedback`). Secondary content — the
  **daily-stack** reference (consistency, not timing; honest evidence note), the model assumptions, and the
  **"Review my fuelling"** button (`/fuel-review`) — sits behind a "More" disclosure to keep the card short.
  Escaped; `data-*` handlers; hidden controls in share view. No LLM on render. (`npm run fuelling` / the
  `fuelling` MCP tool print the whole week.)
- **MCP / on-demand** — `fuelling` (deterministic plan), `log_fuel` (record an outcome), `fuel_review`
  (the learning pass). Same engine as the card.

## The learning loop (`src/coach/fuelReview.ts`) — ONE LLM call

`runFuelReview` is the only LLM surface (medium effort, cost-logged). It computes deterministic stats
first (`summariseFuelLog` — observed best-tolerated and gone-badly carb/hr) so the model phrases real
numbers, **wellbeing-screens every free-text note** before it's included, and frames everything as fuelling
*adequately*. It needs ≥3 logged sessions or it returns a deterministic "log a few more" message (no spend).
Output: what's working, a carb/hr nudge, per-sport patterns, caffeine/timing, and a **suggested
`fuelling.preferences` block** for the athlete to apply (not auto-written — gated-writes mindset).

## Tests
`test/fuelInventory.test.ts`, `test/fuelPlan.test.ts`, `test/fuelLogStore.test.ts`, `test/fuelCard.test.ts`
— parsing/selection, the threshold + quiet-path behaviour, the JSONL round-trip + tolerance roll-up, and
the card's escaping + script-safety.
