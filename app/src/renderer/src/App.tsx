import { useEffect, useState } from 'react';
import {
  useAppStore,
  selectProjectCount,
  selectSessionCount,
} from './store.js';
import { Titlebar } from './components/Titlebar.js';
import { LeftColumn } from './components/LeftColumn.js';
import { MiddleColumn } from './components/MiddleColumn.js';
import { RightColumn } from './components/RightColumn.js';

export function App(): JSX.Element {
  const projectCount = useAppStore(selectProjectCount);
  const sessionCount = useAppStore(selectSessionCount);
  const ingestEvent = useAppStore((s) => s.ingestEvent);
  const loadProjects = useAppStore((s) => s.loadProjects);
  const loadSessions = useAppStore((s) => s.loadSessions);
  const [meta, setMeta] = useState<{ version: string; electron: string } | null>(null);
  const [preloadError, setPreloadError] = useState<string | null>(null);

  useEffect(() => {
    if (!window.code24) {
      setPreloadError(
        'window.code24 is undefined — preload script failed to load.'
      );
      return;
    }

    void Promise.allSettled([
      window.code24.call('app.meta', {}),
      window.code24.call('project.list', {}),
      window.code24.call('session.list', {}),
    ]).then((results) => {
      const [m, p, s] = results;
      if (m.status === 'fulfilled') {
        setMeta({ version: m.value.version, electron: m.value.electron });
      }
      if (p.status === 'fulfilled') loadProjects(p.value.projects);
      if (s.status === 'fulfilled') loadSessions(s.value.sessions);
    });

    // Single subscription to the event stream (PRD F10.4).
    const off = window.code24.onEvent(ingestEvent);
    return off;
  }, [ingestEvent, loadProjects, loadSessions]);

  if (preloadError) {
    return (
      <div className="app">
        <div className="boot-error">
          <h1>code24 — boot error</h1>
          <pre>{preloadError}</pre>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Titlebar
        version={meta?.version ?? 'dev'}
        electronVersion={meta?.electron ?? ''}
        projectCount={projectCount}
        sessionCount={sessionCount}
      />
      <main className="main">
        <LeftColumn />
        <MiddleColumn />
        <RightColumn />
      </main>
    </div>
  );
}
