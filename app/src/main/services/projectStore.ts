/**
 * Project CRUD backed by SQLite.
 *
 * Per PRD F1.1 / F1.3: add/list projects with stable IDs that survive
 * relaunch (we'll move to UUIDs once we have a migration; for the MVP
 * we use sha256(path) prefix matching the telemetry hashing pattern).
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { getDatabase } from '../database/index.js';
import type { Project } from '../../shared/ipc.js';
import { emit } from './eventBus.js';

function projectIdFromPath(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

export function addProject(absolutePath: string): Project {
  const id = projectIdFromPath(absolutePath);
  const name = basename(absolutePath);
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
