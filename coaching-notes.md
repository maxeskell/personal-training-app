# Coaching notes — to-dos & decisions (NOT a data store)

> **This file is deliberately not a data cache.** Athlete data is *pulled live at question time*, never
> stored here — stored numbers go stale, and the repo's whole posture is "live numbers come live":
> - **Stable context** (body, kit, fuelling inventory + GI notes, race targets) lives in
>   `profile.local.yaml`, served by the `get_profile` MCP tool.
> - **Live numbers** (FTP, CSS, weight, HRV, load, the plan, the race calendar) come from AI Endurance /
>   Garmin via the MCP server (`npm run mcp`).
>
> What lives *here* is only what has no live source and doesn't go stale: **open questions / to-dos** and
> **decisions we've agreed**. It's committed so it travels with the repo — including a web checkout, where
> the MCP and the gitignored profile aren't reachable.

## To do
- [ ] **Sweat-rate test** — gives a real ml/h + sodium figure so fuelling/hydration advice isn't a
      population MODEL. Protocol: weigh yourself (minimal/no clothing, towel-dry) before a ~60 min steady
      session; record fluid drunk during it; weigh again after. Sweat loss (L) ≈ (pre-kg − post-kg) +
      fluid drunk (L); rate = that ÷ session hours. Repeat once cooler / once warmer if you can. Note
      shirt salt-staining / sweat taste for a rough sodium read (a patch test is the accurate version).
      The field now exists — put the result in `profile.local.yaml → fuelling.preferences.sweat_rate_ml_per_hour`
      (and `sweat_sodium_mg_per_l` if known); the fuelling plan then uses your number instead of the MODEL.

## Decisions / things we've talked through
- **2026-06-23 — 70.3 Outlaw fuelling.** Agreed the framework (coaching guidance, not athlete data):
  ~70–90 g/h, bias the bike and ease on the run, multi-transportable carb above ~60 g/h, eat to a clock,
  nothing new on race day, gut-train the rate up in long sessions. Exact grams to be worked out live once
  the question is pinned to a specific Outlaw + your pulled weight/products.
