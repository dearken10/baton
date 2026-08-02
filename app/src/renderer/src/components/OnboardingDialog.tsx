import { LoginSessionsSection } from './LoginSessionsSection.js';

/**
 * First-run onboarding. Baton uses each agent's global CLI login by
 * default; this is where a new user can instead sign a separate account
 * in through the browser before starting work. Shown once — dismissing
 * it marks onboarding complete (see App / onboarding.complete).
 */
export function OnboardingDialog({
  open,
  onDone,
}: {
  open: boolean;
  onDone: () => void;
}): JSX.Element | null {
  if (!open) return null;
  return (
    <div className="dialog-overlay" role="presentation">
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="dialog-head">
          <h3 id="onboarding-title">Welcome to Baton</h3>
        </div>

        <div className="settings-panel" style={{ padding: '4px 20px 8px' }}>
          <p className="dialog-hint" style={{ marginBottom: 16 }}>
            Baton supervises your Claude Code and Codex sessions. It uses the
            logins already set up on this machine — you're ready to go. If you'd
            rather run Baton under a separate account, set that up here.
          </p>
          <LoginSessionsSection />
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn primary" onClick={onDone}>
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
