import { escapeHtml } from "./dashboardHelpers.js";
import type { FuelPlan, FuelSection } from "./fuelPlan.js";
import { dailySupplements, type FuelProduct } from "./fuelInventory.js";
import type { FuelLogRecord } from "./fuelLogStore.js";
import { fuelLogKey, latestFuelByDateSport } from "./fuelLogStore.js";

/**
 * The "Fuelling — next session" dashboard card. DETERMINISTIC (no LLM on render) and deliberately SHORT:
 * it shows ONLY the soonest upcoming session's plan — pre/during/after as one line each, or a single
 * "water's fine" line when nothing's needed — with a one-tap 👍/👎 that feeds the learning loop
 * (/fuel-feedback → fuel-log.jsonl). Everything secondary (daily supplements, the assumptions, the
 * "Review my fuelling" button) sits behind one disclosure so the card stays glanceable. All interpolated
 * text is escaped; buttons carry data-* attributes (no quoted JS args), per the dashboard convention.
 */

const SPORT_EMOJI: Record<string, string> = { Ride: "🚴", Run: "🏃", Swim: "🏊", Strength: "🏋️", Other: "•" };

function weekdayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

/** Carb/hr the plan targeted (parsed back from the During line) so the feedback can record it for learning. */
function carbTargetFrom(plan: FuelPlan): number | undefined {
  const m = plan.during?.lines.find((l) => /g carb\/hr/.test(l))?.match(/~(\d+)\s*g carb\/hr/);
  return m ? Number(m[1]) : undefined;
}

/** One section as a single tight line: "**During** ~75 g carb/hr … · ~500 ml/hr …". */
function sectionLine(s: FuelSection): string {
  return `<div class="fdetail"><b>${escapeHtml(s.label)}</b> ${escapeHtml(s.lines.join(" · "))}</div>`;
}

/** Honest, static daily-supplement reference (consistency not timing) — tucked in the disclosure. */
function dailyStackLine(inv: FuelProduct[]): string {
  const supps = dailySupplements(inv);
  if (!supps.length) return "";
  const names = supps.map((p) => escapeHtml(p.brand ? `${p.brand} ${p.name}` : p.name)).join(", ");
  return `<div class="ev"><b>Daily stack</b> (consistency, not session timing): ${names}. Evidence varies — beta-alanine helps repeated hard efforts; others lower-evidence. Not medical advice.</div>`;
}

export interface FuelCardInput {
  plans: FuelPlan[];
  inventory: FuelProduct[];
  fuelLog?: FuelLogRecord[];
  share?: boolean;
  /** True when the LLM key is present, so the "Review my fuelling" button is offered. */
  hasApiKey?: boolean;
}

/**
 * Render the card, or "" when there's nothing to show. Shows the NEXT upcoming session only (the user
 * doesn't want the whole week here). The embedded <script> defines the feedback + review handlers once.
 */
