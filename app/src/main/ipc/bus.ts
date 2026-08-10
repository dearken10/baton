/**
 * Control-channel IPC bus.
 *
 * Single registration point for every control verb (PRD F10.1).
 * Each handler is wrapped with Zod parse-on-input + parse-on-output
 * so a renderer error or a main-side bug is surfaced as a typed
 * Error, never an unhandled crash (NF8: fail-closed for IPC schema
 * violations).
 *
 * High-rate `pty.data` does NOT come through this bus — it has its
 * own channel (PRD F10.2). See SessionManager.
 */

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileP = promisify(execFile);

import {
  Channels,
  ControlVerbs,
  type ControlVerb,
  type RequestOf,
  type ResponseOf,
} from '../../shared/ipc.js';
import { addProject, createProject, listProjects, getProject, removeProject, renameProject, reorderProjects, setProjectSnoozed, setProjectLoginDefaults, setProjectMaestroShow, setProjectMaestroMode } from '../services/projectStore.js';
import { batonHome } from '../paths.js';
import {
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  testConnection,
  testPath,
} from '../services/connectionStore.js';
import { getSessionManager } from '../services/sessionManager.js';
import { getOtelSettings, setOtelSettings, getOnboarded, setOnboarded } from '../services/settingsStore.js';
import {
  listLoginSessions,
  createLoginSession,
  updateLoginSession,
  deleteLoginSession,
  reorderLoginSessions,
  probeLoginSession,
  startLogin,
  submitLoginCode,
  cancelLogin,
} from '../services/loginSessions.js';
import { setSelectedSession } from '../services/notifier.js';
import { readFileTree, readSubdir, readGitStatus } from '../services/worktreeReader.js';
import { readSessionTurns } from '../services/sessionTurns.js';
import { listWorktrees, removeWorktree } from '../services/worktreeManager.js';
import { getUsage } from '../services/claudeUsageApi.js';
import { getCodexUsage } from '../services/codexUsageApi.js';
import { buildUsageList } from '../services/usageList.js';
import { getMaestroPrompts, setMaestroPrompts } from '../services/maestroPrompts.js';
import {
  getMaestroSuggestion,
  acceptMaestroSuggestion,
  dismissMaestroSuggestion,
  regenerateMaestroSuggestion,
} from '../services/maestroSuggestion.js';
import { getDatabase } from '../database/index.js';
import { getFs, getFsForProject, getFsForSession, reconnect as reconnectConnection, dropConnection } from '../services/fs/registry.js';

type Handler<V extends ControlVerb> = (
  req: RequestOf<V>
) => Promise<ResponseOf<V>> | ResponseOf<V>;

