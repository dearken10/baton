/**
 * Maestro action card — shared between the strip popup (later) and
 * the full-screen view. Matches the M9 mockup at
 * design/mockup-maestro-layouts.html (tab 9).
 *
 * The card shows:
 *  - project / branch / status header
 *  - one-line intent (last_summary)
 *  - confidence visual (5-cell bar) + word label + assumption count
 *  - prompt body (mono-font, scrollable when long)
 *  - first assumption inline (additional ones revealed on click)
 *  - revert note + action buttons
 *
 * For `defer` actions the body collapses to a one-line "why deferred"
 * — no prompt, no assumptions, no action buttons.
 *
 * The action buttons are wired to fire console.log for now; execution
 * isn't built yet (PRD F15.6 checkpoint+revert pipeline).
 */

import { useMemo, useState } from 'react';
import type { ResponseOf } from '@shared/ipc.js';

type Plan = NonNullable<ResponseOf<'maestro.getState'>['plan']>;
type Action = Plan['actions'][number];

interface Props {
  action: Action;
  /** When provided, lets the card resolve a session's project + branch
   *  for the header. Without it the card falls back to truncated ids. */
  sessionLookup?: (
    sessionId: string | null
  ) => { projectName?: string; branch?: string } | undefined;
}

export function MaestroActionCard(
  { action: a, sessionLookup }: Props
): JSX.Element {
  const isDefer = a.kind === 'defer';
  const lookup = sessionLookup?.(a.targetSessionId ?? null);
  const projectName = lookup?.projectName ?? '<unknown>';
  const branch = lookup?.branch ?? a.targetSessionId?.slice(0, 8) ?? '?';
  const [showMore, setShowMore] = useState(false);

  const conf = confidenceBucket(a.confidence);
  const firstAssumption = a.assumptionsMade[0];
  const extraAssumptions = a.assumptionsMade.slice(1);

  return (
    <div className={`mac mac-${a.kind} mac-${conf.tone}`}>
      <div className="mac-head">
        <span className={`mac-status-dot mac-dot-${statusDotClass(a.kind, conf.tone)}`} aria-hidden />
        <span className="mac-project">{projectName}</span>
        <span className="mac-branch">/ {branch}</span>
        <span className={`mac-status-badge mac-status-${a.kind}`}>{statusLabel(a.kind)}</span>
      </div>

      {isDefer ? (
        <div className="mac-defer-msg">{a.rationale}</div>
      ) : (
        <>
          {a.rationale ? <div className="mac-intent">{a.rationale}</div> : null}

          <div className="mac-confidence-row">
            <ConfidenceBar value={a.confidence} />
            <span className={`mac-conf-label mac-conf-${conf.tone}`}>{conf.label}</span>
            {a.assumptionsMade.length > 0 ? (
              <span className="mac-conf-meta">
                · {a.assumptionsMade.length} assumption{a.assumptionsMade.length === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>

          {a.prompt ? (
            <pre className="mac-prompt">
              <span className="mac-prompt-label">▸ Send to agent</span>
              {a.prompt}
            </pre>
          ) : null}

          {firstAssumption ? (
            <div className="mac-assumption">
              <span className="mac-qa"><b>Q:</b> {firstAssumption.question}</span>
              <span className="mac-qa"><b>A:</b> {firstAssumption.assumedAnswer}</span>
              {firstAssumption.ifWrong ? (
                <span className="mac-iw">✗ If wrong: {firstAssumption.ifWrong}</span>
              ) : null}
            </div>
          ) : null}

          {extraAssumptions.length > 0 ? (
            <>
              <button
                type="button"
                className="mac-more-toggle"
                onClick={() => setShowMore((v) => !v)}
              >
                {showMore ? '▾' : '▸'} {extraAssumptions.length} more assumption{extraAssumptions.length === 1 ? '' : 's'}
              </button>
              {showMore ? (
                <div className="mac-more-assumptions">
                  {extraAssumptions.map((x, i) => (
                    <div key={i} className="mac-assumption">
                      <span className="mac-qa"><b>Q:</b> {x.question}</span>
                      <span className="mac-qa"><b>A:</b> {x.assumedAnswer}</span>
                      {x.ifWrong ? <span className="mac-iw">✗ {x.ifWrong}</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          {a.reversibilityNote ? (
            <div className="mac-revert">↻ {a.reversibilityNote}</div>
          ) : null}

          <div className="mac-actions">
            <button className="mac-btn mac-btn-primary" onClick={() => onAction('approve', a)}>✓ Approve</button>
            <button className="mac-btn" onClick={() => onAction('edit', a)}>✎ Edit</button>
            <button className="mac-btn mac-btn-subtle" onClick={() => onAction('snooze', a)}>💤 Snooze</button>
            <button className="mac-btn mac-btn-danger mac-btn-subtle" onClick={() => onAction('reject', a)}>✗ Reject</button>
          </div>
        </>
      )}
    </div>
  );
}

interface ConfidenceBucket {
  label: string;
  tone: 'high' | 'medium' | 'low';
  filled: number; // 0..5
}

function confidenceBucket(c: number): ConfidenceBucket {
  if (c >= 0.85) return { label: 'High',       tone: 'high',   filled: 5 };
  if (c >= 0.6 ) return { label: 'Medium',     tone: 'medium', filled: 4 };
  if (c >= 0.45) return { label: 'Medium',     tone: 'medium', filled: 3 };
  if (c >= 0.3 ) return { label: 'Low-medium', tone: 'low',    filled: 2 };
  return            { label: 'Low',         tone: 'low',    filled: 1 };
}

function ConfidenceBar({ value }: { value: number }): JSX.Element {
  const b = useMemo(() => confidenceBucket(value), [value]);
  return (
    <div className="mac-conf-bar" aria-label={`Confidence ${(value * 100).toFixed(0)}%`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`mac-conf-cell ${i < b.filled ? `mac-conf-fill-${b.tone}` : ''}`}
        />
      ))}
    </div>
  );
}

function statusLabel(kind: Action['kind']): string {
  if (kind === 'resume') return 'resume';
  if (kind === 'initiate') return 'initiate';
  return 'deferred';
}

function statusDotClass(
  kind: Action['kind'],
  tone: 'high' | 'medium' | 'low'
): string {
  if (kind === 'defer') return 'paused';
  if (tone === 'high') return 'high';
  if (tone === 'medium') return 'medium';
  return 'low';
}

function onAction(kind: 'approve' | 'edit' | 'snooze' | 'reject', a: Action): void {
  // Execution wiring lands in PRD F15.6 — for now just log so the
  // chip ergonomics can be evaluated without a runtime behind it.
  // eslint-disable-next-line no-console
  console.log('[maestro] action', { kind, action: a });
}
