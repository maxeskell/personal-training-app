import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDigestMarkdown, renderResearchDigestPage } from "../src/coach/researchPage.js";

/**
 * The research-digest page renders an LLM-drafted markdown proposal read-only. It must (1) stay escape-FIRST
 * so injected markup can't go live (dashboard invariant), (2) render real structure (headings, lists,
 * blockquotes, emphasis) instead of a flat pre-wrap blob, (3) linkify both URLs and bare DOIs to the
 * originals, and (4) drop the generator's process-narration ("Let me search…") that sometimes leaks in.
 */

test("renderDigestMarkdown: escapes injected markup — it never goes live", () => {
  const html = renderDigestMarkdown("Normal line.\n<script>alert(1)</script>\n<img src=x onerror=hack()>");
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/, "no live script");
  assert.doesNotMatch(html, /<img src=x onerror=/, "no live img/onerror");
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, "shown inert");
});

test("renderDigestMarkdown: headings render at their level", () => {
  const html = renderDigestMarkdown("# Research digest\n## Section\n### Carbohydrate fuelling");
  assert.match(html, /<h1>Research digest<\/h1>/);
  assert.match(html, /<h2>Section<\/h2>/);
  assert.match(html, /<h3>Carbohydrate fuelling<\/h3>/);
});

test("renderDigestMarkdown: bullets and numbered items become real lists", () => {
  const ul = renderDigestMarkdown("- first\n- second");
  assert.match(ul, /<ul>\n<li>first<\/li>\n<li>second<\/li>\n<\/ul>/);
  const ol = renderDigestMarkdown("1. one\n2. two");
  assert.match(ol, /<ol>\n<li>one<\/li>\n<li>two<\/li>\n<\/ol>/);
  // A bullet that uses the • glyph (what the real digests emit) also lists.
  assert.match(renderDigestMarkdown("• Proposed prior: keep 90 g/h"), /<ul>\n<li>Proposed prior: keep 90 g\/h<\/li>/);
});

test("renderDigestMarkdown: bold, italic and inline code", () => {
  assert.match(renderDigestMarkdown("a **bold** word"), /a <b>bold<\/b> word/);
  assert.match(renderDigestMarkdown("the *Journal of Nutrition* review"), /the <i>Journal of Nutrition<\/i> review/);
  assert.match(renderDigestMarkdown("an _emphasised_ note"), /an <i>emphasised<\/i> note/);
  assert.match(renderDigestMarkdown("run `npm run research` now"), /run <code>npm run research<\/code> now/);
});

test("renderDigestMarkdown: quoted study excerpts become a blockquote (coalesced)", () => {
  const html = renderDigestMarkdown("> the upper limit could increase\n> from 90 to 120 g/h");
  assert.match(html, /<blockquote>the upper limit could increase from 90 to 120 g\/h<\/blockquote>/);
});

test("renderDigestMarkdown: linkifies a full URL and a bare DOI to the original", () => {
  const html = renderDigestMarkdown("See https://jn.nutrition.org/article/x and also 10.1234/abcd-99 for detail.");
  assert.match(html, /<a href="https:\/\/jn\.nutrition\.org\/article\/x" target="_blank" rel="noopener noreferrer">/, "URL linked");
  assert.match(html, /<a href="https:\/\/doi\.org\/10\.1234\/abcd-99" target="_blank" rel="noopener noreferrer">10\.1234\/abcd-99<\/a>/, "bare DOI → doi.org");
});

test("renderDigestMarkdown: a DOI already inside a URL is not double-linked", () => {
  const html = renderDigestMarkdown("Source: https://doi.org/10.5555/zenodo.1");
  // Exactly one anchor; no nested <a ...><a ...>.
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(html, /<a[^>]*><a /);
});

test("renderDigestMarkdown: drops generator process-narration lines", () => {
  const md = [
    "I'll research recent developments across the key topic areas. Let me run several focused searches.",
    "Good material on fuelling and durability. Let me now cover gear.",
    "Here's a review proposal based on developments in the past ~12 months.",
    "## Carbohydrate fuelling",
    "Real content stays.",
  ].join("\n");
  const html = renderDigestMarkdown(md);
  assert.doesNotMatch(html, /I'll research|Let me run|Good material|Here's a review/);
  assert.match(html, /<h2>Carbohydrate fuelling<\/h2>/);
  assert.match(html, /Real content stays\./);
});

test("renderResearchDigestPage: keeps the honest framing, the real approve command, and the empty state", () => {
  const md = ["# Research digest — 2026-06-14 (PROPOSED)", "### Carb intake", "- See https://doi.org/10.x", "<script>alert(1)</script>"].join("\n");
  const html = renderResearchDigestPage("2026-06-14-research-digest.md", md);
  assert.match(html, /npm run knowledge -- approve 2026-06-14-research-digest\.md/);
  assert.match(html, /<a href="https:\/\/doi\.org\/10\.x" target="_blank" rel="noopener noreferrer">/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /n=1 data outranks the textbook/);

  const empty = renderResearchDigestPage(null, null);
  assert.match(empty, /No research digest yet/);
  assert.match(empty, /npm run research/);
});
