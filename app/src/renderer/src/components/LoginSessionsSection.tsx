import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  AgentAccountId,
  AppEvent,
  AuthScheme,
  LoginKind,
  LoginSession,
  LoginSessionStatus,
} from '@shared/ipc.js';

/**
 * Login sessions — create and manage named credential profiles per agent
 * (Claude Code / Codex). Each is one of: browser sign-in, custom endpoint,
 * or a pasted token. The built-in "Global" session (the machine login) is
 * always present and can't be removed. Projects pick a default from these;
 * individual sessions can override. Shared by Settings + onboarding.
 */

const AGENTS: { id: AgentAccountId; label: string }[] = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
];

const KIND_LABEL: Record<LoginKind, string> = {
  global: 'Global',
  browser: 'Browser login',
  custom: 'Custom endpoint',
  token: 'Token',
};

interface LoginFlow {
  sessionId: string;
  loginId: string;
  agent: AgentAccountId;
  phase: 'starting' | 'browser_opened' | 'awaiting_code' | 'success' | 'error';
  url: string | null;
  message: string | null;
  account: string | null;
  code: string;
  submitting: boolean;
}

type EditorTarget =
  | { mode: 'create'; agent: AgentAccountId }
  | { mode: 'edit'; session: LoginSession };

export function LoginSessionsSection({
  onChanged,
}: {
  onChanged?: () => void;
}): JSX.Element {
  const [sessions, setSessions] = useState<LoginSession[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LoginSessionStatus>>({});
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [login, setLogin] = useState<LoginFlow | null>(null);
  const loginRef = useRef<LoginFlow | null>(null);
  loginRef.current = login;

  const reload = useCallback(async () => {
    const { sessions: list } = await window.baton.call('loginSession.list', {});
    setSessions(list);
    // Probe each in parallel — cheap enough for a settings screen.
    void Promise.all(
      list.map((s) =>
        window.baton
          .call('loginSession.probe', { id: s.id })
          .then((st) => [s.id, st] as const)
          .catch(() => [s.id, { installed: false, valid: false, label: null }] as const)
      )
    ).then((pairs) => setStatuses(Object.fromEntries(pairs)));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const off = window.baton.onEvent((e: AppEvent) => {
      if (e.type !== 'account.login_progress') return;
      const cur = loginRef.current;
      if (!cur || e.loginId !== cur.loginId) return;
      setLogin((s) =>
        s
          ? {
              ...s,
              phase: e.phase,
              url: e.url ?? s.url,
              message: e.message ?? s.message,
              account: e.account ?? s.account,
            }
          : null
      );
      if (e.phase === 'success') void reload().then(() => onChanged?.());
    });
    return off;
  }, [reload, onChanged]);

  async function startSignIn(session: LoginSession): Promise<void> {
    setLogin({
      sessionId: session.id,
      loginId: '',
      agent: session.agent,
      phase: 'starting',
      url: null,
      message: null,
      account: null,
      code: '',
      submitting: false,
    });
    try {
      const { loginId } = await window.baton.call('loginSession.loginStart', { id: session.id });
      setLogin((s) => (s && s.sessionId === session.id ? { ...s, loginId } : s));
    } catch (err) {
      setLogin((s) => (s ? { ...s, phase: 'error', message: String(err) } : s));
    }
  }

  async function submitCode(): Promise<void> {
    const cur = loginRef.current;
    if (!cur || !cur.code.trim()) return;
    setLogin((s) => (s ? { ...s, submitting: true } : s));
    try {
      await window.baton.call('loginSession.submitCode', { loginId: cur.loginId, code: cur.code.trim() });
    } catch (err) {
      setLogin((s) => (s ? { ...s, phase: 'error', message: String(err) } : s));
    }
  }

  const closeLogin = useCallback((): void => {
    const cur = loginRef.current;
    if (cur && cur.loginId && cur.phase !== 'success' && cur.phase !== 'error') {
      void window.baton.call('loginSession.cancel', { loginId: cur.loginId });
    }
    setLogin(null);
  }, []);

  async function remove(session: LoginSession): Promise<void> {
    await window.baton.call('loginSession.delete', { id: session.id });
    await reload();
    onChanged?.();
  }

  return (
    <>
      <h4 className="settings-section-title">Login sessions</h4>
      <p className="dialog-hint" style={{ marginBottom: 16 }}>
        Named logins for each agent — the machine's global login, a separate
        browser account, a pasted token, or a custom API endpoint. Projects pick
        a default from these, and individual sessions can override it.
      </p>

      {!sessions && <p className="dim">Loading…</p>}

      {sessions &&
        AGENTS.map(({ id, label }) => (
          <div key={id} className="dialog-field" style={{ gap: 6 }}>
            <span style={{ fontWeight: 600 }}>{label}</span>
            {sessions
              .filter((s) => s.agent === id)
              .map((s) => (
                <LoginRow
                  key={s.id}
                  session={s}
                  status={statuses[s.id]}
                  onSignIn={() => void startSignIn(s)}
                  onEdit={() => setEditor({ mode: 'edit', session: s })}
                  onDelete={() => void remove(s)}
                />
              ))}
            <div>
              <button
                type="button"
                className="btn ghost"
                style={{ marginTop: 4 }}
                onClick={() => setEditor({ mode: 'create', agent: id })}
              >
                + Add {label} login
              </button>
            </div>
          </div>
        ))}

      {editor && (
        <LoginEditor
          target={editor}
          onClose={() => setEditor(null)}
          onSaved={(created) => {
            setEditor(null);
            void reload().then(() => {
              onChanged?.();
              // Fresh browser sessions have nothing signed in yet — jump
              // straight into the sign-in flow.
              if (created && created.kind === 'browser') void startSignIn(created);
            });
          }}
        />
      )}

      {login && (
        <LoginModal
          login={login}
          onCode={(code) => setLogin((s) => (s ? { ...s, code } : s))}
          onSubmit={() => void submitCode()}
          onClose={closeLogin}
        />
      )}
    </>
  );
}

function LoginRow({
  session,
  status,
  onSignIn,
  onEdit,
  onDelete,
}: {
  session: LoginSession;
  status: LoginSessionStatus | undefined;
  onSignIn: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): JSX.Element {
  const statusText = !status
    ? '…'
    : !status.installed
      ? 'CLI not installed'
      : status.valid
        ? `ready${status.label ? ` — ${status.label}` : ''}`
        : session.kind === 'browser'
          ? 'not signed in'
          : session.kind === 'global'
            ? 'not signed in'
            : 'not configured';

  return (
    <div className="login-row">
      <div className="login-row-main">
        <span className="login-row-name">{session.name}</span>
        <span className="login-kind-badge">{KIND_LABEL[session.kind]}</span>
        {session.builtIn && <span className="login-kind-badge">built-in</span>}
      </div>
      <span className="dialog-hint login-row-status">{statusText}</span>
      <div className="login-row-actions">
        {session.kind === 'browser' && (
          <button type="button" className="linklike" onClick={onSignIn}>
            {status?.valid ? 'Re-sign in' : 'Sign in'}
          </button>
        )}
        {(session.kind === 'custom' || session.kind === 'token') && (
          <button type="button" className="linklike" onClick={onEdit}>
            Edit
          </button>
        )}
        {session.builtIn ? (
          <button type="button" className="linklike" onClick={onEdit}>
            Rename
          </button>
        ) : (
          <button type="button" className="linklike" onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function LoginEditor({
  target,
  onClose,
  onSaved,
}: {
  target: EditorTarget;
  onClose: () => void;
  onSaved: (created: LoginSession | null) => void;
}): JSX.Element {
  const isEdit = target.mode === 'edit';
  const editing = isEdit ? target.session : null;
  const agent = isEdit ? target.session.agent : target.agent;
  const isClaude = agent === 'claude-code';

  const [name, setName] = useState(editing?.name ?? '');
  const [kind, setKind] = useState<LoginKind>(editing?.kind ?? 'browser');
  const [baseUrl, setBaseUrl] = useState(editing?.custom?.baseUrl ?? '');
  const [authScheme, setAuthScheme] = useState<AuthScheme>(editing?.custom?.authScheme ?? 'apikey');
  const [model, setModel] = useState(editing?.custom?.model ?? '');
  const [headers, setHeaders] = useState(editing?.custom?.headers ?? '');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Built-in globals only allow a rename.
  const lockedKind = !!editing?.builtIn || isEdit;

  async function save(): Promise<void> {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (kind === 'custom' && !baseUrl.trim()) {
      setError('Base URL is required for a custom endpoint.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) {
        const req: Record<string, unknown> = { id: editing!.id, name: name.trim() };
        if (editing!.kind === 'custom') {
          req.baseUrl = baseUrl.trim();
          req.authScheme = authScheme;
          req.model = model.trim() || null;
          req.headers = isClaude ? headers.trim() || null : null;
        }
        if ((editing!.kind === 'custom' || editing!.kind === 'token') && secret) {
          req.secret = secret;
        }
        await window.baton.call('loginSession.update', req as never);
        onSaved(null);
      } else {
        const req: Record<string, unknown> = { agent, kind, name: name.trim() };
        if (kind === 'custom') {
          req.baseUrl = baseUrl.trim();
          req.authScheme = authScheme;
          req.model = model.trim() || null;
          req.headers = isClaude ? headers.trim() || null : null;
        }
        if ((kind === 'custom' || kind === 'token') && secret) req.secret = secret;
        const { session } = await window.baton.call('loginSession.create', req as never);
        onSaved(session);
      }
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
      setSaving(false);
    }
  }

  const tokenHint = isClaude ? (
    <>
      Run <code className="mono">claude setup-token</code> in a terminal to
      generate a long-lived token, then paste it here. Sets{' '}
      <code className="mono">ANTHROPIC_AUTH_TOKEN</code>.
    </>
  ) : (
    <>
      Paste an OpenAI API key (<code className="mono">sk-…</code> from
      platform.openai.com). Sets <code className="mono">OPENAI_API_KEY</code>.
    </>
  );

  return (
    <div className="dialog-overlay" role="presentation" style={{ zIndex: 60 }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="dialog-head">
          <h3>{isEdit ? `Edit ${editing!.name}` : `Add ${isClaude ? 'Claude Code' : 'Codex'} login`}</h3>
        </div>

        <div style={{ padding: '4px 4px 8px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label className="dialog-field">
            <span>Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Work account"
              autoFocus
            />
          </label>

          {!lockedKind && (
            <label className="dialog-field">
              <span>Type</span>
              <div className="seg" role="group" aria-label="Login type">
                {(['browser', 'token', 'custom'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={kind === k ? 'active' : ''}
                    onClick={() => setKind(k)}
                  >
                    {KIND_LABEL[k]}
                  </button>
                ))}
              </div>
            </label>
          )}

          {(isEdit ? editing!.kind : kind) === 'browser' && (
            <p className="dialog-hint">
              You'll sign in through the browser after saving. The account is
              kept in its own config dir, separate from your global login.
            </p>
          )}

          {(isEdit ? editing!.kind : kind) === 'custom' && (
            <>
              <label className="dialog-field">
                <span>Base URL</span>
                <input
                  type="text"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={isClaude ? 'https://gateway.example.com' : 'https://gateway.example.com/v1'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <span className="dialog-hint">
                  {isClaude ? (
                    <>Sets <code className="mono">ANTHROPIC_BASE_URL</code>.</>
                  ) : (
                    <>Sets <code className="mono">OPENAI_BASE_URL</code>. Must be OpenAI Responses-API compatible.</>
                  )}
                </span>
              </label>
              {isClaude && (
                <label className="dialog-field">
                  <span>Auth scheme</span>
                  <div className="seg" role="group" aria-label="Auth scheme">
                    <button type="button" className={authScheme === 'apikey' ? 'active' : ''} onClick={() => setAuthScheme('apikey')}>
                      API key
                    </button>
                    <button type="button" className={authScheme === 'token' ? 'active' : ''} onClick={() => setAuthScheme('token')}>
                      Bearer token
                    </button>
                  </div>
                </label>
              )}
              <label className="dialog-field">
                <span>{isClaude && authScheme === 'token' ? 'Auth token' : 'API key'}</span>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={editing?.hasSecret ? '•••••••• (unchanged)' : 'Paste your key/token'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
                <span className="dialog-hint">Stored encrypted in your OS keychain.</span>
              </label>
              <label className="dialog-field">
                <span>Model (optional)</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={isClaude ? 'e.g. claude-opus-4-8' : 'e.g. gpt-5.1'}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                />
              </label>
              {isClaude && (
                <label className="dialog-field">
                  <span>Custom headers (optional)</span>
                  <input
                    type="text"
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                    placeholder="X-Tenant: acme"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                  <span className="dialog-hint">
                    → <code className="mono">ANTHROPIC_CUSTOM_HEADERS</code>.
                  </span>
                </label>
              )}
            </>
          )}

          {(isEdit ? editing!.kind : kind) === 'token' && (
            <label className="dialog-field">
              <span>Token</span>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={editing?.hasSecret ? '•••••••• (unchanged)' : 'Paste your token'}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <span className="dialog-hint">{tokenHint} Stored encrypted in your OS keychain.</span>
            </label>
          )}

          {error && (
            <p className="dialog-hint" style={{ color: 'var(--danger, #e5484d)' }}>{error}</p>
          )}
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginModal({
  login,
  onCode,
  onSubmit,
  onClose,
}: {
  login: LoginFlow;
  onCode: (code: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}): JSX.Element {
  const agentLabel = login.agent === 'claude-code' ? 'Claude' : 'Codex';
  const done = login.phase === 'success' || login.phase === 'error';

  const phase = login.phase;
  useEffect(() => {
    if (phase !== 'success') return;
    const t = setTimeout(onClose, 1600);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  return (
    <div className="dialog-overlay" role="presentation" style={{ zIndex: 70 }}>
      <div className="dialog" role="dialog" aria-modal="true" style={{ maxWidth: 460 }}>
        <div className="dialog-head">
          <h3>Sign in to {agentLabel}</h3>
        </div>
        <div style={{ padding: '4px 4px 8px' }}>
          {login.phase === 'starting' && <p className="dim">Starting sign-in…</p>}
          {login.phase === 'browser_opened' && (
            <>
              <p>🌐 A browser window opened for sign-in.</p>
              <p className="dialog-hint">Waiting for you to authorize…</p>
              {login.url && (
                <p className="dialog-hint">
                  Didn't open?{' '}
                  <a href={login.url} target="_blank" rel="noreferrer">Open the sign-in page</a>.
                </p>
              )}
            </>
          )}
          {login.phase === 'awaiting_code' && (
            <>
              <p>After authorizing, paste the code from the browser here:</p>
              <input
                type="text"
                value={login.code}
                onChange={(e) => onCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') onSubmit(); }}
                placeholder="Authorization code"
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                style={{ width: '100%', marginTop: 8 }}
              />
            </>
          )}
          {login.phase === 'success' && (
            <p>✓ Signed in{login.account ? ` as ${login.account}` : ''}.</p>
          )}
          {login.phase === 'error' && (
            <p style={{ color: 'var(--danger, #e5484d)' }}>
              Sign-in failed{login.message ? `: ${login.message}` : '.'}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          {login.phase === 'awaiting_code' && (
            <button type="button" className="btn primary" onClick={onSubmit} disabled={!login.code.trim() || login.submitting}>
              {login.submitting ? 'Submitting…' : 'Submit code'}
            </button>
          )}
          <button type="button" className="btn ghost" onClick={onClose}>
            {done ? 'Close' : 'Cancel'}
          </button>
        </div>
      </div>
    </div>
  );
}
