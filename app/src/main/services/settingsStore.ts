/**
 * App-wide settings, persisted in the SQLite `settings` key/value table.
 *
 * Currently just the OTEL telemetry config (see OtelSettings in
 * src/shared/ipc.ts). Stored as a single JSON blob under the `otel` key
 * so the shape can evolve without schema migrations.
 */

import { getDatabase } from '../database/index.js';
import { OtelSettings } from '../../shared/ipc.js';

const OTEL_KEY = 'otel';
const ONBOARDED_KEY = 'onboarded';

/** Initial OTEL config for a fresh install. Seeds endpoint/protocol from
 *  the ambient OTEL_* env when present so an operator can pre-point the
 *  app at the team collector via the environment rather than hardcoding a
 *  host here. Telemetry stays OFF until the user opts in. */
function defaultOtelSettings(): OtelSettings {
  const endpoint = process.env['OTEL_EXPORTER_OTLP_ENDPOINT'] ?? '';
  const protocol =
    process.env['OTEL_EXPORTER_OTLP_PROTOCOL'] === 'http/protobuf'
      ? 'http/protobuf'
      : 'grpc';
  const headers = process.env['OTEL_EXPORTER_OTLP_HEADERS'] ?? '';
  return { enabled: false, endpoint, protocol, userEmail: '', headers };
}

export function getOtelSettings(): OtelSettings {
  const row = getDatabase()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(OTEL_KEY) as { value: string } | undefined;
  if (row) {
    try {
      const parsed = OtelSettings.safeParse(JSON.parse(row.value));
      if (parsed.success) return parsed.data;
    } catch {
      // Corrupt/legacy value — fall through to defaults.
    }
  }
  return defaultOtelSettings();
}

export function setOtelSettings(next: OtelSettings): OtelSettings {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(OTEL_KEY, JSON.stringify(next));
  return next;
}

/* ─── First-run onboarding flag ─── */

export function getOnboarded(): boolean {
  const row = getDatabase()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(ONBOARDED_KEY) as { value: string } | undefined;
  return row?.value === 'true';
}

export function setOnboarded(done: boolean): void {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(ONBOARDED_KEY, done ? 'true' : 'false');
}

/** Build the env vars that turn on Claude Code's native OpenTelemetry
 *  export for a spawned agent, tagged with the session's Jira ticket,
 *  user, and repo. Returns {} when telemetry is disabled or no endpoint
 *  is configured (so the caller can just spread the result). The env is
 *  read once by the agent at launch — see OTEL_RESOURCE_ATTRIBUTES. */
export function buildOtelEnv(args: {
  settings: OtelSettings;
  /** Resolved Jira key, or null → bucketed as "untagged". */
  jiraTicket: string | null;
  /** Repo name for the `repo` attribute (usually the project name). */
  repo: string;
}): Record<string, string> {
  const { settings, jiraTicket, repo } = args;
  if (!settings.enabled || !settings.endpoint.trim()) return {};

  const attrs: string[] = [`jira.ticket=${jiraTicket ?? 'untagged'}`];
  if (settings.userEmail.trim()) attrs.push(`user=${settings.userEmail.trim()}`);
  if (repo.trim()) attrs.push(`repo=${repo.trim()}`);

  const env: Record<string, string> = {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_ENDPOINT: settings.endpoint.trim(),
    OTEL_EXPORTER_OTLP_PROTOCOL: settings.protocol,
    OTEL_RESOURCE_ATTRIBUTES: attrs.join(','),
  };
  // Auth headers for collectors that require them (SaaS / gateway).
  if (settings.headers.trim()) {
    env['OTEL_EXPORTER_OTLP_HEADERS'] = settings.headers.trim();
  }
  return env;
}
