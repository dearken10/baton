/**
 * The session's Jira ticket, rendered as a leading segment on the session
 * card's meta line and on the conversation header — e.g.
 *   IMBEE-8704 · automation · feature/foo
 *
 * Renders nothing when the session has no ticket, so callers can drop it in
 * unconditionally without guarding. Includes its own trailing separator
 * because it's always a prefix to the project/branch that follow.
 */
export function JiraTag({ id }: { id: string | null | undefined }): JSX.Element | null {
  const key = id?.trim();
  if (!key) return null;
  return (
    <>
      <span className="jira-tag" title={`Jira ticket ${key}`}>{key}</span>
      <span className="jira-sep" aria-hidden>·</span>
    </>
  );
}
