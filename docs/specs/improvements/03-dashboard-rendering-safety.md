# Spec 3 — Dashboard rendering safety (escaping + handler robustness)

**Status:** ✅ landed on `main` (reconciled 2026-06-22) · **Priority:** P0 (release gate) · **Size:** S (≈½ day) · **Owner:** TBD

## Problem
`src/coach/dashboard.ts` builds a large HTML+inline-JS string. Event-handler args are produced by **string
concatenation** through `escapeHtml`, which escapes only `& < > "` — **not `'` or `\`**. So:
- A finding titled *"athlete's threshold…"* terminates the JS string early and **breaks the feedback buttons**
  (this is live — same class as the proposal-button bug just fixed via `data-id`).
- A `\`, `</script>`, or quote+paren in LLM/external text can **inject arbitrary JS** (one bad literal disables
  every handler on the page, since they share one document).
- Race-goal fields (`event_name`, `priority`, sport) are interpolated **without any escaping**.

## Goals
- No user/LLM/external string can break a handler or inject markup/JS.
- One malformed value never disables the whole page.

## Non-goals
- Visual redesign (covered elsewhere).

## Current behaviour (file:line)
- `dashboard.ts:~147–149` feedback `onclick="feedback(this,'agree','${escapeHtml(key)}','${escapeHtml(f.title)}')"`.
- `dashboard.ts:~417` `escapeHtml` escapes `& < > "` only; client-side `esc` (≈line 436) duplicates the same gap.
- `dashboard.ts:~344` race rows interpolate `g.event_name`, `g.event_date`, `String(g.priority)` raw.

## Proposed design
1. **Stop putting data in inline-handler arguments.** Emit values as **HTML-escaped `data-*` attributes** and use
   **delegated listeners** (one `addEventListener` per action that reads `event.target.closest('[data-…]').dataset`).
   The proposal buttons already moved to `data-id`; apply the same to feedback (`data-key`, and read the title from
   the DOM, not an arg).
2. **Single shared escaper util** (`src/util/html.ts`): `escapeHtml` (incl. `'` → `&#39;`) and, if any inline-JS
   string interpolation must remain, a `jsString()` escaper (`\ ' " </ \n \r    `). Import in both the
   server renderer and the (inlined) client helper so they can't drift.
3. **Escape every external field**: wrap `event_name`/`priority`/sport/labels in `escapeHtml`.
4. Keep the existing **CI test** that `new Function()`-compiles every inline `<script>`, and extend it with a
   fixture finding/title containing `'`, `"`, `\`, `</script>` to prove handlers still parse and the values render literally.

## Acceptance criteria
- Rendering a finding titled `O'Brien "5x3'" \ </script>` produces valid scripts (test passes), the feedback
  buttons work, and the text appears literally (no injection, no broken handlers).
- Race goal `<b>Hack</b>` renders as text, not markup.
- No inline `onclick` passes a quoted string argument built from data.

## Test plan
- Extend `test/dashboard.test.ts`: render with the adversarial title/goal above; assert all `<script>` blocks
  compile, assert the raw string isn't present unescaped, assert `data-*` carries the key.

## Risks
- Low. Pure rendering change; the script-compile test guards regressions.