const handlers: { [V in ControlVerb]?: Handler<V> } = {
  'app.ping': () => ({ ok: true as const, ts: Date.now() }),
  'app.meta': () => ({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    node: process.versions.node,
    platform: process.platform,
  }),
  'app.setSelectedSession': (req) => {
    setSelectedSession(req.sessionId);
    return {};
  },

  'settings.getOtel': () => ({ otel: getOtelSettings() }),
  'settings.setOtel': (req) => ({ otel: setOtelSettings(req) }),

  'loginSession.list': () => ({ sessions: listLoginSessions() }),
  'loginSession.create': (req) => ({
    session: createLoginSession({
      agent: req.agent,
      kind: req.kind,
      name: req.name,
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.authScheme !== undefined ? { authScheme: req.authScheme } : {}),
      model: req.model ?? null,
      headers: req.headers ?? null,
      ...(req.secret !== undefined ? { secret: req.secret } : {}),
    }),
  }),
  'loginSession.update': (req) => ({
    session: updateLoginSession({
      id: req.id,
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
      ...(req.authScheme !== undefined ? { authScheme: req.authScheme } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.headers !== undefined ? { headers: req.headers } : {}),
      ...(req.secret !== undefined ? { secret: req.secret } : {}),
    }),
  }),
  'loginSession.delete': (req) => {
    deleteLoginSession(req.id);
    return { ok: true as const };
  },
  'loginSession.reorder': (req) => ({ sessions: reorderLoginSessions(req.orderedIds) }),
  'loginSession.probe': (req) => probeLoginSession(req.id),
  'loginSession.loginStart': (req) => startLogin(req.id),
  'loginSession.submitCode': (req) => {
    submitLoginCode(req.loginId, req.code);
    return { ok: true as const };
  },
  'loginSession.cancel': (req) => {
    cancelLogin(req.loginId);
    return { ok: true as const };
  },
  'project.setLoginDefaults': (req) => ({
    project: setProjectLoginDefaults(
      req.projectId,
      req.claudeLoginSessionId,
      req.codexLoginSessionId,
    ),
  }),

  'onboarding.getState': () => ({ done: getOnboarded() }),
  'onboarding.complete': () => {
    setOnboarded(true);
    return { done: true as const };
  },

  'project.pickFolder': async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(focused ?? new BrowserWindow({ show: false }), {
      title: 'Add a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { path: null };
    return { path: res.filePaths[0] ?? null };
  },
  'project.add': (req) => ({
    project: addProject(req.path, req.name, req.connectionId ?? 'local', {
      claudeLoginSessionId: req.claudeLoginSessionId ?? null,
      codexLoginSessionId: req.codexLoginSessionId ?? null,
    }),
  }),
  'project.create': async (req) => ({
    project: await createProject({
      path: req.path,
      ...(req.initGit !== undefined ? { initGit: req.initGit } : {}),
      ...(req.connectionId !== undefined ? { connectionId: req.connectionId } : {}),
      logins: {
        claudeLoginSessionId: req.claudeLoginSessionId ?? null,
        codexLoginSessionId: req.codexLoginSessionId ?? null,
      },
    }),
  }),
  'project.list': () => ({ projects: listProjects() }),
  'project.remove': async (req) => {
    // Kill any live ptys for sessions in this project first so they
    // don't keep running orphaned after the rows disappear.
    const mgr = getSessionManager();
    for (const s of mgr.listAll().filter((x) => x.projectId === req.projectId)) {
      try { await mgr.delete(s.id, { removeWorktree: false }); } catch { /* best-effort */ }
    }
    removeProject(req.projectId);
    return { ok: true as const };
  },
  'project.reorder': (req) => {
    reorderProjects(req.orderedIds);
    return { ok: true as const };
  },
  'project.rename': (req) => {
    const project = renameProject(req.projectId, req.newName);
    return { project };
  },
  'project.setSnoozed': (req) => {
    const project = setProjectSnoozed(req.projectId, req.snoozed);
    return { project };
  },
  'project.setMaestroShow': (req) => {
    const project = setProjectMaestroShow(req.projectId, req.show);
    return { project };
  },
  'project.setMaestroMode': (req) => {
    const project = setProjectMaestroMode(req.projectId, req.mode);
    return { project };
  },
  'session.reorder': (req) => {
    getSessionManager().reorderSessions(req.orderedIds);
    return { ok: true as const };
  },
  'session.setSnoozed': (req) => {
    const session = getSessionManager().setSnoozed(req.sessionId, req.snoozed);
    return { session };
  },
  'session.setMaestroShow': (req) => {
    const session = getSessionManager().setMaestroShow(
      req.sessionId,
      req.show,
    );
    return { session };
  },
  'session.setMaestroMode': (req) => {
    const session = getSessionManager().setMaestroMode(
      req.sessionId,
      req.mode,
    );
    return { session };
  },
  'session.setTitle': (req) => {
    const session = getSessionManager().setTitle(req.sessionId, req.title);
    return { session };
  },
  'session.setJiraTaskId': async (req) => {
    const session = await getSessionManager().setJiraTaskId(req.sessionId, req.jiraTaskId);
    return { session };
  },

  'connection.list': () => ({ profiles: listConnections() }),
  'connection.create': (req) => {
    const profile = createConnection({
      name: req.name,
      host: req.host,
      user: req.user,
      port: req.port,
      authMethod: req.authMethod,
      ...(req.authKeyPath !== undefined ? { authKeyPath: req.authKeyPath } : {}),
      claudeCredsMode: req.claudeCredsMode,
    });
    return { profile };
  },
  'connection.update': (req) => {
    const profile = updateConnection({
      id: req.id,
      ...(req.name !== undefined ? { name: req.name } : {}),
      ...(req.host !== undefined ? { host: req.host } : {}),
      ...(req.user !== undefined ? { user: req.user } : {}),
      ...(req.port !== undefined ? { port: req.port } : {}),
      ...(req.authMethod !== undefined ? { authMethod: req.authMethod } : {}),
      ...(req.authKeyPath !== undefined ? { authKeyPath: req.authKeyPath } : {}),
      ...(req.claudeCredsMode !== undefined ? { claudeCredsMode: req.claudeCredsMode } : {}),
    });
    return { profile };
  },
  'connection.delete': (req) => {
    deleteConnection(req.id);
    dropConnection(req.id);
    return { ok: true as const };
  },
  'connection.test': async (req) => {
    const res = await testConnection(req.id);
    return res;
  },
  'connection.testPath': async (req) => {
    const res = await testPath(req.connectionId, req.path);
    return res;
  },
  'connection.reconnect': async (req) => {
    await reconnectConnection(req.id);
    return { ok: true as const };
  },
  'connection.listDir': async (req) => {
    try {
      const fs = getFs(req.connectionId);
      // Resolve `~` and any relative segments to an absolute path. For
      // an empty input we default to the home directory.
      const requested = req.path.trim() || '~';
      const quoted = shellQuoteWithTilde(requested);
      const resolveRes = await fs.exec(
        'sh', ['-c', `cd ${quoted} 2>&1 && pwd -P`],
        { cwd: '/', timeoutMs: 5000 }
      );
      if (resolveRes.code !== 0) {
        return {
          resolvedPath: '',
          entries: [],
          error: (resolveRes.stderr || resolveRes.stdout).trim() || `exit ${resolveRes.code}`,
        };
      }
      const resolvedPath = resolveRes.stdout.trim();
      const entries = await fs.readdir(resolvedPath);
      entries.sort((a, b) => {
        const ad = a.kind === 'dir' ? 0 : 1;
        const bd = b.kind === 'dir' ? 0 : 1;
        if (ad !== bd) return ad - bd;
        return a.name.localeCompare(b.name);
      });
      return { resolvedPath, entries, error: '' };
    } catch (err) {
      return { resolvedPath: '', entries: [], error: String(err) };
    }
  },

  'session.list': () => ({
    sessions: getSessionManager().listAll(),
    startingIds: getSessionManager().autoResumeCandidateIds(),
  }),
  'usage.getStats': async () => getUsage(),
  'usage.getCodexStats': () => getCodexUsage(),
  'usage.list': async () => ({ items: await buildUsageList() }),
  'maestro.getSuggestion':      (req) => ({ suggestion: getMaestroSuggestion(req.sessionId) }),
  'maestro.acceptSuggestion':   (req) => acceptMaestroSuggestion(req.sessionId, req.prompt),
  'maestro.dismissSuggestion':  (req) => dismissMaestroSuggestion(req.sessionId),
  'maestro.regenerateSuggestion': (req) => regenerateMaestroSuggestion(req.sessionId),
  'maestro.getPrompts':     () => getMaestroPrompts(),
  'maestro.setPrompts':     (req) => setMaestroPrompts({ goal: req.goal }),
  'session.spawn': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    if (req.newWorktreeBranch && req.existingWorktreePath) {
      throw new Error(
        'Cannot set both newWorktreeBranch and existingWorktreePath.'
      );
    }
    // A companion terminal attaches to an existing agent session: it
    // always runs a plain shell in the parent's exact worktree, so we
    // take the cwd straight from the parent row (no worktree lookup) and
    // force the shell backend regardless of what the renderer asked for.
    if (req.parentSessionId) {
      const parent = getSessionManager()
        .listAll()
        .find((s) => s.id === req.parentSessionId);
      if (!parent) {
        throw new Error(`Unknown parent session: ${req.parentSessionId}`);
      }
      const session = await getSessionManager().spawn({
        projectId: parent.projectId,
        backendId: 'shell',
        cwd: parent.worktreePath,
        parentSessionId: parent.id,
      });
      return { session };
    }
    // Default cwd is the project root; an existing worktree path
    // overrides it (must belong to this project's worktree list — we
    // verify against listWorktrees so the renderer can't sneak in an
    // arbitrary directory).
    let cwd = project.path;
    if (req.existingWorktreePath) {
      const wts = await listWorktrees(getFsForProject(project.id), project.path);
      const ok = wts.some((w) => w.path === req.existingWorktreePath);
      if (!ok) {
        throw new Error(
          `Worktree not found for project ${project.name}: ${req.existingWorktreePath}`
        );
      }
      cwd = req.existingWorktreePath;
    }
    const session = await getSessionManager().spawn({
      projectId: project.id,
      backendId: req.backendId,
      cwd,
      // Repo name for the OTEL `repo` attribute; jira ticket (if the
      // renderer supplied one) for `jira.ticket`. Both are no-ops when
      // telemetry is disabled.
      repo: project.name,
      ...(req.newWorktreeBranch
        ? { newWorktreeBranch: req.newWorktreeBranch }
        : {}),
      ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
      ...(req.model !== undefined ? { model: req.model } : {}),
      ...(req.jiraTaskId ? { jiraTaskId: req.jiraTaskId } : {}),
      // The renderer's chosen login (New Session dialog). Without this the
      // pick is silently dropped and the spawn falls back to the project
      // default → global, inheriting the shell's auth vars.
      ...(req.loginSessionId ? { loginSessionId: req.loginSessionId } : {}),
    });
    return { session };
  },
  'session.kill': async (req) => {
    await getSessionManager().kill(req.sessionId);
    return { ok: true as const };
  },
  'session.resume': async (req) => {
    const session = await getSessionManager().resume(req.sessionId);
    return { session };
  },
  'session.respawn': async (req) => {
    const session = await getSessionManager().respawn(req.sessionId);
    return { session };
  },
  'session.clone': async (req) => {
    const session = await getSessionManager().clone(
      req.sessionId,
      req.newWorktreeBranch ? { newWorktreeBranch: req.newWorktreeBranch } : {}
    );
    return { session };
  },
  'session.revertToTurn': async (req) => {
    return await getSessionManager().revertToTurn(
      req.sessionId,
      req.turnId,
      req.turnTs
    );
  },
  'session.setPermissionMode': async (req) => {
    const session = await getSessionManager().setPermissionMode(req.sessionId, req.mode);
    return { session };
  },
  'session.setModel': async (req) => {
    const session = await getSessionManager().setModel(req.sessionId, req.model);
    return { session };
  },
  'session.setLoginSessionId': async (req) => {
    const session = await getSessionManager().setLoginSessionId(
      req.sessionId,
      req.loginSessionId,
    );
    return { session };
  },
  'session.delete': async (req) => {
    const opts =
      req.removeWorktree === undefined
        ? {}
        : { removeWorktree: req.removeWorktree };
    const { worktreeRemoved } = await getSessionManager().delete(
      req.sessionId,
      opts
    );
    return { ok: true as const, worktreeRemoved };
  },
  'session.rename': async (req) => {
    const session = await getSessionManager().rename(
      req.sessionId,
      req.newBranchName
    );
    return { session };
  },

  'worktree.fileTree': async (req) => {
    // Tolerant lookup: if the session was just deleted, the renderer
    // can still have an in-flight call from a stale effect — return
    // an empty tree instead of throwing, so main's log stays quiet.
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) {
      return { root: { name: '', path: '', type: 'dir' as const, children: [] } };
    }
    const fs = getFsForSession(req.sessionId);
    if (!fs) {
      return { root: { name: '', path: '', type: 'dir' as const, children: [] } };
    }
    const root = await readFileTree(fs, worktreePath);
    return { root };
  },
  'worktree.readDir': async (req) => {
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) return { children: [], truncated: false };
    const fs = getFsForSession(req.sessionId);
    if (!fs) return { children: [], truncated: false };
    return await readSubdir(fs, worktreePath, req.relPath);
  },
  'worktree.gitStatus': async (req) => {
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) {
      return { branch: null, ahead: 0, behind: 0, files: [], dirty: false };
    }
    const fs = getFsForSession(req.sessionId);
    if (!fs) {
      return { branch: null, ahead: 0, behind: 0, files: [], dirty: false };
    }
    const report = await readGitStatus(fs, worktreePath);
    return report;
  },
  'session.turns': async (req) => {
    // Find the row; if it's gone (deleted in a race, or never existed)
    // just return an empty list rather than throwing. Remote-session
    // transcripts live on the remote host (under that user's
    // ~/.claude); reading them needs an SSH probe we haven't built, so
    // remote sessions also return [] for now.
    const session = getSessionManager().listAll().find((s) => s.id === req.sessionId);
    if (!session) return { turns: [] };
    const project = getProject(session.projectId);
    if (project && project.connectionId !== 'local') return { turns: [] };
    return { turns: readSessionTurns(session) };
  },
  'worktree.list': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    const projectFs = getFsForProject(project.id);
    const entries = await listWorktrees(projectFs, project.path);
    // Same `.git/...` filter we apply to orphan detection: skip
    // submodule gitdirs that masquerade as worktrees. Path separator
    // is `/` on remote (POSIX), platform-dependent locally.
    const sep = projectFs.isLocal ? path.sep : '/';
    const worktrees = entries
      .filter((e) => !e.path.includes(`${sep}.git${sep}`))
      .map((e) => ({ path: e.path, branch: e.branch }));
    return { worktrees };
  },
  'worktree.listOrphans': async () => {
    const projects = listProjects();
    const known = new Set<string>(
      (getDatabase()
        .prepare('SELECT worktree_path FROM sessions')
        .all() as { worktree_path: string }[]).map((r) => r.worktree_path)
    );
    const orphans: { projectId: string; path: string; branch: string | null }[] = [];
    for (const p of projects) {
      let entries: { path: string; branch: string | null; head: string | null }[];
      try {
        const projectFs = getFsForProject(p.id);
        entries = await listWorktrees(projectFs, p.path);
      } catch {
        // Remote that's currently offline — skip orphan scan for it.
        continue;
      }
      for (const e of entries) {
        // Any path with a `/.git/` segment is git bookkeeping
        // (submodule gitdirs, etc.) — never a real worktree, even
        // when `git worktree list` reports it. The classic case is a
        // submodule project whose worktree-list response points to
        //   <parent>/.git/modules/<submodule>
        // and would otherwise tempt the user to click Remove (which
        // would `git worktree remove --force` the submodule's gitdir
        // and break the parent repo's submodule tracking).
        // `path.sep` for local (might be `\` on Windows builds);
        // `/` for any remote, where filesystems are POSIX.
        const sep = getFsForProject(p.id).isLocal ? path.sep : '/';
        if (e.path.includes(`${sep}.git${sep}`)) continue;
        // The "main" worktree is already filtered out by listWorktrees.
        // Anything not tracked by a session row is an orphan.
        if (!known.has(e.path)) {
          orphans.push({ projectId: p.id, path: e.path, branch: e.branch });
        }
      }
    }
    return { orphans };
  },
  'git.stage': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) throw new Error(`Unknown session: ${req.sessionId}`);
    const res = await fs.exec('git', ['add', '--', ...req.paths], {
      cwd: worktreePath, timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      throw new Error(`git add failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return { ok: true as const };
  },
  'git.unstage': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) throw new Error(`Unknown session: ${req.sessionId}`);
    const res = await fs.exec('git', ['reset', 'HEAD', '--', ...req.paths], {
      cwd: worktreePath, timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      throw new Error(`git reset failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    return { ok: true as const };
  },
  'git.commit': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) throw new Error(`Unknown session: ${req.sessionId}`);
    const res = await fs.exec('git', ['commit', '-m', req.message], {
      cwd: worktreePath, timeoutMs: 30_000,
    });
    if (res.code !== 0) {
      throw new Error(`git commit failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    // Grab the short OID for the toast.
    const oidRes = await fs.exec('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: worktreePath, timeoutMs: 5000,
    });
    return {
      ok: true as const,
      oid: oidRes.stdout.trim(),
    };
  },
  'git.push': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) return { ok: false, output: 'session not found' };
    const res = await fs.exec('git', ['push'], {
      cwd: worktreePath, timeoutMs: 120_000,
    });
    if (res.code !== 0) {
      return { ok: false, output: res.stderr.trim() || res.stdout.trim() || `exit ${res.code}` };
    }
    return { ok: true, output: res.stdout || 'Push complete.' };
  },
  'git.pull': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) return { ok: false, output: 'session not found' };
    const res = await fs.exec('git', ['pull', '--ff-only'], {
      cwd: worktreePath, timeoutMs: 120_000,
    });
    if (res.code !== 0) {
      return { ok: false, output: res.stderr.trim() || res.stdout.trim() || `exit ${res.code}` };
    }
    return { ok: true, output: res.stdout || 'Pull complete.' };
  },
  'worktree.removeOrphan': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    const projectFs = getFsForProject(project.id);
    await removeWorktree(projectFs, project.path, req.path);
    return { ok: true as const };
  },
  'worktree.search': async (req) => {
    const cwd = resolveWorktreePath(req.sessionId);
    const fs = getFsForSession(req.sessionId);
    if (!fs) return { matches: [], truncated: false, error: 'session not found' };
    return await runGitGrep(fs, cwd, req);
  },
  'worktree.resolveFile': async (req) => {
    // Tolerant: a stale click after the session was deleted should
    // resolve to "no match" rather than throw.
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) return { matches: [] };
    const fs = getFsForSession(req.sessionId);
    if (!fs) return { matches: [] };
    return await resolveWorktreeFile(fs, worktreePath, req.ref);
  },
  'shell.openPath': async (req) => {
    // openPath returns a string — empty on success, error message on
    // failure. We surface it as a boolean for the renderer.
    const err = await shell.openPath(req.absPath);
    return { ok: err === '' };
  },
  'shell.openTerminal': async (req) => {
    // Launch the platform's default terminal at the project path.
    // macOS: `open -a Terminal <path>` — works for both Terminal.app
    // and any user-set default (iTerm, etc.) if they've made it the
    // .terminal handler.
    try {
      if (process.platform === 'darwin') {
        await execFileP('open', ['-a', 'Terminal', req.absPath]);
      } else if (process.platform === 'win32') {
        await execFileP('cmd', ['/c', 'start', '', 'cmd', '/K', `cd /d "${req.absPath}"`]);
      } else {
        await execFileP('x-terminal-emulator', [], { cwd: req.absPath });
      }
      return { ok: true, error: null };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  'shell.openExternal': async (req) => {
    // Route an external http(s) link to the OS default browser. The
    // renderer only calls this for non-localhost URLs; localhost dev
    // servers still render in the in-app browser tab.
    try {
      await shell.openExternal(req.url);
      return { ok: true, error: null };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
  'editor.openIn': async (req) => {
    // VS Code + Cursor register URL schemes that handle file:// paths.
    // Zed doesn't reliably ship a URL scheme on every install, so we
    // shell out to its CLI. All three: if the external app isn't
    // installed, the OS just won't open anything — we surface that as
    // ok:false so the renderer can prompt the user to install.
    try {
      switch (req.editor) {
        case 'vscode': {
          await shell.openExternal(`vscode://file${req.absPath}`);
          return { ok: true, error: null };
        }
        case 'cursor': {
          await shell.openExternal(`cursor://file${req.absPath}`);
          return { ok: true, error: null };
        }
        case 'zed': {
          await execFileP('zed', [req.absPath]);
          return { ok: true, error: null };
        }
      }
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: false, error: 'unknown editor' };
  },
  'file.read': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    const opts = req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : undefined;
    return await fs.readFile(req.absPath, opts);
  },
  'file.readGitDiff': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');

    // Find the repo root via `git rev-parse --show-toplevel`. For local
    // we can also walk the parent chain (older code path); for remote
    // shelling out is the only option, so we unify.
    const stat = await fs.stat(req.absPath);
    let working = '';
    if (stat) {
      const r = await fs.readFile(req.absPath, { maxBytes: 5 * 1024 * 1024 });
      if (!r.binary && !r.tooLarge) working = r.content;
    }

    // cwd for the git command: parent of the file. If the file itself
    // is gone, walk up via a parent path until we find a dir that
    // exists — easy with posix join + `dirname`.
    const cwd = req.absPath.replace(/\/+[^/]+\/?$/, '') || '/';
    const rootRes = await fs.exec('git', ['rev-parse', '--show-toplevel'], {
      cwd, timeoutMs: 6000,
    });
    if (rootRes.code !== 0) {
      return {
        head: working,
        working,
        state: 'clean' as const,
        inRepo: false,
        mtimeMs: stat?.mtimeMs ?? 0,
      };
    }
    const repoRoot = rootRes.stdout.trim();
    if (!repoRoot) {
      return {
        head: working,
        working,
        state: 'clean' as const,
        inRepo: false,
        mtimeMs: stat?.mtimeMs ?? 0,
      };
    }

    // Make path relative using POSIX semantics — works for both Fs.
    const rel = req.absPath.startsWith(repoRoot + '/')
      ? req.absPath.slice(repoRoot.length + 1)
      : req.absPath;

    const showRes = await fs.exec('git', ['show', `HEAD:${rel}`], {
      cwd: repoRoot, timeoutMs: 15_000, maxStdoutBytes: 10 * 1024 * 1024,
    });
    const head = showRes.code === 0 ? showRes.stdout : '';

    let state: ResponseOf<'file.readGitDiff'>['state'] = 'clean';
    if (!stat && head) state = 'deleted';
    else if (!head && stat) state = 'untracked';
    else if (head !== working) state = 'modified';

    return {
      head,
      working,
      state,
      inRepo: true,
      mtimeMs: stat?.mtimeMs ?? 0,
    };
  },
  'file.readBinary': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    const opts = req.maxBytes !== undefined ? { maxBytes: req.maxBytes } : undefined;
    const r = await fs.readFileBinary(req.absPath, opts);
    return {
      data: r.data,
      mimeType: mimeFromPath(req.absPath),
      size: r.size,
      mtimeMs: r.mtimeMs,
      tooLarge: r.tooLarge,
    };
  },
  'file.write': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    const opts: { knownMtimeMs?: number; force?: boolean } = {};
    if (req.knownMtimeMs !== undefined) opts.knownMtimeMs = req.knownMtimeMs;
    if (req.force !== undefined) opts.force = req.force;
    return await fs.writeFile(req.absPath, req.content, opts);
  },

  'file.copy': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    const dest = req.destAbsPath ?? await pickSiblingCopyName(fs, req.absPath);
    await fs.cp(req.absPath, dest, { recursive: true, errorOnExist: true });
    return { destAbsPath: dest };
  },
  'file.rename': async (req) => {
    if (req.newName.includes('/') || req.newName.includes('\\') || req.newName === '..' || req.newName === '.') {
      throw new Error('Invalid name — basename must not contain slashes or be . / ..');
    }
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    // POSIX-style dirname extraction (works the same for both Fs since
    // remote paths are always `/`-separated and local paths on macOS
    // use `/` too).
    const dir = req.absPath.replace(/\/+[^/]+\/?$/, '') || '/';
    const newAbs = dir === '/' ? `/${req.newName}` : `${dir}/${req.newName}`;
    if (newAbs === req.absPath) return { newAbsPath: newAbs };
    if (await fs.exists(newAbs)) {
      throw new Error(`"${req.newName}" already exists in this folder.`);
    }
    await fs.rename(req.absPath, newAbs);
    return { newAbsPath: newAbs };
  },
  'file.move': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    // Normalise away trailing slashes so the self/descendant check below
    // doesn't get tripped by "/a/b" vs "/a/b/". POSIX-style throughout —
    // both local (macOS) and remote (Linux) paths use forward slashes.
    const src = req.absPath.replace(/\/+$/, '') || req.absPath;
    const destDir = req.destDirAbsPath.replace(/\/+$/, '') || req.destDirAbsPath;
    const base = src.replace(/^.*\/+/, '');
    if (!base || base === '.' || base === '..') {
      throw new Error('Invalid source path.');
    }
    const srcDir = src.replace(/\/+[^/]+\/?$/, '') || '/';
    // Moving onto its current parent is a silent no-op — the user dragged
    // the row back where it was, no reason to error.
    if (destDir === srcDir) return { newAbsPath: src };
    // Reject moving a directory into itself or one of its descendants:
    // the resulting tree would be unreachable and `rename` may corrupt it.
    if (destDir === src || destDir.startsWith(src + '/')) {
      throw new Error("Can't move a folder into itself.");
    }
    const newAbs = destDir === '/' ? `/${base}` : `${destDir}/${base}`;
    if (await fs.exists(newAbs)) {
      throw new Error(`"${base}" already exists in the destination folder.`);
    }
    const destStat = await fs.stat(destDir);
    if (!destStat || destStat.kind !== 'dir') {
      throw new Error('Destination is not a directory.');
    }
    await fs.rename(src, newAbs);
    return { newAbsPath: newAbs };
  },
  'file.create': async (req) => {
    const base = path.basename(req.absPath);
    if (!base || base === '.' || base === '..') {
      throw new Error('Invalid name.');
    }
    await fsp.mkdir(path.dirname(req.absPath), { recursive: true });
    // wx = create + exclusive: fails with EEXIST if the path is taken,
    // so we never silently truncate an existing file.
    const handle = await fsp.open(req.absPath, 'wx');
    await handle.close();
    return { absPath: req.absPath };
  },
  'file.mkdir': async (req) => {
    const base = path.basename(req.absPath);
    if (!base || base === '.' || base === '..') {
      throw new Error('Invalid name.');
    }
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    if (await fs.exists(req.absPath)) {
      throw new Error(`"${base}" already exists in this folder.`);
    }
    // recursive: true creates intermediate parents (mkdir -p) so nested
    // paths like "a/b/c" work in one go. The exists() check above still
    // guards against clobbering an existing leaf.
    await fs.mkdir(req.absPath, { recursive: true });
    return { absPath: req.absPath };
  },
  'file.delete': async (req) => {
    const fs = req.sessionId ? getFsForSession(req.sessionId) ?? getFs('local') : getFs('local');
    if (fs.isLocal) {
      // shell.trashItem moves to the OS trash — recoverable.
      await shell.trashItem(req.absPath);
    } else {
      // No portable trash on Linux remote — rm -rf. Caller has already
      // shown the confirm prompt.
      await fs.rm(req.absPath, { recursive: true, force: true });
    }
    return { ok: true };
  },
  'file.revealInFinder': (req) => {
    // Local-only — the OS doesn't have a "reveal" for a remote path.
    // The renderer suppresses this menu item for remote sessions.
    if (req.sessionId) {
      const fs = getFsForSession(req.sessionId);
      if (fs && !fs.isLocal) {
        throw new Error("Reveal in Finder isn't available for remote projects.");
      }
    }
    shell.showItemInFolder(req.absPath);
    return { ok: true };
  },

  'scrollback.save': async (req) => {
    try {
      const file = scrollbackPath(req.sessionId);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      let data = req.data;
      // Cap at 5 MB by keeping the TAIL of the buffer. Serialised
      // xterm state with a long preamble of escape sequences may
      // misrender if truncated mid-sequence, but in practice the
      // tail of a 5 MB snapshot is plenty for replay use.
      const SCROLLBACK_MAX_BYTES = 5 * 1024 * 1024;
      if (data.length > SCROLLBACK_MAX_BYTES) {
        data = data.slice(data.length - SCROLLBACK_MAX_BYTES);
      }
      await fsp.writeFile(file, data, 'utf-8');
      return { ok: true };
    } catch {
      return { ok: false };
    }
  },
  'scrollback.load': async (req) => {
    try {
      const file = scrollbackPath(req.sessionId);
      const data = await fsp.readFile(file, 'utf-8');
      return { data };
    } catch {
      // No disk scrollback yet (brand-new session, hasn't had its
      // first 10-second snapshot). Fall back to the in-memory ring
      // buffer of recent pty bytes so the welcome banner / initial
      // prompt isn't lost on TerminalPane mount. The same bytes are
      // also broadcast as live pty.data frames; the TerminalPane drops
      // those queued frames after writing this snapshot so the user
      // doesn't see duplicates.
      const buf = getSessionManager().getRecentPtyBytes(req.sessionId);
      if (buf && buf.length > 0) return { data: buf.toString('utf-8') };
      return { data: null };
    }
  },

  'pty.write': (req) => {
    const bytes = Buffer.from(req.data, 'base64').toString('utf-8');
    getSessionManager().write(req.sessionId, bytes);
    return {};
  },
  'pty.resize': (req) => {
    getSessionManager().resize(req.sessionId, req.cols, req.rows);
    return {};
  },
};

