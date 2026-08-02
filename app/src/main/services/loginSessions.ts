/**
 * Login sessions — named credential profiles per agent.
 *
 * A login session is one way to authenticate a Claude Code / Codex spawn:
 *   • global  — the machine's default CLI login (no env override).
 *   • browser — a separate account signed in via the browser, kept in a
 *               baton-managed config dir (CLAUDE_CONFIG_DIR / CODEX_HOME),
 *               keyed by the session id (~/.baton/agents/<id>).
 *   • custom  — a custom API endpoint / gateway (base URL + key).
 *   • token   — a pasted long-lived token (Claude: CLAUDE_CODE_OAUTH_TOKEN;
 *               Codex: an OpenAI API key).
 *
 * Sessions live in the `login_sessions` table. Projects pick a default
 * Claude + Codex session; an individual agent session may override. This
 * module owns the store CRUD, the spawn env/args each session produces,
 * the browser-login pty flow, and secret encryption (OS keychain via
 * safeStorage). Secrets never leave the main process.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pty from 'node-pty';
import { safeStorage } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { batonHome } from '../paths.js';
import { getDatabase } from '../database/index.js';
import { emit } from './eventBus.js';
import { randomUUID } from 'node:crypto';
import type {
  AgentAccountId,
  AuthScheme,
  LoginKind,
  LoginSession,
  LoginSessionStatus,
} from '../../shared/ipc.js';

const execFileAsync = promisify(execFile);

/* ─── Row model ─────────────────────────────────────────────────────── */

interface LoginConfig {
  baseUrl?: string;
  authScheme?: AuthScheme;
  model?: string | null;
  headers?: string | null;
  /** Encrypted secret (base64, `enc:`/`plain:` prefixed), or absent. */
  secretEnc?: string | null;
}

interface LoginRow {
  id: string;
  name: string;
  agent: AgentAccountId;
  kind: LoginKind;
  config: LoginConfig;
  builtIn: boolean;
}

interface RawRow {
  id: string;
  name: string;
  agent: string;
  kind: string;
  config: string;
  built_in: number;
}

function parseRow(r: RawRow): LoginRow {
  let config: LoginConfig = {};
  try { config = JSON.parse(r.config) as LoginConfig; } catch { /* {} */ }
  return {
    id: r.id,
    name: r.name,
    agent: r.agent as AgentAccountId,
    kind: r.kind as LoginKind,
    config,
    builtIn: r.built_in === 1,
  };
}

export function getLoginRow(id: string): LoginRow | null {
  const r = getDatabase()
    .prepare('SELECT id, name, agent, kind, config, built_in FROM login_sessions WHERE id = ?')
    .get(id) as RawRow | undefined;
  return r ? parseRow(r) : null;
}

function allRows(): LoginRow[] {
  const rows = getDatabase()
    .prepare('SELECT id, name, agent, kind, config, built_in FROM login_sessions ORDER BY built_in DESC, name ASC')
    .all() as RawRow[];
  return rows.map(parseRow);
}

/** Public (secret-free) view of a session for the UI. */
function toSession(row: LoginRow): LoginSession {
  const isCustom = row.kind === 'custom';
  return {
    id: row.id,
    name: row.name,
    agent: row.agent,
    kind: row.kind,
    builtIn: row.builtIn,
    hasSecret: !!row.config.secretEnc,
    custom: isCustom
      ? {
          baseUrl: row.config.baseUrl ?? '',
          authScheme: row.config.authScheme ?? 'apikey',
          model: row.config.model ?? null,
          headers: row.config.headers ?? null,
        }
      : null,
  };
}

export function listLoginSessions(): LoginSession[] {
  return allRows().map(toSession);
}

/* ─── CRUD ──────────────────────────────────────────────────────────── */

export interface UpsertInput {
  agent: AgentAccountId;
  kind: LoginKind;
  name: string;
  baseUrl?: string;
  authScheme?: AuthScheme;
  model?: string | null;
  headers?: string | null;
  secret?: string;
}

