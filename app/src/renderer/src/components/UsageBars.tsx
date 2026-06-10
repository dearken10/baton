import { useCallback, useEffect, useRef, useState } from 'react';
import type { ControlVerb, ResponseOf } from '@shared/ipc.js';

/**
 * Plan-usage chip + popup, modeled on Nimbalyst. The chip is a small
 * circular progress showing the higher of the two windows (the
 * binding constraint at a glance). Click → popup with both windows,
 * each showing % + bar + a live "Resets in Xh Ym" countdown.
 *
 * Data sources:
 *   - source="claude" → Anthropic OAuth-usage API (via main process)
 *   - source="codex"  → rate_limits embedded in Codex rollout JSONL
 *
 * Both come back in the same shape, so the UI is identical; the only
 * differences are the verb to call, the popup title, and the support
 * link in the footer.
 */

type Stats = ResponseOf<'usage.getStats'>;
type Win = Stats['fiveH'];

interface Source {
  /** IPC verb that returns a UsageGetStatsResponse. */
  verb: Extract<ControlVerb, `usage.${string}`>;
  /** Title shown in the popup. */
  title: string;
  /** Link in the popup footer. */
  statusUrl: string;
  /** When true, render nothing if the source has no data yet. Used
   *  so a user without a Codex setup doesn't see an empty chip. */
  hideWhenEmpty: boolean;
}

const SOURCES: Record<'claude' | 'codex', Source> = {
  claude: {
    verb: 'usage.getStats',
    title: 'Claude Usage',
    statusUrl: 'https://status.anthropic.com',
    hideWhenEmpty: false,
  },
  codex: {
    verb: 'usage.getCodexStats',
    title: 'Codex Usage',
    statusUrl: 'https://status.openai.com',
    hideWhenEmpty: true,
  },
};

/** Poll the API at most once per minute from the renderer — main
 *  caches its result so this is mostly chosen so the "Resets in X"
 *  label stays approximately fresh. */
const POLL_MS = 60_000;

interface Props {
  /** Which backend to show usage for. Defaults to Claude for backward
   *  compatibility with the original single-indicator call site. */
  source?: 'claude' | 'codex';
}

