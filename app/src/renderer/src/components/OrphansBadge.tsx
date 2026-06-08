import { useCallback, useEffect, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';

type Orphan = ResponseOf<'worktree.listOrphans'>['orphans'][number];

/**
 * Polling badge that surfaces "orphaned" git worktrees — directories
 * git knows about but no SQLite session row matches. Click → modal
 * with per-row Remove buttons. Cf. PRD F7.6.
 *
 * We don't auto-delete because the PRD spec is explicit: "Unknowns
 * surface in an 'Orphaned worktrees (N)' context-menu entry — don't
 * auto-delete." Users keep ultimate control.
 */
const POLL_MS = 15_000;

export function OrphansBadge(): JSX.Element | null {
  const [orphans, setOrphans] = useState<Orphan[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.baton.call('worktree.listOrphans', {});
      setOrphans(res.orphans);
    } catch {
      // best-effort — empty list is fine
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const remove = useCallback(async (o: Orphan): Promise<void> => {
    if (busy) return;
    const ok = window.confirm(
      [
        'Remove this orphaned worktree?',
        '',
        o.path,
        '',
        'This runs `git worktree remove --force` and deletes the',
        'directory. Any uncommitted changes inside it will be lost.',
      ].join('\n')
    );
    if (!ok) return;
    setBusy(true);
    try {
      await window.baton.call('worktree.removeOrphan', {
        projectId: o.projectId,
        path: o.path,
      });
      await refresh();
    } catch (err) {
      alert(`Remove failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [busy, refresh]);

  if (orphans.length === 0) return null;

  return (
    <>
      <button
        type="button"
        className="orphans-badge"
        onClick={() => setOpen(true)}
        title={`${orphans.length} orphaned git worktree${orphans.length === 1 ? '' : 's'}`}
      >
        🧹 {orphans.length}
      </button>
      {open ? (
        <div className="dialog-overlay" onClick={() => setOpen(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Orphaned worktrees</h3>
            <p className="dim">
              Directories git still knows about but no baton session row
              matches. Usually left behind by a crash or a forced quit.
            </p>
            <ul className="orphans-list">
              {orphans.map((o) => (
                <li key={`${o.projectId}:${o.path}`}>
                  <div className="orphans-row">
                    <span className="orphans-branch mono">{o.branch ?? '(detached)'}</span>
                    <span className="orphans-path mono" title={o.path}>{o.path}</span>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void remove(o)}
                      disabled={busy}
                    >
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="dialog-actions">
              <button className="btn" onClick={() => setOpen(false)} disabled={busy}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
