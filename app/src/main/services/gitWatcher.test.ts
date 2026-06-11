/**
 * Integration test for the git watcher lifecycle.
 *
 * Uses a REAL chokidar watcher against a REAL temp git repo, with electron
 * + the database mocked out so emit() runs in the node test environment.
 * We assert on the real `worktree.changed` events via eventBus.subscribe.
 *
 * What this covers (the parts that need real FS + timing, which the
 * porcelain parser unit tests can't reach):
 *  - a worktree file change produces a debounced worktree.changed
 *  - a .git/index change (staging) produces an event (git-meta watching)
 *  - node_modules churn does NOT produce an event (ignore filter)
 *  - stopWatch tears the watcher down (no events after stop)
 *  - ref-counting: two sessions on one worktree, one stop keeps it alive
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// electron is unavailable in the node test env; emit() touches
// BrowserWindow. Mock it to a no-op windows list.
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));
// getDatabase() would throw (no DB initialised); emit() already wraps the
// DB write in try/catch, but mock it so the test doesn't depend on that.
vi.mock('../database/index.js', () => ({
  getDatabase: () => { throw new Error('no db in test'); },
}));
// statusTrace writes to ~/.baton/logs; stub it to a no-op.
vi.mock('./statusTrace.js', () => ({
  trace: () => {},
  shortSid: (s: string) => s,
}));

import { subscribe } from './eventBus.js';
import { startWatch, stopWatch, stopAllWatches } from './gitWatcher.js';

let repo: string;
const events: string[] = [];
let unsub: () => void;

/** Wait until `pred` is true or `timeoutMs` elapses (poll every 25ms). */
async function waitFor(pred: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-gitwatch-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 't@t.t'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'hello\n');
  execFileSync('git', ['add', 'a.txt'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });
  events.length = 0;
  unsub = subscribe((e) => {
    if (e.type === 'worktree.changed') events.push(e.sessionId);
  });
});

afterEach(() => {
  unsub?.();
  stopAllWatches();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('gitWatcher lifecycle', () => {
  it('emits worktree.changed on a worktree file change', async () => {
    startWatch('s1', repo);
    // Give chokidar a moment to finish its initial scan before mutating.
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'changed\n');
    const got = await waitFor(() => events.includes('s1'));
    expect(got).toBe(true);
  });

  it('emits on a staged change (.git/index write)', async () => {
    startWatch('s1', repo);
    await new Promise((r) => setTimeout(r, 300));
    fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n');
    execFileSync('git', ['add', 'b.txt'], { cwd: repo }); // writes .git/index
    const got = await waitFor(() => events.includes('s1'));
    expect(got).toBe(true);
  });

  it('does NOT emit for node_modules churn', async () => {
    startWatch('s1', repo);
    await new Promise((r) => setTimeout(r, 300));
    const nm = path.join(repo, 'node_modules', 'pkg');
    fs.mkdirSync(nm, { recursive: true });
    // Write a bunch of files like an install would.
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(nm, `f${i}.js`), `module.exports=${i}\n`);
    }
    // Wait past the debounce window; assert nothing fired.
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toEqual([]);
  });

  it('stops emitting after stopWatch', async () => {
    startWatch('s1', repo);
    await new Promise((r) => setTimeout(r, 300));
    stopWatch('s1');
    // chokidar.close() is async; give it a beat to settle.
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'after-stop\n');
    await new Promise((r) => setTimeout(r, 600));
    expect(events).toEqual([]);
  });

  it('ref-counts: one stop keeps the watcher alive for the other session', async () => {
    startWatch('s1', repo);
    startWatch('s2', repo); // same worktree → shares one watcher
    await new Promise((r) => setTimeout(r, 300));
    stopWatch('s1'); // s2 still holds it
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'still-watched\n');
    // s2 should still get the event; s1 should not.
    const got = await waitFor(() => events.includes('s2'));
    expect(got).toBe(true);
    expect(events).not.toContain('s1');
  });

  it('emits on a staged change in a LINKED worktree (.git is a pointer file)', async () => {
    // baton's core model: `git worktree add` creates a linked worktree whose
    // `.git` is a pointer FILE, and whose index/HEAD live OUTSIDE the worktree
    // under <repo>/.git/worktrees/<name>/. Watching only the worktree path
    // would miss staging here — this is the codex [P1] case.
    const linked = path.join(os.tmpdir(), `baton-gitwatch-linked-${Date.now()}`);
    execFileSync('git', ['worktree', 'add', '-q', linked], { cwd: repo });
    try {
      // Sanity: .git is a pointer file, not a dir.
      expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true);

      startWatch('lw', linked);
      await new Promise((r) => setTimeout(r, 300));

      // Stage a file: writes the index in the EXTERNAL per-worktree git dir,
      // not under `linked`. The watcher must still fire.
      fs.writeFileSync(path.join(linked, 'staged.txt'), 'new\n');
      execFileSync('git', ['add', 'staged.txt'], { cwd: linked });

      const got = await waitFor(() => events.includes('lw'));
      expect(got).toBe(true);
    } finally {
      stopWatch('lw');
      await new Promise((r) => setTimeout(r, 200));
      try {
        execFileSync('git', ['worktree', 'remove', '--force', linked], { cwd: repo });
      } catch { /* fall back to rm */ }
      try { fs.rmSync(linked, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
