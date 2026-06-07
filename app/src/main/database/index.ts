/**
 * SQLite owned by the main process.
 *
 * Per PRD F12.3: SQLite owns everything mutable. ~/.code24/config.json
 * holds bootstrap values only (loaded BEFORE this opens).
 *
 * Per Architect §6: better-sqlite3 with WAL + synchronous=NORMAL.
 *
 * Per PRD F2.4 / NF4: restore writes to a temp model first; commits
 * after success. Schema is intentionally small and append-only here —
 * everything else lands in migration files keyed by user_version.
 */

import { app } from 'electron';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

-- Time-bucketed token deltas. Each row is the increase since the
-- prior totals for a given session. Used by the plan-usage panel
-- to compute rolling 5-hour / 7-day windows (PRD F11.3) without
-- re-parsing transcripts on every tick.
CREATE TABLE IF NOT EXISTS token_usage_events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  tokens_in    INTEGER NOT NULL,
  tokens_out   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_token_usage_ts ON token_usage_events(ts);

-- One row per scanned transcript file under ~/.claude/projects/.
-- Records how many lines we've already turned into token_usage_events
-- so re-scans only process new ones. Cheap dedup without UUIDs.
CREATE TABLE IF NOT EXISTS transcript_scan_state (
  file_path        TEXT PRIMARY KEY,
  lines_processed  INTEGER NOT NULL DEFAULT 0,
  last_scan_at     INTEGER NOT NULL DEFAULT 0
);
`;

export function initDatabase(): Database.Database {
  if (db) return db;
  const dir = join(app.getPath('home'), '.code24');
  mkdirSync(dir, { recursive: true });
  db = new Database(join(dir, 'code24.db'));
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

  // One-time recount: until v2, tokens_in summed input + cache_creation
  // + cache_read. Cache reads are effectively free and shouldn't count
  // 1:1 toward plan limits, so we wipe + rescan with the new formula.
  // Idempotent — re-running on a v2 DB is a no-op.
  const TOKEN_FORMULA_VERSION = '2';
  const existing = d
    .prepare(`SELECT value FROM settings WHERE key = 'token_formula_version'`)
    .get() as { value: string } | undefined;
  if (existing?.value !== TOKEN_FORMULA_VERSION) {
    try { d.exec('DELETE FROM token_usage_events'); } catch { /* ignore */ }
    try { d.exec('DELETE FROM transcript_scan_state'); } catch { /* ignore */ }
    try {
      d.prepare(
        `INSERT INTO settings (key, value) VALUES ('token_formula_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).run(TOKEN_FORMULA_VERSION);
    } catch { /* ignore */ }
    // Also zero the per-session tokens cache so the chips redraw from
    // the next Stop hook with the new formula.
    try {
      d.exec('UPDATE sessions SET tokens_in = 0, tokens_out = 0');
    } catch { /* ignore */ }
  }
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