function configFor(kind: LoginKind, input: UpsertInput, prev?: LoginConfig): LoginConfig {
  if (kind === 'global' || kind === 'browser') return {};
  const secretEnc =
    input.secret !== undefined && input.secret !== ''
      ? encryptSecret(input.secret)
      : prev?.secretEnc ?? null;
  if (kind === 'token') return { secretEnc };
  // custom
  return {
    baseUrl: (input.baseUrl ?? prev?.baseUrl ?? '').trim(),
    authScheme: input.authScheme ?? prev?.authScheme ?? 'apikey',
    model: input.model?.trim() ? input.model.trim() : null,
    headers: input.headers?.trim() ? input.headers.trim() : null,
    secretEnc,
  };
}

export function createLoginSession(input: UpsertInput): LoginSession {
  const id = randomUUID();
  const config = configFor(input.kind, input);
  getDatabase()
    .prepare(
      `INSERT INTO login_sessions (id, name, agent, kind, config, built_in, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .run(id, input.name.trim(), input.agent, input.kind, JSON.stringify(config), Date.now());
  return toSession(getLoginRow(id)!);
}

export interface UpdateInput {
  id: string;
  name?: string;
  baseUrl?: string;
  authScheme?: AuthScheme;
  model?: string | null;
  headers?: string | null;
  secret?: string;
}

export function updateLoginSession(input: UpdateInput): LoginSession {
  const row = getLoginRow(input.id);
  if (!row) throw new Error(`login session not found: ${input.id}`);

  const name = input.name?.trim() || row.name;
  // Built-ins (global) only allow a rename — never gain a config.
  const config = row.builtIn
    ? row.config
    : configFor(row.kind, { agent: row.agent, kind: row.kind, name, ...input }, row.config);

  getDatabase()
    .prepare('UPDATE login_sessions SET name = ?, config = ? WHERE id = ?')
    .run(name, JSON.stringify(config), input.id);
  return toSession(getLoginRow(input.id)!);
}

export function deleteLoginSession(id: string): void {
  const row = getLoginRow(id);
  if (!row) return;
  if (row.builtIn) throw new Error('the built-in global login cannot be deleted');

  const db = getDatabase();
  // Drop references so projects/sessions fall back to the global login.
  db.prepare('UPDATE projects SET claude_login_session_id = NULL WHERE claude_login_session_id = ?').run(id);
  db.prepare('UPDATE projects SET codex_login_session_id = NULL WHERE codex_login_session_id = ?').run(id);
  db.prepare('UPDATE sessions SET login_session_id = NULL WHERE login_session_id = ?').run(id);
  db.prepare('DELETE FROM login_sessions WHERE id = ?').run(id);

  // A browser session owns a config dir — remove it.
  if (row.kind === 'browser') {
    try { fs.rmSync(agentConfigDir(row), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ─── Spawn env / args resolution ───────────────────────────────────── */

/** The env var each CLI honours to relocate its config dir. */
function configEnvVar(agent: AgentAccountId): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
  return agent === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
}

function cliName(agent: AgentAccountId): string {
  return agent === 'claude-code' ? 'claude' : 'codex';
}

/** Config dir for a browser session (its own isolated login). */
function agentConfigDir(row: LoginRow): string {
  return path.join(batonHome(), 'agents', row.id);
}

/** The built-in global session id for an agent. */
export function globalSessionId(agent: AgentAccountId): string {
  return agent === 'claude-code' ? 'global-claude-code' : 'global-codex';
}

/** Resolve a (possibly null) login session id to the row that should
 *  drive a spawn for `agent`, honouring built-in-global fallback and
 *  guarding against an id that belongs to the wrong agent / was deleted. */
function resolveRow(id: string | null | undefined, agent: AgentAccountId): LoginRow | null {
  if (id) {
    const row = getLoginRow(id);
    if (row && row.agent === agent) return row;
  }
  return getLoginRow(globalSessionId(agent));
}

/** Env override for a spawn, given the resolved login session id and the
 *  backend. Global → {}. Spread into the spawn env by the caller. */
export function buildLoginEnv(
  id: string | null | undefined,
  agent: AgentAccountId
): Record<string, string> {
  const row = resolveRow(id, agent);
  if (!row || row.kind === 'global') return {};

  if (row.kind === 'browser') {
    const dir = agentConfigDir(row);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    return { [configEnvVar(agent)]: dir };
  }

  const secret = decryptSecret(row.config.secretEnc ?? null);

  if (row.kind === 'token') {
    if (!secret) return {};
    return agent === 'claude-code'
      ? { CLAUDE_CODE_OAUTH_TOKEN: secret }
      : { OPENAI_API_KEY: secret };
  }

  // custom
  const baseUrl = (row.config.baseUrl ?? '').trim();
  if (!baseUrl) return {};
  if (agent === 'claude-code') {
    const env: Record<string, string> = { ANTHROPIC_BASE_URL: baseUrl };
    if (secret) {
      env[row.config.authScheme === 'token' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] =
        secret;
    }
    if (row.config.model) env['ANTHROPIC_MODEL'] = row.config.model;
    if (row.config.headers && row.config.headers.trim()) {
      env['ANTHROPIC_CUSTOM_HEADERS'] = row.config.headers.trim();
    }
    return env;
  }
  const env: Record<string, string> = { OPENAI_BASE_URL: baseUrl };
  if (secret) env['OPENAI_API_KEY'] = secret;
  return env;
}

/** Extra `-c key=value` overrides Codex needs for custom/token sessions
 *  (force API-key auth so a lingering ChatGPT login can't win; pin the
 *  model for custom). Empty for global/browser or non-codex. */
export function buildCodexLoginArgs(id: string | null | undefined): string[] {
  const row = resolveRow(id, 'codex');
  if (!row || (row.kind !== 'custom' && row.kind !== 'token')) return [];
  const args = ['-c', 'preferred_auth_method="apikey"'];
  if (row.kind === 'custom' && row.config.model) {
    args.push('-c', `model=${JSON.stringify(row.config.model)}`);
  }
  return args;
}

/* ─── Status probe ──────────────────────────────────────────────────── */

async function isInstalled(agent: AgentAccountId): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(cliName(agent), ['--version']);
    return /\d+\.\d+/.test(stdout);
  } catch {
    return false;
  }
}

/** Live status for a session (CLI installed + whether it's usable). */
export async function probeLoginSession(id: string): Promise<LoginSessionStatus> {
  const row = getLoginRow(id);
  if (!row) return { installed: false, valid: false, label: null };
  const installed = await isInstalled(row.agent);

  // Config-only kinds: "valid" means the necessary fields are present.
  if (row.kind === 'custom') {
    const ok = !!(row.config.baseUrl && row.config.baseUrl.trim());
    return { installed, valid: ok, label: ok ? hostOf(row.config.baseUrl!) : null };
  }
  if (row.kind === 'token') {
    const ok = !!row.config.secretEnc;
    return { installed, valid: ok, label: ok ? 'token set' : null };
  }

  // global / browser → ask the CLI.
  const env =
    row.kind === 'browser'
      ? { ...process.env, [configEnvVar(row.agent)]: agentConfigDir(row) }
      : process.env;
  try {
    if (row.agent === 'claude-code') {
      const { stdout } = await execFileAsync('claude', ['auth', 'status', '--json'], { env });
      const j = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
      const valid = j.loggedIn === true;
      return { installed, valid, label: valid ? j.email ?? j.subscriptionType ?? 'signed in' : null };
    }
    const { stdout } = await execFileAsync('codex', ['login', 'status'], { env });
    const text = stdout.trim();
    const valid = text.length > 0 && !/not\s+logged\s+in/i.test(text);
    return { installed, valid, label: valid ? (text.split('\n')[0] ?? 'signed in').trim() : null };
  } catch {
    return { installed, valid: false, label: null };
  }
}

/* ─── Browser login flow (OAuth in a pty) ───────────────────────────── */

interface LoginFlow {
  loginId: string;
  sessionId: string;
  agent: AgentAccountId;
  proc: pty.IPty;
  buf: string;
  browserOpened: boolean;
  awaitingCode: boolean;
  finished: boolean;
  timer: NodeJS.Timeout;
}

const flows = new Map<string, LoginFlow>();
const flowBySession = new Map<string, string>();

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const AUTH_URL = /https?:\/\/[^\s'"]*(?:oauth|authorize|auth\/)[^\s'"]*/i;
const stripAnsi = (s: string): string => s.replace(ANSI, '');
let loginSeq = 0;

/** Start the browser sign-in for a `browser` session, into its config
 *  dir. Returns a loginId the renderer correlates with progress events. */
export function startLogin(sessionId: string): { loginId: string } {
  const row = getLoginRow(sessionId);
  if (!row) throw new Error(`login session not found: ${sessionId}`);
  if (row.kind !== 'browser') throw new Error('only browser sessions sign in');

  const prior = flowBySession.get(sessionId);
  if (prior) cancelLogin(prior);

  const loginId = `login-${sessionId}-${++loginSeq}`;
  const dir = agentConfigDir(row);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }

  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    [configEnvVar(row.agent)]: dir,
  } as Record<string, string>;

  const args = row.agent === 'claude-code' ? ['auth', 'login'] : ['login'];
  const proc = pty.spawn(cliName(row.agent), args, {
    name: 'xterm-256color',
    cols: 100,
    rows: 32,
    cwd: dir,
    env,
  });

  const flow: LoginFlow = {
    loginId,
    sessionId,
    agent: row.agent,
    proc,
    buf: '',
    browserOpened: false,
    awaitingCode: false,
    finished: false,
    timer: setTimeout(() => cancelLogin(loginId), 5 * 60_000),
  };
  flows.set(loginId, flow);
  flowBySession.set(sessionId, loginId);

  proc.onData((chunk) => {
    flow.buf += stripAnsi(chunk);
    if (flow.buf.length > 8192) flow.buf = flow.buf.slice(-8192);

    if (!flow.browserOpened) {
      const m = flow.buf.match(AUTH_URL);
      if (m) {
        flow.browserOpened = true;
        emit({
          type: 'account.login_progress',
          loginId,
          sessionId,
          backend: row.agent,
          phase: 'browser_opened',
          url: m[0],
        });
      }
    }
    if (!flow.awaitingCode && /paste\s+code/i.test(flow.buf)) {
      flow.awaitingCode = true;
      emit({
        type: 'account.login_progress',
        loginId,
        sessionId,
        backend: row.agent,
        phase: 'awaiting_code',
      });
    }
  });

  proc.onExit(({ exitCode }) => {
    if (flow.finished) return;
    flow.finished = true;
    clearTimeout(flow.timer);
    flows.delete(loginId);
    if (flowBySession.get(sessionId) === loginId) flowBySession.delete(sessionId);

    if (exitCode === 0) {
      void probeLoginSession(sessionId).then((status) => {
        emit({
          type: 'account.login_progress',
          loginId,
          sessionId,
          backend: row.agent,
          phase: status.valid ? 'success' : 'error',
          account: status.label,
          message: status.valid ? null : 'Login finished but the account is not signed in.',
        });
      });
    } else {
      emit({
        type: 'account.login_progress',
        loginId,
        sessionId,
        backend: row.agent,
        phase: 'error',
        message: lastLine(flow.buf) || `Login exited with code ${exitCode}.`,
      });
    }
  });

  return { loginId };
}

export function submitLoginCode(loginId: string, code: string): void {
  const flow = flows.get(loginId);
  if (!flow) return;
  flow.proc.write(code.trim() + '\r');
}

export function cancelLogin(loginId: string): void {
  const flow = flows.get(loginId);
  if (!flow) return;
  flow.finished = true;
  clearTimeout(flow.timer);
  flows.delete(loginId);
  if (flowBySession.get(flow.sessionId) === loginId) flowBySession.delete(flow.sessionId);
  try { flow.proc.kill(); } catch { /* already gone */ }
}

/* ─── Secret encryption (OS keychain via safeStorage) ──────────────── */

function encryptSecret(plain: string): string {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(plain).toString('base64');
    }
  } catch { /* fall through */ }
  return 'plain:' + Buffer.from(plain, 'utf8').toString('base64');
}

function decryptSecret(stored: string | null): string | null {
  if (!stored) return null;
  if (stored.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch {
      return null;
    }
  }
  if (stored.startsWith('plain:')) {
    return Buffer.from(stored.slice(6), 'base64').toString('utf8');
  }
  return null;
}

function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url; }
}

function lastLine(s: string): string {
  const lines = s.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}
