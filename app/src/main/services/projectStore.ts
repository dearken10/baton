/**
 * Project CRUD backed by SQLite.
 *
 * Per PRD F1.1 / F1.3: add/list projects with stable IDs that survive
 * relaunch (we'll move to UUIDs once we have a migration; for the MVP
 * we use sha256(path) prefix matching the telemetry hashing pattern).
 */

import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { getDatabase } from '../database/index.js';
import type { Project } from '../../shared/ipc.js';
import { emit } from './eventBus.js';

interface ProjectRow {
  id: string;
  path: string;
  name: string;
  added_at: number;
  connection_id: string;
  snoozed_at: number | null;
}

function rowToProject(r: ProjectRow): Project {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    addedAt: r.added_at,
    connectionId: r.connection_id,
    snoozedAt: r.snoozed_at,
  };
}

/** ID is keyed on (connectionId, path) so the same path on two
 *  different hosts gets two distinct rows. Older rows seeded before
 *  the connection model used the path alone — we keep that exact shape
 *  for the local path so existing IDs stay stable across the migration. */
function projectIdFromPath(absolutePath: string, connectionId: string): string {
  const input = connectionId === 'local' ? absolutePath : `${connectionId}::${absolutePath}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

export function addProject(
  absolutePath: string,
  nameOverride?: string,
  connectionId: string = 'local',
): Project {
  const id = projectIdFromPath(absolutePath, connectionId);
  const name = (nameOverride?.trim() || basename(absolutePath));
  const addedAt = Date.now();

  getDatabase()
    .prepare(
      `INSERT INTO projects (id, path, name, added_at, connection_id)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(id, absolutePath, name, addedAt, connectionId);

  const row = getDatabase()
    .prepare(
      'SELECT id, path, name, added_at, connection_id, snoozed_at FROM projects WHERE id = ?'
    )
    .get(id) as ProjectRow;

  const project = rowToProject(row);
  emit({ type: 'project.added', project });
  return project;
}

