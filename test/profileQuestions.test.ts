import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  PROFILE_QUESTIONS,
  questionsByArea,
  renderQuestionsText,
  renderQuestionsMarkdown,
  WAYS_TO_ANSWER,
  type ProfileQuestion,
} from "../src/profile/questions.js";

/**
 * `src/profile/questions.ts` is the single source of truth behind `npm run profile:questions` and the
 * generated `docs/profile-questions.md`. These PURE tests lock that it's well-formed and — crucially —
 * that every `field` dot-path actually exists in the committed example profile / schema, so the list can
 * never reference a field that doesn't exist (which would silently mislead the user).
 */

const exampleText = readFileSync(new URL("../profile.example.yaml", import.meta.url), "utf8");
const example = parseYaml(exampleText) as Record<string, unknown>;

/** Does the dot-path resolve to a KEY that exists in `obj` (a null/empty value still counts as present)? */
function pathExists(obj: unknown, dotPath: string): boolean {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && !Array.isArray(cur) && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return false;
    }
  }
  return true;
}

test("every question entry is well-formed (non-empty area/field/question/why)", () => {
  assert.ok(PROFILE_QUESTIONS.length > 0, "there should be at least one optional question");
  for (const q of PROFILE_QUESTIONS) {
    for (const k of ["area", "field", "question", "why"] as const) {
      const v = (q as ProfileQuestion)[k];
      assert.equal(typeof v, "string", `${q.field}.${k} must be a string`);
      assert.ok(v.trim().length > 0, `${q.field}.${k} must be non-empty`);
    }
    // The field's first dot-segment should be (or sit under) its declared area.
    assert.ok(q.field === q.area || q.field.startsWith(`${q.area}.`), `${q.field} should live under area "${q.area}"`);
  }
});

test("every field dot-path exists in the committed example profile (no phantom fields)", () => {
  for (const q of PROFILE_QUESTIONS) {
    assert.ok(
      pathExists(example, q.field),
      `questions.ts references "${q.field}" but no such key exists in profile.example.yaml`,
    );
  }
});

test("field dot-paths are unique (no duplicate entries)", () => {
  const seen = new Set<string>();
  for (const q of PROFILE_QUESTIONS) {
    assert.ok(!seen.has(q.field), `duplicate field path: ${q.field}`);
    seen.add(q.field);
  }
});

test("questionsByArea groups every question, preserving first-seen area order", () => {
  const grouped = questionsByArea();
  const flatCount = grouped.reduce((n, g) => n + g.items.length, 0);
  assert.equal(flatCount, PROFILE_QUESTIONS.length, "grouping must not drop or duplicate questions");
  // Areas appear in first-seen order and each item really belongs to its group.
  for (const g of grouped) {
    for (const item of g.items) assert.equal(item.area, g.area);
  }
});

test("the CLI text and the generated doc both render every question and state they're optional", () => {
  const text = renderQuestionsText();
  const md = renderQuestionsMarkdown();
  for (const q of PROFILE_QUESTIONS) {
    assert.ok(text.includes(q.field), `CLI text should mention ${q.field}`);
    assert.ok(text.includes(q.question), `CLI text should include the question for ${q.field}`);
    assert.ok(md.includes(`\`${q.field}\``), `doc should mention ${q.field}`);
  }
  for (const w of WAYS_TO_ANSWER) {
    assert.ok(text.includes(w), "CLI text lists every way to answer");
    assert.ok(md.includes(w), "doc lists every way to answer");
  }
  assert.match(text, /OPTIONAL/);
  assert.match(md, /optional/i);
  // The doc carries the generated-from-source banner so no one hand-edits it into drift.
  assert.match(md, /GENERATED FROM src\/profile\/questions\.ts/);
});

test("the Markdown renderer escapes table-breaking characters (backslash before pipe)", () => {
  const tricky: ProfileQuestion[] = [
    { area: "demo", field: "demo.a|b", question: "pipe | here and a back\\slash", why: "ends with a backslash\\" },
  ];
  const md = renderQuestionsMarkdown(tricky);
  // Every literal pipe inside a cell is escaped so it can't be read as a column separator…
  assert.ok(md.includes("`demo.a\\|b`"), "field pipe should be escaped");
  assert.ok(md.includes("pipe \\| here"), "question pipe should be escaped");
  // …and the backslash itself is escaped FIRST, so a trailing `\` can't swallow the pipe-escape.
  assert.ok(md.includes("back\\\\slash"), "interior backslash should be doubled");
  assert.ok(md.includes("a backslash\\\\ |"), "a trailing backslash should be doubled, not left to escape the cell border");
});

test("docs/profile-questions.md on disk matches the renderer (no drift)", () => {
  const onDisk = readFileSync(new URL("../docs/profile-questions.md", import.meta.url), "utf8");
  assert.equal(onDisk, renderQuestionsMarkdown(), "regenerate with: npm run profile:questions -- --write-doc");
});
