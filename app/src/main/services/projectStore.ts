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
    .prepare('SELECT id, path, name, added_at FROM projects ORDER BY added_at ASC')
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
