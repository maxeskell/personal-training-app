import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSwimCssSec, resolveRunPaceSec } from "../src/state/assemble.js";
import { parseManualSwimCss } from "../src/config.js";

// --- Swim CSS (sec/100m) ---
test("resolveSwimCssSec reads a CSS pace STRING (the AIE shape firstNum dropped)", () => {
  assert.equal(resolveSwimCssSec({ css: "1:52" }), 112);
  assert.equal(resolveSwimCssSec({ swim_css: "1:52/100m" }), 112, "strips a /100m suffix");
});

test("resolveSwimCssSec reads m/s speed and plain sec/100m numbers", () => {
  assert.equal(resolveSwimCssSec({ critical_swim_speed: 0.8929 }), 112, "m/s → sec/100m");
  assert.equal(resolveSwimCssSec({ css_sec_per_100m: 112 }), 112, "already sec/100m");
  assert.equal(resolveSwimCssSec({ css: "112" }), 112, "numeric string");
});

test("resolveSwimCssSec checks a nested swim block", () => {
  assert.equal(resolveSwimCssSec({ swim: { css: "1:52" } }), 112);
});

test("resolveSwimCssSec gates out-of-range / unparseable values", () => {
  assert.equal(resolveSwimCssSec({ css: "0:30" }), undefined, "30s/100m too fast");
  assert.equal(resolveSwimCssSec({ css_sec_per_100m: 300 }), undefined, "300s/100m too slow");
  assert.equal(resolveSwimCssSec({ css: "fast" }), undefined, "junk string");
  assert.equal(resolveSwimCssSec({}), undefined, "absent");
  assert.equal(resolveSwimCssSec(null), undefined, "null payload");
});

// --- Run threshold pace (sec/km): same string-dropped-by-firstNum bug class as CSS ---
test("resolveRunPaceSec reads a threshold-pace STRING (would otherwise be dropped)", () => {
  assert.equal(resolveRunPaceSec({ threshold_pace: "4:50" }), 290);
  assert.equal(resolveRunPaceSec({ run_threshold_pace: "4:50/km" }), 290, "strips a /km suffix");
});

test("resolveRunPaceSec reads m/s speed and plain sec/km numbers", () => {
  assert.equal(resolveRunPaceSec({ threshold_pace: 3.448 }), 290, "m/s → sec/km");
  assert.equal(resolveRunPaceSec({ run_threshold_pace_sec_per_km: 290 }), 290, "already sec/km");
});

test("resolveRunPaceSec checks a nested run block and gates the range", () => {
  assert.equal(resolveRunPaceSec({ run: { threshold_pace: "4:50" } }), 290);
  assert.equal(resolveRunPaceSec({ threshold_pace: "0:30" }), undefined, "too fast");
  assert.equal(resolveRunPaceSec({ threshold_pace: "12:00" }), undefined, "too slow");
  assert.equal(resolveRunPaceSec({}), undefined, "absent");
});

// --- COACH_SWIM_CSS env parser ---
test("parseManualSwimCss handles m:ss, bare seconds, and rejects nonsense/out-of-range", () => {
  assert.equal(parseManualSwimCss("1:52"), 112);
  assert.equal(parseManualSwimCss("112"), 112);
  assert.equal(parseManualSwimCss("0:30"), undefined, "too fast");
  assert.equal(parseManualSwimCss("300"), undefined, "too slow");
  assert.equal(parseManualSwimCss("1.52"), undefined, "not misread as a pace");
  assert.equal(parseManualSwimCss("abc"), undefined);
  assert.equal(parseManualSwimCss(""), undefined);
  assert.equal(parseManualSwimCss(undefined), undefined);
});
