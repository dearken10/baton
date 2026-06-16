/**
 * MaestroStrip — the permanent 30px strip below the titlebar (M9
 * layout from design/mockup-maestro-layouts.html, tab 9).
 *
 * Glanceable summary of Maestro's state. Click anywhere on the strip
 * to toggle the full-screen Maestro view. The chip in the titlebar
 * remains the secondary trigger (also wired to toggle).
 *
 * Renders nothing when the PoC isn't installed (no on-disk state) so
 * the workspace gets its full vertical height back.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';
import { useMaestroUI } from './maestroUI.js';

type State = ResponseOf<'maestro.getState'>;

const POLL_MS = 5_000;

export function MaestroStrip(): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);
  const [, force] = useState(0); // re-render every second so the countdown moves
  const fullScreen = useMaestroUI((s) => s.fullScreen);
  const toggleFullScreen = useMaestroUI((s) => s.toggleFullScreen);

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

  useEffect(() => {
    const id = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  if (!state || !state.installed) return null;

  const proposals = state.plan?.actions?.filter((a) => a.kind !== 'defer').length ?? 0;
  const deferred = state.plan?.actions?.filter((a) => a.kind === 'defer').length ?? 0;
  const tone = stripTone(state);

  return (
    <div
      className={`maestro-strip maestro-strip-${tone}`}
      role="button"
      tabIndex={0}
      onClick={toggleFullScreen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleFullScreen();
        }
      }}
      title={fullScreen ? 'Click to return to workspace' : 'Click to expand Maestro full-screen'}
    >
      <span className="maestro-strip-glyph" aria-hidden>🎼</span>
      <span className="maestro-strip-label">Maestro</span>
      <span className="maestro-strip-dim">
        tick {state.tickCount}
        {state.paused ? ' · paused'
          : !state.daemonRunning ? ' · daemon off'
          : ` · ${state.mode === 'act-first' ? 'run' : 'suggest'}`}
      </span>
      {state.nextTickEtaAt && state.daemonRunning && !state.paused ? (
        <span className="maestro-strip-next" title={`Scheduled at ${fmtAbsolute(state.nextTickEtaAt)}`}>
          next in {fmtCountdown(state.nextTickEtaAt)} · {fmtAbsolute(state.nextTickEtaAt)}
        </span>
      ) : null}

      <div className="maestro-strip-tail">
        {proposals > 0 ? (
          <span className="maestro-strip-badge-prop">
            {proposals} proposal{proposals === 1 ? '' : 's'}
          </span>
        ) : null}
        {deferred > 0 ? (
          <span className="maestro-strip-badge-defer">
            {deferred} deferred
          </span>
        ) : null}
        <button
          type="button"
          className="maestro-strip-toggle"
          onClick={(e) => { e.stopPropagation(); toggleFullScreen(); }}
          title={fullScreen ? 'Exit full-screen' : 'Switch to full-screen Maestro'}
        >
          <span className="maestro-strip-toggle-icon" aria-hidden>
            {fullScreen ? '⛯' : '⛶'}
          </span>
          {fullScreen ? 'Compact' : 'Full screen'}
        </button>
      </div>
    </div>
  );
}

function stripTone(s: State): 'ok' | 'paused' | 'desync' | 'idle' {
  if (s.paused) return 'paused';
  if (!s.daemonRunning && s.tickCount > 0) return 'desync';
  if (!s.daemonRunning) return 'idle';
  return 'ok';
}

function fmtCountdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const totalMin = Math.floor(ms / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return `${h}h ${m}m`;
  }
  if (totalMin > 0) return `${totalMin}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function fmtAbsolute(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
