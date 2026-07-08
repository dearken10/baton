import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { DRAG_FILE_PATH } from './FilesPanel.js';
import { useAppStore } from '../store.js';
import { webUrlTabId } from './tabIds.js';
import { getTheme, subscribeTheme, type Theme } from '../lib/theme.js';

function xtermThemeFor(t: Theme): {
  background: string; foreground: string; cursor: string;
  cursorAccent: string; selectionBackground: string;
} {
  if (t === 'light') {
    return {
      background: '#ffffff',
      foreground: '#1a1d22',
      cursor: '#3a6fd8',
      cursorAccent: '#ffffff',
      selectionBackground: 'rgba(58, 111, 216, 0.20)',
    };
  }
  return {
    background: '#0a0b0d',
    foreground: '#e6e8eb',
    cursor: '#5b8def',
    cursorAccent: '#0a0b0d',
    selectionBackground: 'rgba(91, 141, 239, 0.35)',
  };
}

/** How often to snapshot the visible terminal to disk. */
const SCROLLBACK_SAVE_MS = 10_000;

/** Highlight colours for search matches. The inactive matches use a
 *  translucent blue; the currently-focused match uses a solid amber so
 *  it stands out as you step through results. Overview-ruler entries
 *  paint tick marks on the scrollbar so off-screen matches are visible. */
const SEARCH_DECORATIONS: NonNullable<ISearchOptions['decorations']> = {
  matchBackground: '#3a6fd8',
  matchBorder: '#5b8def',
  matchOverviewRuler: '#5b8def',
  activeMatchBackground: '#f5a623',
  activeMatchBorder: '#f5a623',
  activeMatchColorOverviewRuler: '#f5a623',
};

interface Props {
  sessionId: string;
}

/**
 * xterm.js terminal bound to a single session. Lifecycle:
 *   1. On mount, create xterm + FitAddon + WebglAddon.
 *   2. Subscribe to pty.data; only write frames matching our sessionId.
 *   3. Forward user keystrokes via pty.write.
 *   4. On unmount, dispose addons + terminal.
 *
 * One pane = one terminal = one session. Selecting a different
 * session re-mounts the pane via React's `key={sessionId}` on the
 * parent.
 */
