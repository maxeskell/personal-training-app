import { escapeHtml, linkifyEscaped } from "./dashboardHelpers.js";
import { pageShell } from "./shell.js";

/**
 * Standalone read-only page for the latest pending research digest — what the "Worth considering" card's
 * "Read the full digest →" link points at, so "where's the research?" has an in-app answer (the digest
 * itself lives in gitignored `knowledge/pending/`). The digest markdown is rendered ESCAPE-FIRST (see
 * {@link renderDigestMarkdown}): every line is escaped before any formatting, so injected markup can't
 * break out (dashboard escaping convention). `file`/`markdown` null → a friendly empty state (best-effort:
 * a missing or unreadable digest must never error). Pure.
 */

/** Lines that are the generator LLM narrating its own process ("Let me search…", "Here's a proposal…")
 *  rather than digest content — a generation artifact we drop at render so an older/messy digest still
 *  reads cleanly. Conservative: only whole lines opening with these first-person meta phrases. */
const NARRATION_RE =
  /^(?:I'?ll\b|I will\b|Let me\b|Let'?s\b|Now (?:I'?ll|let me|let'?s)\b|Here'?s\b|Here is\b|Good (?:material|stuff|news)\b|First,?\s+I\b|Next,?\s+I\b|I'?ve\b|I (?:searched|ran|need|should|now)\b|Okay[,!]|Sure[,!]|Alright[,!])/i;

/** Turn bare DOIs (`10.1234/xyz`) in ALREADY-ESCAPED, already-URL-linkified text into doi.org links —
 *  but never inside an `<a>` we just produced (so a `https://doi.org/10…` URL isn't double-wrapped). */
function linkifyDois(html: string): string {
  const DOI = /\b(10\.\d{4,9}\/[^\s<>"'`)\]]+)/g;
  // Split keeps the anchors as odd-indexed segments; only the even (outside-anchor) text gets DOI links.
  return html
    .split(/(<a\b[^>]*>.*?<\/a>)/g)
    .map((seg, i) =>
      i % 2 === 1
        ? seg
        : seg.replace(DOI, (raw) => {
            const clean = raw.replace(/[.,;:]+$/, ""); // don't swallow sentence punctuation
            const tail = raw.slice(clean.length);
            return `<a href="https://doi.org/${clean}" target="_blank" rel="noopener noreferrer">${clean}</a>${tail}`;
          }),
    )
    .join("");
}

/** Inline formatting on ALREADY-ESCAPED text: bold, italic, inline code, then URL + DOI links. */
function inlineFmt(escaped: string): string {
  let h = escaped;
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>"); // **bold** before *italic* so ** isn't half-eaten
  h = h.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");
  h = h.replace(/(?<![A-Za-z0-9])_([^_\n]+)_(?![A-Za-z0-9])/g, "<i>$1</i>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  return linkifyDois(linkifyEscaped(h));
}

/**
 * Minimal block-level markdown → HTML for the digest page, escape-FIRST. Handles headings (#/##/###),
 * horizontal rules, `-`/`*`/`•` bullets, `1.` numbered lists, `>` blockquotes (the quoted study excerpts),
 * and paragraphs, with inline bold/italic/code and URL/DOI links. Adjacent text/quote/list lines coalesce.
 * Generator process-narration lines are dropped. Pure; safe on any input (everything is escaped). Exported
 * for unit tests.
 */
export function renderDigestMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];
  let quote: string[] = [];
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineFmt(escapeHtml(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inlineFmt(escapeHtml(quote.join(" ")))}</blockquote>`);
      quote = [];
    }
  };
  const flushInline = () => {
    flushPara();
    flushQuote();
  };

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) {
      flushInline();
      closeList();
      continue;
    }
    if (NARRATION_RE.test(t)) continue; // drop generator self-narration

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)) {
      flushInline();
      closeList();
      out.push("<hr>");
      continue;
    }
    const heading = t.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushInline();
      closeList();
      const lvl = heading[1].length;
      out.push(`<h${lvl}>${inlineFmt(escapeHtml(heading[2]))}</h${lvl}>`);
      continue;
    }
    const bq = t.match(/^>\s?(.*)$/);
    if (bq) {
      flushPara();
      closeList();
      quote.push(bq[1]);
      continue;
    }
    const bullet = t.match(/^(?:[-*•·–])\s+(.*)$/);
    if (bullet) {
      flushInline();
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inlineFmt(escapeHtml(bullet[1]))}</li>`);
      continue;
    }
    const numbered = t.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushInline();
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inlineFmt(escapeHtml(numbered[1]))}</li>`);
      continue;
    }
    // plain text → paragraph (coalesce consecutive lines)
    flushQuote();
    closeList();
    para.push(t);
  }
  flushInline();
  closeList();
  return out.join("\n");
}

export function renderResearchDigestPage(file: string | null, markdown: string | null): string {
  const shell = (inner: string) => pageShell({ title: "Research digest", active: "decide" }, inner);
  if (!file || !markdown || !markdown.trim()) {
    return shell(`<h1>No research digest yet</h1><div class="note">The monthly research flow hasn't drafted one yet. Run <code>npm run research</code> to generate a proposed update to the coach's priors — it web-searches recent training / triathlon / gear research and drops a review proposal in <code>knowledge/pending/</code>. Best-effort; needs <code>ANTHROPIC_API_KEY</code>.</div>`);
  }
  const approve = `npm run knowledge -- approve ${file}`;
  return shell(`<h1>Research digest</h1><div class="note"><b>This is a proposal — nothing here is active yet.</b> These are priors to weigh, not verdicts: your own n=1 data outranks the textbook. To fold it into the coach's priors run <code>${escapeHtml(approve)}</code>, or ask the coach what any item means for you.</div><div class="digest">${renderDigestMarkdown(markdown)}</div>`);
}
