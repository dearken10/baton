-- poc/maestro/option3-master-session/migrations/001-add-session-kind.sql
--
-- Add a `session_kind` discriminator to baton.db sessions so the
-- F15.1 runtime gate can distinguish the master-mind Maestro session
-- ('maestro') from ordinary agent sessions ('agent').
--
-- Idempotent: SQLite will error on duplicate column, the harness
-- swallows that error. Safe to re-run.
--
-- Apply via:
--   sqlite3 ~/.baton/baton.db < 001-add-session-kind.sql
--
-- This is a PoC-grade migration. The production migration belongs in
-- app/src/main/database/ when option 3 is promoted from PoC to v1.x.

ALTER TABLE sessions ADD COLUMN session_kind TEXT NOT NULL DEFAULT 'agent';
