import { escapeHtml } from "./dashboardHelpers.js";

/**
 * Shared page chrome for the whole site — ONE stylesheet + ONE persistent nav, so every page
 * (the tabbed dashboard, the standalone /career and /season deep pages, the research digest) reads
 * as one app instead of four drifting documents. Before this, each page redefined its own `<style>`
 * (760px here, 820px there) and only the dashboard had navigation.
 *
 * The four sections are the site's information architecture:
 *   Today        — the daily operational view (readiness verdict + action, last session).
 *   Plan         — the plan at every horizon: this week (weather/fuel/load) → this phase → season arc.
 *   Decide       — the unified "your call" inbox (insights, data changes, coach recs, setup) — one UX.
 *   Performance  — your numbers: load/zones/scores → race readiness → career history & PBs.
 *
 * On the dashboard the nav switches in-page tab panels (hash-driven, no round-trip); on a standalone
 * page the same links carry an absolute `/#section` href so they navigate home and open that tab.
 * PURE; everything interpolated is escaped (dashboard escaping convention).
 */

export type NavId = "today" | "plan" | "decide" | "performance";

const NAV: Array<{ id: NavId; label: string }> = [
  { id: "today", label: "Today" },
  { id: "plan", label: "Plan" },
  { id: "decide", label: "Decide" },
  { id: "performance", label: "Performance" },
];

/**
 * The single stylesheet. The dashboard's card/insight/setup vocabulary is global; the season- and
 * career-page component classes are SCOPED under `.season-inner` / `.career-inner` so their
 * differently-tuned `.big` / `.grid` / `.dot` / `.num` don't collide with the dashboard's. The
 * standalone pages and the embedded tab folds both wrap their content in those scope classes, so a
 * card looks identical whether it's on /season or inside the Plan tab.
 */
