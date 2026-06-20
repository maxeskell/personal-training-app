import { escapeHtml } from "./dashboardHelpers.js";
import type { FuelPlan, FuelSection } from "./fuelPlan.js";
import { dailySupplements, type FuelProduct } from "./fuelInventory.js";
import type { FuelLogRecord } from "./fuelLogStore.js";
import { fuelLogKey, latestFuelByDateSport } from "./fuelLogStore.js";

/**
 * The "Fuelling — week ahead" dashboard card. DETERMINISTIC (no LLM on render): it renders the per-session
 * plans built by fuelPlan.ts, honouring the only-what-you-need rule — sessions that need nothing are
 * collapsed to one muted line, the ones that matter get pre/during/after with a one-tap 👍/👎 that feeds
 * the learning loop (/fuel-feedback → fuel-log.jsonl). All interpolated text is escaped; the buttons carry
 * data-* attributes (no quoted JS args), per the dashboard escaping convention.
 */

const SPORT_EMOJI: Record<string, string> = { Ride: "🚴", Run: "🏃", Swim: "🏊", Strength: "🏋️", Other: "•" };

function weekdayShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
}

function renderSection(s: FuelSection): string {
  const items = s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");
  return `<div class="fuelsec"><span class="fuellabel">${escapeHtml(s.label)}</span><ul style="margin:2px 0 6px 0;padding-left:18px">${items}</ul></div>`;
}

/** Carb/hr the plan targeted (parsed back from the During line) so the feedback can record it for learning. */
function carbTargetFrom(plan: FuelPlan): number | undefined {
  const line = plan.during?.lines.find((l) => /g carb\/hr/.test(l));
  const m = line?.match(/~(\d+)\s*g carb\/hr/);
  return m ? Number(m[1]) : undefined;
}

function renderNeeded(plan: FuelPlan, logged: FuelLogRecord | undefined, share: boolean): string {
  const head = `${escapeHtml(weekdayShort(plan.date ?? ""))} ${SPORT_EMOJI[plan.sport] ?? ""} ${escapeHtml(plan.sport)}${plan.durationMin ? ` · ${Math.round(plan.durationMin)} min` : ""}`;
  const sections = [plan.pre, plan.during, plan.after].filter((s): s is FuelSection => !!s).map(renderSection).join("");
  const assumptions = plan.assumptions.length ? `<div class="ev">${escapeHtml(plan.assumptions.join(" · "))}</div>` : "";
  const carb = carbTargetFrom(plan);
  // One-tap feedback (hidden in share view — it's an interactive control with a live server behind it).
  const loggedBadge = logged ? `${logged.outcome === "good" ? "👍" : "👎"} logged — ${escapeHtml(logged.outcome === "good" ? "went well" : logged.outcome)}` : "";
  const acts = share
    ? ""
    : `<div class="fuelacts acts">${
        logged
          ? `<span class="reacted">${loggedBadge}</span>`
          : `<span class="k" style="margin-right:4px">How did it go?</span>` +
            `<button class="agree" data-outcome="good" onclick="fuelFeedback(this,'good')">👍 Went well</button>` +
            `<button class="disagree" data-outcome="rough" onclick="fuelFeedback(this,'rough')">👎 Felt rough</button>` +
            `<span class="fuelreacted reacted"></span>`
      }</div>`;
  return `<div class="fuelsess" data-date="${escapeHtml(plan.date ?? "")}" data-sport="${escapeHtml(plan.sport)}" data-carb="${carb ?? ""}" data-planned="${escapeHtml(plan.summary)}"
      style="border-top:1px solid #f0ede5;padding:9px 0">
    <div style="font-weight:600;font-size:14px">${head}</div>
    ${sections}
    ${assumptions}
    ${acts}
  </div>`;
}

/** Honest, static daily-supplement reference (consistency not timing) — never a per-session nag. */
function renderDailyStack(inv: FuelProduct[]): string {
  const supps = dailySupplements(inv);
  if (!supps.length) return "";
  const names = supps.map((p) => escapeHtml(p.brand ? `${p.brand} ${p.name}` : p.name)).join(", ");
  return `<div class="ev" style="margin-top:10px;border-top:1px solid #f0ede5;padding-top:8px">
    <b>Daily stack</b> (consistency, not session timing): ${names}.
    Evidence varies — beta-alanine helps repeated hard efforts (needs weeks of loading); others are lower-evidence. Not medical advice.</div>`;
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
 * Render the card, or "" when there's nothing to show (no inventory AND no upcoming sessions) — so it
 * stays quiet rather than nagging. The embedded <script> defines the feedback + review handlers once.
 */
export function renderFuelCard({ plans, inventory, fuelLog, share, hasApiKey }: FuelCardInput): string {
  const hasInventory = inventory.length > 0;
  if (!hasInventory && !plans.length) return "";

  // No inventory yet → a single setup nudge (the analysis can't run without the products).
  if (!hasInventory) {
    return `<div class="card"><h2>Fuelling — week ahead</h2>
      <div class="fdetail">Add the nutrition you use to <code>profile.local.yaml</code> under <code>fuelling.products</code> and I'll give per-session pre/during/after guidance here — only when a session actually needs it. See <code>profile.example.yaml</code> for the format.</div>
    </div>`;
  }

  const logged = latestFuelByDateSport(fuelLog ?? []);
  const needed = plans.filter((p) => p.needed);
  const quiet = plans.filter((p) => !p.needed);

  const neededHtml = needed.map((p) => renderNeeded(p, logged.get(fuelLogKey(p.date ?? "", p.sport)), !!share)).join("");
  const quietLine = quiet.length
    ? `<div class="k" style="margin-top:8px">Nothing needed (water's fine): ${quiet
        .map((p) => `${escapeHtml(weekdayShort(p.date ?? ""))} ${escapeHtml(p.sport.toLowerCase())}`)
        .join(", ")}.</div>`
    : "";
  const emptyWeek = !plans.length ? `<div class="muted">No upcoming sessions in the plan to fuel for.</div>` : "";

  // "Review my fuelling" — the on-demand learning pass (LLM). Hidden in share view + when no key.
  const reviewBtn =
    share || !hasApiKey
      ? ""
      : `<div style="margin-top:12px"><button class="actbtn" onclick="fuelReview()">🍌 Review my fuelling (learn from my logs)</button><div id="fuelreview"></div></div>`;

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

  return `<div class="card"><h2>Fuelling — week ahead <span class="cat cat-fuelling">MODEL</span></h2>
    <div class="k" style="margin-bottom:4px">Per-session pre / during / after — only where it matters. Estimates; gut-train new carb rates.</div>
    ${neededHtml || emptyWeek}
    ${quietLine}
    ${renderDailyStack(inventory)}
    ${reviewBtn}
  </div>${script}`;
}
