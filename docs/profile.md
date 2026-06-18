# The athlete profile

The coach reads two kinds of thing about you:

- **Live numbers** — FTP, weight, paces, swim CSS, HRV, training load — pulled **live** from AI
  Endurance and Garmin every sync. These change constantly and the platforms own them.
- **Stable context** — body and biomechanics, kit, medical notes, availability, fuelling, your own
  race targets. No training API holds this. It lives in the **athlete profile**.

This page documents the profile: the two-file model, the schema, the `get_profile` tool, the computed
`dose_cycle`, and the hard rule that **live numbers never live in the profile**.

## Two-file privacy split

| File | Committed? | What it is |
|---|---|---|
| `profile.example.yaml` | **yes** | the blank template with explanatory comments — what new users copy |
| `profile.local.yaml` | **no** (gitignored) | your real data; loaded in preference to the example |

The loader resolves `COACH_PROFILE_PATH` (if set) → `profile.local.yaml` → `profile.example.yaml`, so a
fresh clone still works (it just reads the blank template). The file is YAML-parsed and validated
against the schema on load; an invalid profile **fails loudly** with a clear message (the `get_profile`
tool surfaces it), while the ambient coaching-context injection degrades silently if the profile is
absent or invalid (never blocks a flow).

`profile.local.yaml` and `profile.local.*` are in `.gitignore`. As with all personal data here, it
never goes in git.

## Setup

```bash
cd /Users/maxeskell/personal-training-app && npm run profile:init     # copy template + walk required fields
```

`npm run setup` also offers this step. The intake copies `profile.example.yaml` to
`profile.local.yaml` and prompts for the **required** fields, validating as it goes:

- `identity.name`, `identity.sex`, `identity.date_of_birth`, `identity.units`, `identity.timezone`
- `availability.weekly_hours`
- at least one race in `races` (with a name + date)

Everything else is optional — open `profile.local.yaml` and fill in biomechanics, equipment, fuelling
and medical context by hand.

## The schema (stable context only)

Top-level blocks (all optional except `schema_version` and `identity`):

`identity` · `biomechanics` · `health` (incl. `medication`) · `availability` · `equipment` ·
`bike_fit` · `fuelling` · `races` · `ai_endurance_todo` · `open_items`.

Validation is strict on the **contract** — enum domains (`sex`, `units`, race `priority`/`distance`,
weekday names), `YYYY-MM-DD` dates, `schema_version` — and **permissive** on the free-form blocks
(`biomechanics`, `equipment`, `bike_fit`, `fuelling`), so a richly-detailed real profile isn't
rejected. The blank example and a fully-filled profile both validate. See `src/profile/schema.ts`.

### No live numbers — enforced

A guard walks the whole profile on load and **throws** if a live-performance key holds a live number.
It matches the key's underscore/camelCase **segments** (not raw substrings), covering `ftp`, `css`,
`vo2(max)`, `hrv`, `hr`/`rhr`/`resting_hr`/`max_hr`/`lthr`, `pace`, `threshold`, `weight`/`weight_kg`,
`ctl`/`atl`/`tsb`/`tss`, `w_per_kg`, `training_load` and `load_ratio`. A value trips it when it's a
number **or a purely-numeric string** (`"223"`), so a live number can't sneak in as text — but genuine
status strings stay fine (`ftp_w: unresolved`, `swim_css: not_set`), which is exactly the
`ai_endurance_todo` block and why those values must be set **in AI Endurance**, not here.
Equipment/fit/fuelling numbers are untouched — segment matching means `crank_length_mm`,
`saddle_height_mm`, `carb_target_g_per_hour`, `lightweight_wheels` and a kit `weight_g` all pass; a
stray `ftp_w: 223` (or `threshold_w: 240`) anywhere does not.

## `get_profile` (MCP) and `dose_cycle`

`get_profile` returns the validated profile plus a computed `dose_cycle`. It's deterministic
(no LLM cost) and read-only, so it's available even on the read-only Cowork surface.

`dose_cycle` is derived on read from today's date + `health.medication.dose_day` + `gi_trough_days`:

```json
{ "dose_day": "sunday", "days_since_dose": 4, "in_gi_trough": true, "gi_trough_days": ["tuesday","wednesday","thursday"] }
```

- `days_since_dose` — whole days since the most recent dose weekday (0 on dose day).
- `in_gi_trough` — whether today's weekday falls in the configured GI-trough window.

It's `null` when no `medication.dose_day` is set. This lets the coach keep the hardest and longest
sessions off the GI-trough days and stay alert to under-fuelling — **the medication's drug, dose and
timing are the prescriber's call; the coach works *around* it.** The same context (medication,
biomechanics, availability, fuelling, race targets) is injected into the app's own coaching flows
(readiness, weekly, race, ask) when a profile is present. That injection is **in-memory only** —
`StateStore.save` strips the profile before writing, so the medical/personal data never lands in
`data/state/*.json` regardless of when a flow saves.

## What this app cannot do

This connector is **read-only to AI Endurance**. It cannot set your **swim CSS, FTP or race target
times** there — set those directly in the AI Endurance app. The `ai_endurance_todo` block is a
reminder of what's unset, not a write path.

## The coaching brief is separate

The default coaching behaviour ships as a **prompt**, not data:
[`coach-instructions.md`](../coach-instructions.md) at the repo root (the app falls back to
[`docs/specs/AI_Triathlon_Coach_Project_Instructions.md`](specs/AI_Triathlon_Coach_Project_Instructions.md)
if it's absent). Keep it separate from your profile — edit the brief to change *how* the coach behaves,
edit the profile to change *what it knows about you*.
