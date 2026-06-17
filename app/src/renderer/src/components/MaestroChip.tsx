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
  const lastActivityAt = useMaestroUI((s) => s.lastActivityAt);
  // Re-render every 10 s so the title's idle-time hint stays accurate
  // without polling main more often than necessary.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => { setTick((n) => n + 1); }, 10_000);
    return () => window.clearInterval(id);
  }, []);

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
          : chipTitle(state, lastActivityAt)}
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

function chipTitle(s: State, lastActivityMs: number): string {
  if (s.paused) return 'Maestro — paused (click for full-screen)';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) {
    return "Maestro — active but daemon isn't running (click for full-screen to Restart)";
  }
  if (!s.daemonRunning && s.tickCount === 0) {
    return 'Maestro — off (click for full-screen to activate)';
  }
  const idle = fmtIdle(s, lastActivityMs);
  if (!s.daemonRunning) {
    return `Maestro — daemon off · tick ${s.tickCount} · ${idle} (click for full-screen)`;
  }
  return `Maestro — tick ${s.tickCount} · ${idle} (click for full-screen)`;
}

function fmtIdle(s: State, lastActivityMs: number): string {
  const thresholdSec = s.idleThresholdMin * 60;
  const sinceSec = Math.max(0, Math.floor((Date.now() - lastActivityMs) / 1000));
  const remaining = thresholdSec - sinceSec;
  if (remaining <= 0) return 'ready (next poll fires it)';
  if (sinceSec < 5) return `active · ${fmtDuration(remaining)} of idle to fire`;
  return `idle ${fmtDuration(sinceSec)} · ${fmtDuration(remaining)} to fire`;
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${String(s).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h}h ${mm}m`;
}
