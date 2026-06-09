/**
 * Connection profiles — local + saved SSH targets.
 *
 * Per PRD F13.2: profiles are named and reusable across projects. The
 * built-in "local" row is seeded by the DB migration; everything else
 * is user-created via connection.create.
 *
 * Stage 1 scope: storage + the SSH probe that powers Test Connection
 * and Validate Path. The remote daemon (F14) is Stage 2 — until then,
 * projects pinned to a remote profile are metadata-only and refuse to
 * spawn sessions.
 */

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { getDatabase } from '../database/index.js';
import {
  type ConnectionKind,
  type ConnectionProbeStatus,
  type ConnectionProfile,
  type SshAuthMethod,
  type ClaudeCredsMode,
} from '../../shared/ipc.js';
import { emit } from './eventBus.js';

interface Row {
  id: string;
  name: string;
  kind: ConnectionKind;
  host: string | null;
  user: string | null;
  port: number | null;
  auth_method: SshAuthMethod | null;
  auth_key_path: string | null;
  claude_creds_mode: ClaudeCredsMode | null;
  last_status: ConnectionProbeStatus | null;
  last_probed_at: number | null;
  created_at: number;
}

function rowToProfile(r: Row): ConnectionProfile {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    host: r.host,
    user: r.user,
    port: r.port,
    authMethod: r.auth_method,
    authKeyPath: r.auth_key_path,
    claudeCredsMode: r.claude_creds_mode,
    lastStatus: r.last_status,
    lastProbedAt: r.last_probed_at,
    createdAt: r.created_at,
  };
}

const SELECT_ALL =
  `SELECT id, name, kind, host, user, port, auth_method, auth_key_path,
          claude_creds_mode, last_status, last_probed_at, created_at
     FROM connection_profiles
    ORDER BY (kind = 'local') DESC, created_at ASC`;

export function listConnections(): ConnectionProfile[] {
  const rows = getDatabase().prepare(SELECT_ALL).all() as Row[];
  return rows.map(rowToProfile);
}

export function getConnection(id: string): ConnectionProfile | undefined {
  const row = getDatabase()
    .prepare(
      `SELECT id, name, kind, host, user, port, auth_method, auth_key_path,
              claude_creds_mode, last_status, last_probed_at, created_at
         FROM connection_profiles WHERE id = ?`
    )
    .get(id) as Row | undefined;
  return row ? rowToProfile(row) : undefined;
}

export interface CreateConnectionInput {
  name: string;
  host: string;
  user: string;
  port: number;
  authMethod: SshAuthMethod;
  authKeyPath?: string;
  claudeCredsMode: ClaudeCredsMode;
}