export function renderFuelCard({ plans, inventory, fuelLog, share, hasApiKey }: FuelCardInput): string {
  const hasInventory = inventory.length > 0;
  if (!hasInventory && !plans.length) return "";

  // No inventory yet → a single setup nudge (the analysis can't run without the products).
  if (!hasInventory) {
    return `<div class="card"><h2>Fuelling</h2>
      <div class="fdetail">Add the nutrition you use to <code>profile.local.yaml</code> under <code>fuelling.products</code> and I'll show the next session's fuelling here — only when it's needed. See <code>profile.example.yaml</code>.</div>
    </div>`;
  }

  // The soonest upcoming session (earliest date) — and that one only.
  const next = [...plans].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))[0];
  if (!next) return ""; // inventory but no upcoming sessions → stay quiet

  const head = `${escapeHtml(weekdayShort(next.date ?? ""))} ${SPORT_EMOJI[next.sport] ?? ""} ${escapeHtml(next.sport)}${next.durationMin ? ` · ${Math.round(next.durationMin)} min` : ""}`;

  let body: string;
  if (!next.needed) {
    body = `<div class="fdetail"><b>${head}</b> — water's fine.</div>`;
  } else {
    const sections = [next.pre, next.during, next.after].filter((s): s is FuelSection => !!s).map(sectionLine).join("");
    const logged = latestFuelByDateSport(fuelLog ?? []).get(fuelLogKey(next.date ?? "", next.sport));
    const carb = carbTargetFrom(next);
    const acts = share
      ? ""
      : `<div class="fuelacts acts" style="margin-top:6px">${
          logged
            ? `<span class="reacted">${logged.outcome === "good" ? "👍" : "👎"} logged — ${escapeHtml(logged.outcome === "good" ? "went well" : logged.outcome)}</span>`
            : `<button class="agree" data-outcome="good" onclick="fuelFeedback(this,'good')">👍 Went well</button>` +
              `<button class="disagree" data-outcome="rough" onclick="fuelFeedback(this,'rough')">👎 Felt rough</button>` +
              `<span class="fuelreacted reacted"></span>`
        }</div>`;
    body = `<div class="fuelsess" data-date="${escapeHtml(next.date ?? "")}" data-sport="${escapeHtml(next.sport)}" data-carb="${carb ?? ""}" data-planned="${escapeHtml(next.summary)}">
      <div style="font-weight:600;font-size:14px;margin-bottom:3px">${head}</div>
      ${sections}
      ${acts}
    </div>`;
  }

  // Secondary content behind one disclosure so the card stays short: daily stack, the model assumptions,
  // and the on-demand learning review. Only rendered (and only off share view) when there's something in it.
  const reviewBtn = !share && hasApiKey ? `<div style="margin-top:8px"><button class="actbtn" onclick="fuelReview()">🍌 Review my fuelling (learn from my logs)</button><div id="fuelreview"></div></div>` : "";
  const detailParts = [
    dailyStackLine(inventory),
    next.needed && next.assumptions.length ? `<div class="ev">${escapeHtml(next.assumptions.join(" · "))}</div>` : "",
    reviewBtn,
  ].filter(Boolean);
  const details = !share && detailParts.length
    ? `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#888">More — daily supplements${hasApiKey ? " · review my fuelling" : ""}</summary><div style="margin-top:6px;display:grid;gap:6px">${detailParts.join("")}</div></details>`
    : "";

  const script = share
    ? ""
    : `<script>
async function fuelFeedback(btn,outcome){
  var box=btn.closest('.fuelsess');var span=box.querySelector('.fuelreacted');if(span)span.textContent='…';
  var carb=box.getAttribute('data-carb');
  try{await fetch('/fuel-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({date:box.getAttribute('data-date'),sport:box.getAttribute('data-sport'),outcome:outcome,
      carbTargetGPerHour:carb?Number(carb):undefined,planned:box.getAttribute('data-planned')})});
    box.querySelectorAll('.fuelacts button').forEach(function(b){b.disabled=true;});
    if(span)span.textContent=outcome==='good'?'👍 logged — went well':'👎 logged — felt rough';
  }catch(e){if(span)span.textContent='error';}
}
async function fuelReview(){
  var box=document.getElementById('fuelreview');box.innerHTML='<div class="k">Reviewing your fuel logs…</div>';
  try{var r=await fetch('/fuel-review',{method:'POST'});var j=await r.json();
    box.innerHTML='<div style="font-size:14px;color:#333;white-space:pre-wrap;margin-top:8px">'+mdToHtml(j.markdown||j.notes||'No review available.')+'</div>';
  }catch(e){box.innerHTML='<div class="k">Error: '+esc(''+e)+'</div>';}
}
</script>`;

  return `<div class="card"><h2>Fuelling — next session <span class="cat cat-fuelling">MODEL</span></h2>
    ${body}
    ${details}
  </div>${script}`;
}
