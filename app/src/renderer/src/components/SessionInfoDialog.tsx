import { useEffect, useState } from 'react';
import type { Session } from '@shared/ipc.js';

interface Props {
  /** Open when non-null. */
  session: Session | null;
  onClose: () => void;
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
export function SessionInfoDialog({ session, onClose }: Props): JSX.Element | null {
  // Esc to close — match the other dialogs' behaviour.
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [session, onClose]);

  if (!session) return null;

  const backendLabel = backendLabelFor(session.backendId);
  const agentSessionLabel =
    session.backendId === 'codex' ? 'Codex session id' : 'Claude session id';
  const agentSessionId = session.claudeSessionId;

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
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
          <p className="dim">Read-only — useful when resuming from the CLI.</p>
        </div>

        <div className="dialog-body">
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
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onClose}>
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
