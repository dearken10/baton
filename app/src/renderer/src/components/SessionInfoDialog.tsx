import { useEffect, useRef, useState } from 'react';
import type { Session, LoginSession } from '@shared/ipc.js';
import { extractJiraKey } from '@shared/jira.js';

interface Props {
  /** Open when non-null. */
  session: Session | null;
  onClose: () => void;
  /** Called once `session.clone` succeeds with the new session, so the
   *  parent can select it in the UI. The dialog closes itself either
   *  way. Omit to hide the Clone button. */
  onCloned?: (session: Session) => void;
}

/**
 * Read-only "what is this session?" dialog. The agent's own session id
 * (Claude → `--resume <id>`, Codex → `codex resume <id>`) is the one
 * field users routinely need to copy out — e.g. to attach a different
 * frontend, or to grep transcripts on disk. Surfacing it inside the
 * app saves a trip through the row's right-click menu / the terminal.
 *
 * The backend stores both Claude and Codex session ids on the same
 * `claudeSessionId` field (the column is named after Claude for
 * historical reasons); we label the row dynamically based on backendId.
 */
export function SessionInfoDialog({ session, onClose, onCloned }: Props): JSX.Element | null {
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  // Editable Jira ticket (OTEL attribution). Draft is seeded from the
  // session and re-seeded whenever the dialog opens for a new one.
  const [jira, setJira] = useState('');
  const [savingJira, setSavingJira] = useState(false);
  const [jiraError, setJiraError] = useState<string | null>(null);
  // Login switch: available logins for this agent + the current draft.
  // '' → follow the project default (which falls back to global).
  const [logins, setLogins] = useState<LoginSession[]>([]);
  const [loginDraft, setLoginDraft] = useState('');
  const [switchingLogin, setSwitchingLogin] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Holds the latest close-request handler so the Esc listener (registered
  // before the null-session guard) can honour the unsaved-changes prompt.
  const requestCloseRef = useRef(onClose);

  // Esc to close — match the other dialogs' behaviour.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') requestCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session]);

  // Reset transient clone state when the dialog opens for a different
  // session — otherwise a leftover error from one session would haunt
  // the next.
  useEffect(() => {
    setCloning(false);
    setCloneError(null);
    setJira(session?.jiraTaskId ?? '');
    setSavingJira(false);
    setJiraError(null);
    setLoginDraft(session?.loginSessionId ?? '');
    setSwitchingLogin(false);
    setLoginError(null);
  }, [session?.id, session?.jiraTaskId, session?.loginSessionId]);

  // Load the login sessions once the dialog opens for an agent session, so
  // the dropdown can offer the alternatives to switch to.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    window.baton
      .call('loginSession.list', {})
      .then((res) => { if (!cancelled) setLogins(res.sessions); })
      .catch(() => { /* leave empty — the dropdown just won't render */ });
    return () => { cancelled = true; };
  }, [session?.id]);

  if (!session) return null;

  const backendLabel = backendLabelFor(session.backendId);
  const agentSessionLabel =
    session.backendId === 'codex' ? 'Codex session id' : 'Claude session id';
  const agentSessionId = session.claudeSessionId;
  // Cloning forks the transcript: only supported on the two agent
  // backends and only once the agent's own session id has been captured.
  const cloneSupported =
    onCloned !== undefined &&
    (session.backendId === 'claude-code' || session.backendId === 'codex');
  const canClone = cloneSupported && agentSessionId != null;
  // Jira attribution is only meaningful for agent backends (shell/mock
  // don't emit OTEL metrics).
  const isAgent = session.backendId === 'claude-code' || session.backendId === 'codex';
  const normalisedJira = extractJiraKey(jira) ?? jira.trim();
  const jiraDirty = normalisedJira !== (session.jiraTaskId ?? '');
  // Non-global logins for this agent are the switch targets; global is
  // offered via the "Project default" option.
  const agentLogins = logins.filter(
    (s) => s.agent === session.backendId && s.kind !== 'global'
  );
  const loginDirty = (loginDraft || null) !== (session.loginSessionId ?? null);
  // Unsaved edits: the Jira draft or the login draft differs from what's
  // stored. Closing (Esc / overlay / Close button) while dirty warns first.
  const dirty = (isAgent && jiraDirty) || (agentLogins.length > 0 && loginDirty);

  function requestClose(): void {
    if (dirty && !window.confirm(
      'You have unsaved changes. Close and discard your edits?'
    )) return;
    onClose();
  }
  // Keep the Esc listener pointed at the current handler (with fresh `dirty`).
  requestCloseRef.current = requestClose;

  async function handleSaveJira(): Promise<void> {
    if (!session || savingJira || !jiraDirty) return;
    setSavingJira(true);
    setJiraError(null);
    try {
      const { session: updated } = await window.baton.call('session.setJiraTaskId', {
        sessionId: session.id,
        jiraTaskId: normalisedJira,
      });
      // Mirror the resolved value: clearing the ticket persists null, but a
      // respawn may back-fill it from the branch (extractJiraKey), so the
      // stored jiraTaskId can differ from what we sent. Seeding from the
      // returned session keeps jiraDirty from sticking true.
      setJira(updated.jiraTaskId ?? '');
    } catch (err) {
      setJiraError(String(err instanceof Error ? err.message : err));
    } finally {
      setSavingJira(false);
    }
  }

  async function handleSwitchLogin(): Promise<void> {
    if (!session || switchingLogin || !loginDirty) return;
    setSwitchingLogin(true);
    setLoginError(null);
    try {
      const { session: updated } = await window.baton.call('session.setLoginSessionId', {
        sessionId: session.id,
        loginSessionId: loginDraft || null,
      });
      // Re-seed the draft from what the backend actually resolved. Picking
      // "Project default" persists null, but a respawn resolves + persists
      // the concrete default login — so session.loginSessionId may not
      // change (or land on a different id than we sent). Without mirroring
      // the resolved value here, loginDraft ('') and the stored id never
      // reconcile and the unsaved-changes prompt sticks forever. The open
      // effect's re-seed only fires when loginSessionId *changes*, so it
      // can't cover the no-op case.
      setLoginDraft(updated.loginSessionId ?? '');
    } catch (err) {
      setLoginError(String(err instanceof Error ? err.message : err));
    } finally {
      setSwitchingLogin(false);
    }
  }

  async function handleClone(): Promise<void> {
    if (!session || !onCloned || !canClone || cloning) return;
    setCloning(true);
    setCloneError(null);
    try {
      const { session: cloned } = await window.baton.call('session.clone', {
        sessionId: session.id,
      });
      onCloned(cloned);
      onClose();
    } catch (err) {
      setCloneError(String(err instanceof Error ? err.message : err));
    } finally {
      setCloning(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
      role="presentation"
    >
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sid-title"
      >
        <div className="dialog-head">
          <h3 id="sid-title">Session info</h3>
          <p className="dim">Ids are handy when resuming from the CLI.</p>
        </div>

        <div className="dialog-body">
          {isAgent && agentLogins.length > 0 ? (
            <>
              <div className="sid-row">
                <span className="sid-row-label">Login</span>
                <select
                  className="sid-row-value sid-row-input"
                  value={loginDraft}
                  onChange={(e) => setLoginDraft(e.target.value)}
                  disabled={switchingLogin}
                >
                  <option value="">Project default (Global machine login)</option>
                  {agentLogins.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="sid-row-copy"
                  onClick={() => void handleSwitchLogin()}
                  disabled={!loginDirty || switchingLogin}
                  title="Restart this session under the chosen login"
                >
                  {switchingLogin ? '…' : 'Switch'}
                </button>
              </div>
              <p className="dim" style={{ margin: '2px 0 0', fontSize: 11 }}>
                Restarts the session under the new login. Conversation history
                is preserved via <code className="mono">--resume</code>.
              </p>
              {loginError ? (
                <div className="dialog-error" role="alert">{loginError}</div>
              ) : null}
            </>
          ) : null}

          <InfoRow label="Backend"        value={backendLabel} />
          <InfoRow label="Branch"         value={session.branch} mono />
          <InfoRow label="Worktree"       value={session.worktreePath} mono copyable />
          <InfoRow label="Baton id"       value={session.id} mono copyable />
          <InfoRow
            label={agentSessionLabel}
            value={agentSessionId ?? '(not captured yet)'}
            mono={agentSessionId != null}
            copyable={agentSessionId != null}
          />
          {isAgent ? (
            <div className="sid-row">
              <span className="sid-row-label">Jira ticket</span>
              <input
                className="sid-row-value mono sid-row-input"
                type="text"
                value={jira}
                onChange={(e) => setJira(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); void handleSaveJira(); }
                }}
                placeholder="IMBEE-8704 (untagged)"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                type="button"
                className="sid-row-copy"
                onClick={() => void handleSaveJira()}
                disabled={!jiraDirty || savingJira}
                title="Update this session's Jira attribution"
              >
                {savingJira ? '…' : 'Save'}
              </button>
            </div>
          ) : null}
          {isAgent ? (
            <p className="dim" style={{ margin: '2px 0 0', fontSize: 11 }}>
              Saving restarts a running session so the new tag takes effect;
              history is preserved via <code className="mono">--resume</code>.
              Metrics already emitted keep the tag they were sent with.
            </p>
          ) : null}
          {jiraError ? (
            <div className="dialog-error" role="alert">{jiraError}</div>
          ) : null}
        </div>

        {cloneError ? (
          <div className="dialog-error" role="alert">{cloneError}</div>
        ) : null}

        <div className="dialog-actions">
          {cloneSupported ? (
            <button
              type="button"
              className="btn"
              onClick={handleClone}
              disabled={!canClone || cloning}
              title={
                canClone
                  ? 'Copy this session\'s transcript under a new id and resume it as a new session'
                  : 'Clone needs the agent session id, which is captured after the first prompt'
              }
            >
              {cloning ? 'Cloning…' : 'Clone'}
            </button>
          ) : null}
          <button type="button" className="btn primary" onClick={requestClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({
  label, value, mono, copyable,
}: { label: string; value: string; mono?: boolean; copyable?: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    if (!copyable) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => { /* clipboard unavailable — fail silent */ });
  }
  return (
    <div className="sid-row">
      <span className="sid-row-label">{label}</span>
      <span className={`sid-row-value${mono ? ' mono' : ''}`}>{value}</span>
      {copyable ? (
        <button
          type="button"
          className="sid-row-copy"
          onClick={copy}
          title="Copy to clipboard"
        >
          {copied ? '✓' : 'Copy'}
        </button>
      ) : null}
    </div>
  );
}

function backendLabelFor(id: Session['backendId']): string {
  switch (id) {
    case 'claude-code': return 'Claude Code';
    case 'codex':       return 'Codex';
    case 'shell':       return 'Shell (login)';
    case 'mock':        return 'Mock';
    default:            return id;
  }
}
