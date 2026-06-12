/**
 * Tab-id encoding for the editor pane's tab strip.
 *
 * Extracted from EditorPane so that other components (GitPanel,
 * TerminalPane, fileOps) can construct tab ids WITHOUT statically
 * importing EditorPane — which pulls all of Monaco into the main bundle.
 * Keeping these here lets EditorPane (and Monaco) be lazy-loaded.
 *
 * Three tab kinds coexist with normal edit tabs for the same path,
 * distinguished by a URI-ish prefix:
 *   diff://     — a diff view of a file
 *   browser://  — an <iframe srcdoc> render of an HTML file's contents
 *   weburl://   — a navigable <iframe src=URL> (links clicked in a terminal)
 */

const DIFF_TAB_PREFIX = 'diff://';
const BROWSER_TAB_PREFIX = 'browser://';
const WEBURL_TAB_PREFIX = 'weburl://';

export function diffTabId(absPath: string): string { return `${DIFF_TAB_PREFIX}${absPath}`; }
export function browserTabId(absPath: string): string { return `${BROWSER_TAB_PREFIX}${absPath}`; }
export function webUrlTabId(url: string): string { return `${WEBURL_TAB_PREFIX}${url}`; }

export function isDiffTab(id: string): boolean { return id.startsWith(DIFF_TAB_PREFIX); }
export function isBrowserTab(id: string): boolean { return id.startsWith(BROWSER_TAB_PREFIX); }
export function isWebUrlTab(id: string): boolean { return id.startsWith(WEBURL_TAB_PREFIX); }

/** Strip whichever prefix a tab id carries, yielding the underlying
 *  path or URL. Plain edit tabs (no prefix) pass through unchanged. */
export function pathOf(id: string): string {
  if (isDiffTab(id)) return id.slice(DIFF_TAB_PREFIX.length);
  if (isBrowserTab(id)) return id.slice(BROWSER_TAB_PREFIX.length);
  if (isWebUrlTab(id)) return id.slice(WEBURL_TAB_PREFIX.length);
  return id;
}

/** Short label for a URL tab — "localhost:5180" instead of the full
 *  href — so the tab doesn't blow up the strip. Falls back to the raw
 *  string if URL parsing fails. */
export function labelForUrl(url: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${tail}`;
  } catch {
    return url;
  }
}
