# Harden & Battle-Test — SUMMARY

**Scope:** `personal-training-app` (TS coach) + `local-llm-server` (Python side-task server).
**Mode:** REPORT-ONLY — no application code was changed. Evidence is from full source review,
three parallel deep-dive audits, and four network-free battle-tests (`/tmp/battletest/*`, results inline below).
**Date:** 2026-06-14.

## Overall verdict

**This is a genuinely well-built app, and the one thing that can actually change your training plan — the
write path — is safe.** The confirm-before-write gate holds against the LLM, scheduled jobs, and prompt
injection (proven, not assumed: §SEC-1). Source-of-truth per metric is respected, Garmin cannot block the
coach, and the n=1 stats engine is unusually rigorous (held-out validation, FDR, permutation nulls).

**Is it safe to rely on for daily coaching? Yes, with caveats.** No P0 was found — nothing leaks
credentials, makes a deterministically-wrong call, or writes without your yes. The real weaknesses are
(a) a **health-safety guardrail that is softer than it claims** and (b) **single-point / silent-failure**
gaps that can mis-colour a *daily* call but never write or leak. Fix #1 and #3 below before trusting the
morning call unattended.

**Path B vs a plain Claude Project: still justified.** The three things that need a custom app —
unattended 06:00 scheduling, a glanceable provenance-tagged dashboard reachable from your phone, and a
durable append-only decision log — are all real, wired to live data, and impossible in a chat project. The
gated write tooling and the deterministic insight engine are well beyond a prompt.

## The 5 things that most need fixing (priority order)

1. **[P1] The wellbeing guardrail is not reliably deterministic.** The nutrition restriction screen is a
   set of brittle adjacency regexes: **9 of 17** natural phrasings ("shed a few kilos before the tri",
   "get me to racing weight", "put me on a cut", "trim some body fat", "calories under maintenance to slim
   down") **passed straight through to the LLM** in my battle-test. Separately, `assessHealthRisk` needs
   **≥2 co-occurring signals** to say anything, so a **standalone 1.5 kg/week drop produced `level="none"`**
   — and the readiness snapshot doesn't include weight at all. Criterion #6 ("a deterministic guardrail,
   not a hope that the LLM behaves") is not met. *Impact: under-fuelling / rapid weight loss can go
   unflagged by the daily safety layer.*

2. **[P2] The two most safety-critical modules have zero unit tests.** `WriteGate` and `wellbeing` have no
   direct coverage; the 99 green tests cover analytics instead. A refactor that broke the gate's single-use
   claim or confirm-without-propose throw would ship green. *Impact: the one invariant that protects your
   AI Endurance account is unprotected against regression.*

3. **[P2] A silently-failed 06:00 ping is invisible, and the ping isn't idempotent.** If AI Endurance is
   down (or any exception fires), `ping` exits to `reports/ping.log` with **no notification** — you just get
   no readiness call and no signal that it failed. A double-fire (manual + scheduled, or a launchd wake)
   duplicates the notification, the LLM spend, and the decision-log line. *Impact: you can't tell when the
   morning call broke.*

4. **[P2] "Trend over single point" is enforced only in the prompt.** There is no code-level floor stopping
   the LLM returning **red on one bad night**; and the headline's RED gate keys partly on a single-day TSB
   that rests on a null-ESS→0 dropout that can't be told from a real rest day. *Impact: one off night or one
   dropped data day can over-colour the daily call.*

5. **[P2] Heat/seasonal confounding isn't removed from the efficiency trends.** EF / durability / economy
   trends are not heat-adjusted; heat is a *parallel* note that goes silent when `.FIT` temperature is
   absent. *Impact: a summer heat wave can read as lost fitness.*

Full detail, evidence (file:line), impact, severity, and concrete fixes — split into **quick wins** vs
**deeper work** — are in [`FINDINGS.md`](./FINDINGS.md).
