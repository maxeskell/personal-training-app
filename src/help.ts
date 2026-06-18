/**
 * `npm run help` — the curated "everyday" commands, so a newcomer running `npm run` isn't met with a
 * wall of 70+ scripts. Pure (returns the text) so it's testable; the full surface is docs/commands.md.
 */
export function helpText(): string {
  return [
    "Endurance Coach — common commands (full list: docs/commands.md)",
    "",
    "  First time:",
    "    npm run setup        guided setup — writes your .env (key, units, location)",
    "    npm run auth:aie     connect AI Endurance (one-time browser login)",
    "",
    "  Every day:",
    "    npm start            run the coach (dashboard server) — open the printed localhost link",
    "    npm run demo         see the dashboard on sample data (no account/key)",
    "    npm run readiness    today's green / amber / red verdict, with cited reasons",
    "    npm run weekly       weekly review → a saved report",
    "    npm run tune         the small, easy wins to apply this week",
    '    npm run ask -- "..." ask your own data',
    "",
    "  Good to know:",
    "    npm run dashboard    one-off glanceable HTML (add --share for a redacted screenshot view)",
    "    npm run cost         what you've spent on the AI write-ups",
    "    npm run doctor       health check (creds, key, tokens)",
    "",
    "  → Race prep, gated plan changes, deep dives, the research/knowledge refresh, the Claude MCP",
    "    server, archiving and scheduling are all in docs/commands.md.",
  ].join("\n");
}
