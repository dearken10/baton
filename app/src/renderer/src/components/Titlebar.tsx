import { UsageMeters } from './UsageBars.js';

interface Props {
  version: string;
  onOpenSettings: () => void;
}

export function Titlebar({ version, onOpenSettings }: Props): JSX.Element {
  // The lifetime-total tokens chip used to live here too, but with
  // the rolling 5h/7d bars it became redundant. Per-session totals
  // still appear on the session chip in the left column (PRD F11.1).
  return (
    <header className="titlebar">
      <div className="brand">baton</div>
      <div className="meta">v{version}</div>
      <div className="spacer" />
      <UsageMeters />
      <button
        type="button"
        className="theme-toggle"
        onClick={onOpenSettings}
        title="Settings"
        aria-label="Settings"
      >
        ⚙
      </button>
    </header>
  );
}
