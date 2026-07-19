import { useEffect, useRef, useState } from 'react';
import type { OtelSettings } from '@shared/ipc.js';
import { setTheme, useTheme, type Theme } from '../lib/theme.js';

interface Props {
  open: boolean;
  onClose: () => void;
}

/** The settings sections, in nav order. Add a new entry here (plus a
 *  branch in the panel switch below) to grow the surface — this is the
 *  single home for all app settings. */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'telemetry', label: 'Telemetry' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

const EMPTY_OTEL: OtelSettings = {
  enabled: false,
  endpoint: '',
  protocol: 'grpc',
  userEmail: '',
  headers: '',
};

/**
 * App settings modal — the canonical home for all preferences.
 *
 * Two-tier persistence (see docs/settings-prd.md):
 *   - Renderer-local prefs (theme) apply + persist instantly to
 *     localStorage; no Save needed, no round-trip flash.
 *   - Main-persisted settings (OTEL) load over IPC and commit on Save.
 */
export function SettingsDialog({ open, onClose }: Props): JSX.Element | null {
  const [active, setActive] = useState<SectionId>('appearance');
  const [otel, setOtel] = useState<OtelSettings>(EMPTY_OTEL);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const theme = useTheme();
  const firstFieldRef = useRef<HTMLButtonElement | null>(null);

  // Load main-persisted settings each time the dialog opens so it
  // reflects out-of-band changes (and never shows a stale draft).
  useEffect(() => {
    if (!open) return;
    setError(null);
    setLoaded(false);
    window.baton
      .call('settings.getOtel', {})
      .then((r) => {
        setOtel(r.otel);
        setLoaded(true);
      })
      .catch((e) => setError(`Failed to load settings: ${String(e)}`));
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) firstFieldRef.current?.focus();
  }, [open]);

  if (!open) return null;

  async function saveOtel(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const { otel: saved } = await window.baton.call('settings.setOtel', {
        enabled: otel.enabled,
        endpoint: otel.endpoint.trim(),
        protocol: otel.protocol,
        userEmail: otel.userEmail.trim(),
        headers: otel.headers.trim(),
      });
      setOtel(saved);
      onClose();
    } catch (e) {
      setError(`Failed to save: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="dialog-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="presentation"
    >
      <div
        className="dialog settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <div className="dialog-head">
          <h3 id="settings-title">Settings</h3>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings sections">
            {SECTIONS.map((s, i) => (
              <button
                key={s.id}
                ref={i === 0 ? firstFieldRef : undefined}
                type="button"
                className={active === s.id ? 'active' : ''}
                onClick={() => setActive(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-panel">
            {active === 'appearance' && (
              <AppearanceSection theme={theme} onSetTheme={setTheme} />
            )}
            {active === 'telemetry' && (
              <TelemetrySection otel={otel} setOtel={setOtel} disabled={!loaded} />
            )}
            {error && (
              <p className="dim" style={{ color: 'var(--danger, #e5484d)', marginTop: 12 }}>
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Close
          </button>
          {active === 'telemetry' && (
            <button
              type="button"
              className="btn primary"
              onClick={() => void saveOtel()}
              disabled={!loaded || saving}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AppearanceSection({
  theme,
  onSetTheme,
}: {
  theme: Theme;
  onSetTheme: (t: Theme) => void;
}): JSX.Element {
  return (
    <>
      <h4 className="settings-section-title">Appearance</h4>
      <div className="dialog-field">
        <span>Theme</span>
        <div className="seg" role="group" aria-label="Theme">
          {(['light', 'dark'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={theme === t ? 'active' : ''}
              onClick={() => onSetTheme(t)}
            >
              {t === 'light' ? '☾ Light' : '☀ Dark'}
            </button>
          ))}
        </div>
        <span className="dialog-hint">Applies instantly and is remembered on this machine.</span>
      </div>
    </>
  );
}

function TelemetrySection({
  otel,
  setOtel,
  disabled,
}: {
  otel: OtelSettings;
  setOtel: React.Dispatch<React.SetStateAction<OtelSettings>>;
  disabled: boolean;
}): JSX.Element {
  const off = disabled || !otel.enabled;
  return (
    <>
      <h4 className="settings-section-title">Telemetry (OpenTelemetry)</h4>
      <p className="dialog-hint" style={{ marginBottom: 12 }}>
        Exports token / cost / active-time metrics for spawned agents to your
        team's collector, attributed per Jira ticket. Metrics only — no prompt
        or code content leaves the machine.
      </p>

      <label className="dialog-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={otel.enabled}
          onChange={(e) => setOtel((o) => ({ ...o, enabled: e.target.checked }))}
          disabled={disabled}
          style={{ width: 'auto' }}
        />
        <span>Enable OpenTelemetry export</span>
      </label>

      <label className="dialog-field">
        <span>Collector endpoint (OTLP)</span>
        <input
          type="text"
          value={otel.endpoint}
          onChange={(e) => setOtel((o) => ({ ...o, endpoint: e.target.value }))}
          placeholder="http://collector.host:4317"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={off}
        />
        <span className="dialog-hint">
          Your team's OTEL Collector. gRPC uses :4317, http/protobuf :4318.
        </span>
      </label>

      <label className="dialog-field">
        <span>Auth headers (optional)</span>
        <input
          type="text"
          value={otel.headers}
          onChange={(e) => setOtel((o) => ({ ...o, headers: e.target.value }))}
          placeholder="Authorization=Bearer <token>"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={off}
        />
        <span className="dialog-hint">
          Only for collectors that require auth (SaaS / gateway). Comma-separated{' '}
          <code className="mono">key=value</code> pairs → <code className="mono">OTEL_EXPORTER_OTLP_HEADERS</code>.
          Leave blank for an in-network collector.
        </span>
      </label>

      <label className="dialog-field">
        <span>Protocol</span>
        <select
          value={otel.protocol}
          onChange={(e) =>
            setOtel((o) => ({ ...o, protocol: e.target.value as OtelSettings['protocol'] }))
          }
          disabled={off}
        >
          <option value="grpc">grpc</option>
          <option value="http/protobuf">http/protobuf</option>
        </select>
      </label>

      <label className="dialog-field">
        <span>Your email</span>
        <input
          type="text"
          value={otel.userEmail}
          onChange={(e) => setOtel((o) => ({ ...o, userEmail: e.target.value }))}
          placeholder="you@imbee.io"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={off}
        />
        <span className="dialog-hint">
          Stamped as the <code className="mono">user</code> attribute on every metric.
        </span>
      </label>

      <p className="dialog-hint" style={{ marginTop: 4 }}>
        Changes take effect on the next session spawn — running sessions keep
        the config they launched with.
      </p>
    </>
  );
}
