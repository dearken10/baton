import { useEffect, useMemo, useState } from 'react';
import { formatTokens } from '../lib/format.js';

/**
 * Nimbalyst-style plan-usage indicator. Two compact bars labelled
 * "5h" and "7d", each filled with the fraction of the configured
 * plan limit that has been spent in that rolling window (PRD F11.3).
 *
 * v1 ships a small set of preset plans (Pro / Max 5x / Max 20x) and
 * picks Pro by default. The user can switch via the menu on the chip
 * — the choice persists in localStorage. A full Settings page comes
 * later.
 */

interface Stats {
  fiveH: { tokensIn: number; tokensOut: number };
  sevenD: { tokensIn: number; tokensOut: number };
}

interface Plan {
  id: string;
  label: string;
  /** Approximate token budget per rolling 5-hour window. */
  fiveHLimit: number;
  /** Approximate token budget per rolling 7-day window. */
  sevenDLimit: number;
}

const PLANS: Plan[] = [
  { id: 'pro',    label: 'Pro',     fiveHLimit:   5_000_000, sevenDLimit:  35_000_000 },
  { id: 'max5',   label: 'Max 5×',  fiveHLimit:  25_000_000, sevenDLimit: 175_000_000 },
  { id: 'max20',  label: 'Max 20×', fiveHLimit: 100_000_000, sevenDLimit: 700_000_000 },
];

const PLAN_LS_KEY = 'code24:plan';
const REFRESH_MS = 30_000;

function loadPlanId(): string {
  try {
    const v = localStorage.getItem(PLAN_LS_KEY);
    if (v && PLANS.some((p) => p.id === v)) return v;
  } catch { /* ignore */ }
  return 'pro';
}

export function UsageBars(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const [planId, setPlanId] = useState<string>(() => loadPlanId());
  const [menuOpen, setMenuOpen] = useState(false);

  const plan = useMemo(() => PLANS.find((p) => p.id === planId) ?? PLANS[0]!, [planId]);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const s = await window.code24.call('usage.getStats', {});
        if (!cancelled) setStats(s);
      } catch { /* leave previous reading */ }
    }
    void tick();
    const id = window.setInterval(() => { void tick(); }, REFRESH_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (!(e.target as Element).closest('.usage-wrapper')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function pickPlan(id: string): void {
    setPlanId(id);
    try { localStorage.setItem(PLAN_LS_KEY, id); } catch { /* ignore */ }
    setMenuOpen(false);
  }

  if (!stats) return <div className="usage-wrapper usage-loading">…</div>;

  const fiveH = stats.fiveH.tokensIn + stats.fiveH.tokensOut;
  const sevenD = stats.sevenD.tokensIn + stats.sevenD.tokensOut;
  const fiveHPct  = Math.min(100, (fiveH  / plan.fiveHLimit ) * 100);
  const sevenDPct = Math.min(100, (sevenD / plan.sevenDLimit) * 100);

  return (
    <div className="usage-wrapper">
      <button
        type="button"
        className="usage-plan"
        onClick={() => setMenuOpen((v) => !v)}
        title={`${plan.label} plan — click to change`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
      >
        {plan.label} ▾
      </button>
      <UsageBar
        label="5h"
        used={fiveH}
        limit={plan.fiveHLimit}
        pct={fiveHPct}
      />
      <UsageBar
        label="7d"
        used={sevenD}
        limit={plan.sevenDLimit}
        pct={sevenDPct}
      />
      {menuOpen ? (
        <div className="usage-menu" role="menu">
          {PLANS.map((p) => (
            <button
              key={p.id}
              className={`usage-menu-item ${p.id === planId ? 'selected' : ''}`}
              role="menuitemradio"
              aria-checked={p.id === planId}
              onClick={() => pickPlan(p.id)}
            >
              <span>{p.label}</span>
              <span className="dim mono">
                {formatTokens(p.fiveHLimit)}/5h · {formatTokens(p.sevenDLimit)}/7d
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface BarProps {
  label: string;
  used: number;
  limit: number;
  pct: number;
}

function UsageBar({ label, used, limit, pct }: BarProps): JSX.Element {
  // Bucket the colour so the user can read severity at a glance.
  const tone =
    pct >= 90 ? 'crit' :
    pct >= 70 ? 'warn' :
    'ok';
  return (
    <div
      className={`usage-bar usage-${tone}`}
      title={`${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct.toFixed(1)}%)`}
    >
      <span className="usage-bar-label">{label}</span>
      <span className="usage-bar-track">
        <span className="usage-bar-fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="usage-bar-pct">{pct.toFixed(0)}%</span>
    </div>
  );
}
