interface Props {
  version: string;
  electronVersion: string;
  projectCount: number;
  sessionCount: number;
}

export function Titlebar({
  version,
  electronVersion,
  projectCount,
  sessionCount,
}: Props): JSX.Element {
  return (
    <header className="titlebar">
      <div className="brand">code24</div>
      <div className="meta">
        v{version}
        {electronVersion ? ` · Electron ${electronVersion}` : ''}
      </div>
      <div className="spacer" />
      <div className="pill variant">Layout: split</div>
      <div className="pill">{projectCount} projects</div>
      <div className="pill">{sessionCount} sessions</div>
    </header>
  );
}
