import { useCallback, useEffect, useState } from 'react';

interface Props {
  sessionId: string;
}

interface PromptEntry {
  ts: number;
  text: string;
}

/**
 * Per-session list of prompts the user has sent the agent, read from
 * the agent's transcript file (Claude JSONL or Codex rollout) via the
 * `session.promptHistory` IPC verb. Click a row to copy the prompt to
 * the clipboard. Refreshes on `session.prompt_submitted`.
 *
 * Why we read the transcript rather than tracking ourselves: the
 * transcript is the source of truth, survives restarts, and works for
 * sessions that existed before this feature shipped. Shell sessions
 * have no transcript and show an empty state.
 */
export function HistoryPanel({ sessionId }: Props): JSX.Element {
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedTs, setCopiedTs] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await window.baton.call('session.promptHistory', { sessionId });
      setPrompts(res.prompts);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
    // Re-fetch when the agent reports a new prompt. The event is just
    // a ping — it carries no content because we re-read the transcript.
    const unsub = window.baton.onEvent((event) => {
      if (event.type !== 'session.prompt_submitted') return;
      if (event.sessionId !== sessionId) return;
      void load();
    });
    return () => { unsub(); };
  }, [sessionId, load]);

  async function copyPrompt(p: PromptEntry): Promise<void> {
    try {
      await navigator.clipboard.writeText(p.text);
      setCopiedTs(p.ts);
      // Reset the "Copied" affordance after a short beat so the row
      // returns to its normal label.
      window.setTimeout(() => {
        setCopiedTs((cur) => (cur === p.ts ? null : cur));
      }, 1200);
    } catch (err) {
      alert(`Copy failed: ${String(err)}`);
    }
  }

  if (error) {
    return <div className="empty"><p className="dim">{error}</p></div>;
  }
  if (prompts === null) {
    return <div className="empty"><p className="dim">Loading history…</p></div>;
  }
  if (prompts.length === 0) {
    return (
      <div className="empty">
        <p className="dim">
          No prompts yet. Anything you send the agent will show up here.
        </p>
      </div>
    );
  }

  // Newest first — the user is most likely to want their recent prompts.
  const ordered = [...prompts].reverse();
  return (
    <div className="history-list">
      {ordered.map((p) => (
        <button
          key={`${p.ts}-${p.text.slice(0, 16)}`}
          type="button"
          className="history-row"
          onClick={() => void copyPrompt(p)}
          title="Click to copy prompt"
        >
          <div className="history-row-head">
            <span className="history-ts">{formatTs(p.ts)}</span>
            <span className="history-copy-hint">
              {copiedTs === p.ts ? 'Copied' : 'Copy'}
            </span>
          </div>
          <div className="history-text">{previewText(p.text)}</div>
        </button>
      ))}
    </div>
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

/** Trim long prompts to a single-screen preview. Full text goes to the
 *  clipboard on click, so collapsing here is purely visual. */
const PREVIEW_CHARS = 240;
function previewText(text: string): string {
  // Collapse runs of whitespace so multi-line prompts don't blow up the
  // row height in the list; the full text still copies verbatim.
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_CHARS
    ? flat.slice(0, PREVIEW_CHARS) + '…'
    : flat;
}
