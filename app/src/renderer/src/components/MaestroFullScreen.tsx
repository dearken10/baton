/**
 * MaestroFullScreen — the full-app Maestro view (M9 layout).
 *
 * Rendered by App.tsx in place of the projects+editor+files
 * workspace when `useMaestroUI().fullScreen` is true.
 *
 * Layout: reasoning banner → 3-column grid of action cards → history.
 *
 * Esc returns to compact via the App-level keyboard handler. The
 * strip persists above this view (rendered by App.tsx as well), so
 * the same toggle is visible without any chrome change.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';
import { useAppStore } from '../store.js';
import { MaestroActionCard } from './MaestroActionCard.js';

type State = ResponseOf<'maestro.getState'>;

const POLL_MS = 5_000;

export function MaestroFullScreen(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await window.baton.call('maestro.getState', {});
      setState(s);
    } catch { /* keep previous */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  const setPaused = useCallback(async (paused: boolean) => {
    setState((s) => (s ? { ...s, paused } : s));
    try {
      const r = await window.baton.call('maestro.setPaused', { paused });
      setState((s) => (s ? { ...s, paused: r.paused } : s));
    } catch { void refresh(); }
  }, [refresh]);

  const setMode = useCallback(async (mode: 'propose-first' | 'act-first') => {
    setState((s) => (s ? { ...s, mode } : s));
    try {
      const r = await window.baton.call('maestro.setMode', { mode });
      setState((s) => (s ? { ...s, mode: r.mode } : s));
    } catch { void refresh(); }
  }, [refresh]);

  // Resolve session id → { projectName, branch } so the cards render
  // human-readable headers instead of 8-char ids.
  const sessionLookup = useCallback(
    (sid: string | null) => {
      if (!sid) return undefined;
      const s = sessions[sid];
      if (!s) return undefined;
      const p = projects[s.projectId];
      return { projectName: p?.name, branch: s.branch };
    },
    [sessions, projects]
  );

  const groups = useMemo(() => {
    const actions = state?.plan?.actions ?? [];
    const proposed = actions.filter((a) => a.kind !== 'defer');
    const deferred = actions.filter((a) => a.kind === 'defer');
    return { proposed, deferred };
  }, [state?.plan?.actions]);

  if (!state) {
    return <div className="maestro-full"><div className="maestro-full-empty">Loading Maestro state…</div></div>;
  }

  return (
    <div className="maestro-full">
      <div className="maestro-full-banner">
        <span className="maestro-full-glyph" aria-hidden>🎼</span>
        <div className="maestro-full-banner-text">
          <h2>Maestro · tick {state.tickCount}</h2>
          <div className="maestro-full-banner-sub">
            {groups.proposed.length} proposal{groups.proposed.length === 1 ? '' : 's'}
            {groups.deferred.length > 0 ? ` · ${groups.deferred.length} deferred` : ''}
            {state.daemonRunning && !state.paused
              ? ` · daemon running · every ${state.tickIntervalMin}m`
              : state.paused
                ? ' · paused'
                : ' · daemon off'}
          </div>
        </div>

        <div className="maestro-full-controls">
          <div className="maestro-full-mode">
            <span className="maestro-full-mode-label">Mode</span>
            <div className="maestro-full-seg">
              <button
                type="button"
                className={state.mode === 'propose-first' ? 'is-active' : ''}
                onClick={() => void setMode('propose-first')}
                title="Propose-first: queue actions for approval"
              >
                suggest
              </button>
              <button
                type="button"
                className={state.mode === 'act-first' ? 'is-active' : ''}
                onClick={() => void setMode('act-first')}
                title="Act-first: execute under checkpoint+revert"
              >
                run
              </button>
            </div>
          </div>

          <button
            type="button"
            className={`maestro-full-toggle ${state.paused ? 'is-paused' : 'is-active'}`}
            onClick={() => void setPaused(!state.paused)}
            role="switch"
            aria-checked={!state.paused}
            title={state.paused ? 'Resume Maestro' : 'Pause Maestro'}
          >
            <span className="maestro-full-toggle-track"><span className="maestro-full-toggle-thumb" /></span>
            <span className="maestro-full-toggle-label">
              {state.paused ? 'paused' : 'active'}
            </span>
          </button>
        </div>
      </div>

      {state.plan?.skipReason ? (
        <div className="maestro-full-skip">SKIP · {state.plan.skipReason}</div>
      ) : null}

      {state.plan?.reasoning ? (
        <div className="maestro-full-reasoning">{state.plan.reasoning}</div>
      ) : null}

      {groups.proposed.length === 0 && groups.deferred.length === 0 ? (
        <div className="maestro-full-empty">
          No actions in the latest plan. Maestro will run again at the next tick
          {state.nextTickEtaAt ? <> (<code>{state.nextTickEtaAt.slice(11, 16)}</code>).</> : null}
        </div>
      ) : (
        <>
          <div className="maestro-full-grid">
            {groups.proposed.map((a) => (
              <MaestroActionCard key={a.actionId} action={a} sessionLookup={sessionLookup} />
            ))}
            {groups.deferred.map((a) => (
              <MaestroActionCard key={a.actionId} action={a} sessionLookup={sessionLookup} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