/** Look up the worktree (cwd) path for a session id from SQLite.
 *  Worktree reads don't go through SessionManager so the row may not
 *  be live in memory. */
function resolveWorktreePath(sessionId: string): string {
  const row = getDatabase()
    .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
    .get(sessionId) as { worktree_path: string } | undefined;
  if (!row) throw new Error(`Unknown session: ${sessionId}`);
  return row.worktree_path;
}

/** Non-throwing variant for read-only worktree calls. Used by the
 *  Files / Git panels so a renderer effect that fires for a session
 *  that just got deleted produces an empty payload instead of an
 *  unhandled IPC error in main's log. */
function tryResolveWorktreePath(sessionId: string): string | null {
  const row = getDatabase()
    .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
    .get(sessionId) as { worktree_path: string } | undefined;
  return row?.worktree_path ?? null;
}

/** Per-session scrollback file path. Lives under ~/.baton/scrollback/
 *  alongside the other per-project app state. */
function scrollbackPath(sessionId: string): string {
  return path.join(batonHome(), 'scrollback', `${sessionId}.bin`);
}

/** Comma-separated glob list → trimmed string[] (drops empties). */
function splitGlobs(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Double-quote a path for `sh -c`, with `~` → `$HOME` rewriting so it
 *  expands inside the quotes. POSIX shells DO NOT expand `~` inside
 *  double quotes (it only expands as the unquoted first character of a
 *  word) — but `$HOME` DOES expand, so the substitution gets us the
 *  same end state without losing safe-quoting of embedded spaces. */
function shellQuoteWithTilde(p: string): string {
  const esc = (s: string): string => s.replace(/"/g, '\\"');
  if (p === '~') return '"$HOME"';
  if (p.startsWith('~/')) return `"$HOME/${esc(p.slice(2))}"`;
  return `"${esc(p)}"`;
}

/** Run `git grep` with the given options and return matches in the
 *  shape WorktreeSearchResponse wants. Uses --line-number --column
 *  --null so we can split on NUL and not get tripped up by colons in
 *  paths or content. Stops at maxMatches; sets `truncated` to true if
 *  it did. */
async function runGitGrep(
  fs: import('../services/fs/types.js').BatonFs,
  cwd: string,
  req: RequestOf<'worktree.search'>,
): Promise<ResponseOf<'worktree.search'>> {
  const maxMatches = req.maxMatches ?? 2000;
  // Shared flags for both passes. `--untracked` and `--recurse-submodules`
  // are mutually exclusive in git grep, so we run two passes and merge:
  //   pass A: --untracked          — catches not-yet-`git add`'d files
  //                                  in the root repo
  //   pass B: --recurse-submodules — descends into submodule trees that
  //                                  pass A silently skips
  // Most repos hit only one of the two paths in practice (a repo with
  // no submodules makes pass B a no-op; a repo with no untracked
  // changes makes pass A return the same as pass B). Running both
  // covers users with monorepo-style submodule layouts (which was the
  // bug report: searching a repo where the whole backend is a submodule
  // returned zero results because the root grep can't see in.)
  const baseArgs: string[] = [
    'grep',
    '--no-color',
    '--line-number',
    '--column',
    '--null',
    '--full-name',
    '-I',
  ];
  if (!req.caseSensitive) baseArgs.push('--ignore-case');
  if (req.wholeWord)      baseArgs.push('--word-regexp');
  if (req.regex) baseArgs.push('--extended-regexp');
  else           baseArgs.push('--fixed-strings');

  const includes = splitGlobs(req.includeGlob);
  const excludes = splitGlobs(req.excludeGlob);
  const buildArgs = (extra: readonly string[]): string[] => {
    const a = [...baseArgs, ...extra, '-e', req.query, '--'];
    for (const g of includes) a.push(g);
    for (const g of excludes) a.push(`:!${g}`);
    return a;
  };

  const [passA, passB] = await Promise.all([
    runOneGrep(fs, cwd, buildArgs(['--untracked']), maxMatches, req),
    runOneGrep(fs, cwd, buildArgs(['--recurse-submodules']), maxMatches, req),
  ]);

  // Pass B (recurses into submodules) is the more complete tracked
  // view, so prefer it as the primary ordering. Pass A then contributes
  // anything new — mostly untracked files in the root repo.
  type Match = ResponseOf<'worktree.search'>['matches'][number];
  const seen = new Set<string>();
  const merged: Match[] = [];
  const pushFrom = (src: Match[]): void => {
    for (const m of src) {
      const key = `${m.file}\0${m.line}\0${m.col}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
      if (merged.length >= maxMatches) return;
    }
  };
  pushFrom(passB.matches);
  if (merged.length < maxMatches) pushFrom(passA.matches);
  const truncated =
    passA.truncated || passB.truncated || merged.length >= maxMatches;
  // Surface a real error only if BOTH passes failed for the same
  // reason; one pass tripping (e.g. a stale submodule) shouldn't hide
  // the other pass's results.
  const error =
    merged.length > 0
      ? null
      : passB.error ?? passA.error ?? null;
  return { matches: merged, truncated, error };
}

/** One `git grep` invocation. Factored out so runGitGrep can run an
 *  untracked-aware pass and a submodule-recursing pass in parallel and
 *  merge them. */
async function runOneGrep(
  fs: import('../services/fs/types.js').BatonFs,
  cwd: string,
  args: readonly string[],
  maxMatches: number,
  req: RequestOf<'worktree.search'>,
): Promise<ResponseOf<'worktree.search'>> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    const res = await fs.exec('git', args as string[], {
      cwd,
      timeoutMs: 30_000,
      maxStdoutBytes: 32 * 1024 * 1024,
    });
    stdout = res.stdout;
    stderr = res.stderr;
    exitCode = res.code;
  } catch (err) {
    return { matches: [], truncated: false, error: String(err) };
  }

  // git grep exits 0 = matches, 1 = no matches, 128 = error
  if (exitCode === 1) return { matches: [], truncated: false, error: null };
  if (exitCode !== 0) {
    return { matches: [], truncated: false, error: stderr.trim() || `git grep exited ${exitCode}` };
  }

  const matches: ResponseOf<'worktree.search'>['matches'] = [];
  let truncated = false;
  const lines = stdout.split('\n');
  for (const raw of lines) {
    if (raw.length === 0) continue;
    // `file\0line\0col\0text` with --null
    const parts = raw.split('\0');
    if (parts.length < 4) continue;
    const file = parts[0];
    const line = Number(parts[1]);
    const col  = Number(parts[2]);
    const text = parts.slice(3).join('\0');
    if (!Number.isFinite(line) || !Number.isFinite(col)) continue;
    matches.push({
      file,
      line,
      col,
      lineText: text,
      // Rough match length: we don't know the matched extent from
      // --column alone, so for highlighting the renderer re-runs the
      // pattern against `lineText` starting at `col-1`. We send the
      // query length as a best-effort default for fixed-string mode.
      matchLen: req.regex ? 0 : req.query.length,
    });
    if (matches.length >= maxMatches) { truncated = true; break; }
  }
  return { matches, truncated, error: null };
}

/** Resolve a file reference (bare basename or partial repo path) that
 *  appeared in transcript text into concrete repo-relative paths.
 *
 *  Uses `git ls-files` (cached + untracked-but-not-ignored) so it sees
 *  the whole tree — the fileTree reader is depth-capped, which would
 *  miss deeply-nested files. Ranking, best first:
 *    1. exact path match
 *    2. path-suffix match (file ends with `/<ref>`)
 *    3. basename match (last path segment equals the ref's basename)
 *  For a ref that already carries directories we favour suffix matches
 *  over loose basename matches; for a bare basename the two collapse. */
async function resolveWorktreeFile(
  fs: import('../services/fs/types.js').BatonFs,
  cwd: string,
  rawRef: string,
): Promise<ResponseOf<'worktree.resolveFile'>> {
  // Defensive normalisation: strip a leading "./", surrounding quotes,
  // and any `:line[:col]` suffix the caller didn't remove.
  const rel = rawRef
    .trim()
    .replace(/^["'`(]+|["'`)]+$/g, '')
    .replace(/^\.\//, '')
    .replace(/:\d+(?::\d+)?$/, '');
  if (!rel || rel.includes('..')) return { matches: [] };

  // Two passes, merged — mirrors runGitGrep. `git ls-files` can't
  // combine `--others` (untracked) with `--recurse-submodules` in one
  // invocation, and many worktrees here keep their real source in
  // submodules (backend/, frontend/). So:
  //   pass A: tracked + untracked in the top repo (misses submodules)
  //   pass B: tracked, recursing into submodules (misses untracked)
  // Union covers both. Submodule paths come back parent-repo-relative,
  // which is exactly what we join against the worktree root.
  const runLsFiles = async (args: readonly string[]): Promise<string[]> => {
    try {
      const res = await fs.exec('git', ['ls-files', '-z', ...args], {
        cwd, timeoutMs: 15_000, maxStdoutBytes: 32 * 1024 * 1024,
      });
      if (res.code !== 0) return [];
      return res.stdout.split('\0').filter((f) => f.length > 0);
    } catch {
      return [];
    }
  };
  const [topFiles, subFiles] = await Promise.all([
    runLsFiles(['--cached', '--others', '--exclude-standard']),
    runLsFiles(['--recurse-submodules']),
  ]);
  const files = [...new Set([...topFiles, ...subFiles])];
  const base = rel.split('/').pop() ?? rel;
  const hasSlash = rel.includes('/');

  const exact: string[] = [];
  const suffix: string[] = [];
  const byBase: string[] = [];
  for (const f of files) {
    if (f === rel) exact.push(f);
    else if (f.endsWith(`/${rel}`)) suffix.push(f);
    else if ((f.split('/').pop() ?? f) === base) byBase.push(f);
  }

  const ranked = hasSlash
    ? [...exact, ...suffix, ...byBase]
    : [...exact, ...byBase, ...suffix];

  const seen = new Set<string>();
  const matches: string[] = [];
  for (const f of ranked) {
    if (seen.has(f)) continue;
    seen.add(f);
    matches.push(f);
    if (matches.length >= 20) break;
  }
  return { matches };
}

/** Pick a non-conflicting destination name for `file.copy` when the
 *  caller didn't supply one. Tries "<stem> copy<ext>" first, then
 *  numbered suffixes. Mirrors macOS Finder's duplicate behaviour. */
async function pickSiblingCopyName(fs: { exists(p: string): Promise<boolean> }, srcAbs: string): Promise<string> {
  // POSIX-style basename / dirname — both remote and local-on-macOS use
  // `/` separators. (path.posix.* would do the same thing.)
  const dir = srcAbs.replace(/\/+[^/]+\/?$/, '') || '/';
  const base = srcAbs.split('/').pop() ?? srcAbs;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidate = dir === '/'
      ? `/${stem}${suffix}${ext}`
      : `${dir}/${stem}${suffix}${ext}`;
    if (!(await fs.exists(candidate))) return candidate;
  }
  throw new Error('Could not find a non-conflicting copy name within 1000 attempts.');
}

/** Cheap extension-based MIME lookup. Only handles the types we
 *  actually preview (PRD F6.2: image viewers). Anything unknown
 *  falls back to application/octet-stream. */
function mimeFromPath(p: string): string {
  const ext = p.toLowerCase().slice(p.lastIndexOf('.') + 1);
  switch (ext) {
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg':  return 'image/svg+xml';
    case 'bmp':  return 'image/bmp';
    case 'ico':  return 'image/x-icon';
    case 'avif': return 'image/avif';
    default:     return 'application/octet-stream';
  }
}

export function registerControlBus(): void {
  ipcMain.handle(
    Channels.control,
    async (_event, verb: unknown, payload: unknown) => {
      const verbName = z
        .enum(Object.keys(ControlVerbs) as [ControlVerb, ...ControlVerb[]])
        .safeParse(verb);
      if (!verbName.success) {
        throw new Error(`IPC: unknown verb "${String(verb)}"`);
      }
      const v = verbName.data;

      const reqSchema = ControlVerbs[v].request;
      const reqParsed = reqSchema.safeParse(payload);
      if (!reqParsed.success) {
        throw new Error(`IPC: bad request for "${v}": ${reqParsed.error.message}`);
      }

      const handler = handlers[v];
      if (!handler) {
        throw new Error(`IPC: no handler registered for "${v}"`);
      }

      const raw = await handler(reqParsed.data as never);

      const respSchema = ControlVerbs[v].response;
      const respParsed = respSchema.safeParse(raw);
      if (!respParsed.success) {
        throw new Error(`IPC: bad response from "${v}": ${respParsed.error.message}`);
      }
      return respParsed.data;
    }
  );
}