export function TerminalPane({ sessionId }: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const openFile = useAppStore((s) => s.openFile);
  // Keep the latest openFile in a ref so the WebLinksAddon click
  // handler (bound once at mount) always calls the current store action
  // without re-creating the addon on every render.
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // ── Search overlay state ──────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  // { current, total } for the match counter. total === -1 means the
  // search addon capped decoration counting (too many matches).
  const [results, setResults] = useState<{ current: number; total: number } | null>(null);

  const searchOptions = useCallback(
    (extra?: Partial<ISearchOptions>): ISearchOptions => ({
      regex: useRegex,
      caseSensitive,
      wholeWord,
      decorations: SEARCH_DECORATIONS,
      ...extra,
    }),
    [useRegex, caseSensitive, wholeWord],
  );

  const findNext = useCallback(
    (term: string, extra?: Partial<ISearchOptions>): void => {
      const addon = searchRef.current;
      if (!addon) return;
      if (!term) { addon.clearDecorations(); setResults(null); return; }
      addon.findNext(term, searchOptions(extra));
    },
    [searchOptions],
  );

  const findPrevious = useCallback(
    (term: string): void => {
      const addon = searchRef.current;
      if (!addon || !term) return;
      addon.findPrevious(term, searchOptions());
    },
    [searchOptions],
  );

  const openSearch = useCallback((): void => {
    setSearchOpen(true);
    // Defer focus to after the overlay renders; select any prior query
    // so the user can immediately overtype it.
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      if (input) { input.focus(); input.select(); }
    });
  }, []);
  // Bound once inside the mount effect's key handler; keep it fresh.
  const openSearchRef = useRef(openSearch);
  openSearchRef.current = openSearch;

  const closeSearch = useCallback((): void => {
    setSearchOpen(false);
    setResults(null);
    try { searchRef.current?.clearDecorations(); } catch { /* addon may be gone */ }
    // Return focus to the terminal so typing resumes going to the pty.
    try { termRef.current?.focus(); } catch { /* term may be tearing down */ }
  }, []);

  // Re-run the search when the query or the match options change while
  // the overlay is open, keeping the highlight/counter in sync.
  useEffect(() => {
    if (!searchOpen) return;
    findNext(query, { incremental: true });
  }, [searchOpen, query, caseSensitive, wholeWord, useRegex, findNext]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: xtermThemeFor(getTheme()),
      allowProposedApi: true,
      scrollback: 10000,
      // Handles OSC 8 hyperlinks (the kind Claude Code prints in its
      // banner). WebLinksAddon below covers regex-detected URLs in
      // shell output. Both routes end up in the in-app browser tab.
      linkHandler: {
        activate: (event, text) => {
          event.preventDefault();
          openFileRef.current(webUrlTabId(text), 'sticky');
        },
        allowNonHttpProtocols: false,
      },
    });
    termRef.current = term;

    const fit = new FitAddon();
    term.loadAddon(fit);
    let webglOk = false;
    let webglAddon: WebglAddon | null = null;
    try {
      webglAddon = new WebglAddon();
      // Chromium has a per-page WebGL-context budget (~16). When many
      // TerminalPanes are mounted (we keep every live session's xterm
      // alive in MiddleColumn) the browser silently evicts the oldest
      // context and the canvas freezes mid-frame — that's what showed
      // up as the "white-out" middle pane. WebglAddon surfaces this as
      // `onContextLoss`; disposing the addon lets xterm fall back to
      // the built-in DOM renderer for the remaining lifetime of this
      // pane. Slower, but visible and correct.
      webglAddon.onContextLoss(() => {
        try {
          // eslint-disable-next-line no-console
          console.warn(`[terminal ${sessionId.slice(0, 8)}] webgl context lost — falling back to DOM renderer`);
          webglAddon?.dispose();
          webglAddon = null;
          // Repaint so the visible viewport switches over right away
          // instead of waiting for the next pty frame.
          try { term.refresh(0, term.rows - 1); } catch { /* term may be tearing down */ }
        } catch { /* ignore — best-effort recovery */ }
      });
      term.loadAddon(webglAddon);
      webglOk = true;
    } catch {
      // Fall back to canvas — webgl can fail on some sandboxed contexts.
    }
    // SerializeAddon captures the visible buffer + scrollback as a
    // single ANSI-replay-able string. We periodically write this to
    // disk and reload it on next mount so terminals "pick up where
    // they left off" across restarts (PRD F8.8).
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // Make URLs in the terminal clickable. Default behaviour is
    // window.open() which would just hand the URL to the OS browser;
    // we intercept and route it to an in-app browser tab in the
    // editor pane instead.
    const webLinks = new WebLinksAddon(
      (event, uri) => {
        event.preventDefault();
        openFileRef.current(webUrlTabId(uri), 'sticky');
      },
    );
    term.loadAddon(webLinks);

    // Find-in-terminal. The overlay UI (rendered below) drives this
    // addon via `searchRef`; `onDidChangeResults` feeds the match
    // counter back into React state.
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    const searchResultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      // resultIndex is 0-based (-1 when nothing is focused yet); present
      // it 1-based to the user. resultCount === -1 means "too many to
      // count" — we surface that as a distinct state below.
      setResults({ current: resultIndex + 1, total: resultCount });
    });

    // Intercept Cmd/Ctrl+F before xterm forwards it to the pty so it
    // opens our search overlay instead of typing a control char.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === 'keydown' &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F')
      ) {
        openSearchRef.current();
        return false;
      }
      return true;
    });

    term.open(host);
    // `fit.fit()` recomputes the row count from the host's current
    // pixel height but it KEEPS the buffer-absolute scroll position.
    // So when the container shrinks even by one row (split-handle
    // drag, editor pane toggling, an inactive terminal-slot flipping
    // from display:none back to flex) the viewport can land above
    // the cursor — that's the "bottom is cut off until I press a
    // key" symptom. Re-stick to the bottom after every fit when the
    // user wasn't already scrolled up reading history.
    const fitAndStick = (): void => {
      let wasAtBottom = true;
      try {
        const buf = term.buffer.active;
        wasAtBottom = buf.viewportY >= buf.baseY;
      } catch { /* buffer not ready yet — treat as at-bottom */ }
      try { fit.fit(); } catch { /* host may be unmounting */ }
      if (wasAtBottom) {
        try { term.scrollToBottom(); } catch { /* term may be tearing down */ }
      }
    };
    // Defer the first fit() so the host element has measured layout.
    // Without this, xterm throws "Cannot read properties of undefined
    // (reading 'dimensions')" on early ANSI input.
    requestAnimationFrame(fitAndStick);

    // Replay previous scrollback BEFORE we attach the live pty data
    // subscription. Any live frames that arrive while we're loading
    // get queued; we drop them after writing the snapshot because the
    // main-side scrollback.load now returns either (a) the disk file
    // (a SerializeAddon dump covering everything up to the last
    // 10-s save), or (b) the in-memory ring of recent pty bytes
    // (covering everything up to RIGHT NOW). In both cases the
    // snapshot already includes whatever just arrived as a live
    // frame — replaying queued frames would write those bytes twice.
    let liveReady = false;
    const queuedFrames: Uint8Array[] = [];
    void window.baton
      .call('scrollback.load', { sessionId })
      .then(({ data }) => {
        if (data) term.write(data);
        queuedFrames.length = 0;
        liveReady = true;
      })
      .catch(() => { liveReady = true; });

    // Refit when the host element resizes (split-handle drags, window
    // resize, font-load shifts). Defer to the next frame so fit()'s
    // own layout change doesn't fire a synchronous follow-up resize
    // observation — that's what browsers report as "ResizeObserver
    // loop completed with undelivered notifications".
    let pendingFit: number | null = null;
    const ro = new ResizeObserver(() => {
      if (pendingFit != null) return;
      pendingFit = requestAnimationFrame(() => {
        pendingFit = null;
        fitAndStick();
      });
    });
    ro.observe(host);

    // Forward user input (keystrokes, paste) to the pty.
    const dataSub = term.onData((data) => {
      const encoded = btoa(unescape(encodeURIComponent(data)));
      void window.baton.call('pty.write', { sessionId, data: encoded });
    });

    // Resize the pty when the terminal is resized.
    const resizeSub = term.onResize(({ cols, rows }) => {
      void window.baton.call('pty.resize', { sessionId, cols, rows });
    });

    // Subscribe to pty data for this session only.
    // IMPORTANT: pass a Uint8Array (raw bytes), not a string. xterm.write
    // treats a string as UTF-16 — multi-byte UTF-8 box-drawing chars
    // would render as garbage. A Uint8Array is correctly decoded as UTF-8.
    const offData = window.baton.onPtyData((frame) => {
      if (frame.sessionId !== sessionId) return;
      const binary = atob(frame.data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      // If the saved scrollback is still loading, queue the frame so
      // it lands AFTER the replay — prevents interleaving the old
      // history with new bytes.
      if (!liveReady) { queuedFrames.push(bytes); return; }
      term.write(bytes);
    });

    // Periodically snapshot the terminal state. We also save on
    // unmount, but the periodic save covers app crashes / SIGKILLs
    // where the unmount handler doesn't get to run.
    const saveSnapshot = (): void => {
      try {
        const data = serialize.serialize();
        void window.baton.call('scrollback.save', { sessionId, data });
      } catch { /* best-effort */ }
    };
    const saveInterval = window.setInterval(saveSnapshot, SCROLLBACK_SAVE_MS);

    // Fit on window resize.
    const onWinResize = (): void => { fitAndStick(); };
    window.addEventListener('resize', onWinResize);

    // Live-restyle on theme toggle. xterm v5+ exposes per-property
    // setters on `term.options` that notify the active renderer
    // (including WebGL). Replacing `term.options` wholesale doesn't
    // always propagate to the WebGL canvas, so we mutate in place +
    // force a redraw for good measure.
    const offTheme = subscribeTheme((t) => {
      try {
        term.options.theme = xtermThemeFor(t);
        term.refresh(0, term.rows - 1);
      } catch { /* ignore — terminal may be tearing down */ }
    });

    return () => {
      window.clearInterval(saveInterval);
      offTheme();
      // Final snapshot on unmount so the very latest state is
      // captured. Synchronous serialise + fire-and-forget IPC.
      saveSnapshot();
      window.removeEventListener('resize', onWinResize);
      ro.disconnect();
      offData();
      dataSub.dispose();
      resizeSub.dispose();
      searchResultsSub.dispose();
      try { webLinks.dispose(); } catch { /* ignore */ }
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
      void webglOk; // silence the lint; useful for future telemetry
    };
  }, [sessionId]);

  function acceptsDrop(e: React.DragEvent<HTMLDivElement>): boolean {
    const types = e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === DRAG_FILE_PATH) return true;
      if (types[i] === 'Files') return true;
    }
    return false;
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>): void {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>): void {
    if (!acceptsDrop(e)) return;
    e.preventDefault();
    const paths: string[] = [];
    const internal = e.dataTransfer.getData(DRAG_FILE_PATH);
    if (internal) {
      paths.push(internal);
    } else {
      // OS-level drag (Finder, etc). Electron 32 removed `File.path`
      // from the renderer; `webUtils.getPathForFile` (exposed via the
      // preload bridge) is the only supported way to resolve a drag-
      // dropped File to a filesystem path.
      for (let i = 0; i < e.dataTransfer.files.length; i++) {
        const f = e.dataTransfer.files[i];
        const p = window.baton.getPathForFile(f);
        if (p) paths.push(p);
      }
    }
    if (paths.length === 0) return;
    const text = paths.map(shellQuotePath).join(' ') + ' ';
    const encoded = btoa(unescape(encodeURIComponent(text)));
    void window.baton.call('pty.write', { sessionId, data: encoded });
  }

  const matchLabel = (): string => {
    if (!query) return '';
    if (!results || results.total === 0) return 'No results';
    if (results.total === -1) return 'Many matches';
    return `${results.current}/${results.total}`;
  };
  const noMatches = Boolean(query) && (!results || results.total === 0);

  return (
    <div className="terminal-pane">
      {searchOpen ? (
        <div className="terminal-search" role="search">
          <input
            ref={searchInputRef}
            className={`terminal-search-input${noMatches ? ' is-empty' : ''}`}
            type="text"
            placeholder="Find"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
              else if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) findPrevious(query);
                else findNext(query);
              } else if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
                // Cmd+F while the box is already open: re-select so the
                // user can overtype, instead of inserting a find char.
                e.preventDefault();
                e.currentTarget.select();
              }
            }}
          />
          <span className="terminal-search-count">{matchLabel()}</span>
          <button
            type="button"
            className={`terminal-search-opt${caseSensitive ? ' is-on' : ''}`}
            title="Match case"
            aria-pressed={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
          >Aa</button>
          <button
            type="button"
            className={`terminal-search-opt${wholeWord ? ' is-on' : ''}`}
            title="Whole word"
            aria-pressed={wholeWord}
            onClick={() => setWholeWord((v) => !v)}
          >W</button>
          <button
            type="button"
            className={`terminal-search-opt${useRegex ? ' is-on' : ''}`}
            title="Use regular expression"
            aria-pressed={useRegex}
            onClick={() => setUseRegex((v) => !v)}
          >.*</button>
          <button
            type="button"
            className="terminal-search-btn"
            title="Previous match (Shift+Enter)"
            disabled={!query}
            onClick={() => findPrevious(query)}
          >↑</button>
          <button
            type="button"
            className="terminal-search-btn"
            title="Next match (Enter)"
            disabled={!query}
            onClick={() => findNext(query)}
          >↓</button>
          <button
            type="button"
            className="terminal-search-btn"
            title="Close (Esc)"
            onClick={closeSearch}
          >✕</button>
        </div>
      ) : null}
      <div
        className="terminal-host"
        ref={hostRef}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
    </div>
  );
}

/** Wrap `path` so a POSIX shell parses it as a single token. Returns
 *  the input unchanged if it contains only "safe" characters — that
 *  keeps the typed text readable for Claude-style prompts where the
 *  surrounding quotes aren't useful. */
function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_./@:+,-]+$/.test(path)) return path;
  return `'${path.replace(/'/g, "'\\''")}'`;
}
