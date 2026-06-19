# The n=1 insight engine & engagement loop

The deterministic statistical layer behind the coach — and the feedback loop that learns what you pay
attention to. This is the detail moved out of the [README](../README.md#the-insight-engine-n1-analytics)
so the front page stays short; nothing here needs an LLM call, and every detector self-gates until there's
enough of your own history behind it. Surfaced in `deep-dive`, `ask`, the dashboard **Signals** panel, and
the MCP `insights` tool.

## n=1 analytics layer (data-scientist brief Q1–Q7)

The insight engine answers a set of pre-registered analytical questions (Q1–Q7) with HONEST uncertainty —
autocorrelation-aware, effect-sizes-with-CIs, and every MODEL caveat attached.

- **Rigorous correlations (Q1):** lagged cross-correlation (predictor at *t−k* → outcome at *t*) with a
  Fisher-z 95% CI computed on the *effective* sample size (discounted for serial dependence). Nothing is
  called real unless its CI clears 0 — the brief's #1 guardrail against naive-Pearson nonsense.
- **Validated monitoring rule set (Q1, Deliverable #3):** candidate HRV/RHR threshold rules selected on
  the earlier ~60% of your history and scored on the **held-out** later ~40%, with a circular-shift
  **permutation null** — a rule is only reported as skilful if it beats chance out-of-sample (else it's
  labelled exploratory). Runs against the **backfilled Garmin series** with **sleep score** as an
  outcome *independent* of the HRV/RHR predictors (falling back to the AIE recovery series, relabelled as
  concordance, when that history isn't there yet).
- **Change-point detection (§5):** dates genuine regime shifts in CTL, HRV and RHR (binary segmentation,
  L2 cost) so inflections can be tied to a training/illness/kit change, not smoothed away.
- **Brick decoupling (Q4):** run efficiency off the bike vs fresh — the triathlon-specific signal.
- **Taper target (Q6):** the race-day form (TSB) band that accompanied your best past races.
- **Economy vs fitness (Q5):** run EF residualised on CTL — separates real economy gains from "just fitness".
- **Fuelling red flag (Q7):** fires when weight *and* skeletal-muscle-mass trend down together (an
  under-fuelling stop-signal). A rapid weight drop on its own is separately flagged by the wellbeing
  guardrail, even without muscle-mass data.
- **Stream-level (.FIT) analysis (§1)** — two layers, two sources:
  - **Thermal / effort** (per-activity temperature for the heat confounder, hot/cool-third HR, training
    effect) comes from `fit-sync`, which pulls Garmin's *parsed summary* (`get_activity_fit_data`). This
    now runs **automatically as part of dashboard Sync** (small, dedup'd) — and daily if you install the
    watch. No manual step.
  - **In-session biomechanics** (aerobic decoupling, cadence/GCT/vertical-osc decay) needs **raw
    per-second `.FIT` files** in `FIT_STREAMS_DIR` (default `data/fit-streams/`); the dependency-free
    parser decodes them in-process. These now **auto-download during the dashboard Sync, the MCP `sync`
    tool and `fit-sync`** (and on demand when you ask for deep session feedback) via
    `download_activity_file`. On older builds, or for activities outside the sync window, export the
    original `.FIT` from Garmin Connect (Activity → ⚙ → *Export Original*) into that folder. See
    `.env.example`. **When a recent session's stream is missing, that's surfaced as an explicit
    data-completeness gap** on `sync` / `get_state` / `npm run state` (with the reason: Garmin off / not
    reachable / capability absent / a download that failed) — a missing stream is never a silent zero.
  - **Per-interval splits + swim CSS** — the same `.FIT` parser now decodes **lap (msg 19)** and
    **length (msg 101)** records, so the `splits` tool (`npm run splits`) returns per-rep / per-length
    splits for a session, and for a **swim test** computes **Critical Swim Speed** by the 400/200 method
    (`CSS/100m = (T400 − T200)/2`) with a **maximal-effort confidence check** (it flags submaximal HR or
    pacing so a soft test can't masquerade as a firm CSS). You can also pass the two times directly
    (`--t400 / --t200`) with no `.FIT`. It's read-only — it recommends the number; you set CSS in AI
    Endurance. (The AI Endurance `*ActivityDetail` endpoint would be an alternative source, but it's
    **blocked upstream** — the activity list exposes no `activity_id` to call it; see the Insight Engine
    Spec — so Garmin's `.FIT` laps/lengths are the route to per-interval structure.)

Every finding carries a **confidence score**; only good-signal findings are surfaced, and the most
important also feed a multiple-comparisons guard: the exploratory correlation scan is **FDR-controlled**
(Benjamini–Hochberg, q=0.1), so a relationship is "confirmed" only if its CI clears 0 *and* it survives
FDR — otherwise it's labelled exploratory.

## Top insights box — like, dislike, snooze (and how old each signal is)

The **Top insights** card lists the five strongest findings ranked by signal strength, each with
**👍 Like / 👎 Dislike / 💤 Snooze**. It sits *after* the daily-loop cards (last session, this week, week
ahead) — the single most important call has already been synthesised into the **Today** header (verdict +
one action), so the box is the supporting detail, not a second copy of it. The finding the header leads on
is still shown here (so you can react to it) but is marked **"today's call ↑"** and **omits its
recommendation line** — the action lives once, in the Today card. Findings already shown here are likewise
not repeated in **Set up & improve → This week**, so a given recommendation appears in exactly one place.

- **Like / Dislike is a saved, visible opinion** — your choice is rendered back on every reload (the button
  shows as active), and it's **reversible**: click it again to clear, or click the other to switch. Both are
  logged to the decision log (append-only, latest-wins), so changing your mind just records a newer choice.
- **Dislike does _not_ hide the insight** — it stays on the card (marked, and **down-ranked** via the
  engagement loop), because you asked to keep seeing it and be able to change your mind. Liking lifts its
  family; disliking sinks it.
- **Snooze is the hide action** — it removes the insight for ~2 weeks and tells the coach
  (readiness/weekly/ask) to stop raising it. After the cool-off it can resurface (and if it keeps coming
  back, that becomes a *"recurring signal you've set aside"* finding).
- **Freshness is explicit** — each insight shows a **NEW** badge (and the header a *"N new"* count) when it
  first appeared in the last ~24h, plus a **"first seen <date> · Nd"** age line so you can tell a brand-new
  signal from a long-standing one. Age is floored at "since logging began" (the insight-history log starts
  when this shipped), and it's labelled that way rather than implying something is new when we just weren't
  watching yet.

Feedback posts to the server's `/insight-feedback` endpoint — credentials never leave the Mac.

## What you listen to — your engagement model

Every time the engine surfaces findings (the dashboard card, the MCP `insights` tool) it appends the
**full surfaced set** to `data/insights/log.jsonl` — not just the ones you react to — so there's a complete
record of *what you were shown* alongside *what you acted on*. The log is de-duplicated (an unchanged
surface isn't re-written on every page load) and gitignored like all personal data.

`npm run listening` (or the MCP `listening` tool) joins that history to your decision log and prints — and
saves as a dated report — your engagement model:
- **which insight families you act on vs wave away** (a 👍/👎/✕ breakdown per family), your overall reaction
  rate, and gated-proposal accept/decline counts;
- **plan adherence** — done vs planned hours overall and per zone, with a "is it slipping?" trend. This
  **defers to AI Endurance's own `getPlanProgress`** (the platform's authoritative planned-vs-done
  reconciliation) and trends its numbers rather than re-deriving a competing match;
- **plan changes** — sessions **added / moved / dropped**, detected by diffing your daily `plannedSessions`
  snapshots (guarded so a workout that simply passed isn't mistaken for a deletion; approximate, and
  workouts without a stable id are skipped). This is something the platform doesn't expose, so it's
  computed here;
- what's **currently snoozed** inside the cool-off, and the honest one — **findings you snoozed that the
  engine surfaced again afterwards** ("dismissed, but came back").

It's deterministic (no LLM, no cost) and **descriptive, not causal**: it tracks engagement, adherence and
recurrence and labels the form numbers a MODEL; it does not claim a finding you ignored *caused* a later
result. Note plan edits you make **directly in AI Endurance** are caught by the snapshot diff; there is no
separate edit feed — the daily snapshots are the record.

## Closing the loop — engagement feeds back into your insights

The engagement model isn't just a mirror; it **feeds back into what the engine surfaces**, on the
dashboard, `insights` and `deep-dive`:

- **Ranking follows your attention.** Families you consistently dismiss are gently **down-ranked** and the
  ones you act on are **lifted** — but this is **safety-preserving**: severity always wins (a `flag` can
  never be buried under a family you like) and flags are never down-weighted. It only reorders *within* a
  severity tier. This counts your reactions **everywhere**, not just the Top-insights box: a 👍/👎 (or ✓ Done
  / 🚫 Ignore) on a **"This week" card** is attributed to its finding family too — the card carries its
  family on the reaction record, since its `setup:*` key never enters the surfaced-insight log. (Before, those
  card reactions were recorded but silently excluded from the weights.)
- **The proposer gets conservative when you decline.** Your gated plan-proposal **accept/decline** history
  feeds the proposal drafter: once you've declined a majority of recent proposals, it's told to propose only
  a change it's highly confident clears the bar — smallest viable edit, or nothing — instead of re-pitching
  edits you keep waving off. (Surfacing of deterministic findings is untouched; this only shapes the LLM
  plan-edit drafter.)
- **The prose flows skip what you wave off.** The weekly review and research digest get an *engagement
  steer* — the families you consistently set aside — so they stop re-pitching them and spend their picks on
  what you act on. (Prompt-level only; it never gates the deterministic engine.)
- **Retrospectives — did it hold up?** Record an outcome note on any insight with `retrospect` (MCP) — it's
  logged against the key **without changing your reaction**, then `listening` joins it back into an
  *"Outcomes you recorded"* section (insight → your reaction → how it worked out) and `decisions` shows it.
  This is what makes "advice → what I did → outcome" answerable later.
- **The LLM write-ups are reactable, not just prose.** The readiness verdict, the deep-dive, and free-form
  `ask` each emit a short, **family-tagged list of recommendations** alongside their prose. Each becomes a
  keyed, info-severity finding logged to the insight history (surfaces `readiness` / `deep-dive` / `ask`), so
  it shows as an individually reactable card on the dashboard's **Coach's recommendations** card (and is
  reactable by key via `react_to_insight` / `retrospect`). Because each carries a family, a 👍/👎/🚫 on a
  coaching suggestion feeds the same family weights as any finding — the prose flows now both *give* advice
  and *learn* from your response. (`ask` returns the answer + its recommendations in one structured call, so
  a purely informational question adds no cost and surfaces no recs.)
- **New "Follow-through" findings.** Two insights are now **generated from your own behaviour**: a
  *recurring signal you've set aside* (something you snoozed that the engine keeps re-raising — surfaced
  only after it recurs ≥2×) and *plan adherence is slipping* (you're doing <70% of planned hours, or it
  dropped ≥15 points). Both are ordinary findings with 👍/👎/💤 buttons, so you can like, dislike or snooze
  them too.

Still no causal claim and still no LLM — it's a transparent, bounded re-weighting plus two honest,
behaviour-derived findings. The whole loop degrades silently: if the history can't be read, surfacing
falls back to exactly what it was before.

---

The forward-looking deeper-mining direction lives in
[`specs/Insight_Engine_Spec.md`](specs/Insight_Engine_Spec.md).