export function createConnection(input: CreateConnectionInput): ConnectionProfile {
  const id = randomUUID();
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO connection_profiles
         (id, name, kind, host, user, port, auth_method, auth_key_path,
          claude_creds_mode, last_status, last_probed_at, created_at)
       VALUES (?, ?, 'ssh', ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`
    )
    .run(
      id,
      input.name.trim(),
      input.host.trim(),
      input.user.trim(),
      input.port,
      input.authMethod,
      input.authKeyPath?.trim() ?? null,
      input.claudeCredsMode,
      now,
    );
  const profile = getConnection(id);
  if (!profile) throw new Error('connection: row disappeared after insert');
  emit({ type: 'connection.added', profile });
  return profile;
}

export interface UpdateConnectionInput {
  id: string;
  name?: string;
  host?: string;
  user?: string;
  port?: number;
  authMethod?: SshAuthMethod;
  /** Pass `null` to clear an existing key path (e.g. switching to agent
   *  auth). Omit to leave the value untouched. */
  authKeyPath?: string | null;
  claudeCredsMode?: ClaudeCredsMode;
}

export function updateConnection(input: UpdateConnectionInput): ConnectionProfile {
  const existing = getConnection(input.id);
  if (!existing) throw new Error(`connection: unknown id ${input.id}`);
  if (existing.kind === 'local') {
    throw new Error('connection: the built-in local profile cannot be edited');
  }
  const merged = {
    name: input.name?.trim() ?? existing.name,
    host: input.host?.trim() ?? existing.host,
    user: input.user?.trim() ?? existing.user,
    port: input.port ?? existing.port,
    authMethod: input.authMethod ?? existing.authMethod,
    authKeyPath:
      input.authKeyPath === undefined
        ? existing.authKeyPath
        : input.authKeyPath === null
          ? null
          : input.authKeyPath.trim(),
    claudeCredsMode: input.claudeCredsMode ?? existing.claudeCredsMode,
  };
  getDatabase()
    .prepare(
      `UPDATE connection_profiles
         SET name = ?, host = ?, user = ?, port = ?,
             auth_method = ?, auth_key_path = ?, claude_creds_mode = ?
       WHERE id = ?`
    )
    .run(
      merged.name,
      merged.host,
      merged.user,
      merged.port,
      merged.authMethod,
      merged.authKeyPath,
      merged.claudeCredsMode,
      input.id,
    );
  const profile = getConnection(input.id);
  if (!profile) throw new Error('connection: row disappeared after update');
  emit({ type: 'connection.updated', profile });
  return profile;
}

export function deleteConnection(id: string): void {
  if (id === 'local') {
    throw new Error('connection: the built-in local profile cannot be deleted');
  }
  // Refuse if a project still pins this connection. The renderer
  // surfaces the error inline; user has to re-pin or remove the
  // project first.
  const projectCount = (getDatabase()
    .prepare('SELECT COUNT(*) AS n FROM projects WHERE connection_id = ?')
    .get(id) as { n: number } | undefined)?.n ?? 0;
  if (projectCount > 0) {
    throw new Error(
      `connection: ${projectCount} project${projectCount === 1 ? '' : 's'} still use this profile`
    );
  }
  const res = getDatabase()
    .prepare('DELETE FROM connection_profiles WHERE id = ?')
    .run(id);
  if (res.changes === 0) throw new Error(`connection: unknown id ${id}`);
  emit({ type: 'connection.removed', id });
}

/* ─── Probes ──────────────────────────────────────────────────────── */

/** Categorise an ssh exit by stderr — matches what the F13.2 spec
 *  surfaces to the user. */
function classifySshFailure(stderr: string, code: number | null): ConnectionProbeStatus {
  const s = stderr.toLowerCase();
  if (s.includes('permission denied') || s.includes('authentication failed')) {
    return 'auth_failed';
  }
  if (s.includes('connection timed out') || s.includes('operation timed out')) {
    return 'timeout';
  }
  if (
    s.includes('no route to host')
    || s.includes('host is down')
    || s.includes('connection refused')
    || s.includes('could not resolve')
    || s.includes('name or service not known')
    || s.includes('name resolution failure')
  ) {
    return 'unreachable';
  }
  if (code === 255) return 'unreachable'; // generic ssh-level failure
  return 'error';
}

/** Build the ssh argv used by every probe. Keeps options consistent
 *  across testConnection / testPath / future fs ops. */
function sshArgs(profile: ConnectionProfile, command: string): string[] {
  if (profile.kind !== 'ssh') {
    throw new Error('sshArgs: profile is not an SSH profile');
  }
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=5',
    '-o', 'StrictHostKeyChecking=accept-new',
  ];
  if (profile.port && profile.port !== 22) {
    args.push('-p', String(profile.port));
  }
  if (profile.authMethod === 'key' && profile.authKeyPath) {
    args.push('-i', profile.authKeyPath);
  }
  args.push(`${profile.user}@${profile.host}`, '--', command);
  return args;
}

interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  errno?: string;
}

function runSsh(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      'ssh',
      args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // execFile resolves err with .code on non-zero exit.
        if (err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          resolve({ code: null, stdout: String(stdout), stderr: String(stderr), errno: 'ETIMEDOUT' });
          return;
        }
        const code =
          err && typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : child.exitCode ?? 0;
        resolve({
          code,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      }
    );
  });
}

function persistProbe(id: string, status: ConnectionProbeStatus): void {
  getDatabase()
    .prepare(
      'UPDATE connection_profiles SET last_status = ?, last_probed_at = ? WHERE id = ?'
    )
    .run(status, Date.now(), id);
  const profile = getConnection(id);
  if (profile) emit({ type: 'connection.updated', profile });
}

export interface TestConnectionResult {
  status: ConnectionProbeStatus;
  rttMs: number | null;
  detail: string;
}

export async function testConnection(id: string): Promise<TestConnectionResult> {
  const profile = getConnection(id);
  if (!profile) throw new Error(`connection: unknown id ${id}`);
  if (profile.kind === 'local') {
    persistProbe(id, 'success');
    return { status: 'success', rttMs: 0, detail: 'Local Mac' };
  }
  if (!profile.host || !profile.user) {
    persistProbe(id, 'error');
    return { status: 'error', rttMs: null, detail: 'profile is missing host or user' };
  }
  const started = Date.now();
  const res = await runSsh(sshArgs(profile, 'echo baton-probe-ok'), 7000);
  const rtt = Date.now() - started;
  if (res.errno === 'ETIMEDOUT') {
    persistProbe(id, 'timeout');
    return { status: 'timeout', rttMs: null, detail: 'ssh did not respond within 7 s' };
  }
  if (res.code === 0 && res.stdout.includes('baton-probe-ok')) {
    persistProbe(id, 'success');
    return { status: 'success', rttMs: rtt, detail: '' };
  }
  const status = classifySshFailure(res.stderr, res.code);
  persistProbe(id, status);
  return {
    status,
    rttMs: null,
    detail: (res.stderr || res.stdout).trim().slice(0, 800),
  };
}

export interface TestPathResult {
  ok: boolean;
  resolvedPath: string;
  detail: string;
}

/** Double-quote a path for `sh -c`, with `~` → `"$HOME"` rewriting.
 *  POSIX shells don't expand `~` inside double quotes — it only
 *  expands as the unquoted first character of a word — but `$HOME`
 *  DOES expand, so the substitution preserves safe-quoting of embedded
 *  spaces while still resolving the user's home dir. */
function shellQuoteWithTilde(p: string): string {
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME/${esc(p.slice(2))}"`;
  return `"${esc(p)}"`;
}

/** Validate a path on a connection. Locally: `fs.stat`. Remotely:
 *  `cd "$P" && pwd -P` over SSH — `pwd -P` handles `~` expansion and
 *  symlinks in one shot. */
export async function testPath(connectionId: string, path: string): Promise<TestPathResult> {
  const profile = getConnection(connectionId);
  if (!profile) throw new Error(`connection: unknown id ${connectionId}`);
  const quoted = shellQuoteWithTilde(path);
  if (profile.kind === 'local') {
    return new Promise<TestPathResult>((resolve) => {
      execFile(
        '/bin/sh',
        ['-c', `cd ${quoted} 2>&1 && pwd -P`],
        { timeout: 4000 },
        (err, stdout, stderr) => {
          if (err) {
            resolve({
              ok: false,
              resolvedPath: '',
              detail: (String(stderr) || String(stdout) || (err as Error).message).trim(),
            });
            return;
          }
          resolve({
            ok: true,
            resolvedPath: String(stdout).trim(),
            detail: '',
          });
        }
      );
    });
  }
  if (!profile.host || !profile.user) {
    return { ok: false, resolvedPath: '', detail: 'profile is missing host or user' };
  }
  const command = `cd ${quoted} 2>&1 && pwd -P`;
  const res = await runSsh(sshArgs(profile, command), 7000);
  if (res.errno === 'ETIMEDOUT') {
    return { ok: false, resolvedPath: '', detail: 'ssh did not respond within 7 s' };
  }
  if (res.code === 0) {
    return { ok: true, resolvedPath: res.stdout.trim(), detail: '' };
  }
  return {
    ok: false,
    resolvedPath: '',
    detail: (res.stderr || res.stdout).trim().slice(0, 800) || `exit ${res.code}`,
  };
}
