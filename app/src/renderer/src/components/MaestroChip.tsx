/**
 * Maestro chip + popup, pinned in the titlebar next to UsageBars.
 * Implements UI brainstorm direction A: minimum-lift surface for the
 * PRD F15 autonomous orchestrator.
 *
 * Data source is the option 3 PoC files on disk (read via the
 * maestro.getState IPC verb). The chip is "uninitialized" (greyed,
 * no badge) until the PoC has bootstrapped.
 *
 * Click → popup showing:
 *   - tick cadence + next-tick countdown
 *   - daemon state (running / off)
 *   - the latest plan: action list with confidence + assumptions
 *   - bloat warning when present
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';

type State = ResponseOf<'maestro.getState'>;
type Action = NonNullable<State['plan']>['actions'][number];

const POLL_MS = 5_000;

export function MaestroChip(): JSX.Element | null {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0); // forces countdown re-render
  const ref = useRef<HTMLDivElement | null>(null);

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

  // Countdown ticker for the popup. Outside the popup we don't need
  // sub-poll precision — the chip itself only changes every few s.
  useEffect(() => {
    if (!open) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [open]);

  // Close popup on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!state) return null;
  if (!state.installed) return null; // PoC not present in this checkout

  const tone = chipTone(state);
  const badge = chipBadge(state);

  return (
    <div className={`maestro-wrapper maestro-${tone}`} ref={ref}>
      <button
        type="button"
        className="maestro-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={chipTitle(state, tick)}
      >
        <span className="maestro-glyph" aria-hidden>🎼</span>
        <span className="maestro-label">{badge}</span>
      </button>
      {open ? (
        <MaestroPopup
          state={state}
          now={tick}
          onTogglePause={async () => {
            const next = !state.paused;
            // Optimistic update so the toggle feels instant. The
            // 5-second poll will reconcile if the IPC fails.
            setState({ ...state, paused: next });
            try {
              const r = await window.baton.call('maestro.setPaused', { paused: next });
              setState((s) => (s ? { ...s, paused: r.paused } : s));
            } catch {
              // Reconcile on next refresh; refresh now to be quick.
              void refresh();
            }
          }}
          onRestartDaemon={async () => {
            // "Restart" = setPaused(false) again, which calls
            // spawnDaemon if not already running. Idempotent.
            try {
              await window.baton.call('maestro.setPaused', { paused: false });
            } finally {
              void refresh();
            }
          }}
          onSetMode={async (mode) => {
            if (mode === state.mode) return;
            setState({ ...state, mode });
            try {
              const r = await window.baton.call('maestro.setMode', { mode });
              setState((s) => (s ? { ...s, mode: r.mode } : s));
            } catch {
              void refresh();
            }
          }}
        />
      ) : null}
    </div>
  );
}

function chipTone(s: State): 'ok' | 'warn' | 'idle' | 'off' | 'paused' | 'desync' {
  if (s.paused) return 'paused';
  // Active but no daemon = something's wrong. Surface louder than warn.
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) return 'desync';
  if (!s.daemonRunning && s.tickCount === 0) return 'off';
  if (!s.daemonRunning) return 'idle';
  return 'ok';
  // (bloatWarning intentionally not used — leaky abstraction; the
  //  daemon handles compaction silently.)
}

function chipBadge(s: State): string {
  if (s.paused) return 'paused';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) return 'stopped';
  if (!s.daemonRunning && s.tickCount === 0) return 'off';
  const acts = s.plan?.actions?.filter((a) => a.kind !== 'defer').length ?? 0;
  return `${acts}/${s.tickCount}`;
}

function chipTitle(s: State, nowTick: number): string {
  void nowTick;
  if (s.paused) return 'Maestro — paused (click to resume)';
  if (!s.paused && !s.daemonRunning && s.tickCount > 0) {
    return "Maestro — active but daemon isn't running (click to Restart)";
  }
  if (!s.daemonRunning && s.tickCount === 0) {
    return 'Maestro — off (click to activate)';
  }
  if (!s.daemonRunning) {
    return `Maestro — daemon off · tick ${s.tickCount}`;
  }
  const next = s.nextTickEtaAt ? ` · next tick in ${fmtCountdown(s.nextTickEtaAt)}` : '';
  return `Maestro — tick ${s.tickCount}${next}`;
}

function MaestroPopup(
  { state, now, onTogglePause, onRestartDaemon, onSetMode }: {
    state: State;
    now: number;
    onTogglePause: () => void;
    onRestartDaemon: () => void;
    onSetMode: (mode: 'propose-first' | 'act-first') => void;
  }
): JSX.Element {
  void now;
  const plan = state.plan;
  const candidatePlanCount = useMemo(
    () => plan?.actions?.filter((a) => a.kind !== 'defer').length ?? 0,
    [plan]
  );
  const deferCount = useMemo(
    () => plan?.actions?.filter((a) => a.kind === 'defer').length ?? 0,
    [plan]
  );

  return (
    <div className="maestro-popup" role="dialog" aria-label="Maestro">
      <div className="maestro-popup-head">
        <span className="maestro-popup-title">🎼 Maestro</span>
        <span className="dim">tick {state.tickCount}</span>
        <button
          type="button"
          className={`maestro-toggle ${state.paused ? 'is-paused' : 'is-active'}`}
          onClick={onTogglePause}
          role="switch"
          aria-checked={!state.paused}
          aria-label={state.paused ? 'Resume Maestro' : 'Pause Maestro'}
          title={state.paused ? 'Resume Maestro' : 'Pause Maestro'}
        >
          <span className="maestro-toggle-track" aria-hidden>
            <span className="maestro-toggle-thumb" />
          </span>
          <span className="maestro-toggle-label">
            {state.paused ? 'paused' : 'active'}
          </span>
        </button>
      </div>

      {/* Daemon-status row. Four shapes:
            paused                   "Paused — no ticks will fire"
            active, running          "Daemon running · every 15m"
            active, not running      "Active but daemon isn't running" + Restart
            inactive (only valid       (impossible — covered above)
              in the desync case)
       */}
      {(() => {
        const desync = !state.paused && !state.daemonRunning;
        return (
          <div className={`maestro-popup-meta ${desync ? 'is-desync' : ''}`}>
            <span
              className={`maestro-dot maestro-dot-${
                state.paused ? 'paused'
                : state.daemonRunning ? 'on'
                : 'desync'
              }`}
              aria-hidden
            />
            <span className="maestro-popup-meta-text">
              {state.paused
                ? 'Paused — no ticks will fire'
                : state.daemonRunning
                  ? <>Daemon running <span className="dim">· every {state.tickIntervalMin}m</span></>
                  : <><strong>Active but daemon isn't running.</strong> No ticks will fire.</>}
            </span>
            {desync ? (
              <button
                type="button"
                className="maestro-popup-restart"
                onClick={onRestartDaemon}
                title="Spawn the daemon now"
              >
                Restart
              </button>
            ) : null}
          </div>
        );
      })()}

      {/* Promoted next-tick row. Only shown when there's a useful
          countdown to surface (daemon running + not paused + we know
          when the last tick fired). */}
      {state.nextTickEtaAt && state.daemonRunning && !state.paused ? (
        <NextTickRow nextTickEtaAt={state.nextTickEtaAt} />
      ) : null}

      {/* Conversation bloat used to surface here as a warning row,
          but it was a leaky abstraction — the underlying threshold
          was tick-count based, not actual size-based, and the user
          had nothing useful to do except --reset (which loses
          memory). Quietly handled in bootstrap-or-tick.sh now. */}

      <ModeSelector
        mode={state.mode}
        disabled={state.paused}
        onChange={onSetMode}
      />

      {plan ? (
        <>
          <div className="maestro-popup-reasoning">{plan.reasoning}</div>

          {plan.skipReason ? (
            <div className="maestro-popup-skip">SKIP · {plan.skipReason}</div>
          ) : null}

          <div className="maestro-popup-stats dim">
            {candidatePlanCount} proposal{candidatePlanCount === 1 ? '' : 's'}
            {deferCount > 0 ? ` · ${deferCount} deferred` : ''}
            {' · '}{fmtRelative(plan.tickAt)}
          </div>

          <div className="maestro-popup-actions">
            {plan.actions.map((a, i) => <ActionRow key={a.actionId ?? i} a={a} />)}
          </div>
        </>
      ) : (
        <div className="maestro-popup-empty dim">
          {state.tickCount === 0
            ? 'No tick has run yet. Bootstrap from the PoC dir.'
            : 'Last tick produced no plan on disk.'}
        </div>
      )}

      <div className="maestro-popup-foot dim">
        <span>session {state.sessionId ? state.sessionId.slice(0, 8) : '—'}</span>
        {state.lastTickAt ? <span>last tick {fmtRelative(state.lastTickAt)}</span> : null}
      </div>
    </div>
  );
}

