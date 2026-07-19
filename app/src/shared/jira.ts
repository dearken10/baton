/**
 * Jira issue-key helpers, shared by main + renderer.
 *
 * Our branch convention encodes the ticket in the branch name (e.g.
 * `feature/IMBEE-8704-fix-retries`). The new-session flow auto-detects
 * the key from the branch so telemetry can attribute engaged time / cost
 * to a ticket with zero friction (see OTEL wiring in sessionManager).
 */

/** Extract a Jira issue key (e.g. "IMBEE-1234") from an arbitrary string
 *  such as a git branch name. Case-insensitive; returns the key
 *  uppercased, or null when the string contains none. */
export function extractJiraKey(s: string): string | null {
  const m = s.match(/[A-Z][A-Z0-9]+-\d+/i);
  return m ? m[0].toUpperCase() : null;
}
