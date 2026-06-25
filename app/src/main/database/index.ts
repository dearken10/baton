/**
 * SQLite owned by the main process.
 *
 * Per PRD F12.3: SQLite owns everything mutable. ~/.baton/config.json
 * holds bootstrap values only (loaded BEFORE this opens).
 *
 * Per Architect §6: better-sqlite3 with WAL + synchronous=NORMAL.
 *
 * Per PRD F2.4 / NF4: restore writes to a temp model first; commits
 * after success. Schema is intentionally small and append-only here —
 * everything else lands in migration files keyed by user_version.
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { batonHome } from '../paths.js';

let db: Database.Database | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  added_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backend_id          TEXT NOT NULL,
  branch              TEXT NOT NULL,
  worktree_path       TEXT NOT NULL,
  status              TEXT NOT NULL,
  intent_label        TEXT,
  started_at          INTEGER NOT NULL,
  ended_at            INTEGER,
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  last_summary        TEXT,
  -- Claude internal session id, captured from the SessionStart hook.
  -- We pass it to "claude --resume <id>" so the user can pick a closed
  -- session back up with its conversation history intact (PRD F2.4).
  claude_session_id   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_project_idx ON sessions(project_id);
CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions(status);

CREATE TABLE IF NOT EXISTS events (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  boot_id     TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  session_id  TEXT,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Connection profiles. The built-in row with id='local' is seeded at
-- boot in runMigrations(); it represents this Mac and is uneditable.
-- SSH-specific columns are nullable so the local row can leave them
-- empty without complicating the schema.
CREATE TABLE IF NOT EXISTS connection_profiles (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('local','ssh')),
  host                TEXT,
  user                TEXT,
  port                INTEGER,
  auth_method         TEXT,
  auth_key_path       TEXT,
  claude_creds_mode   TEXT,
  last_status         TEXT,
  last_probed_at      INTEGER,
  created_at          INTEGER NOT NULL
);

`;

export function initDatabase(): Database.Database {
  if (db) return db;
  const dir = batonHome();
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'baton.db'));
  db.exec(SCHEMA);
  runMigrations(db);
  return db;
}

/** Forward-only migrations applied at boot. Each tries to add new
 *  columns or indices; ignores "already exists" errors so existing
 *  DBs catch up silently. */
function runMigrations(d: Database.Database): void {
  // Add claude_session_id to sessions if missing (for installs that
  // pre-date the column).
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN claude_session_id TEXT');
  } catch {
    // duplicate column name — already migrated, no-op
  }
  // skip_permissions = 1 means we launch `claude --dangerously-skip-permissions`
  // for this session (auto-approve every tool use). Default 0.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0');
  } catch {
    // already migrated
  }

  // model = optional Claude `--model <name>` alias for this session
  // (e.g. "sonnet"/"opus"/"haiku"). NULL means "don't pass --model" —
  // Claude uses the user's configured default.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN model TEXT');
  } catch {
    // already migrated
  }

  // The locally-aggregated usage tables we used before switching to
  // Anthropic's OAuth usage API. Drop them — they're dead weight.
  try { d.exec('DROP TABLE IF EXISTS token_usage_events'); } catch { /* ignore */ }
  try { d.exec('DROP TABLE IF EXISTS transcript_scan_state'); } catch { /* ignore */ }

  // display_order on projects + sessions for drag-reorder.
  try {
    d.exec('ALTER TABLE projects ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
  } catch { /* already migrated */ }
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0');
  } catch { /* already migrated */ }

  // snoozed_at = wall-clock ms when the user snoozed this project,
  // or NULL when active. Snoozed projects live in the "Snoozed" view
  // in the left column (see LeftColumn.tsx).
  try {
    d.exec('ALTER TABLE projects ADD COLUMN snoozed_at INTEGER');
  } catch { /* already migrated */ }

  // Per-session snooze: when set, the renderer hides the status chip
  // for this row so the user isn't pinged about false-positive
  // `needs-input` flags. See SessionRowMenu in LeftColumn.tsx.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN snoozed_at INTEGER');
  } catch { /* already migrated */ }

  // permission_mode = the agent's tool-permission posture, passed to
  // `claude --permission-mode <value>` at spawn. Supersedes the binary
  // skip_permissions column: the old YOLO flag is now the most
  // permissive value, `bypassPermissions`. Backfill preserves behaviour
  // for any session that had skip_permissions=1. See PermissionMode in
  // src/shared/ipc.ts. The skip_permissions column is left in place
  // (SQLite drop-column is destructive); it's simply no longer read.
  try {
    d.exec(`ALTER TABLE sessions ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'default'`);
    // Only runs on the migration that actually adds the column (the
    // ALTER throws on already-migrated DBs and we skip the backfill),
    // so existing 'bypassPermissions' choices aren't clobbered later.
    d.exec(`UPDATE sessions SET permission_mode = 'bypassPermissions' WHERE skip_permissions = 1`);
  } catch { /* already migrated */ }

  // Connection model. Old databases predate connection_profiles and
  // have no connection_id on their project rows; everything pre-existing
  // is a local project.
  try {
    d.exec(
      `ALTER TABLE projects ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'local'`
    );
  } catch { /* already migrated */ }

  // Seed the built-in 'local' row. ON CONFLICT keeps it idempotent
  // across relaunches; we don't overwrite a renamed local row (the user
  // can't actually rename it in the UI, but be defensive).
  d.prepare(
    `INSERT INTO connection_profiles
       (id, name, kind, host, user, port, auth_method, auth_key_path,
        claude_creds_mode, last_status, last_probed_at, created_at)
     VALUES ('local', 'Local Mac', 'local', NULL, NULL, NULL, NULL, NULL,
             NULL, 'success', ?, ?)
     ON CONFLICT(id) DO NOTHING`
  ).run(Date.now(), Date.now());

}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('database: not initialized');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