function NextTickRow({ nextTickEtaAt }: { nextTickEtaAt: string }): JSX.Element {
  // Re-render every second so the countdown is live while the popup
  // is open. (Tick prop on the parent already drives this; we just
  // read it transitively via Date.now() at render time.)
  const ms = Date.parse(nextTickEtaAt) - Date.now();
  const overdue = ms <= 0;
  const t = new Date(nextTickEtaAt);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return (
    <div
      className={`maestro-nexttick ${overdue ? 'is-overdue' : ''}`}
      title={`Scheduled at ${t.toLocaleString()}`}
    >
      <span className="maestro-nexttick-label">Next tick</span>
      <span className="maestro-nexttick-value">
        {overdue ? 'overdue (any moment)' : `in ${fmtCountdown(nextTickEtaAt)}`}
      </span>
      <span className="maestro-nexttick-at dim">· at {hhmm}</span>
    </div>
  );
}

function ModeSelector(
  { mode, disabled, onChange }: {
    mode: 'propose-first' | 'act-first';
    disabled: boolean;
    onChange: (m: 'propose-first' | 'act-first') => void;
  }
): JSX.Element {
  const cosmetic = true; // PoC stage — execution is not wired yet.
  return (
    <div
      className={`maestro-mode-row ${disabled ? 'is-disabled' : ''}`}
      role="radiogroup"
      aria-label="Maestro mode"
    >
      <div className="maestro-mode-label dim">Mode</div>
      <div className="maestro-mode-seg">
        <button
          type="button"
          className={`maestro-mode-pill ${mode === 'propose-first' ? 'is-active' : ''}`}
          role="radio"
          aria-checked={mode === 'propose-first'}
          onClick={() => !disabled && onChange('propose-first')}
          disabled={disabled}
          title="Propose-first: queue actions for human approval"
        >
          suggest
        </button>
        <button
          type="button"
          className={`maestro-mode-pill ${mode === 'act-first' ? 'is-active' : ''}`}
          role="radio"
          aria-checked={mode === 'act-first'}
          onClick={() => !disabled && onChange('act-first')}
          disabled={disabled}
          title="Act-first: execute under checkpoint+revert, user reviews after"
        >
          run
        </button>
      </div>
      {cosmetic ? (
        <div className="maestro-mode-note dim">
          Execution isn't wired yet — selector is cosmetic.
        </div>
      ) : null}
    </div>
  );
}

