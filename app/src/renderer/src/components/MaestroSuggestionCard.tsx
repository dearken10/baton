/**
 * MaestroSuggestionCard — variant A from
 * design/mockup-maestro-inline-suggestion.html, evolved into an
 * always-visible collapsible dock at the bottom of the middle-column
 * terminal slot.
 *
 * States (single component, one dock, four content modes):
 *   idle       — no suggestion yet; body shows a hint + "Suggest"
 *                button so the user can generate one on demand
 *                (doesn't need the session to have hit any event)
 *   thinking   — the user just hit Suggest and we're waiting for the
 *                proposer to land; body shows a shimmer + a note
 *   resume     — proposer produced a concrete next prompt; body shows
 *                the editor + Send / Reset / Regenerate / Dismiss
 *   wait/defer — proposer chose not to propose; body shows the
 *                rationale + Regenerate / Dismiss
 *
 * Header is always visible. Collapsed hides the body but leaves the
 * header + Suggest / expand button visible so the user can trigger
 * regeneration from a minimal footprint. Collapsed state is persisted
 * globally (one preference, not per-session).
 *
 * Data flow:
 *   1. Main fires option5's PM proposer either on a session status
 *      transition (running → idle/…) OR when the user clicks Suggest
 *      (via maestro.regenerateSuggestion). See maestroSuggestion.ts.
 *   2. Main pushes maestro.suggestion.updated — the store slice
 *      maestroSuggestions[sessionId] gets the new proposal or null.
 *   3. This component reads the slice for its session id and renders.
 *      Send → maestro.acceptSuggestion writes the final prompt into
 *      the PTY. Dismiss → maestro.dismissSuggestion. Regenerate /
 *      Suggest → maestro.regenerateSuggestion.
 *
 * Boot: on mount we also pull maestro.getSuggestion so a suggestion
 * that landed while this session's tab was hidden shows up when the
 * user switches back.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import type { MaestroMode, MaestroSuggestion } from '@shared/ipc.js';

interface Props {
  sessionId: string;
}

/** localStorage key for the global collapsed preference. */
const LS_KEY_COLLAPSED = 'baton:maestro-card:collapsed';

/** Backstop timeout for the "thinking" state — a proposer that's
 *  stuck (or died silently) shouldn't leave the button disabled
 *  forever. 3 min matches PROPOSER_TIMEOUT_MS on the main side. */
const THINKING_TIMEOUT_MS = 180_000;

function loadCollapsed(): boolean {
  try { return localStorage.getItem(LS_KEY_COLLAPSED) === 'true'; }
  catch { return false; }
}
function saveCollapsed(v: boolean): void {
  try { localStorage.setItem(LS_KEY_COLLAPSED, v ? 'true' : 'false'); }
  catch { /* best-effort */ }
}