export function UsageBars({ source = 'claude' }: Props = {}): JSX.Element | null {
  const cfg = SOURCES[source];
  const [stats, setStats] = useState<Stats | null>(null);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setRefreshing(true);
    try {
      const s = await window.baton.call(cfg.verb, {});
      setStats(s);
    } catch { /* leave previous reading */ }
    finally { setRefreshing(false); }
  }, [cfg.verb]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => { void refresh(); }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Close popup on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!stats) {
    if (cfg.hideWhenEmpty) return null;
    return <div className="usage-wrapper usage-loading">…</div>;
  }

  // Pct shown in the chip = whichever window is currently binding.
  // Errored API → leave the ring empty + show a `?`.
  const fiveHPct  = clampPct(stats.fiveH.utilization);
  const sevenDPct = clampPct(stats.sevenD.utilization);
  const chipPct = Math.max(fiveHPct, sevenDPct);
  const tone =
    stats.error ? 'err'
    : chipPct >= 90 ? 'crit'
    : chipPct >= 70 ? 'warn'
    : 'ok';

  // Codex: when both windows are zero AND there's an error (e.g. "no
  // rate_limits recorded yet"), the indicator carries no signal — hide
  // it instead of showing an empty ring next to the Claude chip.
  if (cfg.hideWhenEmpty && stats.error && fiveHPct === 0 && sevenDPct === 0) {
    return null;
  }

  return (
    <div className={`usage-wrapper usage-source-${source}`} ref={ref}>
      <button
        type="button"
        className={`usage-chip usage-${tone}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={stats.error ?? `${cfg.title}: ${chipPct.toFixed(0)}% of plan used — click for detail`}
      >
        <CircleProgress pct={chipPct} tone={tone} error={!!stats.error} />
      </button>
      {open ? (
        <UsagePopup
          stats={stats}
          title={cfg.title}
          statusUrl={cfg.statusUrl}
          refreshing={refreshing}
          onRefresh={() => void refresh()}
        />
      ) : null}
    </div>
  );
}

function clampPct(util: number): number {
  // The /api/oauth/usage endpoint reports utilization on a 0..100
  // scale (e.g. 5.0 = 5%, 33.0 = 33%) — NOT a 0..1 fraction. Just
  // clamp; don't multiply.
  return Math.max(0, Math.min(100, util));
}

function CircleProgress(
  { pct, tone, error }: { pct: number; tone: string; error: boolean }
): JSX.Element {
  const r = 9;
  const c = 2 * Math.PI * r;
  const dash = error ? 0 : (pct / 100) * c;
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden>
      <circle cx="12" cy="12" r={r} fill="none"
        stroke="var(--bg-3)" strokeWidth="2.5" />
      {!error ? (
        <circle cx="12" cy="12" r={r} fill="none"
          stroke="currentColor" strokeWidth="2.5"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 12 12)" />
      ) : null}
      <text x="12" y="12" textAnchor="middle" dominantBaseline="central"
        fontSize="9" fontWeight="600" fill={`var(--usage-${tone}-fg, currentColor)`}>
        {error ? '?' : Math.round(pct)}
      </text>
    </svg>
  );
}

interface PopupProps {
  stats: Stats;
  title: string;
  statusUrl: string;
  refreshing: boolean;
  onRefresh: () => void;
}

function UsagePopup({ stats, title, statusUrl, refreshing, onRefresh }: PopupProps): JSX.Element {
  // Recompute "Resets in" every 30s so the labels don't go stale
  // while the popup is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="usage-popup" role="dialog" aria-label={title}>
      <div className="usage-popup-head">
        <span className="usage-popup-title">{title}</span>
        <button
          type="button"
          className="usage-popup-refresh"
          onClick={onRefresh}
          disabled={refreshing}
          title="Refresh"
          aria-label="Refresh"
        >
          ↻
        </button>
      </div>

      {stats.error ? (
        <div className="usage-popup-error">{stats.error}</div>
      ) : (
        <>
          <UsageRow
            label="Session"
            sub="5-hour window"
            win={stats.fiveH}
            now={now}
          />
          <UsageRow
            label="Weekly"
            sub="7-day window"
            win={stats.sevenD}
            now={now}
          />
          {stats.sevenDOpus ? (
            <UsageRow
              label="Opus"
              sub="7-day window"
              win={stats.sevenDOpus}
              now={now}
            />
          ) : null}
        </>
      )}

      <div className="usage-popup-foot">
        <span className="dim">Updated {fmtRelative(now - stats.lastUpdated)}</span>
        <a href={statusUrl} target="_blank" rel="noopener noreferrer">
          Status
        </a>
      </div>
    </div>
  );
}

interface UsageRowProps {
  label: string;
  sub: string;
  win: Win;
  now: number;
}

function UsageRow({ label, sub, win, now }: UsageRowProps): JSX.Element {
  const pct = clampPct(win.utilization);
  const tone = pct >= 90 ? 'crit' : pct >= 70 ? 'warn' : 'ok';
  const resetMs = win.resetsAt ? Date.parse(win.resetsAt) - now : NaN;
  return (
    <div className={`usage-row usage-${tone}`}>
      <div className="usage-row-line">
        <span className="usage-row-label">{label}</span>
        <span className="usage-row-pct">{pct.toFixed(0)}%</span>
      </div>
      <div className="usage-row-track">
        <span className="usage-row-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="usage-row-foot dim">
        <span>{sub}</span>
        {Number.isFinite(resetMs) && resetMs > 0
          ? <span>Resets in {fmtDuration(resetMs)}</span>
          : <span>Reset time unknown</span>}
      </div>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function fmtRelative(ms: number): string {
  if (ms < 60_000) return 'just now';
  return `${fmtDuration(ms)} ago`;
}
