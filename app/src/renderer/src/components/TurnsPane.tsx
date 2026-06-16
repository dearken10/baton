import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  sessionId: string;
}

type ProgressItem =
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_use'; name: string; inputPreview: string }
  | { kind: 'tool_result'; ok: boolean; preview: string };

interface SessionTurn {
  id: string;
  ts: number;
  userInput: string;
  progress: ProgressItem[];
  recap: string | null;
}

/**
 * Alternate, structured view of a session's transcript: one card per
 * user prompt, each broken into [user input | progress (collapsible) |
 * recap]. Lives next to <TerminalPane> in MiddleColumn and is toggled
 * via the "Live | Turns" switch in the conv-head.
 *
 * Re-fetches on `session.prompt_submitted`. Data comes from
 * `session.turns`, which parses the agent's JSONL on disk.
 *
 * Input: the bottom composer forwards plain text + `\r` to `pty.write`
 * (same path xterm uses for keystrokes). That covers the 80% case
 * (send a prompt, type a slash command in full). Interactive bits the
 * TUI renders — permission prompts, slash-command picker, @-mentions —
 * still need the Live view.
 */
export function TurnsPane({ sessionId }: Props): JSX.Element {
  const [turns, setTurns] = useState<SessionTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Track whether the user is "stuck to the bottom". If they've
  // scrolled up to read older turns we leave them alone; if they're at
  // (or near) the bottom, we follow new content. Defaults to true so
  // the first render lands at the bottom.
  const stickToBottomRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await window.baton.call('session.turns', { sessionId });
      setTurns(res.turns);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    // The event is a content-free ping — we re-read the transcript.
    const unsub = window.baton.onEvent((event) => {
      if (event.type !== 'session.prompt_submitted') return;
      if (event.sessionId !== sessionId) return;
      void load();
    });
    return () => { unsub(); };
  }, [sessionId, load]);

  // Reset stick-to-bottom when the user changes sessions — fresh
  // session, fresh assumption that we want to follow new turns.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [sessionId]);

  // After every render that changes the content height (i.e. when the
  // `turns` array changes), pin to the bottom if we were tracking it.
  // Run inside requestAnimationFrame so the DOM has measured the new
  // content height before we read scrollHeight.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [turns]);

  // Mark stick-to-bottom on scroll. 32 px threshold — a finger-flick
  // can overshoot the bottom by a few px without meaning "I want to
  // leave the bottom".
  function onScroll(e: React.UIEvent<HTMLDivElement>): void {
    const el = e.currentTarget;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 32;
  }

  return (
    <div className="turns-pane">
      <div className="turns-scroll" ref={scrollRef} onScroll={onScroll}>
        <TurnsBody turns={turns} error={error} />
      </div>
      <Composer sessionId={sessionId} />
    </div>
  );
}

function TurnsBody({
  turns, error,
}: { turns: SessionTurn[] | null; error: string | null }): JSX.Element {
  if (error) return <div className="empty"><p className="dim">{error}</p></div>;
  if (turns === null) return <div className="empty"><p className="dim">Loading turns…</p></div>;
  if (turns.length === 0) {
    return (
      <div className="empty">
        <p className="dim">
          No turns yet. Type below to send your first prompt.
        </p>
      </div>
    );
  }
  // Oldest first — matches chat/TUI convention so newly-sent turns flow
  // in right above the composer.
  return (
    <div className="turns-list">
      {turns.map((t) => <TurnCard key={t.id} turn={t} />)}
    </div>
  );
}

function TurnCard({ turn }: { turn: SessionTurn }): JSX.Element {
  // Progress collapsed by default — the whole point of this view is to
  // skim the user prompt + recap and only dig into progress when the
  // recap is missing or confusing.
  const [open, setOpen] = useState(false);
  const ts = useMemo(() => formatTs(turn.ts), [turn.ts]);
  return (
    <article className="turn-card">
      <header className="turn-user">
        <span className="turn-ts">{ts}</span>
        <pre className="turn-input">{turn.userInput}</pre>
      </header>

      <button
        type="button"
        className="turn-progress-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="turn-progress-caret">{open ? '▾' : '▸'}</span>
        Progress · {turn.progress.length}{turn.progress.length === 1 ? ' step' : ' steps'}
      </button>
      {open ? (
        <ol className="turn-progress">
          {turn.progress.map((p, i) => <li key={i}><ProgressRow item={p} /></li>)}
        </ol>
      ) : null}

      <div className="turn-recap">
        {turn.recap !== null
          ? <pre className="turn-recap-text">{turn.recap}</pre>
          : <p className="dim turn-recap-pending">…running</p>}
      </div>
    </article>
  );
}

function ProgressRow({ item }: { item: ProgressItem }): JSX.Element {
  if (item.kind === 'tool_use') {
    return (
      <div className="turn-prog turn-prog-tool">
        <span className="turn-prog-tag">⚙ {item.name}</span>
        <code className="turn-prog-arg">{item.inputPreview}</code>
      </div>
    );
  }
  if (item.kind === 'tool_result') {
    return (
      <div className={`turn-prog turn-prog-result ${item.ok ? '' : 'err'}`}>
        <span className="turn-prog-tag">{item.ok ? '✓' : '✗'}</span>
        <code className="turn-prog-arg">{item.preview}</code>
      </div>
    );
  }
  return (
    <div className="turn-prog turn-prog-text">
      <span className="turn-prog-tag">›</span>
      <span>{item.text}</span>
    </div>
  );
}

/** Bottom-of-pane prompt composer. Sends plain text + `\r` to the pty
 *  via the same `pty.write` IPC xterm uses, so the TUI receives it
 *  exactly as if the user had typed in the live terminal. Enter sends,
 *  Shift+Enter inserts a newline (standard chat UX). */
function Composer({ sessionId }: { sessionId: string }): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow up to ~6 rows, then scroll. Cheap measurement: reset to
  // 'auto' so scrollHeight reflects the natural content height.
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
  }, [text]);

  async function send(): Promise<void> {
    const value = text;
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      // Mirror TerminalPane's encoder — base64 of UTF-8 bytes. Append \r
      // to commit the prompt in the agent's TUI (Enter keystroke).
      const payload = value + '\r';
      const encoded = btoa(unescape(encodeURIComponent(payload)));
      await window.baton.call('pty.write', { sessionId, data: encoded });
      setText('');
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    // Enter sends, Shift+Enter inserts a newline (default behaviour).
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void send();
    }
  }

  return (
    <form
      className="turns-composer"
      onSubmit={(e) => { e.preventDefault(); void send(); }}
    >
      <textarea
        ref={taRef}
        className="turns-composer-input"
        placeholder="Send a prompt… (Enter to send · Shift+Enter for newline)"
        value={text}
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={busy}
      />
      <button
        type="submit"
        className="turns-composer-send"
        disabled={busy || text.trim().length === 0}
      >
        Send
      </button>
    </form>
  );
}

/** Compact timestamp — "14:32" for today, "Jun 12 14:32" otherwise.
 *  Returns '' for the defensive ts=0 case (older transcripts without
 *  timestamps shouldn't render a misleading "Jan 1, 1970"). */
function formatTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()} ${hhmm}`;
}
