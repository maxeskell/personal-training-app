import { escapeHtml, mdLite, linkifyEscaped } from "./dashboardHelpers.js";

/**
 * Standalone read-only page for the latest pending research digest — what the "Worth considering" card's
 * "Read the full digest →" link points at, so "where's the research?" has an in-app answer (the digest
 * itself lives in gitignored `knowledge/pending/`). Escape-FIRST markdown via {@link mdLite}, then URLs
 * linkified; the approve command shows the REAL file name. `file`/`markdown` null → a friendly empty state
 * (best-effort: a missing or unreadable digest must never error). Pure.
 */
export function renderResearchDigestPage(file: string | null, markdown: string | null): string {
  const shell = (inner: string) =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Research digest</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:0 auto;padding:26px 20px 64px;color:#2b2b2b;line-height:1.6}h2{margin:.2em 0 .4em}a{color:#c8642d}code{background:#f4f1ea;border-radius:4px;padding:1px 5px;font-size:.92em}.back{display:inline-block;margin-bottom:18px;font-size:13px;text-decoration:none}.digest{font-size:15px;white-space:pre-wrap}.note{background:#faf8f3;border-left:3px solid #e7d9c6;border-radius:5px;padding:12px 14px;font-size:14px;margin:0 0 20px}</style></head>
<body><a class="back" href="/">← Back to the dashboard</a>${inner}</body></html>`;
  if (!file || !markdown || !markdown.trim()) {
    return shell(`<h2>No research digest yet</h2><div class="note">The monthly research flow hasn't drafted one yet. Run <code>npm run research</code> to generate a proposed update to the coach's priors — it web-searches recent training / triathlon / gear research and drops a review proposal in <code>knowledge/pending/</code>. Best-effort; needs <code>ANTHROPIC_API_KEY</code>.</div>`);
  }
  const approve = `npm run knowledge -- approve ${file}`;
  return shell(`<div class="note"><b>This is a proposal — nothing here is active yet.</b> These are priors to weigh, not verdicts: your own n=1 data outranks the textbook. To fold it into the coach's priors run <code>${escapeHtml(approve)}</code>, or ask the coach what any item means for you.</div><div class="digest">${linkifyEscaped(mdLite(markdown))}</div>`);
}
