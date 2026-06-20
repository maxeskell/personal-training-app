import { escapeHtml } from "./dashboardHelpers.js";
import type { FuelPlan, FuelSection } from "./fuelPlan.js";
import { dailySupplements, type FuelProduct } from "./fuelInventory.js";
import type { FuelLogRecord } from "./fuelLogStore.js";
import { fuelLogKey, latestFuelByDateSport } from "./fuelLogStore.js";

/**
 * Fuelling UI. The per-session plan can be surfaced two ways, sharing ONE renderer + ONE script:
 *  - folded into the "Week ahead" card as a collapsed "⛽ Fuelling" dropdown on each session row that
 *    needs it (renderWeather calls `fuelSessionInner` + `renderFuelExtras` + `fuelScript`), and
 *  - the standalone "Fuelling — next session" card (`renderFuelCard`), used as a FALLBACK when the
 *    week-ahead/weather card isn't shown (e.g. forecast unavailable, or share view).
 *
 * Deterministic (no LLM on render). All interpolated text is escaped; the one-tap buttons carry data-*
 * attributes (no quoted JS args), per the dashboard convention.
 */

const SPORT_EMOJI: Record<string, string> = { Ride: "🚴", Run: "🏃", Swim: "🏊", Strength: "🏋️", Other: "•" };

function weekdayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

function fuelHead(plan: FuelPlan): string {
  return `${escapeHtml(weekdayShort(plan.date ?? ""))} ${SPORT_EMOJI[plan.sport] ?? ""} ${escapeHtml(plan.sport)}${plan.durationMin ? ` · ${Math.round(plan.durationMin)} min` : ""}`;
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

/**
 * One session's fuelling block — the shared body used by BOTH the week-ahead dropdown and the fallback
 * card. `showHead` prints the day/sport line (the standalone card wants it; the week-ahead row already
 * shows it). Returns a single "water's fine" line when nothing's needed. The `.fuelsess` wrapper carries
 * the data-* the feedback script reads.
 */
export function fuelSessionInner(plan: FuelPlan, logged: FuelLogRecord | undefined, share: boolean, showHead: boolean): string {
  if (!plan.needed) {
    return `<div class="fdetail">${showHead ? `<b>${fuelHead(plan)}</b> — ` : ""}water's fine.</div>`;
  }
  const sections = [plan.pre, plan.during, plan.after].filter((s): s is FuelSection => !!s).map(sectionLine).join("");
  const carb = carbTargetFrom(plan);
  const acts = share
    ? ""
    : `<div class="fuelacts acts" style="margin-top:6px">${
        logged
          ? `<span class="reacted">${logged.outcome === "good" ? "👍" : "👎"} logged — ${escapeHtml(logged.outcome === "good" ? "went well" : logged.outcome)}</span>`
          : `<button class="agree" data-outcome="good" onclick="fuelFeedback(this,'good')">👍 Went well</button>` +
            `<button class="disagree" data-outcome="rough" onclick="fuelFeedback(this,'rough')">👎 Felt rough</button>` +
            `<span class="fuelreacted reacted"></span>`
      }</div>`;
  return `<div class="fuelsess" data-date="${escapeHtml(plan.date ?? "")}" data-sport="${escapeHtml(plan.sport)}" data-carb="${carb ?? ""}" data-planned="${escapeHtml(plan.summary)}">
    ${showHead ? `<div style="font-weight:600;font-size:14px;margin-bottom:3px">${fuelHead(plan)}</div>` : ""}
    ${sections}
    ${acts}
  </div>`;
}

/** Honest, static daily-supplement reference (consistency not timing). */
function dailyStackLine(inv: FuelProduct[]): string {
  const supps = dailySupplements(inv);
  if (!supps.length) return "";
  const names = supps.map((p) => escapeHtml(p.brand ? `${p.brand} ${p.name}` : p.name)).join(", ");
  return `<div class="ev"><b>Daily stack</b> (consistency, not session timing): ${names}. Evidence varies — beta-alanine helps repeated hard efforts; others lower-evidence. Not medical advice.</div>`;
}

/** The "More" disclosure: daily supplements + the on-demand learning review. "" when nothing to show / share. */
export function renderFuelExtras(inventory: FuelProduct[], hasApiKey: boolean | undefined, share: boolean): string {
  if (share) return "";
  const review = hasApiKey ? `<div style="margin-top:8px"><button class="actbtn" onclick="fuelReview()">🍌 Review my fuelling (learn from my logs)</button><div id="fuelreview"></div></div>` : "";
  const parts = [dailyStackLine(inventory), review].filter(Boolean);
  if (!parts.length) return "";
  return `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#888">More — daily supplements${hasApiKey ? " · review my fuelling" : ""}</summary><div style="margin-top:6px;display:grid;gap:6px">${parts.join("")}</div></details>`;
}

/** The fuelling handlers (feedback + review). Emitted ONCE by whichever surface hosts the plans. "" in share. */
export function fuelScript(share: boolean): string {
  if (share) return "";
  return `<script>
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
 * Standalone "Fuelling — next session" card — the FALLBACK shown when the week-ahead card isn't carrying
 * the fuelling (forecast unavailable, or share view). Shows the soonest session only. "" when nothing to show.
 */
export function renderFuelCard({ plans, inventory, fuelLog, share, hasApiKey }: FuelCardInput): string {
  const hasInventory = inventory.length > 0;
  if (!hasInventory && !plans.length) return "";

  if (!hasInventory) {
    return `<div class="card"><h2>Fuelling</h2>
      <div class="fdetail">Add the nutrition you use to <code>profile.local.yaml</code> under <code>fuelling.products</code> and I'll show the next session's fuelling here — only when it's needed. See <code>profile.example.yaml</code>.</div>
    </div>`;
  }

  const next = [...plans].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))[0];
  if (!next) return ""; // inventory but no upcoming sessions → stay quiet

  const logged = latestFuelByDateSport(fuelLog ?? []).get(fuelLogKey(next.date ?? "", next.sport));
  return `<div class="card"><h2>Fuelling — next session <span class="cat cat-fuelling">MODEL</span></h2>
    ${fuelSessionInner(next, logged, !!share, true)}
    ${renderFuelExtras(inventory, hasApiKey, !!share)}
  </div>${fuelScript(!!share)}`;
}
