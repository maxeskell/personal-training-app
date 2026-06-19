import { test } from "node:test";
import assert from "node:assert/strict";
import { categorize, isPlanEdit, CATEGORY_LABEL } from "../src/coach/weeklyActions.js";

test("categorize: places a recommendation into the right kind, falling back to general", () => {
  // Training execution cues + sessions.
  assert.equal(categorize("Cut one grey-zone ride"), "training");
  assert.equal(categorize("Add a second threshold interval to Tuesday"), "training");
  // Fuelling.
  assert.equal(categorize("Take 60 g/h carb on rides over 90 min"), "fuelling");
  assert.equal(categorize("Add a pre-race breakfast 3h before the start"), "fuelling");
  // Gear.
  assert.equal(categorize("Drop tyre pressure to 70 psi for the wet crit"), "gear");
  assert.equal(categorize("Try the new carbon-plate shoes on the long run"), "gear");
  // Recovery.
  assert.equal(categorize("Protect a full rest day after the long ride"), "recovery");
  assert.equal(categorize("Prioritise sleep — HRV is trending down"), "recovery");
  // Nothing matches → general (still gets agree/disagree/snooze).
  assert.equal(categorize("Email the physio about your follow-up"), "general");
});

test("categorize: overlap precedence is deterministic (recovery & fuelling win over a session noun)", () => {
  // Names a 'ride' but the change is a rest insertion → recovery, not training.
  assert.equal(categorize("Swap the second ride for a recovery week"), "recovery");
  // Names the 'long run' but the change is fuelling → fuelling, not training.
  assert.equal(categorize("Fuel the long run with 60 g/h carb"), "fuelling");
});

test("isPlanEdit: a schedule edit (verb + session/slot) is applyable; an execution cue is not", () => {
  assert.equal(isPlanEdit("Cut one grey-zone ride"), true);
  assert.equal(isPlanEdit("Move the long run off your GI-trough day"), true);
  assert.equal(isPlanEdit("Skip Thursday's intervals if HRV is low"), true);
  assert.equal(isPlanEdit("Add a recovery week"), true);
  // Execution cues / non-schedule advice are NOT plan edits.
  assert.equal(isPlanEdit("Start the brick run 5s/km easier"), false);
  assert.equal(isPlanEdit("Take 60 g/h carb on rides over 90 min"), false);
  assert.equal(isPlanEdit("Prioritise sleep this week"), false);
});

test("CATEGORY_LABEL: every category has a human chip label", () => {
  for (const c of ["training", "fuelling", "gear", "recovery", "general"] as const) {
    assert.ok(CATEGORY_LABEL[c] && CATEGORY_LABEL[c].length > 0, `${c} has a label`);
  }
});
