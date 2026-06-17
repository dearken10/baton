/**
 * MaestroSessionView — the T6 3-column view rendered inside
 * MaestroFullScreen.
 *
 *   ┌──────────┬──────────────────────┬─────────────┐
 *   │  Ticks   │  Conversation        │  Actions    │
 *   │  (col 1) │  (col 2)             │  (col 3)    │
 *   └──────────┴──────────────────────┴─────────────┘
 *
 * Column 1: chronological tick list, latest on top, with status
 *           badges (success / failed / skipped). Click selects.
 * Column 2: the selected tick's normalized turns as chat bubbles —
 *           user prompt, assistant text, thinking (collapsed),
 *           tool calls + results.
 * Column 3: the action cards that tick produced. Empty placeholder
 *           when the tick failed / has no plan.
 *
 * Data: pulled by the parent via `maestro.getSession`. We re-render
 * when the parent passes a refreshed payload.
 */

import { useCallback, useMemo } from 'react';
import type { ResponseOf } from '@shared/ipc.js';
import { useAppStore } from '../store.js';

type Session = ResponseOf<'maestro.getSession'>;
type Tick = Session['ticks'][number];
type Turn = Tick['turns'][number];
type Block = Turn['blocks'][number];
type Plan = NonNullable<Tick['plan']>;
type Action = Plan['actions'][number];

interface Props {
  session: Session;
  /** Initial selection — usually the last tick. Caller can override
   *  to keep selection sticky across refreshes. */
  selectedIndex: number | null;
  onSelect: (tickIndex: number) => void;
}

export function MaestroSessionView({
  session, selectedIndex, onSelect,
}: Props): JSX.Element {
  const ticksDesc = useMemo(() => [...session.ticks].reverse(), [session.ticks]);
  const selected = useMemo(
    () => session.ticks.find((t) => t.index === selectedIndex) ?? null,
    [session.ticks, selectedIndex]
  );

  return (
    <div className="mss-split">
      <TickList
        ticks={ticksDesc}
        selectedIndex={selectedIndex}
        totalTicks={session.totalTicks}
        onSelect={onSelect}
      />
      <TickDetail tick={selected} />
      <TickActions tick={selected} />
    </div>
  );
}

/* ────────────────────── Column 1 — tick list ────────────────────── */

