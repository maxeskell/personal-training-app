import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionDetail } from "../src/coach/session.js";
import type { SessionDecay } from "../src/insights/fit.js";
import {
  sessionPlanSignal,
  buildSessionAdjustRequest,
  DECOUPLE_FLAG_PCT,
  STEADY_MIN_MINUTES,
  DEEP_FATIGUE_TSB,
} from "../src/coach/reviewBridge.js";

/** A complete SessionDetail with neutral defaults (no signal), overridden per case. */
function detail(over: Partial<SessionDetail> = {}): SessionDetail {
  return {
    date: "2026-06-20",
    sport: "Run",
    startTimeS: null,
    durationMin: 90,
    avgPowerW: null,
    avgHr: null,
    ess: null,
    ef: null,
    durabilityPct: null,
    aerThrHr: null,
    aerThrW: null,
    decay: null,
    fit: null,
    comparable: { n: 0, efMean: null, essMean: null, durabilityMean: null, durMinMean: null },
    tsbOnDay: 0,
    ctlOnDay: null,
    sessionsOnDate: 1,
    sameSportOnDate: 1,
    ...over,
  };
}

/** Build a decay carrying just the decoupling we test on (the only field the bridge reads). */
function decay(decouplingPct: number | null): SessionDecay {
  return { decouplingPct } as unknown as SessionDecay;
}

test("aerobic-fade fires on high decoupling over a long steady effort", () => {
  const s = sessionPlanSignal(detail({ durationMin: 95, decay: decay(12.4), tsbOnDay: 0 }));
  assert.ok(s, "expected a signal");
  assert.equal(s!.kind, "aerobic-fade");
  assert.match(s!.reasons.join(" "), /12\.4%/);
  assert.match(s!.headline, /decoupled/i);
});

test("aerobic-fade does NOT fire when the effort is too short to judge decoupling", () => {
  const s = sessionPlanSignal(detail({ durationMin: STEADY_MIN_MINUTES - 1, decay: decay(15), tsbOnDay: 0 }));
  assert.equal(s, null);
});

test("aerobic-fade does NOT fire at/below the decoupling threshold (only above)", () => {
  assert.equal(sessionPlanSignal(detail({ durationMin: 90, decay: decay(DECOUPLE_FLAG_PCT), tsbOnDay: 0 })), null);
  assert.equal(sessionPlanSignal(detail({ durationMin: 90, decay: decay(6), tsbOnDay: 0 })), null);
});

test("aerobic-fade needs a decay (no .FIT stream → no fade signal)", () => {
  assert.equal(sessionPlanSignal(detail({ durationMin: 120, decay: null, tsbOnDay: 0 })), null);
});

test("deep-fatigue fires at/below the TSB threshold, not just above it", () => {
  assert.equal(sessionPlanSignal(detail({ tsbOnDay: DEEP_FATIGUE_TSB }))!.kind, "deep-fatigue");
  assert.equal(sessionPlanSignal(detail({ tsbOnDay: DEEP_FATIGUE_TSB - 5 }))!.kind, "deep-fatigue");
  assert.equal(sessionPlanSignal(detail({ tsbOnDay: DEEP_FATIGUE_TSB + 1 })), null);
});

test("deep-fatigue outranks aerobic-fade when both conditions hold", () => {
  const s = sessionPlanSignal(detail({ durationMin: 120, decay: decay(14), tsbOnDay: -30 }));
  assert.equal(s!.kind, "deep-fatigue");
});

test("no signal when the session is unremarkable", () => {
  assert.equal(sessionPlanSignal(detail({ tsbOnDay: -8, durationMin: 45, decay: decay(4) })), null);
});

test("null TSB never triggers deep-fatigue", () => {
  assert.equal(sessionPlanSignal(detail({ tsbOnDay: null, decay: null })), null);
});

test("buildSessionAdjustRequest carries the suggestion, the deterministic basis, and the targeting rule", () => {
  const d = detail({ tsbOnDay: -28 });
  const s = sessionPlanSignal(d)!;
  const req = buildSessionAdjustRequest(d, s);
  assert.match(req, /deep fatigue/i);
  assert.match(req, /Target a SPECIFIC upcoming planned session by id/);
  assert.match(req, /Deterministic basis:/);
  assert.match(req, /TSB -28/);
});
