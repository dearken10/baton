import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import { WebLinksAddon } from '@xterm/addon-web-links';
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

/** Absolute buffer line numbers where the user submitted each prompt
 *  (per session). Lives at module scope so it survives TerminalPane
 *  unmount/remount — sessions transition through 'done' on respawn /
 *  permission toggle, which drops them from the parent's liveSessions
 *  filter and unmounts us. xterm's IMarker would die with the Terminal,
 *  so we trade auto-tracking on scrollback rotation for the feature
 *  actually working across status churn. */
const promptLinesBySession = new Map<string, number[]>();

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
  const openFile = useAppStore((s) => s.openFile);
  // Keep the latest openFile in a ref so the WebLinksAddon click
  // handler (bound once at mount) always calls the current store action
  // without re-creating the addon on every render.
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  // Index INTO promptLinesBySession[sessionId] for Up/Down navigation:
  //   navIndex === lines.length → "at the bottom" (newest); Up moves back
  //   navIndex === 0            → "at the top" (oldest); Down moves forward
  // Lazy initialiser so a remount preserves the user's place at the end
  // of the persisted history rather than snapping to 0.
  const [navIndex, setNavIndex] = useState(
    () => promptLinesBySession.get(sessionId)?.length ?? 0,
  );
  // Render-trigger nonce — bumped whenever we mutate the persisted
  // line array for this session so React re-evaluates hasPrev/hasNext.
  const [, setLinesNonce] = useState(0);

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
    try {
      const webgl = new WebglAddon();
      term.loadAddon(webgl);
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

    term.open(host);
    // Defer the first fit() so the host element has measured layout.
    // Without this, xterm throws "Cannot read properties of undefined
    // (reading 'dimensions')" on early ANSI input.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* host may be unmounting */ }
    });

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
        try { fit.fit(); } catch { /* ignore */ }
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

    // Listen for prompt-submitted events for THIS session and append
    // the line number the cursor was on to the persisted array. Stored
    // at module scope so an unmount/remount (status churn dropping us
    // from liveSessions) doesn't lose the history.
    const offPrompt = window.baton.onEvent((event) => {
      if (event.type !== 'session.prompt_submitted') return;
      if (event.sessionId !== sessionId) return;
      const buf = term.buffer.active;
      const line = buf.baseY + buf.cursorY;
      const lines = promptLinesBySession.get(sessionId) ?? [];
      lines.push(line);
      promptLinesBySession.set(sessionId, lines);
      // eslint-disable-next-line no-console
      console.log('[prompt-nav] PUSH', { sessionId, line, totalLines: lines.length });
      setLinesNonce((n) => n + 1);
      // Snap the nav cursor past the end so Up goes to the newest prompt.
      setNavIndex(lines.length);
    });
    // eslint-disable-next-line no-console
    console.log('[prompt-nav] MOUNT', {
      sessionId,
      persistedLines: promptLinesBySession.get(sessionId)?.length ?? 0,
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
    const onWinResize = (): void => {
      try { fit.fit(); } catch { /* ignore mid-mount fit errors */ }
    };
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
      offPrompt();
      offData();
      dataSub.dispose();
      resizeSub.dispose();
      try { webLinks.dispose(); } catch { /* ignore */ }
      // Note: promptLinesBySession is INTENTIONALLY not cleared here.
      // The whole reason we moved it to module scope was to survive
      // unmount. session.deleted is the right place to evict, not here.
      term.dispose();
      termRef.current = null;
      void webglOk; // silence the lint; useful for future telemetry
    };
  }, [sessionId]);

  /** Step the nav cursor by ±1, clamp to the persisted-line bounds, and
   *  scroll the terminal so the corresponding prompt comes into view. */
  const jumpBy = useCallback((delta: -1 | 1): void => {
    const term = termRef.current;
    if (!term) return;
    const lines = promptLinesBySession.get(sessionId) ?? [];
    if (lines.length === 0) return;
    const idx = navIndex + delta;
    if (idx < 0 || idx >= lines.length) return;
    setNavIndex(idx);
    // Aim a couple of rows ABOVE the prompt so the user sees a little
    // context (the agent's last output line) without losing the prompt
    // off the top edge. Clamp to the current buffer length so a stored
    // line past the current end (rare: scrollback re-saved smaller)
    // just snaps to the bottom rather than throwing.
    const buf = term.buffer.active;
    const target = Math.max(0, Math.min(lines[idx] - 2, buf.length - 1));
    try { term.scrollToLine(target); } catch { /* terminal disposed */ }
  }, [navIndex, sessionId]);

  // Live counts of how many prompts are above/below the cursor. The
  // line values themselves are read from the module-level map; the
  // unused destructure subscribes the render to setLinesNonce so a new
  // push triggers re-evaluation.
  const linesForSession = promptLinesBySession.get(sessionId) ?? [];
  const hasPrev = navIndex > 0;
  const hasNext = navIndex < linesForSession.length - 1;
  // eslint-disable-next-line no-console
  console.log('[prompt-nav] RENDER', {
    sessionId: sessionId.slice(0, 8),
    navIndex,
    linesLen: linesForSession.length,
    hasPrev,
    hasNext,
  });

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

  return (
    <div
      className="terminal-host"
      ref={hostRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="terminal-prompt-nav">
        <button
          type="button"
          className="btn ghost terminal-prompt-nav-btn"
          onClick={() => {
            // eslint-disable-next-line no-console
            console.log('[prompt-nav] CLICK up', { hasPrev, navIndex });
            jumpBy(-1);
          }}
          disabled={!hasPrev}
          aria-label="Jump to previous prompt"
          title="Previous prompt"
        >
          ▲
        </button>
        <button
          type="button"
          className="btn ghost terminal-prompt-nav-btn"
          onClick={() => {
            // eslint-disable-next-line no-console
            console.log('[prompt-nav] CLICK down', { hasNext, navIndex });
            jumpBy(1);
          }}
          disabled={!hasNext}
          aria-label="Jump to next prompt"
          title="Next prompt"
        >
          ▼
        </button>
      </div>
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
