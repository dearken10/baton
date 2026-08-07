/**
 * MaestroSuggestionCard — variant A from
 * design/mockup-maestro-inline-suggestion.html. Mounted at the bottom
 * of the middle-column terminal slot, above the xterm host. Renders
 * only when the current session has a pending Maestro suggestion.
 *
 * Data flow:
 *   1. Main fires option4's per-session proposer when the session
 *      transitions to idle/needs-input/done (see maestroSuggestion.ts).
 *   2. Main pushes `maestro.suggestion.updated` — the store slice
 *      `maestroSuggestions[sessionId]` gets the new proposal (or null).
 *   3. This component reads the slice for its session id and shows an
 *      editable card. Send → `maestro.acceptSuggestion` writes the
 *      final prompt into the PTY. Dismiss → `maestro.dismissSuggestion`.
 *      Regenerate → `maestro.regenerateSuggestion`.
 *
 * Boot: on mount we also pull `maestro.getSuggestion` so a suggestion
 * that landed while this session's tab was hidden shows up when the
 * user switches back.
 */

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../store.js';
import type { MaestroSuggestion } from '@shared/ipc.js';

interface Props {
  sessionId: string;
}

export function MaestroSuggestionCard({ sessionId }: Props): JSX.Element | null {
  const suggestion = useAppStore(
    (s) => s.maestroSuggestions[sessionId] ?? null,
  );

  // Draft — starts from the proposer's prompt, decouples from the
  // store so the user can edit freely. Resets whenever a new
  // suggestion lands (identified by proposedAt so re-edits of the
  // same object don't reset the draft mid-typing).
  const [draft, setDraft] = useState('');
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (suggestion && suggestion.proposedAt !== lastAt) {
      setDraft(suggestion.prompt);
      setLastAt(suggestion.proposedAt);
      setError(null);
    }
    if (!suggestion) {
      setLastAt(null);
    }
  }, [suggestion, lastAt]);

  // Cold-start pull — if the session already had a suggestion when
  // we mounted (main pushed the event before this component existed),
  // fetch it explicitly so the card populates immediately.
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
      if (!r.ok) {
        setError(r.reason ?? 'Send failed');
      }
      // On success main clears its state and emits an update — the
      // subscription flips this component off, no local state work.
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

  const regenerate = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const r = await window.baton.call('maestro.regenerateSuggestion', {
        sessionId,
      });
      if (!r.ok) setError(r.reason ?? 'Regenerate failed');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [sessionId]);

  if (!suggestion) return null;

  // `wait` / `defer` proposals render a passive card — Maestro ran and
  // has an opinion (the rationale) but chose not to propose a concrete
  // prompt (usually because the last agent turn ended with an open
  // question the user genuinely has to answer). No editor, no Send;
  // just the reasoning plus Regenerate (in case the state changed) +
  // Dismiss.
  if (suggestion.kind !== 'resume') {
    return (
      <div className="mae-card mae-card-passive" role="region" aria-label="Maestro waiting">
        <div className="mae-card-head">
          <span className="mae-glyph" aria-hidden>🎼</span>
          <span className="mae-title">
            Maestro is {suggestion.kind === 'defer' ? 'deferring' : 'waiting for you'}
          </span>
          <span className="mae-conf" title={`Confidence: ${suggestion.confidence.toFixed(2)}`}>
            {fmtConfidence(suggestion.confidence)}
          </span>
          <span className="mae-card-spacer" />
          <button
            type="button"
            className="mae-btn ghost"
            onClick={() => void regenerate()}
            disabled={busy}
            title="Ask Maestro to re-evaluate — useful if the transcript has changed"
          >
            ↻ Regenerate
          </button>
          <button
            type="button"
            className="mae-btn ghost"
            onClick={() => void dismiss()}
            disabled={busy}
            title="Dismiss the suggestion"
          >
            ✕ Dismiss
          </button>
        </div>
        <SuggestionRationale suggestion={suggestion} />
        {error ? <div className="mae-error" style={{ marginTop: 6 }}>{error}</div> : null}
      </div>
    );
  }

  return (
    <div className="mae-card" role="region" aria-label="Maestro suggestion">
      <div className="mae-card-head">
        <span className="mae-glyph" aria-hidden>🎼</span>
        <span className="mae-title">Maestro suggests</span>
        <span className="mae-conf" title={`Confidence: ${suggestion.confidence.toFixed(2)}`}>
          {fmtConfidence(suggestion.confidence)}
        </span>
        <span className="mae-card-spacer" />
        <button
          type="button"
          className="mae-btn ghost"
          onClick={() => void regenerate()}
          disabled={busy}
          title="Ask Maestro for a different suggestion"
        >
          ↻ Regenerate
        </button>
        <button
          type="button"
          className="mae-btn ghost"
          onClick={() => void dismiss()}
          disabled={busy}
          title="Dismiss the suggestion without sending"
        >
          ✕ Dismiss
        </button>
      </div>
      <textarea
        className="mae-editor mono"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // ⌘/Ctrl+Enter sends — matches the terminal's own submit
          // vocabulary and lets the user commit without reaching for
          // the mouse.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
          // Esc dismisses when the editor is empty; otherwise it
          // just blurs, matching how form controls usually behave.
          if (e.key === 'Escape' && draft.length === 0) {
            e.preventDefault();
            void dismiss();
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
        <SuggestionRationale suggestion={suggestion} />
        {error ? <span className="mae-error">{error}</span> : null}
        <span className="mae-card-spacer" />
        <button
          type="button"
          className="mae-btn"
          onClick={() => setDraft(suggestion.prompt)}
          disabled={busy || draft === suggestion.prompt}
          title="Revert to the original suggestion body"
        >
          Reset
        </button>
        <button
          type="button"
          className="mae-btn primary"
          onClick={() => void send()}
          disabled={busy || draft.trim().length === 0}
          title="Send this prompt into the terminal (⌘↵)"
        >
          {busy ? 'Sending…' : 'Send ↵'}
        </button>
      </div>
    </div>
  );
}

/** Compact "why this?" text — the rationale is the main signal; the
 *  assumption + if-wrong are shown on hover via title. */
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

/** Confidence buckets — matches the proposer's bucket→number mapping
 *  (0.85 high / 0.60 medium / 0.35 low) so the label doesn't lie when
 *  the proposer sent a bucketed value. */
function fmtConfidence(c: number): string {
  if (c >= 0.75) return 'high confidence';
  if (c >= 0.50) return 'medium confidence';
  return 'low confidence';
}
