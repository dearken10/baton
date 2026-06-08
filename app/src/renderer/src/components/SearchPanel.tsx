import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppStore } from '../store.js';
import type { ResponseOf } from '@shared/ipc.js';

interface Props {
  sessionId: string;
  worktreePath: string;
}

type SearchResponse = ResponseOf<'worktree.search'>;
type Match = SearchResponse['matches'][number];

const DEBOUNCE_MS = 250;
const LS_KEY = 'baton:search:opts';

interface PersistedOpts {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeGlob: string;
  excludeGlob: string;
}

function loadOpts(): PersistedOpts {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<PersistedOpts>;
    return { ...DEFAULTS, ...parsed };
  } catch { return DEFAULTS; }
}
const DEFAULTS: PersistedOpts = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includeGlob: '',
  excludeGlob: '',
};

export function SearchPanel({ sessionId, worktreePath }: Props): JSX.Element {
  const openFile = useAppStore((s) => s.openFile);
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState<PersistedOpts>(loadOpts);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const reqIdRef = useRef(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Persist toggles + globs so they survive reloads.
  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(opts)); } catch { /* ignore */ }
  }, [opts]);

  // Focus the search box when the panel mounts.
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Debounced live search. Empty query clears the result.
  useEffect(() => {
    if (query.trim().length === 0) {
      setResult(null);
      setBusy(false);
      return;
    }
    const t = window.setTimeout(() => { void run(); }, DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, opts, sessionId]);

  const run = useCallback(async (): Promise<void> => {
    const myReq = ++reqIdRef.current;
    setBusy(true);
    try {
      const res = await window.baton.call('worktree.search', {
        sessionId,
        query,
        caseSensitive: opts.caseSensitive,
        wholeWord: opts.wholeWord,
        regex: opts.regex,
        includeGlob: opts.includeGlob,
        excludeGlob: opts.excludeGlob,
      });
      // Drop stale responses if the user typed more while we were
      // waiting on the previous IPC.
      if (reqIdRef.current !== myReq) return;
      setResult(res);
    } catch (err) {
      if (reqIdRef.current === myReq) {
        setResult({ matches: [], truncated: false, error: String(err) });
      }
    } finally {
      if (reqIdRef.current === myReq) setBusy(false);
    }
  }, [sessionId, query, opts]);

  // Group flat matches by file for the list rendering.
  const grouped = useMemo(() => {
    const m = new Map<string, Match[]>();
    if (!result) return m;
    for (const match of result.matches) {
      const arr = m.get(match.file) ?? [];
      arr.push(match);
      m.set(match.file, arr);
    }
    return m;
  }, [result]);

  function toggleFile(file: string): void {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(file)) next.delete(file); else next.add(file);
      return next;
    });
  }

  function jumpTo(m: Match): void {
    const abs = `${worktreePath}/${m.file}`;
    openFile(abs, 'preview', { line: m.line, col: m.col });
  }

  const matchCount = result?.matches.length ?? 0;
  const fileCount = grouped.size;

  return (
    <div className="search-panel">
      <div className="search-head">
        <div className="search-input-row">
          <input
            ref={inputRef}
            className="search-input"
            type="text"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <button
            type="button"
            className={`search-toggle ${opts.caseSensitive ? 'on' : ''}`}
            onClick={() => setOpts((o) => ({ ...o, caseSensitive: !o.caseSensitive }))}
            title="Match case (Aa)"
            aria-pressed={opts.caseSensitive}
          >Aa</button>
          <button
            type="button"
            className={`search-toggle ${opts.wholeWord ? 'on' : ''}`}
            onClick={() => setOpts((o) => ({ ...o, wholeWord: !o.wholeWord }))}
            title="Match whole word"
            aria-pressed={opts.wholeWord}
          >ab</button>
          <button
            type="button"
            className={`search-toggle ${opts.regex ? 'on' : ''}`}
            onClick={() => setOpts((o) => ({ ...o, regex: !o.regex }))}
            title="Use regular expression"
            aria-pressed={opts.regex}
          >.*</button>
        </div>
        <details className="search-globs">
          <summary>files to include / exclude</summary>
          <label className="search-glob-row">
            <span>include</span>
            <input
              type="text"
              placeholder="e.g. *.ts, src/**"
              value={opts.includeGlob}
              onChange={(e) => setOpts((o) => ({ ...o, includeGlob: e.target.value }))}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
          <label className="search-glob-row">
            <span>exclude</span>
            <input
              type="text"
              placeholder="e.g. *.test.ts, dist/**"
              value={opts.excludeGlob}
              onChange={(e) => setOpts((o) => ({ ...o, excludeGlob: e.target.value }))}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </details>
        <div className="search-summary dim">
          {result?.error ? (
            <span className="search-err">{result.error}</span>
          ) : busy ? (
            'Searching…'
          ) : !result || query.trim().length === 0 ? (
            'Type to search this worktree'
          ) : matchCount === 0 ? (
            'No matches'
          ) : (
            <>
              {matchCount} match{matchCount === 1 ? '' : 'es'} in {fileCount} file{fileCount === 1 ? '' : 's'}
              {result.truncated ? ' (truncated)' : ''}
            </>
          )}
        </div>
      </div>
      <div className="search-results">
        {[...grouped.entries()].map(([file, fileMatches]) => {
          const collapsed = collapsedFiles.has(file);
          return (
            <div key={file} className="search-file-group">
              <button
                type="button"
                className="search-file-row"
                onClick={() => toggleFile(file)}
                title={file}
              >
                <span className="tree-caret">{collapsed ? '▸' : '▾'}</span>
                <span className="search-file-icon">📄</span>
                <span className="search-file-name">{basename(file)}</span>
                <span className="search-file-dir dim">{dirname(file)}</span>
                <span className="search-file-count dim">{fileMatches.length}</span>
              </button>
              {!collapsed ? fileMatches.map((m, i) => (
                <button
                  key={`${m.line}:${m.col}:${i}`}
                  type="button"
                  className="search-match-row"
                  onClick={() => jumpTo(m)}
                  title={`${file}:${m.line}:${m.col}`}
                >
                  <span className="search-match-line dim">{m.line}</span>
                  <span className="search-match-text">
                    {renderMatchLine(m, query, opts.regex)}
                  </span>
                </button>
              )) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

/** Highlight the matched portion of a line. For fixed-string search we
 *  know the match length; for regex we re-run the pattern client-side
 *  to find the extent. Best-effort — on regex syntax errors we just
 *  show the raw line. */
function renderMatchLine(m: Match, query: string, regex: boolean): JSX.Element {
  const text = m.lineText;
  const start = Math.max(0, m.col - 1);
  let end = start + m.matchLen;
  if (regex) {
    try {
      const re = new RegExp(query);
      const sub = text.slice(start);
      const matched = re.exec(sub);
      if (matched && matched[0].length > 0) end = start + matched[0].length;
    } catch { /* invalid pattern — leave end as start */ }
  }
  if (end <= start || end > text.length) {
    return <span>{trimLeading(text)}</span>;
  }
  // Compute leading whitespace trim so the match isn't pushed offscreen
  // by deep indentation.
  const trimAmount = text.length - text.trimStart().length;
  const left = Math.min(start, trimAmount);
  return (
    <>
      <span>{text.slice(left, start)}</span>
      <mark className="search-match-mark">{text.slice(start, end)}</mark>
      <span>{text.slice(end)}</span>
    </>
  );
}
function trimLeading(s: string): string {
  return s.replace(/^\s+/, '');
}
