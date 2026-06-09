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
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import simpleGit from 'simple-git';
import { z } from 'zod';

const execFileP = promisify(execFile);

import {
  Channels,
  ControlVerbs,
  type ControlVerb,
  type RequestOf,
  type ResponseOf,
} from '../../shared/ipc.js';
import { addProject, createProject, listProjects, getProject, removeProject, renameProject, reorderProjects, setProjectSnoozed } from '../services/projectStore.js';
import { getSessionManager } from '../services/sessionManager.js';
import { setSelectedSession } from '../services/notifier.js';
import { readFileTree, readSubdir, readGitStatus } from '../services/worktreeReader.js';
import { listWorktrees, removeWorktree } from '../services/worktreeManager.js';
import { getUsage } from '../services/claudeUsageApi.js';
import { getDatabase } from '../database/index.js';

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

  'project.pickFolder': async () => {
    const focused = BrowserWindow.getFocusedWindow();
    const res = await dialog.showOpenDialog(focused ?? new BrowserWindow({ show: false }), {
      title: 'Add a project folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return { path: null };
    return { path: res.filePaths[0] ?? null };
  },
  'project.add': (req) => ({ project: addProject(req.path, req.name) }),
  'project.create': (req) => ({
    project: createProject({
      path: req.path,
      ...(req.initGit !== undefined ? { initGit: req.initGit } : {}),
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
  'session.reorder': (req) => {
    getSessionManager().reorderSessions(req.orderedIds);
    return { ok: true as const };
  },
  'session.setSnoozed': (req) => {
    const session = getSessionManager().setSnoozed(req.sessionId, req.snoozed);
    return { session };
  },

  'session.list': () => ({ sessions: getSessionManager().listAll() }),
  'usage.getStats': async () => getUsage(),
  'session.spawn': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    const session = await getSessionManager().spawn({
      projectId: project.id,
      backendId: req.backendId,
      cwd: project.path,
      ...(req.newWorktreeBranch
        ? { newWorktreeBranch: req.newWorktreeBranch }
        : {}),
      ...(req.skipPermissions ? { skipPermissions: true } : {}),
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
  'session.toggleYolo': async (req) => {
    const session = await getSessionManager().toggleYolo(req.sessionId);
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
    const root = await readFileTree(worktreePath);
    return { root };
  },
  'worktree.readDir': async (req) => {
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) return { children: [], truncated: false };
    return await readSubdir(worktreePath, req.relPath);
  },
  'worktree.gitStatus': async (req) => {
    const worktreePath = tryResolveWorktreePath(req.sessionId);
    if (!worktreePath) {
      return { branch: null, ahead: 0, behind: 0, files: [], dirty: false };
    }
    const report = await readGitStatus(worktreePath);
    return report;
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
      const entries = await listWorktrees(p.path);
      for (const e of entries) {
        // Any path with a `/.git/` segment is git bookkeeping
        // (submodule gitdirs, etc.) — never a real worktree, even
        // when `git worktree list` reports it. The classic case is a
        // submodule project whose worktree-list response points to
        //   <parent>/.git/modules/<submodule>
        // and would otherwise tempt the user to click Remove (which
        // would `git worktree remove --force` the submodule's gitdir
        // and break the parent repo's submodule tracking).
        if (e.path.includes(`${path.sep}.git${path.sep}`)) continue;
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
    await simpleGit(worktreePath).add(req.paths);
    return { ok: true as const };
  },
  'git.unstage': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    // `git reset HEAD <paths>` unstages without touching the working
    // tree. simple-git's raw is the most predictable way to do this.
    await simpleGit(worktreePath).raw(['reset', 'HEAD', '--', ...req.paths]);
    return { ok: true as const };
  },
  'git.commit': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    const res = await simpleGit(worktreePath).commit(req.message);
    return {
      ok: true as const,
      oid: (res.commit ?? '').slice(0, 7),
    };
  },
  'git.push': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    try {
      // `git push` with no args — uses the branch's configured
      // upstream. simple-git surfaces git's own stdout/stderr on error.
      const out = await simpleGit(worktreePath).raw(['push']);
      return { ok: true, output: out || 'Push complete.' };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
  'git.pull': async (req) => {
    const worktreePath = resolveWorktreePath(req.sessionId);
    try {
      const out = await simpleGit(worktreePath).raw(['pull', '--ff-only']);
      return { ok: true, output: out || 'Pull complete.' };
    } catch (err) {
      return {
        ok: false,
        output: err instanceof Error ? err.message : String(err),
      };
    }
  },
  'worktree.removeOrphan': async (req) => {
    const project = getProject(req.projectId);
    if (!project) throw new Error(`Unknown project: ${req.projectId}`);
    await removeWorktree(project.path, req.path);
    return { ok: true as const };
  },
  'worktree.search': async (req) => {
    const cwd = resolveWorktreePath(req.sessionId);
    return await runGitGrep(cwd, req);
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
    const max = req.maxBytes ?? 5 * 1024 * 1024;
    const stat = await fsp.stat(req.absPath);
    if (stat.size > max) {
      return {
        content: '',
        mtimeMs: stat.mtimeMs,
        binary: false,
        tooLarge: true,
        size: stat.size,
      };
    }
    const buf = await fsp.readFile(req.absPath);
    // Cheap binary sniff: NUL byte in the first 4 KB is a strong hit.
    const sliceEnd = Math.min(buf.length, 4096);
    let binary = false;
    for (let i = 0; i < sliceEnd; i++) {
      if (buf[i] === 0) { binary = true; break; }
    }
    if (binary) {
      return {
        content: '',
        mtimeMs: stat.mtimeMs,
        binary: true,
        tooLarge: false,
        size: stat.size,
      };
    }
    return {
      content: buf.toString('utf-8'),
      mtimeMs: stat.mtimeMs,
      binary: false,
      tooLarge: false,
      size: stat.size,
    };
  },
  'file.readGitDiff': async (req) => {
    const repoRoot = findRepoRoot(req.absPath);
    let stat: { mtimeMs: number } | null = null;
    try { stat = await fsp.stat(req.absPath); } catch { stat = null; }

    let working = '';
    if (stat) {
      try { working = await fsp.readFile(req.absPath, 'utf-8'); }
      catch { /* binary or unreadable — leave empty */ }
    }

    if (!repoRoot) {
      // Not in a repo. Treat the working file as the only side; nothing
      // to diff against, so we return head === working so the diff
      // editor renders a clean view.
      return {
        head: working,
        working,
        state: 'clean' as const,
        mtimeMs: stat?.mtimeMs ?? 0,
      };
    }

    const relPath = path.relative(repoRoot, req.absPath).split(path.sep).join('/');
    const git = simpleGit(repoRoot);

    // `git show HEAD:<relPath>` returns the HEAD blob. Throws if the
    // file didn't exist in HEAD (untracked or newly added), in which
    // case the "previous" side is empty.
    let head = '';
    try {
      head = await git.show([`HEAD:${relPath}`]);
    } catch {
      head = '';
    }

    // Coarse state — same buckets as worktree.gitStatus. We re-derive
    // here instead of calling readGitStatus to keep this fast for a
    // single file.
    let state: ResponseOf<'file.readGitDiff'>['state'] = 'clean';
    if (!stat && head) state = 'deleted';
    else if (!head && stat) state = 'untracked';
    else if (head !== working) state = 'modified';

    return {
      head,
      working,
      state,
      mtimeMs: stat?.mtimeMs ?? 0,
    };
  },
  'file.readBinary': async (req) => {
    const max = req.maxBytes ?? 8 * 1024 * 1024;
    const stat = await fsp.stat(req.absPath);
    if (stat.size > max) {
      return {
        data: '',
        mimeType: mimeFromPath(req.absPath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        tooLarge: true,
      };
    }
    const buf = await fsp.readFile(req.absPath);
    return {
      data: buf.toString('base64'),
      mimeType: mimeFromPath(req.absPath),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      tooLarge: false,
    };
  },
  'file.write': async (req) => {
    // Stale-write guard: if the file on disk is newer than what the
    // renderer loaded, refuse unless `force: true`. The renderer then
    // surfaces a "file changed on disk" prompt.
    if (req.knownMtimeMs != null && !req.force) {
      try {
        const stat = await fsp.stat(req.absPath);
        if (stat.mtimeMs > req.knownMtimeMs + 1) {
          return { ok: false, mtimeMs: stat.mtimeMs, stale: true };
        }
      } catch {
        // File doesn't exist on disk anymore — proceed (we'll create it).
      }
    }
    await fsp.writeFile(req.absPath, req.content, 'utf-8');
    const stat = await fsp.stat(req.absPath);
    return { ok: true, mtimeMs: stat.mtimeMs, stale: false };
  },

  'file.copy': async (req) => {
    const dest = req.destAbsPath ?? await pickSiblingCopyName(req.absPath);
    // recursive so directories work the same way as files. errorOnExist
    // keeps us from clobbering an existing target — the caller can
    // pass an explicit destAbsPath if they want overwrite semantics.
    await fsp.cp(req.absPath, dest, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    return { destAbsPath: dest };
  },
  'file.rename': async (req) => {
    if (req.newName.includes('/') || req.newName.includes('\\') || req.newName === '..' || req.newName === '.') {
      throw new Error('Invalid name — basename must not contain slashes or be . / ..');
    }
    const dir = path.dirname(req.absPath);
    const newAbs = path.join(dir, req.newName);
    if (newAbs === req.absPath) return { newAbsPath: newAbs };
    // Refuse to clobber an existing file with the new name. The
    // renderer surfaces this as an alert and the user can choose
    // another name.
    try {
      await fsp.access(newAbs);
      throw new Error(`"${req.newName}" already exists in this folder.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    await fsp.rename(req.absPath, newAbs);
    return { newAbsPath: newAbs };
  },
  'file.delete': async (req) => {
    // shell.trashItem moves to the OS trash — recoverable from Finder.
    // We deliberately do NOT use rm -rf here: the renderer asks for
    // confirmation, but accidental clicks happen and OS-trash is
    // strictly safer.
    await shell.trashItem(req.absPath);
    return { ok: true };
  },
  'file.revealInFinder': (req) => {
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
  return path.join(app.getPath('home'), '.baton', 'scrollback', `${sessionId}.bin`);
}

/** Comma-separated glob list → trimmed string[] (drops empties). */
function splitGlobs(s: string): string[] {
  return s.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
}

/** Run `git grep` with the given options and return matches in the
 *  shape WorktreeSearchResponse wants. Uses --line-number --column
 *  --null so we can split on NUL and not get tripped up by colons in
 *  paths or content. Stops at maxMatches; sets `truncated` to true if
 *  it did. */
async function runGitGrep(
  cwd: string,
  req: RequestOf<'worktree.search'>,
): Promise<ResponseOf<'worktree.search'>> {
  const maxMatches = req.maxMatches ?? 2000;
  const args = [
    'grep',
    '--no-color',
    '--line-number',
    '--column',
    '--null',         // NUL between fields → safe split
    '--full-name',    // paths relative to repo root
    '-I',             // skip binaries
    '--untracked',    // honour .gitignore but include untracked files
  ];
  if (!req.caseSensitive) args.push('--ignore-case');
  if (req.wholeWord)      args.push('--word-regexp');
  if (req.regex) args.push('--extended-regexp');
  else           args.push('--fixed-strings');
  // Patterns terminated with `--` so anything in includeGlob isn't
  // mistaken for a flag.
  args.push('-e', req.query, '--');
  const includes = splitGlobs(req.includeGlob);
  const excludes = splitGlobs(req.excludeGlob);
  for (const g of includes) args.push(g);
  for (const g of excludes) args.push(`:!${g}`);

  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  try {
    const child = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
      const proc: ChildProcessWithoutNullStreams = spawn('git', args, {
        cwd,
        env: process.env,
      });
      let out = '';
      let err = '';
      proc.stdout.setEncoding('utf-8');
      proc.stderr.setEncoding('utf-8');
      proc.stdout.on('data', (d: string) => { out += d; });
      proc.stderr.on('data', (d: string) => { err += d; });
      proc.on('error', (e) => resolve({ stdout: out, stderr: String(e), code: 1 }));
      proc.on('close', (code) => resolve({ stdout: out, stderr: err, code }));
    });
    stdout = child.stdout;
    stderr = child.stderr;
    exitCode = child.code;
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

/** Pick a non-conflicting destination name for `file.copy` when the
 *  caller didn't supply one. Tries "<stem> copy<ext>" first, then
 *  numbered suffixes. Mirrors macOS Finder's duplicate behaviour. */
async function pickSiblingCopyName(srcAbs: string): Promise<string> {
  const dir = path.dirname(srcAbs);
  const base = path.basename(srcAbs);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const suffix = i === 1 ? ' copy' : ` copy ${i}`;
    const candidate = path.join(dir, `${stem}${suffix}${ext}`);
    try { await fsp.access(candidate); } catch { return candidate; }
  }
  throw new Error('Could not find a non-conflicting copy name within 1000 attempts.');
}

/** Walk up from `absPath` to find a directory containing `.git`.
 *  Returns null if none — caller treats the file as non-repo. */
function findRepoRoot(absPath: string): string | null {
  let dir = path.dirname(path.resolve(absPath));
  // Bound the walk so we never loop on weird filesystems.
  for (let i = 0; i < 64; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
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
