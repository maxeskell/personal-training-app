/**
 * Strip anything token-shaped from a string before it reaches a log, an MCP response, or a notification.
 * Pure + dependency-free so it can sit on the hot error paths (the AI Endurance / intervals spines,
 * the MCP HTTP error boundary) without risking an import cycle with health.ts.
 */
export function redactSecrets(s: string): string {
  return s
    .replace(/\b(sk-ant-[A-Za-z0-9_-]{6,})\b/g, "sk-ant-***")
    .replace(/\b(gh[opsu]_[A-Za-z0-9]{6,})\b/g, "gh*_***")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, "Bearer ***")
    .replace(/("?(?:access_token|refresh_token|api_key)"?\s*[:=]\s*)"?[A-Za-z0-9._-]{8,}"?/gi, "$1***");
}
