import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store.js';

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
 * Input: the bottom composer forwards the prompt text and a separate
 * Enter keystroke to `pty.write` (same path xterm uses for
 * keystrokes — see Composer for why they're split). That covers the 80% case
 * (send a prompt, type a slash command in full). Interactive bits the
 * TUI renders — permission prompts, slash-command picker, @-mentions —
 * still need the Live view.
 */
export function TurnsPane({ sessionId }: Props): JSX.Element {
  const [turns, setTurns] = useState<SessionTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Drive the "working" indicator off the same status the sidebar /
  // header use, so all three views agree on whether Claude is busy.
  const isWorking = useAppStore((s) => s.sessions[sessionId]?.status === 'running');
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
    // Re-read the transcript on any content-free ping for THIS session.
    //   - prompt_submitted: the user's new prompt landed.
    //   - status_changed:   the agent started/stopped working, so the
    //     new progress and (on Stop → idle) the recap are on disk now.
    // Without the status_changed trigger the pane only refreshed when
    // the user sent the next prompt, so the agent's reply never showed.
    const unsub = window.baton.onEvent((event) => {
      if (
        event.type !== 'session.prompt_submitted' &&
        event.type !== 'session.status_changed'
      ) return;
      if (event.sessionId !== sessionId) return;
      void load();
    });
    return () => { unsub(); };
  }, [sessionId, load]);

  // While the agent is actively working, status doesn't change between
  // the start and end of a long turn, so the status_changed trigger
  // alone can't surface streamed assistant text / tool calls as they
  // arrive. Poll the transcript on a short interval so the pane updates
  // live. Only runs while working AND while this pane is mounted (it's
  // only mounted for the selected session in the Turns view), so the
  // cost is bounded.
  useEffect(() => {
    if (!isWorking) return;
    const id = window.setInterval(() => { void load(); }, 1500);
    return () => window.clearInterval(id);
  }, [isWorking, load]);

  // Reset stick-to-bottom when the user changes sessions — fresh
  // session, fresh assumption that we want to follow new turns.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [sessionId]);

  // After every render that changes the content height (i.e. when the
  // `turns` array changes, or the "working" indicator toggles), pin to
  // the bottom if we were tracking it. Run inside requestAnimationFrame
  // so the DOM has measured the new content height before we read
  // scrollHeight.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(id);
  }, [turns, isWorking]);

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
        <TurnsBody turns={turns} error={error} isWorking={isWorking} sessionId={sessionId} />
      </div>
      <Composer sessionId={sessionId} />
    </div>
  );
}

function TurnsBody({
  turns, error, isWorking, sessionId,
}: { turns: SessionTurn[] | null; error: string | null; isWorking: boolean; sessionId: string }): JSX.Element {
  if (error) return <div className="empty"><p className="dim">{error}</p></div>;
  if (turns === null) return <div className="empty"><p className="dim">Loading turns…</p></div>;
  if (turns.length === 0) {
    // First prompt may already be in-flight before any turn has been
    // written to the transcript — show the indicator so the user isn't
    // staring at an empty pane.
    return (
      <div className="empty">
        {isWorking
          ? <WorkingIndicator />
          : <p className="dim">No turns yet. Type below to send your first prompt.</p>}
      </div>
    );
  }
  // Oldest first — matches chat/TUI convention so newly-sent turns flow
  // in right above the composer.
  return (
    <div className="turns-list">
      {turns.map((t) => <TurnCard key={t.id} turn={t} sessionId={sessionId} />)}
      {isWorking ? <WorkingIndicator /> : null}
    </div>
  );
}

function WorkingIndicator(): JSX.Element {
  return (
    <div className="turns-working" role="status" aria-live="polite">
      <span className="turns-working-dots" aria-hidden="true">
        <span /><span /><span />
      </span>
      <span className="turns-working-label">Claude is working…</span>
    </div>
  );
}

