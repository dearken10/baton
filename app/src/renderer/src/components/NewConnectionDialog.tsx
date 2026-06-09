import { useEffect, useState } from 'react';
import type {
  ClaudeCredsMode,
  ConnectionProbeStatus,
  ConnectionProfile,
  SshAuthMethod,
} from '@shared/ipc.js';

interface Props {
  /** Closes the dialog without creating a profile. */
  onCancel: () => void;
  /** Called after the profile was created. The parent typically
   *  selects it in the connection picker. */
  onCreated: (profile: ConnectionProfile) => void;
  busy: boolean;
}

interface ProbeState {
  status: ConnectionProbeStatus | 'idle' | 'running';
  rttMs: number | null;
  detail: string;
}

/** Format a probe state for the inline result row. */
function probeRowFor(s: ProbeState): { tone: 'ok' | 'err' | 'muted'; text: string } {
  if (s.status === 'idle')    return { tone: 'muted', text: 'Hit Test connection to verify.' };
  if (s.status === 'running') return { tone: 'muted', text: 'Probing…' };
  if (s.status === 'success') {
    return {
      tone: 'ok',
      text: `Reachable · ${s.rttMs != null ? `${s.rttMs} ms RTT` : ''}`,
    };
  }
  const label =
    s.status === 'auth_failed' ? 'Authentication failed'
    : s.status === 'unreachable' ? 'Host unreachable'
    : s.status === 'timeout' ? 'Timed out'
    : s.status === 'daemon_missing' ? 'Connected — but the remote daemon dependencies are missing'
    : 'Error';
  return { tone: 'err', text: s.detail ? `${label} — ${s.detail}` : label };
}

export function NewConnectionDialog({ onCancel, onCreated, busy }: Props): JSX.Element {
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [user, setUser] = useState('');
  const [port, setPort] = useState('22');
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>('key');
  const [authKeyPath, setAuthKeyPath] = useState('~/.ssh/id_ed25519');
  const [credsMode, setCredsMode] = useState<ClaudeCredsMode>('remote');

  const [probe, setProbe] = useState<ProbeState>({ status: 'idle', rttMs: null, detail: '' });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // Validation just for the Test/Save buttons. Name + host + user are
  // required; port must parse as a positive integer; key path is
  // required when authMethod=key.
  const parsedPort = Number(port);
  const portValid = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536;
  const baseValid =
    name.trim().length > 0
    && host.trim().length > 0
    && user.trim().length > 0
    && portValid;
  const keyValid = authMethod !== 'key' || authKeyPath.trim().length > 0;
  const canAct = baseValid && keyValid;

  async function runTest(): Promise<void> {
    if (!canAct) return;
    setProbe({ status: 'running', rttMs: null, detail: '' });
    try {
      // Round-trip via a transient row would be simplest, but it'd
      // pollute the user's profiles list if they cancel. Instead we
      // ask main to create a profile up-front only on Save & Test —
      // for a stand-alone Test we use a one-shot wrapper that creates
      // + tests + deletes. For Stage 1 we keep it pragmatic: persist
      // a temporary profile, probe it, delete it, all in this method.
      const { profile } = await window.baton.call('connection.create', {
        name: `__probe__ ${Date.now()}`,
        host: host.trim(),
        user: user.trim(),
        port: parsedPort,
        authMethod,
        ...(authMethod === 'key' ? { authKeyPath: authKeyPath.trim() } : {}),
        claudeCredsMode: credsMode,
      });
      try {
        const res = await window.baton.call('connection.test', { id: profile.id });
        setProbe({ status: res.status, rttMs: res.rttMs, detail: res.detail });
      } finally {
        // Best-effort cleanup; if it fails, the row sits in the table
        // with the __probe__ name — easy enough to spot if it happens.
        try { await window.baton.call('connection.delete', { id: profile.id }); } catch { /* ignore */ }
      }
    } catch (err) {
      setProbe({ status: 'error', rttMs: null, detail: String(err) });
    }
  }

  async function submit(): Promise<void> {
    if (!canAct) return;
    setError(null);
    setSubmitting(true);
    try {
      const { profile } = await window.baton.call('connection.create', {
        name: name.trim(),
        host: host.trim(),
        user: user.trim(),
        port: parsedPort,
        authMethod,
        ...(authMethod === 'key' ? { authKeyPath: authKeyPath.trim() } : {}),
        claudeCredsMode: credsMode,
      });
      // Probe in the background so lastStatus gets a value, but don't
      // block onCreated — the dropdown caller wants to keep moving.
      void window.baton.call('connection.test', { id: profile.id }).catch(() => { /* ignore */ });
      onCreated(profile);
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const disabled = busy || submitting;
  const row = probeRowFor(probe);

  return (
    <div className="dialog-overlay dialog-overlay-stacked" onMouseDown={onCancel}>
      <div
        className="dialog dialog-narrow"
        role="dialog"
        aria-modal="true"
        aria-label="New SSH connection"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>New SSH connection</h3>
          <p className="dim">Saved as a profile — reusable across projects.</p>
        </div>
        <div className="dialog-body">
          <label className="dialog-field">
            <span>Profile name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="dev-box"
              spellCheck={false}
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="dialog-field-row">
            <label className="dialog-field">
              <span>Host</span>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="dev-box.internal"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="dialog-field" style={{ maxWidth: 120 }}>
              <span>Port</span>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value)}
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </div>
          <label className="dialog-field">
            <span>User</span>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="kenchu"
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="dialog-field">
            <span>Auth</span>
            <select
              value={authMethod}
              onChange={(e) => setAuthMethod(e.target.value as SshAuthMethod)}
            >
              <option value="key">SSH key (-i)</option>
              <option value="agent">ssh-agent</option>
              <option value="password">Password (interactive)</option>
            </select>
          </label>
          {authMethod === 'key' ? (
            <label className="dialog-field">
              <span>Key path</span>
              <input
                type="text"
                value={authKeyPath}
                onChange={(e) => setAuthKeyPath(e.target.value)}
                placeholder="~/.ssh/id_ed25519"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="dialog-hint">
                The Mac side. ssh resolves <code>~</code> for you.
              </span>
            </label>
          ) : null}
          <label className="dialog-field">
            <span>Claude credentials on remote</span>
            <select
              value={credsMode}
              onChange={(e) => setCredsMode(e.target.value as ClaudeCredsMode)}
            >
              <option value="remote">Use the remote's existing ~/.claude/credentials</option>
              <option value="forward">Forward a token from this Mac per session</option>
            </select>
          </label>

          <div className={`probe-row probe-${row.tone}`}>
            <span className="probe-ic" aria-hidden>
              {row.tone === 'ok' ? '✓' : row.tone === 'err' ? '!' : '○'}
            </span>
            <span className="probe-text">{row.text}</span>
          </div>

          {error ? <div className="dialog-error">{error}</div> : null}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel} disabled={disabled}>
            Cancel
          </button>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            className="btn"
            onClick={() => void runTest()}
            disabled={disabled || !canAct || probe.status === 'running'}
          >
            Test connection
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={disabled || !canAct}
          >
            Save &amp; use
          </button>
        </div>
      </div>
    </div>
  );
}