function TickList({
  ticks, selectedIndex, totalTicks, onSelect,
}: {
  ticks: Tick[];
  selectedIndex: number | null;
  totalTicks: number;
  onSelect: (n: number) => void;
}): JSX.Element {
  return (
    <div className="mss-col mss-col-ticks">
      <div className="mss-col-head">
        <span>Ticks</span>
        <span className="mss-col-count">{totalTicks}</span>
      </div>
      <div className="mss-col-body">
        {ticks.length === 0 ? (
          <div className="mss-empty-col">No ticks yet.</div>
        ) : (
          ticks.map((t) => (
            <TickRow
              key={t.index}
              tick={t}
              selected={t.index === selectedIndex}
              onClick={() => onSelect(t.index)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TickRow({
  tick, selected, onClick,
}: { tick: Tick; selected: boolean; onClick: () => void }): JSX.Element {
  const cls = [
    'mss-row',
    selected ? 'is-selected' : '',
    tick.status === 'failed' ? 'is-error' : '',
    tick.status === 'in-progress' ? 'is-pending' : '',
  ].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} onClick={onClick}>
      <div className="mss-row-top">
        <span className="mss-row-no">Tick {tick.index}</span>
        <span className="mss-row-time">{fmtRowTime(tick.startedAt)}</span>
      </div>
      <div className="mss-row-sub">{tickSummary(tick)}</div>
    </button>
  );
}

function tickSummary(t: Tick): string {
  if (t.status === 'failed') return t.statusDetail ?? 'failed';
  if (t.status === 'in-progress') return 'in progress…';
  if (t.plan) {
    const acts = t.plan.actions;
    if (acts.length === 0) return 'no actions';
    const proposed = acts.filter((a) => a.kind !== 'defer').length;
    const deferred = acts.length - proposed;
    if (deferred === 0) return `${proposed} proposal${proposed === 1 ? '' : 's'}`;
    return `${proposed} proposal${proposed === 1 ? '' : 's'} · ${deferred} deferred`;
  }
  return `${t.turnCount} turn${t.turnCount === 1 ? '' : 's'}`;
}

/* ────────────────────── Column 2 — conversation ────────────────────── */

function TickDetail({ tick }: { tick: Tick | null }): JSX.Element {
  if (!tick) {
    return (
      <div className="mss-col mss-col-detail">
        <div className="mss-empty">Select a tick to see its conversation.</div>
      </div>
    );
  }
  return (
    <div className="mss-col mss-col-detail">
      <div className="mss-detail-head">
        <h3>Tick {tick.index} · {tick.turnCount} turn{tick.turnCount === 1 ? '' : 's'}</h3>
        <span className="mss-detail-meta">
          {fmtDetailRange(tick.startedAt, tick.endedAt)}
          {tick.status === 'failed' && tick.statusDetail
            ? <> · <span className="mss-status-fail">{tick.statusDetail}</span></>
            : null}
        </span>
      </div>
      <div className="mss-detail-body">
        {tick.turns.map((turn) => (
          <TurnRow key={turn.id} turn={turn} />
        ))}
      </div>
    </div>
  );
}

function TurnRow({ turn }: { turn: Turn }): JSX.Element {
  // Style: user turns get a ▶ glyph, assistant turns get the maestro 🎼.
  // Tool-result user turns get a ⚙ glyph so they read as machine output
  // rather than human input.
  const isToolResultOnly = turn.role === 'user'
    && turn.blocks.length > 0
    && turn.blocks.every((b) => b.kind === 'tool_result');

  const glyph = turn.role === 'assistant' ? '🎼'
    : isToolResultOnly ? '⚙' : '▶';
  const role = turn.role === 'assistant' ? 'Maestro'
    : isToolResultOnly ? 'Tool result' : 'User';
  const cls = `mss-turn mss-turn-${turn.role}${isToolResultOnly ? ' is-tool' : ''}`;

  return (
    <div className={cls}>
      <div className="mss-turn-glyph" aria-hidden>{glyph}</div>
      <div className="mss-turn-body">
        <div className="mss-turn-meta">
          <span>{role}</span>
          {turn.timestamp ? <span className="mss-turn-time">{fmtTurnTime(turn.timestamp)}</span> : null}
        </div>
        {turn.blocks.map((b, i) => <BlockRow key={i} block={b} />)}
      </div>
    </div>
  );
}

function BlockRow({ block }: { block: Block }): JSX.Element | null {
  switch (block.kind) {
    case 'text':
      return <div className="mss-block-text">{block.text}</div>;
    case 'thinking':
      return (
        <details className="mss-block-thinking">
          <summary>Thinking</summary>
          <div className="mss-block-thinking-body">{block.text}</div>
        </details>
      );
    case 'tool_use':
      return (
        <div className="mss-block-tool">
          <span className="mss-tool-name">{block.name}</span>
          <span className="mss-tool-input">{block.inputPreview}</span>
        </div>
      );
    case 'tool_result':
      return (
        <div className={`mss-block-result${block.isError ? ' is-error' : ''}`}>
          {block.preview}
        </div>
      );
    default: {
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

/* ────────────────────── Column 3 — actions ────────────────────── */

function TickActions({ tick }: { tick: Tick | null }): JSX.Element {
  const sessions = useAppStore((s) => s.sessions);
  const projects = useAppStore((s) => s.projects);

  const lookup = useCallback((sid: string | null) => {
    if (!sid) return undefined;
    const s = sessions[sid];
    if (!s) return undefined;
    const p = projects[s.projectId];
    return { projectName: p?.name, branch: s.branch };
  }, [sessions, projects]);

  if (!tick) {
    return (
      <div className="mss-col mss-col-actions">
        <div className="mss-col-head"><span>Actions</span></div>
        <div className="mss-empty">No tick selected.</div>
      </div>
    );
  }

  if (!tick.plan) {
    let msg = 'No plan written for this tick.';
    if (tick.status === 'failed') msg = `${tick.statusDetail ?? 'Tick failed'} — no plan written.`;
    else if (tick.status === 'in-progress') msg = 'Tick still in progress.';
    return (
      <div className="mss-col mss-col-actions">
        <div className="mss-col-head"><span>Actions</span></div>
        <div className="mss-empty">{msg}</div>
      </div>
    );
  }

  const acts = tick.plan.actions;
  return (
    <div className="mss-col mss-col-actions">
      <div className="mss-col-head">
        <span>Actions</span>
        <span className="mss-col-count">{acts.length}</span>
      </div>
      <div className="mss-actions-body">
        {acts.length === 0 ? (
          <div className="mss-empty">Plan was written with no actions.</div>
        ) : (
          acts.map((a) => (
            <SessionActionCard key={a.actionId} action={a} lookup={lookup} />
          ))
        )}
      </div>
    </div>
  );
}

function SessionActionCard({
  action: a, lookup,
}: {
  action: Action;
  lookup: (sid: string | null) => { projectName?: string; branch?: string } | undefined;
}): JSX.Element {
  const info = lookup(a.targetSessionId);
  const project = info?.projectName ?? (a.targetSessionId?.slice(0, 8) ?? '—');
  const branch = info?.branch;
  const conf = confidenceBucket(a.confidence);

  // Defer actions carry a single-line rationale ("why deferred") and
  // nothing else worth surfacing in the card.
  const isDefer = a.kind === 'defer';

  const [firstAssumption, ...moreAssumptions] = a.assumptionsMade;

  return (
    <div className={`mss-acard mss-acard-${a.kind}`}>
      <div className="mss-acard-head">
        <span className="mss-acard-project" title={project + (branch ? ` · ${branch}` : '')}>
          {project}{branch ? <span className="mss-acard-branch"> / {branch}</span> : null}
        </span>
        <span className={`mss-acard-kind mss-acard-kind-${a.kind}`}>{a.kind}</span>
      </div>

      {isDefer ? (
        <div className="mss-acard-rationale">{a.rationale}</div>
      ) : (
        <>
          {a.rationale ? <div className="mss-acard-rationale">{a.rationale}</div> : null}
          {a.prompt ? (
            <div className="mss-acard-prompt">
              <span className="mss-acard-prompt-label">▸ Send to agent</span>
              {a.prompt}
            </div>
          ) : null}

          <div className="mss-acard-foot">
            <span className="mss-acard-bar">
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} className={i < conf.filled ? 'on' : ''} />
              ))}
            </span>
            <span className="mss-acard-conf">{conf.label} · {a.confidence.toFixed(2)}</span>
            {a.assumptionsMade.length > 0 ? (
              <span className="mss-acard-meta">
                {a.assumptionsMade.length} assumption{a.assumptionsMade.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>

          {firstAssumption ? (
            <AssumptionBlock assumption={firstAssumption} />
          ) : null}

          {moreAssumptions.length > 0 ? (
            <details className="mss-acard-more">
              <summary>
                {moreAssumptions.length} more assumption{moreAssumptions.length === 1 ? '' : 's'}
              </summary>
              <div className="mss-acard-more-body">
                {moreAssumptions.map((x, i) => (
                  <AssumptionBlock key={i} assumption={x} />
                ))}
              </div>
            </details>
          ) : null}

          {a.reversibilityNote ? (
            <div className="mss-acard-revert">↻ {a.reversibilityNote}</div>
          ) : null}

          <div className="mss-acard-buttons">
            <button type="button" className="mss-acard-btn mss-acard-btn-approve">Approve</button>
            <button type="button" className="mss-acard-btn">Edit</button>
            <button type="button" className="mss-acard-btn">Snooze</button>
          </div>
        </>
      )}
    </div>
  );
}

function AssumptionBlock({
  assumption: x,
}: { assumption: Action['assumptionsMade'][number] }): JSX.Element {
  return (
    <div className="mss-acard-assumption">
      <div className="mss-acard-q"><b>Q:</b> {x.question}</div>
      <div className="mss-acard-a"><b>A:</b> {x.assumedAnswer}</div>
      {x.ifWrong ? (
        <div className="mss-acard-iw">✗ If wrong: {x.ifWrong}</div>
      ) : null}
    </div>
  );
}

interface Bucket {
  label: string;
  tone: 'high' | 'medium' | 'low';
  filled: number;
}
function confidenceBucket(c: number): Bucket {
  if (c >= 0.85) return { label: 'High',       tone: 'high',   filled: 5 };
  if (c >= 0.6 ) return { label: 'Medium',     tone: 'medium', filled: 4 };
  if (c >= 0.45) return { label: 'Medium',     tone: 'medium', filled: 3 };
  if (c >= 0.3 ) return { label: 'Low-medium', tone: 'low',    filled: 2 };
  return            { label: 'Low',         tone: 'low',    filled: 1 };
}

/* ────────────────────── Date formatting ────────────────────── */

function fmtRowTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Yesterday: stash time as "Yest HH:mm"
  const yest = new Date(now);
  yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) {
    return `Yest ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtTurnTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function fmtDetailRange(startIso: string, endIso: string | null): string {
  const start = new Date(startIso);
  const startFmt = start.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (!endIso) return startFmt;
  const end = new Date(endIso);
  const durMs = end.getTime() - start.getTime();
  if (durMs <= 0) return startFmt;
  const m = Math.floor(durMs / 60_000);
  const s = Math.floor((durMs % 60_000) / 1000);
  return `${startFmt} · ${m > 0 ? `${m}m ${s}s` : `${s}s`}`;
}
