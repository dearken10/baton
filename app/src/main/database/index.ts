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

  // last_active_at = wall-clock ms of the session's most recent activity:
  // spawn/resume, a status change to running/needs-input, or token/summary
  // updates. The Timeline view (LeftColumn.tsx) sorts + labels by this so
  // the genuinely-most-recently-active session sits on top. started_at is
  // unfit for that — it's re-stamped to "now" on every resume, so resumed
  // sessions all collapse onto the app's launch time. Backfill to
  // started_at so pre-existing rows have a sensible initial value.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN last_active_at INTEGER');
    d.exec('UPDATE sessions SET last_active_at = started_at WHERE last_active_at IS NULL');
  } catch { /* already migrated */ }

  // One-time repair for DBs that ran the first cut of last_active_at,
  // which re-stamped the column to Date.now() on every resume. Since the
  // app auto-resumes all sessions at launch, that collapsed every row's
  // "active" time onto the boot instant — the Timeline showed identical
  // times. started_at is never re-stamped in the DB (the upsert leaves it
  // alone), so it's the true creation time; reset last_active_at to it as
  // a sane, varied baseline that genuine activity then bumps forward.
  // Guarded by a marker column so the reset runs exactly once.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN last_active_repaired INTEGER NOT NULL DEFAULT 0');
    d.exec('UPDATE sessions SET last_active_at = started_at');
  } catch { /* already repaired */ }

  // parent_session_id = when set, this row is a companion shell terminal
  // attached to the agent session with this id. Companion terminals run in
  // the agent's worktree and surface as extra tabs in the middle column;
  // they're filtered out of the sidebar session list. NULL for ordinary
  // top-level sessions. See parentSessionId in src/shared/ipc.ts.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT');
  } catch { /* already migrated */ }

  // title = a stable, user-editable session name. Auto-generated once
  // from the first turn's intent summary (see updateIntentSummary in
  // sessionManager.ts), then frozen unless the user edits it inline in
  // the sidebar. NULL until the first summary lands — the row falls back
  // to the git branch name for its label. See SessionTitleLabel in
  // LeftColumn.tsx.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN title TEXT');
  } catch { /* already migrated */ }

  // jira_task_id = the Jira ticket this session's effort is attributed
  // to (e.g. "IMBEE-8704"). Captured at spawn (user-entered or
  // auto-detected from the branch) and stamped onto the session's OTEL
  // metrics as `jira.ticket`. NULL = untagged. See jiraTaskId in
  // src/shared/ipc.ts and buildOtelEnv in settingsStore.ts.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN jira_task_id TEXT');
  } catch { /* already migrated */ }

  // Connection model. Old databases predate connection_profiles and
  // have no connection_id on their project rows; everything pre-existing
  // is a local project.
  try {
    d.exec(
      `ALTER TABLE projects ADD COLUMN connection_id TEXT NOT NULL DEFAULT 'local'`
    );
  } catch { /* already migrated */ }

  // Per-turn code snapshots for "revert to this turn". On every
  // UserPromptSubmit we stash the worktree's pre-turn state into a
  // dangling git commit (parked under refs/baton/snap/*) and record it
  // here keyed by the turn's wall-clock ts. Revert restores the worktree
  // to that commit. turn_ts is filled in a beat after capture (once the
  // prompt line lands in the transcript), so it's nullable at insert.
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS turn_snapshots (
      session_id   TEXT NOT NULL,
      turn_ts      INTEGER,
      commit_sha   TEXT NOT NULL,
      captured_at  INTEGER NOT NULL
    )`);
    d.exec(
      'CREATE INDEX IF NOT EXISTS turn_snapshots_session_idx ON turn_snapshots(session_id)'
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

  // Login sessions: named credential profiles per agent. `kind` is one
  // of global | browser | custom | token; `config` is a kind-specific
  // JSON blob (endpoint fields, encrypted secret). A project picks a
  // default Claude + Codex session; an individual session may override.
  try {
    d.exec(`CREATE TABLE IF NOT EXISTS login_sessions (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      agent       TEXT NOT NULL,
      kind        TEXT NOT NULL,
      config      TEXT NOT NULL DEFAULT '{}',
      built_in    INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    )`);
  } catch { /* already migrated */ }

  // User-controlled display order for the settings list + titlebar usage
  // meters. Existing rows default to 0 and fall back to built_in/name until
  // the user reorders (which assigns distinct positions).
  try {
    d.exec('ALTER TABLE login_sessions ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  } catch { /* already migrated */ }

  // Per-project default login session ids (NULL → the built-in global
  // for that agent). Per-session override lives on sessions.login_session_id.
  try {
    d.exec('ALTER TABLE projects ADD COLUMN claude_login_session_id TEXT');
  } catch { /* already migrated */ }
  try {
    d.exec('ALTER TABLE projects ADD COLUMN codex_login_session_id TEXT');
  } catch { /* already migrated */ }
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN login_session_id TEXT');
  } catch { /* already migrated */ }

  // Seed the two built-in "Global" login sessions (the machine default
  // login for each agent). Non-deletable; always present so projects can
  // fall back to them. Fixed ids so resolution is stable across boots.
  const now = Date.now();
  const seedGlobal = d.prepare(
    `INSERT INTO login_sessions (id, name, agent, kind, config, built_in, created_at)
     VALUES (?, ?, ?, 'global', '{}', 1, ?)
     ON CONFLICT(id) DO NOTHING`
  );
  seedGlobal.run('global-claude-code', 'Global (machine login)', 'claude-code', now);
  seedGlobal.run('global-codex', 'Global (machine login)', 'codex', now);

  // Maestro action ledger (PRD F15.6). Every Approve writes a row
  // BEFORE the prompt is sent to the target agent — the prompt write
  // is gated on a successful checkpoint. Revert reads the row, runs
  // `git reset --hard <pre_tag>` + `git stash apply <stash_ref>`, then
  // marks state='reverted'.
  //
  // We intentionally don't FK target_session_id with CASCADE: deleting
  // a session shouldn't lose its action history (you might still want
  // to know what was approved before the session row went away).
  try {
    d.exec(`
      CREATE TABLE IF NOT EXISTS maestro_actions (
        action_id          TEXT PRIMARY KEY,
        kind               TEXT NOT NULL,
        target_session_id  TEXT,
        target_project_id  TEXT,
        worktree_path      TEXT NOT NULL,
        pre_tag            TEXT,
        stash_ref          TEXT,
        prompt             TEXT NOT NULL,
        rationale          TEXT,
        confidence         REAL,
        state              TEXT NOT NULL,
        state_detail       TEXT,
        created_at         INTEGER NOT NULL,
        reverted_at        INTEGER
      );
      CREATE INDEX IF NOT EXISTS maestro_actions_state_idx
        ON maestro_actions(state);
      CREATE INDEX IF NOT EXISTS maestro_actions_target_session_idx
        ON maestro_actions(target_session_id);
    `);
  } catch { /* already migrated */ }

  // Maestro session backup pointers — added so Revert can rewind the
  // agent's Claude Code transcript as well as the worktree. We record
  // the absolute path of the agent's JSONL and the byte offset at the
  // moment we sent the prompt; truncating the file to that offset on
  // revert + respawning `claude --resume <uuid>` rebuilds the agent
  // with zero memory of the action we just rolled back.
  try {
    d.exec('ALTER TABLE maestro_actions ADD COLUMN jsonl_path TEXT');
  } catch { /* already migrated */ }
  try {
    d.exec('ALTER TABLE maestro_actions ADD COLUMN jsonl_offset INTEGER');
  } catch { /* already migrated */ }
  // For `initiate` actions (PRD F15.6): the branch we created the
  // worktree at. Revert removes the worktree via `git worktree
  // remove --force` after killing the session, so we don't need a
  // pre-tag for these.
  try {
    d.exec('ALTER TABLE maestro_actions ADD COLUMN target_branch TEXT');
  } catch { /* already migrated */ }

  // Per-project Maestro opt-out. 1 = Maestro may propose actions
  // for this project's sessions; 0 = inventory drops them, and the
  // gate is enforced before the planner even runs. Defaults ON so
  // existing projects pre-feature behave exactly as before.
  try {
    d.exec(
      `ALTER TABLE projects ADD COLUMN maestro_enabled INTEGER NOT NULL DEFAULT 1`
    );
  } catch { /* already migrated */ }

  // Per-session Maestro override. NULL = follow the parent project's
  // maestro_enabled (default behaviour); 1 = force-enable even if the
  // project is off; 0 = force-disable even if the project is on. Kept
  // nullable so the "follow project" default has a distinct third
  // state from an explicit choice — the UI shows Follow / On / Off.
  try {
    d.exec('ALTER TABLE sessions ADD COLUMN maestro_enabled INTEGER');
  } catch { /* already migrated */ }
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