export function listProjects(): Project[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, path, name, added_at, connection_id, snoozed_at
         FROM projects
        ORDER BY display_order ASC, added_at ASC`
    )
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

/** Remove a project. Sessions cascade-delete via the FK. Caller is
 *  expected to kill any live ptys beforehand via SessionManager. */
export function removeProject(id: string): { sessionIds: string[] } {
  const sessionIds = (getDatabase()
    .prepare('SELECT id FROM sessions WHERE project_id = ?')
    .all(id) as { id: string }[]).map((r) => r.id);
  getDatabase().prepare('DELETE FROM projects WHERE id = ?').run(id);
  emit({ type: 'project.removed', projectId: id });
  return { sessionIds };
}

/** Create a new project folder on disk (and optionally `git init` it)
 *  before registering it. Throws if the target folder already exists —
 *  the renderer should switch the user to "Add existing" in that case. */
/** Default folder for new projects, shown as `~/baton/` in the dialog. */
export function defaultProjectsParent(): string {
  return join(homedir(), 'baton');
}

/** Expand a leading `~` (or `~/`) to the user's home directory. Leaves
 *  other paths alone. */
function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export async function createProject(opts: {
  path: string;
  initGit?: boolean;
  connectionId?: string;
}): Promise<Project> {
  const connectionId = opts.connectionId ?? 'local';

  if (connectionId !== 'local') {
    return createRemoteProject({
      path: opts.path,
      connectionId,
      initGit: opts.initGit ?? true,
    });
  }

  const target = resolve(expandTilde(opts.path.trim()));
  const parent = resolve(target, '..');
  const folder = basename(target);
  // Folder name must be a single non-empty path component. resolve()
  // collapses things like "foo/.." which would leave us at /, so we
  // reject those explicitly.
  if (!folder || folder === '.' || folder === '..' || folder === '/') {
    throw new Error('Path must end in a folder name.');
  }
  // mkdir the parent on demand. For ~/baton/ this matters on the very
  // first project; for a user-supplied custom dir it's a convenience.
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(target)) {
    throw new Error(`"${target}" already exists. Use "Add existing" instead.`);
  }
  fs.mkdirSync(target, { recursive: false });
  if (opts.initGit !== false) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' });
    } catch (err) {
      // git init failed but the folder is there — let the caller decide
      // whether to register it anyway. We log and continue.
      console.warn('[baton] git init failed for new project:', err);
    }
  }
  return addProject(target, undefined, 'local');
}

/** Remote variant: mkdir + (optionally) `git init` on the remote
 *  before registering the row. We use the connection's BatonFs so the
 *  same code runs against any remote, and so we benefit from the
 *  ControlMaster connection reuse.
 *
 *  Done after Stage 1 (where remote create was metadata-only) — that
 *  left a hole where the folder didn't exist on the remote and
 *  auto-spawn's `cd <path>` failed with a misleading "claude not
 *  found" error. */
async function createRemoteProject(opts: {
  path: string;
  connectionId: string;
  initGit: boolean;
}): Promise<Project> {
  // Lazy require avoids a circular import (registry → projectStore).
  const { getFs } = await import('./fs/registry.js');
  const fs = getFs(opts.connectionId);
  const target = opts.path.trim();
  if (!target) throw new Error('Path is required.');

  // Resolve the user-typed path to an absolute one on the remote so
  // future calls don't have to re-handle `~`. We use `bash -lc` for
  // the resolve so `~` expands.
  const resolveCmd = await fs.exec('bash', ['-lc',
    `mkdir -p ${shellQuote(target.replace(/\/+[^/]+\/?$/, '') || '/')} && ` +
    `cd ${shellQuote(target.replace(/\/+[^/]+\/?$/, '') || '/')} && pwd -P`,
  ], { cwd: '/', timeoutMs: 10_000 });
  if (resolveCmd.code !== 0) {
    throw new Error(
      `Could not prepare parent on remote: ${resolveCmd.stderr.trim() || `exit ${resolveCmd.code}`}`
    );
  }
  const parentAbs = resolveCmd.stdout.trim();
  const folder = target.replace(/\/+$/, '').split('/').pop() ?? '';
  if (!folder || folder === '.' || folder === '..') {
    throw new Error('Path must end in a folder name.');
  }
  const absTarget = `${parentAbs}/${folder}`;
  if (await fs.exists(absTarget)) {
    throw new Error(`"${absTarget}" already exists on the remote. Use "Add existing" instead.`);
  }
  await fs.mkdir(absTarget, { recursive: false });

  if (opts.initGit) {
    const gitRes = await fs.exec('git', ['init', '-q'], {
      cwd: absTarget,
      timeoutMs: 15_000,
    });
    if (gitRes.code !== 0) {
      // Folder exists; git init failed (maybe git not installed). Log
      // and continue — same as the local branch's behaviour.
      // eslint-disable-next-line no-console
      console.warn(
        `[baton] git init failed on remote for ${absTarget}:`,
        gitRes.stderr.trim()
      );
    }
  }
  return addProject(absTarget, undefined, opts.connectionId);
}

/** POSIX single-quote with embedded-quote escape via `'\''`. Kept
 *  private to this file — different from the bus.ts helper which
 *  double-quotes for `sh -c` argument bodies. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Update a project's display name. The on-disk path is untouched —
 *  only the human-readable label in the left column changes. */
export function renameProject(id: string, newName: string): Project {
  const trimmed = newName.trim();
  if (!trimmed) throw new Error('Project name cannot be empty.');
  const res = getDatabase()
    .prepare('UPDATE projects SET name = ? WHERE id = ?')
    .run(trimmed, id);
  if (res.changes === 0) throw new Error(`Unknown project: ${id}`);
  const project = getProject(id);
  if (!project) throw new Error(`Project disappeared after rename: ${id}`);
  emit({ type: 'project.renamed', project });
  return project;
}

/** Persist a new project ordering. The renderer sends the IDs in the
 *  order it wants; we just stamp display_order = index. */
export function reorderProjects(orderedIds: string[]): void {
  const stmt = getDatabase().prepare(
    'UPDATE projects SET display_order = ? WHERE id = ?'
  );
  const tx = getDatabase().transaction((ids: string[]) => {
    ids.forEach((id, i) => stmt.run(i, id));
  });
  tx(orderedIds);
  emit({ type: 'project.reordered', orderedIds });
}

export function getProject(id: string): Project | undefined {
  const row = getDatabase()
    .prepare(
      'SELECT id, path, name, added_at, connection_id, snoozed_at FROM projects WHERE id = ?'
    )
    .get(id) as ProjectRow | undefined;
  if (!row) return undefined;
  return rowToProject(row);
}

/** Toggle snooze state. `snoozed=true` stamps snoozed_at = now;
 *  `snoozed=false` clears it. */
export function setProjectSnoozed(id: string, snoozed: boolean): Project {
  const value = snoozed ? Date.now() : null;
  const res = getDatabase()
    .prepare('UPDATE projects SET snoozed_at = ? WHERE id = ?')
    .run(value, id);
  if (res.changes === 0) throw new Error(`Unknown project: ${id}`);
  const project = getProject(id);
  if (!project) throw new Error(`Project disappeared after snooze toggle: ${id}`);
  emit({ type: 'project.snoozeChanged', project });
  return project;
}
