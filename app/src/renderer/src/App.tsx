import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from './store.js';
import { Titlebar } from './components/Titlebar.js';
import { SettingsDialog } from './components/SettingsDialog.js';
import { OnboardingDialog } from './components/OnboardingDialog.js';
import { LeftColumn } from './components/LeftColumn.js';
import { MiddleColumn } from './components/MiddleColumn.js';
import { RightColumn } from './components/RightColumn.js';
import { SplitHandle } from './components/SplitHandle.js';
import { MaestroFullScreen } from './components/MaestroFullScreen.js';
import { useMaestroUI } from './components/maestroUI.js';

// Column-width clamps. Middle column gets whatever's left over.
const LEFT_MIN = 200;
const LEFT_MAX = 600;
const RIGHT_MIN = 200;
const RIGHT_MAX = 600;
const LEFT_DEFAULT = 320;
const RIGHT_DEFAULT = 380;
const LEFT_LS_KEY = 'baton:layout:leftWidth';
const RIGHT_LS_KEY = 'baton:layout:rightWidth';

function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.round(n)));
  } catch {
    return fallback;
  }
}

export function App(): JSX.Element {
  const ingestEvent = useAppStore((s) => s.ingestEvent);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const loadConnections = useAppStore((s) => s.loadConnections);
  const selectSession = useAppStore((s) => s.selectSession);
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const [meta, setMeta] = useState<{ version: string } | null>(null);
  const [preloadError, setPreloadError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);

  // Persisted column widths. Saved to localStorage on every change.
  const [leftWidth, setLeftWidth] = useState(() =>
    loadWidth(LEFT_LS_KEY, LEFT_DEFAULT, LEFT_MIN, LEFT_MAX)
  );
  const [rightWidth, setRightWidth] = useState(() =>
    loadWidth(RIGHT_LS_KEY, RIGHT_DEFAULT, RIGHT_MIN, RIGHT_MAX)
  );

  const onLeftResize = useCallback((delta: number) => {
    setLeftWidth((w) => {
      const next = Math.max(LEFT_MIN, Math.min(LEFT_MAX, w + delta));
      try { localStorage.setItem(LEFT_LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const onRightResize = useCallback((delta: number) => {
    // Dragging the right handle to the right shrinks the right column.
    setRightWidth((w) => {
      const next = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, w - delta));
      try { localStorage.setItem(RIGHT_LS_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!window.baton) {
      setPreloadError(
        'window.baton is undefined — preload script failed to load.'
      );
      return;
    }

    void Promise.allSettled([
      window.baton.call('app.meta', {}),
      window.baton.call('project.list', {}),
      window.baton.call('session.list', {}),
      window.baton.call('connection.list', {}),
    ]).then((results) => {
      const [m, p, s, c] = results;
      if (m && m.status === 'fulfilled') {
        setMeta({ version: m.value.version });
      }
      if (p && p.status === 'fulfilled') loadProjects(p.value.projects);
      if (s && s.status === 'fulfilled') {
        loadSessions(s.value.sessions, s.value.startingIds);
      }
      if (c && c.status === 'fulfilled') loadConnections(c.value.profiles);
    });

    // First-run onboarding — show the account setup once.
    void window.baton
      .call('onboarding.getState', {})
      .then((r) => {
        if (!r.done) setOnboardingOpen(true);
      })
      .catch(() => { /* non-fatal — skip onboarding on error */ });

    // Single subscription to the event stream (PRD F10.4).
    const offEvents = window.baton.onEvent(ingestEvent);
    // Main asks us to focus a specific session when the user clicks a
    // desktop notification (PRD F9).
    const offSelect = window.baton.onSelectSession(({ sessionId }) =>
      selectSession(sessionId)
    );
    return () => {
      offEvents();
      offSelect();
    };
  }, [ingestEvent, loadProjects, loadSessions, loadConnections, selectSession]);

  // Tell main which session is in focus so the notifier can suppress
  // pop-ups for the session the user is already looking at.
  useEffect(() => {
    if (!window.baton) return;
    void window.baton
      .call('app.setSelectedSession', { sessionId: selectedSessionId })
      .catch(() => { /* notifier failure must never break the UI */ });
  }, [selectedSessionId]);

  // Esc returns from Maestro full-screen to the workspace.
  const fullScreen = useMaestroUI((s) => s.fullScreen);
  const setFullScreen = useMaestroUI((s) => s.setFullScreen);
  const markActivity = useMaestroUI((s) => s.markActivity);
  useEffect(() => {
    if (!fullScreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setFullScreen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullScreen, setFullScreen]);

  // Maestro idle tracker (PRD F15.x). Every mousemove / click / keydown
  // refreshes the in-renderer `lastActivityAt` and, throttled to once
  // every 5 s, fires a maestro.reportActivity IPC so the daemon's
  // idle gate sees a fresh mtime on ~/.baton/maestro/last-activity.
  //
  // Throttle (not debounce): we want activity reports to keep flowing
  // while the user is actively working, capped at one per window. A
  // debounce would only report after the user stops — exactly the
  // opposite of what we need.
  useEffect(() => {
    let lastReportedAt = 0;
    const REPORT_THROTTLE_MS = 5_000;
    const onActivity = (): void => {
      const now = Date.now();
      markActivity(now);
      if (now - lastReportedAt < REPORT_THROTTLE_MS) return;
      lastReportedAt = now;
      if (!window.baton) return;
      void window.baton
        .call('maestro.reportActivity', { at: now })
        .catch(() => { /* heartbeat is best-effort */ });
    };
    // `passive: true` so the mousemove handler doesn't ever block
    // scrolling. `capture: true` so we win the race against any child
    // that calls stopPropagation (rare but possible inside Monaco).
    const opts: AddEventListenerOptions = { passive: true, capture: true };
    document.addEventListener('mousemove', onActivity, opts);
    document.addEventListener('mousedown', onActivity, opts);
    document.addEventListener('keydown',   onActivity, opts);
    document.addEventListener('wheel',     onActivity, opts);
    return () => {
      document.removeEventListener('mousemove', onActivity, opts);
      document.removeEventListener('mousedown', onActivity, opts);
      document.removeEventListener('keydown',   onActivity, opts);
      document.removeEventListener('wheel',     onActivity, opts);
    };
  }, [markActivity]);

  if (preloadError) {
    return (
      <div className="app">
        <div className="boot-error">
          <h1>baton — boot error</h1>
          <pre>{preloadError}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${fullScreen ? 'app-maestro-full' : ''}`}>
      <Titlebar
        version={meta?.version ?? 'dev'}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <OnboardingDialog
        open={onboardingOpen}
        onDone={() => {
          setOnboardingOpen(false);
          void window.baton.call('onboarding.complete', {}).catch(() => { /* best-effort */ });
        }}
      />
      {fullScreen ? (
        <MaestroFullScreen />
      ) : (
        <main
          className="main"
          style={{
            ['--left-w' as never]: `${leftWidth}px`,
            ['--right-w' as never]: `${rightWidth}px`,
          }}
        >
          <LeftColumn />
          <SplitHandle onResize={onLeftResize} ariaLabel="Resize projects column" />
          <MiddleColumn />
          <SplitHandle onResize={onRightResize} ariaLabel="Resize files column" />
          <RightColumn />
        </main>
      )}
    </div>
  );
}
