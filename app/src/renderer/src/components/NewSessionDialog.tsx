import { useEffect, useRef, useState } from 'react';
import { extractJiraKey } from '@shared/jira.js';
import type { LoginSession } from '@shared/ipc.js';

export interface NewSessionTarget {
  projectId: string;
  projectName: string;
  backendId: 'claude-code' | 'codex';
}

interface Props {
  /** Open when non-null. */
  target: NewSessionTarget | null;
  onCancel: () => void;
  /** Confirm with the (possibly empty) Jira ticket and the chosen login
   *  session (null → inherit the project default). */
  onConfirm: (opts: { jiraTaskId: string; loginSessionId: string | null }) => void;
  busy: boolean;
  /** Show the Jira attribution field (telemetry on). */
  showJira: boolean;
  /** All login sessions; filtered to the target agent for the dropdown. */
  loginSessions: LoginSession[];
  /** The project's default login for this agent (null → global). Used to
   *  preselect the dropdown so "inherit" is the obvious default. */
  defaultLoginId: string | null;
}

/**
 * Prompt shown before a project-root "New Session" spawn when OTEL is
 * enabled, so the user can attribute the session to a Jira ticket.
 * Unlike the worktree flow there's no branch to auto-fill from here, so
 * the field starts empty and a blank confirm falls back to branch
 * auto-detection in the main process.
 */
export function NewSessionDialog({
  target,
  onCancel,
  onConfirm,
  busy,
  showJira,
  loginSessions,
  defaultLoginId,
}: Props): JSX.Element | null {
  const [jira, setJira] = useState('');
  // '' → inherit the project default (which itself falls back to global).
  const [loginId, setLoginId] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (target) {
      setJira('');
      setLoginId('');
      inputRef.current?.focus();
    }
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [target, onCancel]);

  if (!target) return null;

  const label = target.backendId === 'codex' ? 'Codex' : 'Claude Code';
  // Normalise a typed key to the canonical uppercase form when it looks
  // like one (e.g. "imbee-8704" → "IMBEE-8704"); otherwise pass as-is.
  const normalised = (v: string): string => extractJiraKey(v) ?? v.trim();

  const agentLogins = loginSessions.filter(
    (s) => s.agent === target.backendId && s.kind !== 'global'
  );
  const inheritLabel =
    (defaultLoginId && loginSessions.find((s) => s.id === defaultLoginId)?.name) ||
    'Global (machine login)';
  const submit = (): void =>
    onConfirm({ jiraTaskId: normalised(jira), loginSessionId: loginId || null });

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      role="presentation"
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nsd-title"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <div className="dialog-head">
          <h3 id="nsd-title">New {label} session in {target.projectName}</h3>
          <p className="dim">Starts a session in the project root.</p>
        </div>

        <div className="dialog-body">
          {agentLogins.length > 0 && (
            <label className="dialog-field">
              <span>Login</span>
              <select value={loginId} onChange={(e) => setLoginId(e.target.value)}>
                <option value="">Project default ({inheritLabel})</option>
                {agentLogins.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
              <span className="dialog-hint">
                Which login this session authenticates with. Manage logins in
                Settings → Login sessions.
              </span>
            </label>
          )}
          {showJira && (
            <label className="dialog-field">
              <span>Jira ticket (optional)</span>
              <input
                ref={inputRef}
                type="text"
                value={jira}
                onChange={(e) => setJira(e.target.value)}
                placeholder="IMBEE-8704"
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <span className="dialog-hint">
                Attributes this session's tokens, cost &amp; engaged time to a
                ticket. Blank = auto-detect from the branch, else untagged.
              </span>
            </label>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </form>
    </div>
  );
}
