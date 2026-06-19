/** Shared HTML-escape primitive: every interpolated text on the dashboard goes through this (the
 *  escaping convention) so injected markup can't break out. Pure. */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
