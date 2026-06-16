/**
 * Maestro chip in the titlebar — secondary trigger for the M9
 * full-screen view. Click toggles `useMaestroUI().fullScreen`; the
 * MaestroStrip below the titlebar is the primary surface.
 *
 * The chip's tone + badge still reflect the underlying daemon state
 * (paused / desync / off / running) so a glance at the corner tells
 * you whether Maestro is healthy without opening anything.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';
import { useMaestroUI } from './maestroUI.js';

type State = ResponseOf<'maestro.getState'>;

const POLL_MS = 5_000;

export function MaestroChip(): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);
  const toggleFullScreen = useMaestroUI((s) => s.toggleFullScreen);
  const fullScreen = useMaestroUI((s) => s.fullScreen);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await window.baton.call('maestro.getState', {});
      setState(s);
    } catch { /* leave previous reading */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  if (!state) return null;
  if (!state.installed) return null;

  const tone = chipTone(state);
  const badge = fullScreen ? 'full' : chipBadge(state);

  return (
    <div className={`maestro-wrapper maestro-${tone}`}>
      <button
        type="button"
        className="maestro-chip"
        onClick={toggleFullScreen}
        aria-pressed={fullScreen}
        title={fullScreen
          ? 'Maestro is in full-screen — click to return to workspace'
          : chipTitle(state)}
      >
        <span className="maestro-glyph" aria-hidden>🎼</span>
        <span className="maestro-label">{badge}</span>
      </button>
    </div>
  );
}

function chipTone(s: State): 'ok' | 'warn' | 'idle' | 'off' | 'paused' | 'desync' {
  if (s.paused) return 'paused';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) return 'desync';
  if (!s.daemonRunning && s.tickCount === 0) return 'off';
  if (!s.daemonRunning) return 'idle';
  return 'ok';
}

function chipBadge(s: State): string {
  if (s.paused) return 'paused';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) return 'stopped';
  if (!s.daemonRunning && s.tickCount === 0) return 'off';
  const acts = s.plan?.actions?.filter((a) => a.kind !== 'defer').length ?? 0;
  return `${acts}/${s.tickCount}`;
}

function chipTitle(s: State): string {
  if (s.paused) return 'Maestro — paused (click for full-screen)';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) {
    return "Maestro — active but daemon isn't running (click for full-screen to Restart)";
  }
  if (!s.daemonRunning && s.tickCount === 0) {
    return 'Maestro — off (click for full-screen to activate)';
  }
  if (!s.daemonRunning) {
    return `Maestro — daemon off · tick ${s.tickCount} (click for full-screen)`;
  }
  const next = s.nextTickEtaAt ? ` · next in ${fmtCountdown(s.nextTickEtaAt)}` : '';
  return `Maestro — tick ${s.tickCount}${next} (click for full-screen)`;
}

function fmtCountdown(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'soon';
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
