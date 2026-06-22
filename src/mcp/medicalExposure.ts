/**
 * Defence-in-depth gate for whether the athlete's MEDICAL context — medication + dose cycle, blood
 * panels, date of birth — is exposed on the current surface.
 *
 * Local, full-trust surfaces leave this ON (the default): the stdio MCP server, the CLI and the LAN
 * dashboard all run as the user, on the user's own data, and the coach genuinely needs the GLP-1 dose
 * cycle / blood flags to coach well — and `get_profile` there is the user reading their own profile.
 *
 * The internet-facing HTTP/Cowork MCP surface (`mcpHttp.ts`) turns it OFF unless the operator opts in
 * with `COACH_MCP_EXPOSE_MEDICAL=true`, so a bearer-token holder on that surface can neither read the
 * medical detail via `get_profile` nor have it laundered into an LLM coaching prompt.
 *
 * Process-global on purpose: each entrypoint is its own process and sets this once at startup.
 */
let exposed = true;

/** Set by the entrypoint at startup (HTTP: from COACH_MCP_EXPOSE_MEDICAL; stdio/CLI/dashboard: true). */
export function setMedicalExposure(value: boolean): void {
  exposed = value;
}

/** Whether medical context may be rendered on this surface. */
export function medicalExposed(): boolean {
  return exposed;
}
