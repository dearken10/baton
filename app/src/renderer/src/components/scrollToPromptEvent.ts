/**
 * Cross-pane signal: HistoryPanel asks TerminalPane to scroll the
 * terminal's scrollback to a specific prompt. We use a plain
 * window.CustomEvent rather than a shared Zustand action because the
 * signal is one-shot and fire-and-forget — no state machine, no
 * lingering value to clear.
 *
 * Filtered by sessionId so multiple terminal panes (live siblings,
 * hidden via display:none) ignore each other's scroll requests.
 */

export const SCROLL_TO_PROMPT_EVENT = 'baton:scrollToPrompt';

export interface ScrollToPromptDetail {
  sessionId: string;
  /** Snippet to search for in the terminal scrollback. Should be short
   *  enough to fit on a single rendered line (long prompts get wrapped
   *  by Claude's TUI and won't match in full). */
  snippet: string;
}

export function dispatchScrollToPrompt(detail: ScrollToPromptDetail): void {
  window.dispatchEvent(new CustomEvent(SCROLL_TO_PROMPT_EVENT, { detail }));
}
