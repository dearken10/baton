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

function projectIdFromPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

export function addProject(absolutePath: string, nameOverride?: string): Project {
  const id = projectIdFromPath(absolutePath);
  const name = (nameOverride?.trim() || basename(absolutePath));
  const addedAt = Date.now();

  getDatabase()
    .prepare(
      `INSERT INTO projects (id, path, name, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(id, absolutePath, name, addedAt);

  const row = getDatabase()
    .prepare('SELECT id, path, name, added_at FROM projects WHERE id = ?')
    .get(id) as {
    id: string;
    path: string;
    name: string;
    added_at: number;
  };

  const project: Project = {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at,
  };

  emit({ type: 'project.added', project });
  return project;
}

export function listProjects(): Project[] {
  const rows = getDatabase()
    .prepare(
      `SELECT id, path, name, added_at
         FROM projects
        ORDER BY display_order ASC, added_at ASC`
    )
    .all() as {
    id: string;
    path: string;
    name: string;
    added_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    path: r.path,
    name: r.name,
    addedAt: r.added_at,
  }));
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

export function createProject(opts: {
  path: string;
  initGit?: boolean;
}): Project {
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
  return addProject(target);
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
    .prepare('SELECT id, path, name, added_at FROM projects WHERE id = ?')
    .get(id) as
    | { id: string; path: string; name: string; added_at: number }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    addedAt: row.added_at,
  };
}
