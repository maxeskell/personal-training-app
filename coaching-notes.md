# Coaching notes — context & to-dos for talking things through

> **What this file is.** A committed companion for *conversations* with the coach (Claude Code / Claude
> on the web), so a chat starts already knowing the durable context it needs — instead of asking you to
> re-state it or hedging because it can't see your data.
>
> **Why it's committed (and `profile.local.yaml` isn't enough).** Two channels feed a chat:
> - the **MCP server** (`npm run mcp`) pulls your *live* numbers — races, FTP, weight, plan — but it's
>   local-by-design: it reads your OAuth tokens (`~/.endurance-coach`) and `data/` on your Mac, so it only
>   works when you chat from Claude Code/Desktop **on the Mac**.
> - `profile.local.yaml` holds durable context for the **app's** coach, but it's gitignored — it is **not**
>   present in a fresh Claude-Code-on-the-web checkout.
>
> In a **web** session neither of those reaches your data (no tokens, no account, no `data/` in the cloud
> container). This file is the one channel that travels with the repo, so it works everywhere. Keep the
> live numbers in MCP/AI Endurance; keep durable context here.
>
> **What goes in here:** durable, non-secret context (fuelling/GI tolerances, how you respond to things,
> equipment quirks, training-history highlights), decisions we've talked through, and a running to-do list.
> **What stays out:** secrets/tokens, and live/drifting numbers (exact weight, FTP, CSS, HRV) — same
> discipline as the rest of the repo. Trends and targets are fine.

## Athlete context (fill in as it comes up)
- **Fuelling tolerance:** _gut-trained carb ceiling (g/h), what sits well vs. goes rough, gels vs. drink-mix._
- **Sweat / hydration:** _sweat rate (ml/h) + saltiness once tested — see To do. Until then it's a guess._
- **Caffeine:** _how you respond, usual race dose, any evening cutoff._
- **GI / digestion:** _anything that's gone wrong in races; foods to avoid pre-race._
- **Race nutrition stack:** _what you actually carry (summary mirror of `profile.local.yaml → fuelling.products`)._
- **History / durability notes:** _races done, what's worked, recurring niggles._

## Races we're working toward
- _e.g. Outlaw Half — date, priority, goal time, goal leg splits. (Authoritative copy lives in
  `profile.local.yaml races[]` / AI Endurance; this is just the chat-visible summary.)_

## Decisions / things we've talked through
- **2026-06-23 — 70.3 Outlaw fuelling.** Framework agreed: target ~70–90 g/h (bias the bike, ease on the
  run), cap at the gut-trained ceiling, multi-transportable carb above ~60 g/h, eat to a clock, nothing new
  on race day, gut-train the rate up in long sessions. Exact grams pending bodyweight + product list + which
  Outlaw (course/heat).

## To do
- [ ] **Sweat-rate test** — gives a real ml/h + sodium figure to replace the population MODEL in fuelling
      advice. Protocol: weigh yourself (minimal/no clothing, towel-dry) before a ~60 min steady session;
      record fluid drunk during it; weigh again after. Sweat loss (L) ≈ (pre-kg − post-kg) + fluid drunk (L);
      sweat rate = that ÷ session hours. Repeat once in cooler and once in warmer conditions if you can.
      Note shirt salt-staining / sweat taste for a rough sodium read (a patch test is the accurate version).
      Record the result under **Athlete context → Sweat / hydration**.