function ActionRow({ a }: { a: Action }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const target = (a.targetSessionId ?? a.targetProjectId ?? '?').slice(0, 8);
  const isDefer = a.kind === 'defer';
  return (
    <div className={`maestro-action maestro-action-${a.kind}`}>
      <button
        type="button"
        className="maestro-action-head"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className={`maestro-pill maestro-pill-${a.kind}`}>
          {a.kind}
        </span>
        <span className="maestro-action-target">{target}</span>
        <span className="maestro-action-conf dim">{a.confidence.toFixed(2)}</span>
        <span className="maestro-action-caret dim">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded ? (
        <div className="maestro-action-body">
          <div className="maestro-action-rationale">{a.rationale}</div>
          {a.prompt && !isDefer ? (
            <pre className="maestro-action-prompt">{a.prompt}</pre>
          ) : null}
          {a.assumptionsMade.length > 0 ? (
            <div className="maestro-action-assumptions">
              <div className="dim">Assumptions</div>
              {a.assumptionsMade.map((as, i) => (
                <div key={i} className="maestro-assumption">
                  <div><strong>Q:</strong> {as.question}</div>
                  <div><strong>A:</strong> {as.assumedAnswer}</div>
                  {as.why ? <div className="dim">∵ {as.why}</div> : null}
                  {as.ifWrong ? <div className="dim">✗ {as.ifWrong}</div> : null}
                </div>
              ))}
            </div>
          ) : null}
          {a.reversibilityNote ? (
            <div className="maestro-action-revert dim">↻ {a.reversibilityNote}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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

function fmtRelative(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60_000) return 'just now';
  const totalMin = Math.round(ms / 60_000);
  if (totalMin < 60) return `${totalMin}m ago`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return `${h}h ${m}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
