import { useEffect, useState } from 'react';
import type { LoginSession, Project } from '@shared/ipc.js';

/**
 * Change a project's default login sessions after creation. Mirrors the
 * "Default logins" pickers in the Add-project dialog. Persists via
 * `project.setLoginDefaults`; the store updates from the emitted
 * `project.renamed` event so open New-session dialogs pick up the change.
 */
export function EditProjectLoginsDialog({
  project,
  onClose,
}: {
  project: Project;
  onClose: () => void;
}): JSX.Element {
  const [loginSessions, setLoginSessions] = useState<LoginSession[]>([]);
  const [claudeLoginId, setClaudeLoginId] = useState(project.claudeLoginSessionId ?? '');
  const [codexLoginId, setCodexLoginId] = useState(project.codexLoginSessionId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.baton
      .call('loginSession.list', {})
      .then((r) => setLoginSessions(r.sessions))
      .catch(() => { /* dropdowns still show Global */ });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function save(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await window.baton.call('project.setLoginDefaults', {
        projectId: project.id,
        claudeLoginSessionId: claudeLoginId || null,
        codexLoginSessionId: codexLoginId || null,
      });
      onClose();
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="presentation"
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Edit project logins" style={{ maxWidth: 440 }}>
        <div className="dialog-head">
          <h3>Default logins — {project.name}</h3>
          <p className="dim">Which login new sessions in this project use by default.</p>
        </div>

        <div className="dialog-body">
          <div className="login-defaults-grid">
            <label className="dialog-field">
              <span>Claude Code</span>
              <select value={claudeLoginId} onChange={(e) => setClaudeLoginId(e.target.value)} disabled={saving}>
                <option value="">Global (machine login)</option>
                {loginSessions
                  .filter((s) => s.agent === 'claude-code' && s.kind !== 'global')
                  .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label className="dialog-field">
              <span>Codex</span>
              <select value={codexLoginId} onChange={(e) => setCodexLoginId(e.target.value)} disabled={saving}>
                <option value="">Global (machine login)</option>
                {loginSessions
                  .filter((s) => s.agent === 'codex' && s.kind !== 'global')
                  .map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
          </div>
          <span className="dialog-hint">
            Applies to new sessions. Running sessions keep the login they launched with.
            Manage logins in Settings → Login sessions.
          </span>
          {error ? <div className="dialog-error">{error}</div> : null}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