export const SHARED_CSS = `
:root{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222}
*{box-sizing:border-box}
body{margin:0;background:#f4f1ea}
.wrap{max-width:880px;margin:0 auto;padding:20px 18px 64px}
h1{font-size:20px;margin:0 0 2px}.sub{color:#777;font-size:13px;margin-bottom:14px}
/* ── Site header + nav ───────────────────────────────────────────────────── */
.site-head{position:sticky;top:0;z-index:20;background:#f4f1eaee;backdrop-filter:saturate(1.1) blur(4px);border-bottom:1px solid #e7ddcb}
.site-head .wrap{padding:12px 18px 0}
.brand{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.brand h1{font-size:18px;letter-spacing:.01em}
.headmeta{font-size:12px;color:#8a8170;text-align:right;line-height:1.4}
.nav{display:flex;gap:4px;margin:10px 0 0;flex-wrap:wrap}
.nav a{font-size:14px;font-weight:600;color:#7a6f59;text-decoration:none;padding:8px 14px;border-radius:9px 9px 0 0;border-bottom:3px solid transparent}
.nav a:hover{color:#c8642d;background:#faf6ee}
.nav a.on{color:#c8642d;border-bottom-color:#c8642d;background:#fff}
.nav .count{display:inline-block;min-width:18px;text-align:center;font-size:11px;font-weight:700;color:#fff;background:#c8642d;border-radius:9px;padding:0 5px;margin-left:6px;vertical-align:1px}
a.back{display:inline-block;margin:0 0 12px;font-size:13px;color:#c8642d;text-decoration:none}
/* ── Tab panels (dashboard). No-JS: every panel shows (a plain long scroll). ─ */
.tab-intro{color:#6b6256;font-size:13px;margin:0 0 14px}
body.js .tab{display:none}
body.js .tab.on{display:block}
/* ── Cards ───────────────────────────────────────────────────────────────── */
.card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#999;margin:0 0 12px}
details.card>summary{list-style:none;cursor:pointer;font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#999;font-weight:600}
details.card>summary::-webkit-details-marker{display:none}
details.card>summary::before{content:"▸";color:#b9aa93;margin-right:6px}
details.card[open]>summary{margin-bottom:12px}
details.card[open]>summary::before{content:"▾"}
/* A responsive deck — reference cards sit two-up on a wide screen, one-up on a phone. */
.deck{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.deck>.card{margin-bottom:0}
.section-rule{border:0;border-top:1px solid #e7ddcb;margin:22px 0 16px}
.section-rule-label{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#a89c84;margin:22px 0 10px}
.verdict{display:flex;align-items:center;gap:12px}
.dot{width:16px;height:16px;border-radius:50%}
.big{font-size:22px;font-weight:600;text-transform:capitalize}
table{width:100%;border-collapse:collapse;font-size:14px} td{padding:5px 6px;border-bottom:1px solid #f0ede5}
tr.total td{border-top:2px solid #e7d9c6;border-bottom:0;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums} .muted{color:#bbb}
.spark polyline{stroke:#888}.spark.up polyline{stroke:#1a8a3a}.spark.down polyline{stroke:#c0392b}
.grid{display:flex;gap:14px;flex-wrap:wrap}.grid>div{flex:1;min-width:120px}
.disc{border-top:2px solid #f0ede5;margin-top:12px;padding-top:10px}.disc:first-of-type{border-top:0;margin-top:0;padding-top:0}
.disch{font-size:13px;font-weight:600;color:#555;margin-bottom:6px}
.k{color:#999;font-size:12px}.v{font-size:18px;font-weight:600}
.finding{padding:8px 0;border-bottom:1px solid #f0ede5}.finding:last-child{border:0}
.finding.done{opacity:.5}.donetag{font-size:10px;color:#1a8a3a;font-weight:600;margin-left:4px}
.badge{color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:10px;margin-right:8px}
.fdetail{font-size:13px;color:#444;margin:3px 0}.ev{font-size:11px;color:#999}
.syncbtn{padding:8px 16px;border:0;border-radius:8px;background:#c8642d;color:#fff;font-size:14px;cursor:pointer}
.syncbtn:disabled{opacity:.55;cursor:default}
.syncstatus{margin-left:10px;font-size:13px;color:#888}
.askbar{display:flex;gap:8px;align-items:center;margin:10px 0 0}
.askbar input{flex:1;padding:9px 12px;border:1px solid #e0d6c4;border-radius:9px;font-size:14px;background:#fff}
.askbar button{padding:9px 16px;border:0;border-radius:9px;background:#c8642d;color:#fff;font-size:14px;cursor:pointer}
.insights{border:1px solid #e7d9c6}
.insight{padding:10px 12px;border-bottom:1px solid #f0ede5;border-left:3px solid transparent;margin-bottom:2px}.insight:last-child{border-bottom:0}
.insight.sev-flag{border-left-color:#c0392b;background:#fdf3f2}
.insight.sev-watch{border-left-color:#c98a00;background:#fdfaf2}
.insight.sev-info{border-left-color:#cfe7d6}
.acts{margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.acts button{font-size:12px;padding:4px 10px;border:1px solid #ddd;border-radius:14px;background:#fff;cursor:pointer}
.acts button:disabled{opacity:.4;cursor:default}
.acts .agree:hover{background:#e6f5ea;border-color:#1a8a3a}.acts .disagree:hover{background:#fdeaea;border-color:#c0392b}
.acts .ignore:hover{background:#f3f3f3}.reacted{font-size:11px;color:#1a8a3a;margin-left:4px}
.acts .agree.on{background:#e6f5ea;border-color:#1a8a3a;font-weight:600}.acts .disagree.on{background:#fdeaea;border-color:#c0392b;font-weight:600}
.insight[data-reaction-state="applied"]{opacity:.65}
.newbadge{background:#1558d6;color:#fff;font-size:9px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:9px;margin-right:6px;vertical-align:middle}
.age{font-size:11px;color:#bbb;margin-top:4px}
.route{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.02em;color:#6b5b45;background:#f4f1ea;border:1px solid #e7d9c6;border-radius:9px;padding:1px 7px;margin-left:4px;white-space:nowrap}
.cat{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;border-radius:9px;padding:1px 7px;margin-right:6px;vertical-align:middle;white-space:nowrap}
.cat-training{background:#e7eefb;color:#1558d6}.cat-fuelling{background:#fdeede;color:#b45309}.cat-gear{background:#eef0f2;color:#475569}.cat-recovery{background:#e6f5ea;color:#1a8a3a}.cat-general{background:#f3f3f3;color:#666}
.item-proposals:not(:empty){margin:6px 0}
details.setup-item{border-bottom:1px solid #f0ede5;padding:5px 0}details.setup-item:last-child{border-bottom:0}
details.setup-item>summary{cursor:pointer;line-height:1.5;list-style:none}
details.setup-item>summary::-webkit-details-marker{display:none}
details.setup-item>summary::before{content:"▸";color:#b9aa93;display:inline-block;width:14px}
details.setup-item[open]>summary::before{content:"▾"}
.setup-action{margin:6px 0 8px 14px;padding:8px 11px;background:#faf8f3;border-left:2px solid #e7d9c6;border-radius:4px;font-size:13px;line-height:1.55;color:#444;white-space:pre-wrap}
.setup-links{margin:0 0 9px 14px;display:flex;flex-wrap:wrap;gap:14px}
.setup-link{font-size:12px;font-weight:600;color:#c8642d;text-decoration:none}.setup-link:hover{text-decoration:underline}
.setup-acts{margin-left:4px;white-space:nowrap}
.setup-item .su-act{font-size:11px;line-height:1;color:#b9aa93;background:none;border:0;cursor:pointer;padding:0 3px}
.setup-item .su-done:hover{color:#1a8a3a}.setup-item .su-snooze:hover{color:#9a8a72}.setup-item .su-ignore:hover{color:#c0392b}
.setup-group{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#9a8a72;margin:10px 0 3px}
.actbtn{font-size:13px;padding:7px 14px;border:1px solid #c8642d;border-radius:8px;background:#fff;color:#c8642d;cursor:pointer}.actbtn:hover{background:#c8642d;color:#fff}
code{background:#f4f1ea;border-radius:4px;padding:0 4px;font-size:13px}
.proposal{border:1px solid #e7d9c6;border-radius:8px;padding:10px 12px;margin-top:10px}
.note{background:#faf8f3;border-left:3px solid #e7d9c6;border-radius:5px;padding:12px 14px;font-size:14px;margin:0 0 16px}
/* ── Season-arc component styles, scoped so they don't collide with the dashboard's ── */
.season-inner .big{font-size:26px;font-weight:700;text-transform:none}.season-inner .unit{font-size:13px;color:#888;font-weight:400}
.season-inner .grid{display:flex;gap:18px;flex-wrap:wrap}.season-inner .grid>div{flex:1;min-width:130px}
.season-inner .k{color:#999;font-size:12px}.season-inner .v{font-size:18px;font-weight:600}
.season-inner .trend-rising{color:#1a8a3a}.season-inner .trend-falling{color:#c0392b}.season-inner .trend-flat{color:#9a8f78}
.season-inner .lever{display:flex;align-items:flex-start;gap:9px;padding:7px 0;border-bottom:1px solid #f0ede5;font-size:14px}.season-inner .lever:last-child{border:0}
.season-inner .dot{width:10px;height:10px;border-radius:50%;margin-top:5px;flex:0 0 auto}
.season-inner .lever .nm{font-weight:600;min-width:96px}
.season-inner .bar{display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0}
.season-inner .bar .yr{width:34px;color:#777;font-variant-numeric:tabular-nums}
.season-inner .bar .track{flex:1;background:#f0ede5;border-radius:3px;overflow:hidden;height:12px}
.season-inner .bar .fill{display:block;height:12px;border-radius:3px;background:#bcae90}.season-inner .bar .fill.peak{background:#2e7d57}.season-inner .bar .fill.cur{background:#c8642d}
.season-inner .bar .val{width:46px;text-align:right;color:#666;font-variant-numeric:tabular-nums}
.season-inner .flag{background:#fdf3f2;border-left:3px solid #c0392b;border-radius:5px;padding:7px 11px;margin:6px 0;font-size:14px}
.season-inner .focus{background:#eef4ff;border-left:3px solid #1558d6;border-radius:5px;padding:10px 13px;font-size:15px;font-weight:500}
.season-inner .prose{font-size:14px;color:#333;line-height:1.6}.season-inner .prose b{color:#222}
.season-inner .stamp{color:#999;font-size:12px;margin:2px 0 10px}.season-inner .stamp .stale{color:#c98a00}
/* ── Career component styles, scoped ── */
.career-inner .num{text-align:right;font-variant-numeric:tabular-nums}.career-inner .muted{color:#bbb}
.career-inner table td,.career-inner table th{padding:6px 7px;border-bottom:1px solid #f0ede5;text-align:left;vertical-align:top}
.career-inner th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#999;font-weight:600}
.career-inner .when{font-size:11px;color:#b1a78f}
.career-inner .tag{font-size:10px;color:#9a7b3a;background:#faf3e3;border:1px solid #ecdcbf;border-radius:9px;padding:0 6px}
.career-inner .pcwrap{overflow-x:auto}.career-inner .pcurve{width:100%;height:auto;min-width:520px}
.career-inner .pcurve .grid{stroke:#eee7d8}.career-inner .pcurve .ax{fill:#9a8f78;font-size:11px}
.career-inner .legend{margin-top:8px;font-size:12px;color:#666}.career-inner .leg{margin-right:16px;white-space:nowrap}.career-inner .sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.career-inner details.splits{margin-top:6px;text-align:left}.career-inner details.splits>summary{cursor:pointer;font-size:12px;color:#c8642d}
.career-inner table.splitt{margin-top:6px;font-size:12px}.career-inner table.splitt td,.career-inner table.splitt th{padding:3px 7px;border-bottom:1px solid #f4f1ea}
.career-inner .cols{display:flex;gap:16px;flex-wrap:wrap}.career-inner .cols>div{flex:1;min-width:300px}
/* ── Research digest prose ── */
.digest{font-size:15px}.digest p{margin:.5em 0}.digest ul,.digest ol{margin:.3em 0 .85em;padding-left:1.45em}.digest li{margin:.25em 0}
.digest h1{font-size:20px;margin:.3em 0 .35em}.digest h2{font-size:18px;margin:1.1em 0 .3em}.digest h3{font-size:15px;margin:1em 0 .2em}
.digest a{color:#c8642d}.digest i,.digest em{font-style:italic}
.digest hr{border:none;border-top:1px solid #e7d9c6;margin:1.5em 0}
.digest blockquote{margin:.5em 0;padding:.35em .95em;border-left:3px solid #d9cdb8;background:#faf8f3;border-radius:0 5px 5px 0;color:#555;font-style:italic}
/* Print / Save-as-PDF: a clean one-document capture — every tab visible, interactive controls hidden. */
@media print {
  body{background:#fff}
  .site-head{position:static;border:0}
  .nav,.askbar,.headmeta{display:none !important}
  body.js .tab{display:block !important}
  .card{break-inside:avoid;box-shadow:none;border:1px solid #ddd}
  .acts,.syncbtn,.actbtn,button,.sharelink,.sharebanner a,.syncbar{display:none !important}
  details{display:block}
  details>summary{display:none}
  a{color:inherit;text-decoration:none}
}`;

