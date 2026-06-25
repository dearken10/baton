/**
 * MaestroFullScreen — the full-app Maestro view (T6 layout).
 *
 * Rendered by App.tsx in place of the projects+editor+files
 * workspace when `useMaestroUI().fullScreen` is true.
 *
 *   Banner (state + controls)
 *   ──────────────────────────
 *   Body:
 *     · default          → 3-column SessionView (ticks / detail / actions)
 *     · "Session" toggle → flat terminal mirror of the JSONL
 *
 * Esc returns to compact via the App-level keyboard handler.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';
import { useMaestroUI } from './maestroUI.js';
import { MaestroSessionView } from './MaestroSessionView.js';
import { MaestroSessionTerminal } from './MaestroSessionTerminal.js';
import { useAppStore, selectRunningAgentCount } from '../store.js';

type State = ResponseOf<'maestro.getState'>;
type Session = ResponseOf<'maestro.getSession'>;
type ActionRecord = ResponseOf<'maestro.listActions'>['actions'][number];

const POLL_MS = 5_000;
const SESSION_POLL_MS = 10_000;
const RECORDS_POLL_MS = 10_000;

export function MaestroFullScreen(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [actionRecords, setActionRecords] = useState<Map<string, ActionRecord>>(new Map());
  const [runNowPending, setRunNowPending] = useState(false);
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [terminalMode, setTerminalMode] = useState(false);
  /** Selected tick in the 3-column view. `null` means "auto-pick latest
   *  on next fetch"; once the user explicitly clicks a row we lock to
   *  that index so refreshes don't yank them around. */
  const [selectedTickIndex, setSelectedTickIndex] = useState<number | null>(null);
  const [userPickedTick, setUserPickedTick] = useState(false);

  const lastActivityAt = useMaestroUI((s) => s.lastActivityAt);
  const runningAgents = useAppStore(selectRunningAgentCount);
  // 1-Hz heartbeat so the banner countdown re-renders every second
  // without polling main. The countdown is a pure function of clocks +
  // state.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => { setTick((n) => n + 1); }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const s = await window.baton.call('maestro.getState', {});
      setState(s);
    } catch { /* keep previous */ }
  }, []);

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const s = await window.baton.call('maestro.getSession', { tickLimit: 60 });
      setSession(s);
    } catch { /* keep previous */ }
  }, []);

  const refreshRecords = useCallback(async (): Promise<void> => {
    try {
      const r = await window.baton.call('maestro.listActions', {});
      const map = new Map<string, ActionRecord>();
      for (const rec of r.actions) map.set(rec.actionId, rec);
      setActionRecords(map);
    } catch { /* keep previous */ }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  useEffect(() => {
    void refreshSession();
    const id = window.setInterval(() => { void refreshSession(); }, SESSION_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshSession]);

  useEffect(() => {
    void refreshRecords();
    const id = window.setInterval(() => { void refreshRecords(); }, RECORDS_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshRecords]);

  // Auto-select the latest tick when (a) the user hasn't picked one
  // yet, or (b) the selected one has scrolled off the tail-window.
  useEffect(() => {
    if (!session || session.ticks.length === 0) return;
    const latest = session.ticks[session.ticks.length - 1]!.index;
    const stillVisible = selectedTickIndex !== null
      && session.ticks.some((t) => t.index === selectedTickIndex);
    if (!userPickedTick || !stillVisible) {
      setSelectedTickIndex(latest);
    }
  }, [session, selectedTickIndex, userPickedTick]);

  const onPickTick = useCallback((idx: number) => {
    setSelectedTickIndex(idx);
    setUserPickedTick(true);
  }, []);

  const onRunNow = useCallback(async () => {
    if (runNowPending) return;
    setRunNowPending(true);
    setRunNowError(null);
    try {
      // Main waits for the child process to exit and resolves with
      // the tick's result. The spinner stays up the whole time.
      const r = await window.baton.call('maestro.runNow', {});
      if (!r.ok) setRunNowError(r.reason ?? 'Run now failed');
    } catch (err) {
      setRunNowError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunNowPending(false);
      // Pull the fresh plan + transcript so the user sees the new
      // tick land in the SessionView immediately.
      void refresh();
      void refreshSession();
    }
  }, [refresh, refreshSession, runNowPending]);

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

  if (!state) {
    return <div className="maestro-full"><div className="maestro-full-empty">Loading Maestro state…</div></div>;
  }

  const idle = computeIdle(state, lastActivityAt, runningAgents);
  const runNowDisabled = state.paused || runNowPending;

  return (
    <div className="maestro-full">
      <div className="maestro-full-banner">
        <span className="maestro-full-glyph" aria-hidden>🎼</span>
        <div className="maestro-full-banner-text">
          <h2>Maestro · tick {state.tickCount}</h2>
          <div className="maestro-full-banner-sub">
            {session ? `${session.totalTicks} tick${session.totalTicks === 1 ? '' : 's'} on transcript · ` : null}
            <span className={`maestro-full-countdown is-${idle.tone}`}>{idle.label}</span>
            {state.paused ? ' · paused' : state.daemonRunning ? '' : ' · daemon off'}
            {runNowError ? (
              <> · <span className="maestro-full-runnow-error">{runNowError}</span></>
            ) : null}
          </div>
        </div>

        <div className="maestro-full-controls">
          <button
            type="button"
            className={`maestro-full-runnow${runNowPending ? ' is-pending' : ''}`}
            onClick={() => void onRunNow()}
            disabled={runNowDisabled}
            title={
              state.paused
                ? 'Resume Maestro to run a tick now'
                : runNowPending
                  ? 'Tick is running — waiting for Maestro to finish'
                  : 'Fire a tick now (bypasses the idle gate)'
            }
          >
            {runNowPending ? (
              <>
                <span className="maestro-full-runnow-spinner" aria-hidden />
                <span>Running…</span>
              </>
            ) : (
              <>
                <span className="maestro-full-runnow-glyph" aria-hidden>▶</span>
                <span>Run now</span>
              </>
            )}
          </button>

          <button
            type="button"
            className={`maestro-full-sessionbtn${terminalMode ? ' is-active' : ''}`}
            onClick={() => setTerminalMode((v) => !v)}
            aria-pressed={terminalMode}
            title={terminalMode
              ? 'Back to the 3-column triage view'
              : 'Show the live Claude Code session terminal mirror'}
          >
            <span aria-hidden>▣</span>
            <span>Session</span>
          </button>

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

      {session === null ? (
        <div className="maestro-full-empty">Loading session…</div>
      ) : terminalMode ? (
        <MaestroSessionTerminal session={session} />
      ) : (
        <MaestroSessionView
          session={session}
          selectedIndex={selectedTickIndex}
          onSelect={onPickTick}
          actionRecords={actionRecords}
          onRecordsChanged={refreshRecords}
        />
      )}
    </div>
  );
}

interface IdleSummary {
  /** "active · 14:23 of idle to go" / "ready — next poll fires it" / "paused" */
  label: string;
  tone: 'active' | 'counting' | 'ready' | 'paused';
}

/** Compute what to show in the banner countdown.
 *
 *  - paused: explicit; no countdown.
 *  - any agent running: countdown frozen (matches the daemon's active-
 *    agent gate in bootstrap-or-tick.sh — ticks wouldn't fire while
 *    another agent is mid-response, so the UI shouldn't pretend to
 *    count down toward something).
 *  - active (idle for less than ~5 s): "active · waiting for Nm of idle".
 *  - counting down: "Nm Ss until ready".
 *  - ready: "ready — next poll fires it" (the daemon polls on a short
 *    cadence so the actual tick lands within a minute).
 *
 *  We pick the activity timestamp ourselves (renderer-local). The main
 *  process's `state.lastActivityAt` is the throttled mtime — fresher
 *  data lives here, in the very component watching `mousemove`. */
function computeIdle(
  state: NonNullable<ResponseOf<'maestro.getState'>>,
  rendererLastActivityMs: number,
  runningAgents: number,
): IdleSummary {
  if (state.paused) return { label: 'paused', tone: 'paused' };
  if (runningAgents > 0) {
    return {
      label: `gated · ${runningAgents} agent${runningAgents === 1 ? '' : 's'} running`,
      tone: 'paused',
    };
  }
  const thresholdSec = state.idleThresholdMin * 60;
  const sinceActSec = Math.max(0, Math.floor((Date.now() - rendererLastActivityMs) / 1000));
  const remainingSec = thresholdSec - sinceActSec;
  if (remainingSec <= 0) {
    return {
      label: `ready · runs on next poll (active ${fmtDuration(sinceActSec)} ago)`,
      tone: 'ready',
    };
  }
  if (sinceActSec < 5) {
    return {
      label: `active · idle ${fmtDuration(remainingSec)} to fire`,
      tone: 'active',
    };
  }
  return {
    label: `idle ${fmtDuration(sinceActSec)} · ${fmtDuration(remainingSec)} to fire`,
    tone: 'counting',
  };
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
