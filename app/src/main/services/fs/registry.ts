/**
 * Fs registry — single place every IPC handler asks "give me an Fs for
 * this thing." Caches RemoteFs instances per connectionId so a busy
 * file panel polling the same remote project doesn't spawn a new SSH
 * channel on every tick.
 */

import { LocalFs } from './localFs.js';
import { RemoteFs } from './remoteFs.js';
import { SshConnection } from './sshConnection.js';
import { getConnection, listConnections } from '../connectionStore.js';
import { getDatabase } from '../../database/index.js';
import { getProject } from '../projectStore.js';
import type { BatonFs } from './types.js';

const localFsInstance = new LocalFs();
const remoteCache = new Map<string, RemoteFs>();

/** Returns LocalFs for "local", RemoteFs (cached) for any other id.
 *  Throws if the id refers to a profile that doesn't exist. */
export function getFs(connectionId: string): BatonFs {
  if (connectionId === 'local') return localFsInstance;
  const cached = remoteCache.get(connectionId);
  if (cached) return cached;
  const profile = getConnection(connectionId);
  if (!profile) throw new Error(`Unknown connection: ${connectionId}`);
  if (profile.kind === 'local') return localFsInstance;
  const conn = new SshConnection(profile);
  const fs = new RemoteFs(conn);
  remoteCache.set(connectionId, fs);
  return fs;
}

/** Resolves the project's connectionId from SQLite, then returns its
 *  Fs. Used by every project-scoped handler (worktree.*) and as a
 *  fallback for orphans. */
export function getFsForProject(projectId: string): BatonFs {
  const project = getProject(projectId);
  if (!project) throw new Error(`Unknown project: ${projectId}`);
  return getFs(project.connectionId);
}

/** Resolves the session row, then the project, then the Fs. Used by
 *  every session-scoped fs verb (worktree.fileTree, file.read with
 *  sessionId, git.*). */
export function getFsForSession(sessionId: string): BatonFs | null {
  const row = getDatabase()
    .prepare('SELECT project_id FROM sessions WHERE id = ?')
    .get(sessionId) as { project_id: string } | undefined;
  if (!row) return null;
  try {
    return getFsForProject(row.project_id);
  } catch {
    return null;
  }
}

/** Force a reconnect for the given profile. Returns the next state
 *  (which can briefly be 'disconnected' before the next ensureMaster
 *  fires). */
export async function reconnect(connectionId: string): Promise<void> {
  const fs = getFs(connectionId);
  if (fs.isLocal) return;
  await (fs as RemoteFs).connection.reconnectNow();
}

/** Tear down an SshConnection on profile delete / app shutdown. */
export function dropConnection(connectionId: string): void {
  const cached = remoteCache.get(connectionId);
  if (!cached) return;
  cached.connection.shutdown();
  remoteCache.delete(connectionId);
}

/** Tear down every cached SSH connection (app shutdown). */
export function dropAllConnections(): void {
  for (const fs of remoteCache.values()) {
    try { fs.connection.shutdown(); } catch { /* best-effort */ }
  }
  remoteCache.clear();
}

/** Initialize masters for every saved SSH profile at boot. Connections
 *  start lazily on first use — but a small upfront probe makes the
 *  dropdown badges reflect reality before the user opens it. */
export function warmAllConnections(): void {
  for (const profile of listConnections()) {
    if (profile.kind === 'local') continue;
    try {
      const fs = getFs(profile.id);
      void (fs as RemoteFs).connection.ensureMaster().catch(() => {
        // setState already wrote the failure status; nothing else to do.
      });
    } catch { /* ignore */ }
  }
}