/** The opening `<!doctype …><head>…` with the shared stylesheet. `title` is escaped. */
export function pageHead(title: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${SHARED_CSS}</style></head>`;
}

/**
 * The persistent section nav. On the dashboard (`home: ""`) the links are in-page hashes the tab JS
 * intercepts; on a standalone page (`home: "/"`) they're absolute `/#section` links that navigate home
 * and open the matching tab. `counts` optionally badges a section (e.g. Decide's open item count).
 * `share` carries the `?share=1` view through every link so the redacted view survives navigation.
 */
export function renderNav(active: NavId | null, opts: { home?: string; share?: boolean; counts?: Partial<Record<NavId, number>> } = {}): string {
  const home = opts.home ?? "";
  const q = opts.share ? "?share=1" : "";
  const links = NAV.map((n) => {
    const on = n.id === active ? " on" : "";
    const c = opts.counts?.[n.id];
    const badge = c && c > 0 ? `<span class="count">${c}</span>` : "";
    return `<a class="nav-link${on}" href="${home}${q}#${n.id}" data-tab="${n.id}">${escapeHtml(n.label)}${badge}</a>`;
  }).join("");
  return `<nav class="nav">${links}</nav>`;
}

/**
 * Full-document shell for the standalone deep pages (/career, /season, /digest). `active` highlights the
 * tab the page belongs to (career → Performance, season → Plan; null for the digest). `inner` is the page
 * body, already escaped by its renderer. Sub-pages are static (pure HTML/`<details>`), so no scripts ship.
 */
export function pageShell(
  opts: { title: string; active: NavId | null; share?: boolean },
  inner: string,
): string {
  return `${pageHead(opts.title)}<body>
<header class="site-head"><div class="wrap">
  <div class="brand"><h1>Endurance Coach</h1></div>
  ${renderNav(opts.active, { home: "/", share: opts.share })}
</div></header>
<main class="wrap">${inner}</main>
</body></html>`;
}
