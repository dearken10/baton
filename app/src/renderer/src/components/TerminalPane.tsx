import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';

/** How often to snapshot the visible terminal to disk. */
const SCROLLBACK_SAVE_MS = 10_000;

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

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SF Mono, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: '#0a0b0d',
        foreground: '#e6e8eb',
        cursor: '#5b8def',
        cursorAccent: '#0a0b0d',
        selectionBackground: 'rgba(91, 141, 239, 0.35)',
      },
      allowProposedApi: true,
      scrollback: 10000,
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

    term.open(host);
    // Defer the first fit() so the host element has measured layout.
    // Without this, xterm throws "Cannot read properties of undefined
    // (reading 'dimensions')" on early ANSI input.
    requestAnimationFrame(() => {
      try { fit.fit(); } catch { /* host may be unmounting */ }
    });

    // Replay previous scrollback BEFORE we attach the live pty data
    // subscription. Any live frames that arrive while we're loading
    // get queued by main; once we subscribe they flush in order.
    let liveReady = false;
    const queuedFrames: Uint8Array[] = [];
    void window.code24
      .call('scrollback.load', { sessionId })
      .then(({ data }) => {
        if (data) term.write(data);
        // Now flush any frames we queued during the load and let
        // future ones go straight to write.
        for (const bytes of queuedFrames) term.write(bytes);
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
      void window.code24.call('pty.write', { sessionId, data: encoded });
    });

    // Resize the pty when the terminal is resized.
    const resizeSub = term.onResize(({ cols, rows }) => {
      void window.code24.call('pty.resize', { sessionId, cols, rows });
    });

    // Subscribe to pty data for this session only.
    // IMPORTANT: pass a Uint8Array (raw bytes), not a string. xterm.write
    // treats a string as UTF-16 — multi-byte UTF-8 box-drawing chars
    // would render as garbage. A Uint8Array is correctly decoded as UTF-8.
    const offData = window.code24.onPtyData((frame) => {
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
        void window.code24.call('scrollback.save', { sessionId, data });
      } catch { /* best-effort */ }
    };
    const saveInterval = window.setInterval(saveSnapshot, SCROLLBACK_SAVE_MS);

    // Fit on window resize.
    const onWinResize = (): void => {
      try { fit.fit(); } catch { /* ignore mid-mount fit errors */ }
    };
    window.addEventListener('resize', onWinResize);

    return () => {
      window.clearInterval(saveInterval);
      // Final snapshot on unmount so the very latest state is
      // captured. Synchronous serialise + fire-and-forget IPC.
      saveSnapshot();
      window.removeEventListener('resize', onWinResize);
      ro.disconnect();
      offData();
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      void webglOk; // silence the lint; useful for future telemetry
    };
  }, [sessionId]);

  return <div className="terminal-host" ref={hostRef} />;
}