function TurnCard({ turn, sessionId }: { turn: SessionTurn; sessionId: string }): JSX.Element {
  // Progress collapsed by default — the whole point of this view is to
  // skim the user prompt + recap and only dig into progress when the
  // recap is missing or confusing.
  const [open, setOpen] = useState(false);
  const ts = useMemo(() => formatTs(turn.ts), [turn.ts]);
  return (
    <article className="turn-card">
      <header className="turn-user">
        <div className="turn-user-top">
          <span className="turn-ts">{ts}</span>
          <RevertControl sessionId={sessionId} turn={turn} />
        </div>
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

/** Per-turn "revert to here" control. Reverting drops this turn and
 *  every turn after it from the conversation AND rolls the worktree's
 *  files back to the snapshot taken before this turn ran. It's
 *  destructive and irreversible, so the button expands into an explicit
 *  Confirm / Cancel pair before doing anything. On success the backend
 *  emits `session.prompt_submitted`, which makes TurnsPane re-read the
 *  (now shorter) transcript — so this card simply disappears. */
function RevertControl({ sessionId, turn }: { sessionId: string; turn: SessionTurn }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function doRevert(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.baton.call('session.revertToTurn', {
        sessionId,
        turnId: turn.id,
        turnTs: turn.ts,
      });
      // Success path: the prompt_submitted event reloads the list and
      // this card unmounts, so there's nothing more to do here.
    } catch (err) {
      setError(String(err));
      setBusy(false);
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <button
        type="button"
        className="turn-revert turn-revert-err"
        title={error}
        onClick={() => setError(null)}
      >
        Revert failed ⟲
      </button>
    );
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="turn-revert"
        title="Drop this turn and everything after it, and roll the files back to before it ran"
        onClick={() => setConfirming(true)}
      >
        Revert
      </button>
    );
  }

  return (
    <span className="turn-revert-confirm">
      <span className="turn-revert-label">Revert &amp; discard later turns?</span>
      <button
        type="button"
        className="turn-revert turn-revert-yes"
        disabled={busy}
        onClick={() => void doRevert()}
      >
        {busy ? '…' : 'Confirm'}
      </button>
      <button
        type="button"
        className="turn-revert turn-revert-no"
        disabled={busy}
        onClick={() => setConfirming(false)}
      >
        Cancel
      </button>
    </span>
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

/** Gap between writing the prompt text and writing the submitting
 *  Enter. Long enough that the agent's TUI doesn't fold the \r into the
 *  preceding paste burst (which would insert a newline instead of
 *  submitting), short enough to feel instant. */
const ENTER_SUBMIT_DELAY_MS = 80;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

/** base64-of-UTF-8 encode `s` and write it to the session's pty —
 *  mirrors TerminalPane's keystroke encoder so the TUI receives it
 *  exactly as if typed in the live terminal. */
function writeToPty(sessionId: string, s: string): Promise<unknown> {
  const encoded = btoa(unescape(encodeURIComponent(s)));
  return window.baton.call('pty.write', { sessionId, data: encoded });
}

/** Bottom-of-pane prompt composer. Sends the prompt text, then a
 *  separate Enter keystroke, to the pty via the same `pty.write` IPC
 *  xterm uses, so the TUI receives it as if typed in the live terminal.
 *  Enter sends, Shift+Enter inserts a newline (standard chat UX). */
function Composer({ sessionId }: { sessionId: string }): JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Focus the composer when the Turns view opens (and when the
  // selected session changes while it's open). This overlay sits on
  // top of the still-mounted live xterm, whose hidden helper textarea
  // is directly underneath us. Without grabbing focus here, keyboard
  // focus stays on that terminal, so Enter lands in the TUI as a
  // newline instead of submitting the prompt.
  useEffect(() => {
    taRef.current?.focus();
  }, [sessionId]);

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
      // Send the prompt text and the submitting Enter as TWO separate
      // pty writes with a gap between them — do NOT append \r to the
      // text in a single write.
      //
      // The agent's TUI (Claude Code / Codex) runs a paste-detection
      // heuristic: when a burst of bytes arrives together it's treated
      // as pasted content, and a \r riding along at the end of that
      // burst is inserted as a literal newline in the input box instead
      // of submitting. That's the "Enter just makes a newline in the
      // terminal" bug. In the Live terminal each keystroke arrives on
      // its own (human typing), so Enter there always submits.
      //
      // Writing the text first, letting it settle, then writing \r on
      // its own makes the TUI read the \r as a real Enter keypress.
      await writeToPty(sessionId, value);
      await delay(ENTER_SUBMIT_DELAY_MS);
      await writeToPty(sessionId, '\r');
      setText('');
    } finally {
      setBusy(false);
      // Keep focus on the composer after a send. The Send-button click
      // moves focus to the button, and any blur drops keystrokes into
      // the xterm sitting underneath this overlay — so the next Enter
      // would leak to the terminal instead of submitting here.
      taRef.current?.focus();
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