export function MaestroSuggestionCard({ sessionId }: Props): JSX.Element {
  const suggestion = useAppStore(
    (s) => s.maestroSuggestions[sessionId] ?? null,
  );

  // Two independent flags, both tri-state (session override → project
  // default → hard default):
  //   show  — dock visibility. When effective show is false we return
  //           null below and the dock renders nothing.
  //   mode  — auto-fire mode. Header exposes a picker; the actual
  //           gating lives in main/services/maestroSuggestion.ts.
  const showOverride = useAppStore(
    (s) => s.sessions[sessionId]?.maestroShow ?? null,
  );
  const projectShow = useAppStore((s) => {
    const sess = s.sessions[sessionId];
    if (!sess) return true;
    return s.projects[sess.projectId]?.maestroShow ?? true;
  });
  const effectiveShow = showOverride ?? projectShow;
  const modeOverride = useAppStore(
    (s) => s.sessions[sessionId]?.maestroMode ?? null,
  );
  const projectMode = useAppStore((s) => {
    const sess = s.sessions[sessionId];
    if (!sess) return 'suggest' as MaestroMode;
    return s.projects[sess.projectId]?.maestroMode ?? ('suggest' as MaestroMode);
  });

  // Draft — starts from the proposer's prompt, decouples from the
  // store so the user can edit freely. Resets whenever a new
  // suggestion lands (identified by proposedAt so re-edits of the
  // same object don't reset the draft mid-typing).
  const [draft, setDraft] = useState('');
  const [lastAt, setLastAt] = useState<number | null>(null);

  // Short-lived (send/dismiss IPC) vs. long-lived (waiting for the
  // proposer to return). Split so the Send button can be re-enabled
  // between long-running proposer calls, and vice versa.
  const [busy, setBusy] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);
  const toggleCollapsed = useCallback((): void => {
    setCollapsed((c) => {
      const next = !c;
      saveCollapsed(next);
      return next;
    });
  }, []);

  // Backstop for `proposing` — if the proposer never fires an update
  // (silent failure), auto-clear so the user isn't stuck.
  const thinkingTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!proposing) {
      if (thinkingTimerRef.current != null) {
        window.clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
      return;
    }
    thinkingTimerRef.current = window.setTimeout(() => {
      setProposing(false);
      setError((prev) => prev ?? 'Proposer timed out — try Suggest again.');
    }, THINKING_TIMEOUT_MS);
    return () => {
      if (thinkingTimerRef.current != null) {
        window.clearTimeout(thinkingTimerRef.current);
        thinkingTimerRef.current = null;
      }
    };
  }, [proposing]);

  // Any store update for this session's suggestion clears the
  // thinking flag — the proposer landed (or something else did).
  useEffect(() => {
    setProposing(false);
    if (suggestion && suggestion.proposedAt !== lastAt) {
      setDraft(suggestion.prompt);
      setLastAt(suggestion.proposedAt);
      setError(null);
    }
    if (!suggestion) {
      setLastAt(null);
    }
    // Only track suggestion identity for the effect trigger — lastAt
    // is stateful and updated inside, deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestion]);

  // Cold-start pull — a suggestion may have landed for this session
  // while its tab was hidden.
  useEffect(() => {
    let cancelled = false;
    void window.baton
      .call('maestro.getSuggestion', { sessionId })
      .then((r) => {
        if (cancelled || !r.suggestion) return;
        useAppStore.setState((s) => {
          s.maestroSuggestions[sessionId] = r.suggestion;
        });
      })
      .catch(() => { /* fine — event will land eventually */ });
    return () => { cancelled = true; };
  }, [sessionId]);

  const send = useCallback(async (): Promise<void> => {
    const prompt = draft.trim();
    if (prompt.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const r = await window.baton.call('maestro.acceptSuggestion', {
        sessionId,
        prompt,
      });
      if (!r.ok) setError(r.reason ?? 'Send failed');
      // On success main clears its state and emits an update.
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId, draft]);

  const dismiss = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.baton.call('maestro.dismissSuggestion', { sessionId });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  const suggest = useCallback(async (): Promise<void> => {
    setError(null);
    setProposing(true);
    try {
      const r = await window.baton.call('maestro.regenerateSuggestion', {
        sessionId,
      });
      if (!r.ok) {
        setProposing(false);
        setError(r.reason ?? 'Could not start the proposer.');
      }
      // On success we stay in `proposing` until the update event
      // lands (or the timeout backstop fires).
    } catch (e) {
      setProposing(false);
      setError(String(e));
    }
  }, [sessionId]);

  const state: DockState = proposing
    ? 'thinking'
    : suggestion?.kind === 'resume'
      ? 'resume'
      : suggestion?.kind === 'wait'
        ? 'wait'
        : suggestion?.kind === 'defer'
          ? 'defer'
          : 'idle';

  const canSuggest = !proposing && !busy;

  const setMode = useCallback(async (value: MaestroMode | null): Promise<void> => {
    try {
      await window.baton.call('session.setMaestroMode', {
        sessionId,
        mode: value,
      });
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  // show=false → render nothing. Un-hiding lives in the sidebar's
  // session row menu (or the project ⋮ menu for the project-wide
  // default) so a hidden dock still has a discoverable way back.
  if (!effectiveShow) return <></>;

  return (
    <div
      className={`mae-dock mae-dock-${state}${collapsed ? ' is-collapsed' : ''}`}
      role="region"
      aria-label="Maestro suggestion dock"
    >
      <DockHeader
        state={state}
        suggestion={suggestion}
        collapsed={collapsed}
        canSuggest={canSuggest}
        modeOverride={modeOverride}
        projectMode={projectMode}
        onSetMode={(v) => void setMode(v)}
        onSuggest={() => void suggest()}
        onToggleCollapsed={toggleCollapsed}
      />
      {!collapsed && (
        <DockBody
          state={state}
          suggestion={suggestion}
          draft={draft}
          setDraft={setDraft}
          busy={busy}
          error={error}
          onSend={() => void send()}
          onDismiss={() => void dismiss()}
          onReset={() => setDraft(suggestion?.prompt ?? '')}
        />
      )}
    </div>
  );
}

type DockState = 'idle' | 'thinking' | 'resume' | 'wait' | 'defer';

function DockHeader({
  state,
  suggestion,
  collapsed,
  canSuggest,
  modeOverride,
  projectMode,
  onSetMode,
  onSuggest,
  onToggleCollapsed,
}: {
  state: DockState;
  suggestion: MaestroSuggestion | null;
  collapsed: boolean;
  canSuggest: boolean;
  modeOverride: MaestroMode | null;
  projectMode: MaestroMode;
  onSetMode: (v: MaestroMode | null) => void;
  onSuggest: () => void;
  onToggleCollapsed: () => void;
}): JSX.Element {
  const modeValue: 'project' | MaestroMode = modeOverride ?? 'project';
  return (
    <div className="mae-dock-head">
      <span className="mae-glyph" aria-hidden>🎼</span>
      <span className="mae-title">{titleFor(state)}</span>
      {suggestion && state !== 'idle' && state !== 'thinking' ? (
        <span
          className="mae-conf"
          title={`Confidence: ${suggestion.confidence.toFixed(2)}`}
        >
          {fmtConfidence(suggestion.confidence)}
        </span>
      ) : null}
      <span className="mae-card-spacer" />
      <label
        className="mae-auto-toggle"
        title={
          modeValue === 'project'
            ? `Mode — follow project (currently ${projectMode})`
            : modeValue === 'suggest'
              ? 'Mode — auto-fire on idle, then wait for you to review + Send'
              : modeValue === 'execute'
                ? 'Mode — auto-fire on idle AND auto-send the prompt (no review)'
                : 'Mode — never auto-fire; only the Suggest button fires the PM'
        }
      >
        <span className="mae-auto-label">Mode</span>
        <select
          className="mae-auto-select"
          value={modeValue}
          aria-label="Maestro auto-fire mode for this session"
          onChange={(e) => {
            const v = e.target.value as 'project' | MaestroMode;
            onSetMode(v === 'project' ? null : v);
          }}
        >
          <option value="project">Project default ({projectMode})</option>
          <option value="suggest">Suggest</option>
          <option value="execute">Execute</option>
          <option value="manual">Manual</option>
        </select>
      </label>
      <button
        type="button"
        className="mae-btn"
        onClick={onSuggest}
        disabled={!canSuggest}
        title="Ask the PM to propose a next instruction for this session"
      >
        {state === 'thinking' ? 'Thinking…' : suggestion ? '↻ Suggest' : '✨ Suggest prompt'}
      </button>
      <button
        type="button"
        className="mae-btn ghost mae-collapse-btn"
        onClick={onToggleCollapsed}
        title={collapsed ? 'Expand Maestro dock' : 'Collapse Maestro dock'}
        aria-expanded={!collapsed}
      >
        {collapsed ? '▲' : '▼'}
      </button>
    </div>
  );
}

function DockBody({
  state,
  suggestion,
  draft,
  setDraft,
  busy,
  error,
  onSend,
  onDismiss,
  onReset,
}: {
  state: DockState;
  suggestion: MaestroSuggestion | null;
  draft: string;
  setDraft: (v: string) => void;
  busy: boolean;
  error: string | null;
  onSend: () => void;
  onDismiss: () => void;
  onReset: () => void;
}): JSX.Element {
  if (state === 'idle') {
    return (
      <div className="mae-dock-body mae-dock-body-idle">
        <p className="mae-hint">
          Maestro will suggest a next instruction the moment this session goes
          idle. You can also hit <strong>Suggest prompt</strong> above to ask now.
        </p>
        {error ? <div className="mae-error">{error}</div> : null}
      </div>
    );
  }
  if (state === 'thinking') {
    return (
      <div className="mae-dock-body mae-dock-body-thinking">
        <p className="mae-hint">
          <span className="mae-spinner" aria-hidden /> The PM is reading the session
          and drafting a next instruction. This takes 20–60 s.
        </p>
        {error ? <div className="mae-error">{error}</div> : null}
      </div>
    );
  }
  if (state !== 'resume') {
    // wait / defer — passive card
    return (
      <div className="mae-dock-body">
        <SuggestionRationale suggestion={suggestion!} />
        <div className="mae-card-actions">
          <span className="mae-card-spacer" />
          <button
            type="button"
            className="mae-btn ghost"
            onClick={onDismiss}
            disabled={busy}
            title="Dismiss the suggestion"
          >
            ✕ Dismiss
          </button>
        </div>
        {error ? <div className="mae-error">{error}</div> : null}
      </div>
    );
  }
  // resume — editable card
  return (
    <div className="mae-dock-body">
      <textarea
        className="mae-editor mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onSend();
          }
          if (e.key === 'Escape' && draft.length === 0) {
            e.preventDefault();
            onDismiss();
          }
        }}
        rows={3}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        disabled={busy}
        aria-label="Edit the suggested prompt before sending"
      />
      <div className="mae-card-actions">
        <SuggestionRationale suggestion={suggestion!} />
        {error ? <span className="mae-error">{error}</span> : null}
        <span className="mae-card-spacer" />
        <button
          type="button"
          className="mae-btn"
          onClick={onReset}
          disabled={busy || draft === (suggestion?.prompt ?? '')}
          title="Revert to the original suggestion body"
        >
          Reset
        </button>
        <button
          type="button"
          className="mae-btn ghost"
          onClick={onDismiss}
          disabled={busy}
          title="Dismiss without sending"
        >
          ✕ Dismiss
        </button>
        <button
          type="button"
          className="mae-btn primary"
          onClick={onSend}
          disabled={busy || draft.trim().length === 0}
          title="Send this prompt into the terminal (⌘↵)"
        >
          {busy ? 'Sending…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}

function SuggestionRationale({
  suggestion,
}: { suggestion: MaestroSuggestion }): JSX.Element | null {
  const parts: string[] = [];
  if (suggestion.assumption) parts.push(`Assumption: ${suggestion.assumption}`);
  if (suggestion.ifWrong)   parts.push(`If wrong: ${suggestion.ifWrong}`);
  const title = parts.join('\n\n');
  return (
    <span className="mae-rationale" title={title || undefined}>
      {suggestion.rationale ?? 'Suggested from the last agent turn.'}
    </span>
  );
}

function titleFor(state: DockState): string {
  switch (state) {
    case 'idle':     return 'Maestro';
    case 'thinking': return 'Maestro is thinking';
    case 'resume':   return 'Maestro suggests';
    case 'wait':     return 'Maestro is waiting for you';
    case 'defer':    return 'Maestro is deferring';
  }
}

/** Confidence buckets — matches the proposer's bucket→number mapping
 *  (0.85 high / 0.60 medium / 0.35 low) so the label doesn't lie when
 *  the proposer sent a bucketed value. */
function fmtConfidence(c: number): string {
  if (c >= 0.75) return 'high confidence';
  if (c >= 0.50) return 'medium confidence';
  return 'low confidence';
}
