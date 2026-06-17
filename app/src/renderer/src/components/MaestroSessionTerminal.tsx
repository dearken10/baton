/**
 * MaestroSessionTerminal — flat, monospace, Claude-Code-styled mirror
 * of the master session's transcript. Read-only — we don't attach a
 * real PTY (the session is owned by the daemon; opening another `claude
 * --resume <sid>` would race with it). Instead we render the same
 * normalized turns the 3-column view uses, but as a single scrolling
 * REPL log.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { ResponseOf } from '@shared/ipc.js';

type Session = ResponseOf<'maestro.getSession'>;
type Tick = Session['ticks'][number];
type Turn = Tick['turns'][number];
type Block = Turn['blocks'][number];

interface Props {
  session: Session;
}

export function MaestroSessionTerminal({ session }: Props): JSX.Element {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // Scroll to the bottom whenever the transcript grows so the user
  // sees the latest tick on entry. Idempotent for repeated renders.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.ticks]);

  // Headline values shown in the header strip.
  const sid = session.sessionId ?? '—';
  const sidShort = sid.length > 8 ? sid.slice(0, 8) : sid;
  const turnCount = useMemo(
    () => session.ticks.reduce((n, t) => n + t.turnCount, 0),
    [session.ticks]
  );

  if (!session.available || session.ticks.length === 0) {
    return (
      <div className="mst-pane">
        <Header sidShort={sidShort} sid={sid} tickCount={session.totalTicks} turnCount={0} />
        <div className="mst-body">
          <div className="mst-empty">
            {session.available
              ? 'No ticks recorded yet — bootstrap the daemon to see output.'
              : 'Master Maestro session not found. Has the daemon ever run?'}
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="mst-pane">
      <Header sidShort={sidShort} sid={sid} tickCount={session.totalTicks} turnCount={turnCount} />

      <div className="mst-body" ref={bodyRef}>
        <Welcome sid={sid} />
        {session.ticks.map((tick) => (
          <TickBlock key={tick.index} tick={tick} />
        ))}

        <div className="mst-prompt-line">
          <span className="mst-prompt-marker">›</span>
          <span className="mst-prompt-hint">_</span>
          <span className="mst-cursor" />
        </div>
      </div>

      <Footer />
    </div>
  );
}

function Header({
  sidShort, sid, tickCount, turnCount,
}: { sidShort: string; sid: string; tickCount: number; turnCount: number }): JSX.Element {
  return (
    <div className="mst-head">
      <span className="mst-dot" aria-hidden /><span className="mst-live">Live</span>
      <span className="mst-pill" title={sid}>claude --resume {sidShort}</span>
      <div className="mst-spacer" />
      <span>{tickCount} tick{tickCount === 1 ? '' : 's'} · {turnCount} turn{turnCount === 1 ? '' : 's'}</span>
    </div>
  );
}

function Footer(): JSX.Element {
  return (
    <div className="mst-foot">
      <span><kbd>↵</kbd> send</span>
      <span><kbd>^C</kbd> interrupt</span>
      <span><kbd>esc</kbd> back</span>
      <div className="mst-spacer" />
      <span className="mst-foot-note">read-only mirror</span>
    </div>
  );
}

function Welcome({ sid }: { sid: string }): JSX.Element {
  return (
    <pre className="mst-welcome">
{`╭───────────────────────────────────────────────────────────────────╮
│  🎼 Maestro · master-mind session                                 │
│  resumed from `}<span className="mst-cyan">{sid}</span>{`           │
│  type `}<span className="mst-grn">/maestro-tick</span>{` to run a tick · `}<span className="mst-grn">/exit</span>{` to detach              │
╰───────────────────────────────────────────────────────────────────╯`}
    </pre>
  );
}

function TickBlock({ tick }: { tick: Tick }): JSX.Element {
  return (
    <div className="mst-tick">
      <div className="mst-tick-sep">
        ─── Tick {tick.index} · {fmtTime(tick.startedAt)}
        {tick.status === 'failed' ? <span className="mst-red"> · failed ({tick.statusDetail ?? 'error'})</span> : null}
        {' '}{'─'.repeat(40)}
      </div>
      {tick.turns.map((turn) => <TurnLine key={turn.id} turn={turn} />)}
    </div>
  );
}

function TurnLine({ turn }: { turn: Turn }): JSX.Element {
  if (turn.isTickStart) {
    return (
      <div className="mst-line">
        <span className="mst-purp">›</span> <span className="mst-cyan">/maestro-tick</span>
      </div>
    );
  }
  return (
    <div className="mst-line">
      {turn.blocks.map((b, i) => <BlockLine key={i} block={b} role={turn.role} />)}
    </div>
  );
}

function BlockLine({ block, role }: { block: Block; role: 'user' | 'assistant' }): JSX.Element | null {
  switch (block.kind) {
    case 'text':
      if (role === 'user') {
        // A user-role text that isn't a slash-command boundary is
        // something the user typed mid-stream (rare for the master
        // session; happens when Claude Code injects a continuation).
        return (
          <div className="mst-text mst-user-text">
            <span className="mst-purp">›</span> {block.text}
          </div>
        );
      }
      return <div className="mst-text mst-assist-text">{block.text}</div>;
    case 'thinking':
      // Claude Code shows thinking as a dim italic block; keep it
      // similar but collapse extra-long ones.
      return (
        <div className="mst-think">
          <span className="mst-think-glyph">⏺ Thinking</span>
          {block.text ? <span className="mst-think-body"> · {truncate(block.text, 240)}</span> : null}
        </div>
      );
    case 'tool_use':
      return (
        <div className="mst-tool">
          <span className="mst-purp">●</span> <span className="mst-grn">{block.name}</span>
          {block.inputPreview ? <span className="mst-tool-input">({block.inputPreview})</span> : null}
        </div>
      );
    case 'tool_result':
      return (
        <div className={`mst-result${block.isError ? ' is-error' : ''}`}>
          <span className="mst-result-prefix">└─ </span>{block.preview}
        </div>
      );
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString([], {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}
