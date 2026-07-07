/**
 * Integration test for the git snapshot/restore round-trip — the
 * destructive half of "revert to this turn". Runs the REAL
 * captureWorktreeSnapshot / restoreWorktreeToCommit against a REAL temp
 * git repo, driven through the REAL LocalFs.exec (so the GIT_INDEX_FILE
 * env passthrough is exercised end to end, not just read).
 *
 * LocalFs pulls in electron + node-pty at import time; neither is used on
 * the exec path, so we stub both just enough to let the module load
 * outside an Electron runtime.
 */

import { vi, describe, it, expect, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('electron', () => ({ shell: {}, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('node-pty', () => ({ spawn: () => { throw new Error('no pty in tests'); } }));

import { LocalFs } from './fs/localFs.js';
import {
  captureWorktreeSnapshot,
  restoreWorktreeToCommit,
} from './worktreeSnapshot.js';

const localFs = new LocalFs();
const repos: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}
function write(repo: string, rel: string, content: string): void {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function read(repo: string, rel: string): string | null {
  try { return fs.readFileSync(path.join(repo, rel), 'utf-8'); }
  catch { return null; }
}
function exists(repo: string, rel: string): boolean {
  return fs.existsSync(path.join(repo, rel));
}

/** A repo with one commit, then uncommitted "pre-turn" working state. */
function initRepoWithPreTurnState(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-snap-test-'));
  repos.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 'tester');
  write(repo, 'a.txt', 'a-original\n');
  write(repo, 'b.txt', 'b-original\n');
  write(repo, 'dir/c.txt', 'c-original\n');
  write(repo, '.gitignore', '*.log\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  // Pre-turn working state the snapshot must capture:
  write(repo, 'a.txt', 'a-EDITED-before-turn\n'); // uncommitted modification
  write(repo, 'new.txt', 'new-before-turn\n');     // uncommitted new file
  write(repo, 'ignored.log', 'noise\n');           // gitignored, present before
  return repo;
}

afterEach(() => {
  while (repos.length) {
    try { fs.rmSync(repos.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

describe('worktreeSnapshot round-trip', () => {
  beforeAll(() => {
    // Fail loudly if git isn't on PATH rather than miscounting assertions.
    execFileSync('git', ['--version']);
  });

  it('captures into a dangling commit without touching the real index', async () => {
    const repo = initRepoWithPreTurnState();
    const sha = await captureWorktreeSnapshot(localFs, repo);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);

    // The real index must be untouched (the GIT_INDEX_FILE trick): even
    // though there were uncommitted changes, nothing is staged.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    // The snapshot commit is reachable via its parked ref (survives gc).
    expect(git(repo, 'rev-parse', `refs/baton/snap/${sha}`)).toBe(sha);
    // And the working tree is left exactly as we found it.
    expect(read(repo, 'a.txt')).toBe('a-EDITED-before-turn\n');
    expect(exists(repo, 'new.txt')).toBe(true);
  });

  it('restores modify / create / delete back to the snapshot', async () => {
    const repo = initRepoWithPreTurnState();
    const sha = await captureWorktreeSnapshot(localFs, repo);
    expect(sha).not.toBeNull();

    // The "turn" does destructive work on top of the snapshot.
    write(repo, 'a.txt', 'a-CLOBBERED-during-turn\n'); // further modify
    write(repo, 'made-in-turn.txt', 'created\n');       // brand-new file
    fs.rmSync(path.join(repo, 'b.txt'));                 // delete a tracked file
    fs.appendFileSync(path.join(repo, 'ignored.log'), 'more\n');

    const ok = await restoreWorktreeToCommit(localFs, repo, sha!);
    expect(ok).toBe(true);

    expect(read(repo, 'a.txt')).toBe('a-EDITED-before-turn\n');   // reverted
    expect(read(repo, 'new.txt')).toBe('new-before-turn\n');      // preserved
    expect(read(repo, 'b.txt')).toBe('b-original\n');             // restored
    expect(read(repo, 'dir/c.txt')).toBe('c-original\n');         // untouched
    expect(exists(repo, 'made-in-turn.txt')).toBe(false);         // swept
    expect(exists(repo, 'ignored.log')).toBe(true);               // gitignored → kept

    // Restored changes show as UNSTAGED (index == HEAD), mirroring how
    // the agent left them mid-session.
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe('');
    expect(git(repo, 'status', '--porcelain')).toContain('a.txt');
  });

  it('reports failure for a non-existent commit instead of throwing', async () => {
    const repo = initRepoWithPreTurnState();
    const ok = await restoreWorktreeToCommit(
      localFs, repo, '0000000000000000000000000000000000000000',
    );
    expect(ok).toBe(false);
  });
});
