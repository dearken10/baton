/**
 * Resolution of baton's on-disk home directory.
 *
 * Everything baton persists — the SQLite db, scrollback, status-trace
 * logs, hook sockets/forwarder, ssh control sockets — lives under a
 * single base dir. By default that's `~/.baton`, but setting the
 * BATON_HOME env var relocates the whole tree, which is what lets you
 * run several independent baton instances on one machine, each with
 * its own db and state (e.g. an installed build alongside a dev build
 * out of a worktree, or separate work/personal profiles).
 *
 * Every call site that needs the base dir MUST go through batonHome()
 * rather than re-deriving `<home>/.baton`, so a single BATON_HOME
 * switch isolates the instance completely.
 */
import { app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Absolute path to baton's data dir. Honours BATON_HOME; defaults to
 *  `~/.baton`. Read live on each call so it stays correct regardless of
 *  when it's first invoked. */
export function batonHome(): string {
  const override = process.env['BATON_HOME'];
  if (override && override.length > 0) return override;
  // `app.getPath('home')` is the project's existing convention; fall
  // back to os.homedir() in case the helper is reached before `app` is
  // available (e.g. unit tests).
  const home = app?.getPath ? app.getPath('home') : homedir();
  return join(home, '.baton');
}

/** When BATON_HOME is set, relocate Electron's own profile dir
 *  (`userData`) under it too. Without this, two instances share
 *  Chromium's `SingletonLock` and caches in the default userData path
 *  and collide even after their baton.db files are separated. Must be
 *  called before `app` is ready. No-op when BATON_HOME is unset. */
export function applyBatonUserDataOverride(): void {
  const override = process.env['BATON_HOME'];
  if (override && override.length > 0) {
    app.setPath('userData', join(override, 'electron'));
  }
}
