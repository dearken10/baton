import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { DiffEditor, type OnMount, loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import { marked } from 'marked';
import '../lib/monacoWorkers.js';
import { JsonTreeView } from './JsonTreeView.js';
import {
  isDiffTab, isBrowserTab, isWebUrlTab, pathOf, labelForUrl,
} from './tabIds.js';
import {
  useAppStore,
  selectOpenFiles,
  selectActiveFilePath,
  selectPreviewFilePath,
} from '../store.js';
import { useTheme } from '../lib/theme.js';

const MARKDOWN_EXTS = new Set(['md', 'markdown', 'mdx']);
function isMarkdown(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  return MARKDOWN_EXTS.has(ext);
}

const JSON_EXTS = new Set(['json', 'jsonc']);
function isJson(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  return JSON_EXTS.has(ext);
}

/** Does this file have a non-source preview mode? Drives whether we
 *  show the Source ⇄ Preview toggle and default to preview-on-open. */
function hasPreviewMode(absPath: string): boolean {
  return isMarkdown(absPath) || isJson(absPath);
}

/** Label for the toggle button — type-specific. */
function previewModeLabel(absPath: string, mode: 'source' | 'rendered'): string {
  if (mode === 'rendered') return 'Source';
  if (isJson(absPath)) return 'Tree';
  return 'Preview';
}

// Configure marked once for the whole renderer. GFM tables + line
// breaks match the rendering most users have seen in GitHub READMEs.
marked.setOptions({ gfm: true, breaks: false });

// Use the locally-bundled monaco — no CDN, offline-capable.
loader.config({ monaco });

/** Pick a Monaco language id from the file extension. */
function languageFor(absPath: string): string {
  const lower = absPath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return 'typescript';
    case 'tsx': return 'typescript';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'javascript';
    case 'json': return 'json';
    case 'md': case 'markdown': return 'markdown';
    case 'css': return 'css';
    case 'scss': return 'scss';
    case 'less': return 'less';
    case 'html': case 'htm': return 'html';
    case 'xml': case 'svg': return 'xml';
    case 'yaml': case 'yml': return 'yaml';
    case 'toml': return 'ini';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'py': return 'python';
    case 'rb': return 'ruby';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'sql': return 'sql';
    case 'java': return 'java';
    case 'c': case 'h': return 'c';
    case 'cpp': case 'cc': case 'cxx': case 'hpp': return 'cpp';
    case 'dockerfile': return 'dockerfile';
    default: return 'plaintext';
  }
}

interface FileMeta {
  /** Last-saved content. dirty = model.getValue() !== baseline. */
  baseline: string;
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  size: number;
  status: 'loading' | 'ready' | 'image' | 'binary' | 'tooLarge' | 'error' | 'diff' | 'browser';
  error: string | null;
  /** True when the model's current value differs from baseline. */
  dirty: boolean;
  /** data: URL for image preview (status === 'image'). */
  imageSrc: string | null;
  /** Diff content (status === 'diff'). `head` = HEAD blob, `working` =
   *  current working copy. We render these in Monaco's DiffEditor. */
  diffHead: string | null;
  diffWorking: string | null;
  diffState:
    | 'modified' | 'staged' | 'untracked'
    | 'deleted' | 'conflicted' | 'clean' | null;
}

const EMPTY_META: FileMeta = {
  baseline: '',
  mtimeMs: 0,
  binary: false,
  tooLarge: false,
  size: 0,
  status: 'loading',
  error: null,
  dirty: false,
  imageSrc: null,
  diffHead: null,
  diffWorking: null,
  diffState: null,
};

const IMAGE_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif',
]);
function isImage(absPath: string): boolean {
  const lower = absPath.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf('.') + 1);
  return IMAGE_EXTS.has(ext);
}

export function EditorPane(): JSX.Element {
  const openFiles = useAppStore(selectOpenFiles);
  const activeFilePath = useAppStore(selectActiveFilePath);
  const previewFilePath = useAppStore(selectPreviewFilePath);
  const editorBySession = useAppStore((s) => s.editorBySession);
  const selectTab = useAppStore((s) => s.selectTab);
  const closeFile = useAppStore((s) => s.closeFile);
  const promoteToSticky = useAppStore((s) => s.promoteToSticky);
  // Sessions own a connection; file ops need that sessionId so main
  // can route through LocalFs vs RemoteFs.
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  // Monaco's built-in theme ids. 'vs' = light, 'vs-dark' = dark.
  const theme = useTheme();
  const monacoTheme = theme === 'light' ? 'vs' : 'vs-dark';

  // Union of files open across ALL sessions. Used by the dispose loop
  // so switching sessions doesn't kill the model of a file that's
  // still open elsewhere — the symptom of that bug was "switching
  // sessions sometimes shows the wrong editor content".
  const allOpenUnion = useMemo(() => {
    const set = new Set<string>();
    for (const slot of Object.values(editorBySession)) {
      for (const p of slot.openFiles) set.add(p);
    }
    return set;
  }, [editorBySession]);

  // Per-tab rendered/source toggle for markdown files. Lives outside
  // the per-file meta because it isn't an artefact of the file itself
  // — it's a UI preference. Defaults to "rendered" on first open of
  // a markdown tab.
  const [previewModeByTab, setPreviewModeByTab] = useState<Record<string, 'source' | 'rendered'>>({});
  const togglePreviewMode = useCallback((tabId: string): void => {
    setPreviewModeByTab((m) => ({
      ...m,
      [tabId]: m[tabId] === 'rendered' ? 'source' : 'rendered',
    }));
  }, []);

  // Per-file metadata for the tab strip and save logic.
  const [metaMap, setMetaMap] = useState<Record<string, FileMeta>>({});
  // Per-file Monaco model. Live outside React state because models
  // aren't comparable / serialisable and we don't want them in deps.
  const modelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  // Per-file content-change subscriptions, so we can dispose them
  // when a file closes.
  const subsRef = useRef<Map<string, monaco.IDisposable>>(new Map());
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

  // Dirty-diff gutter. A single hidden DiffEditor computes line-level
  // changes between each file's HEAD content and its working model;
  // `onDidUpdateDiff` fires whenever either side mutates (including
  // live edits in the main editor, since both editors share the same
  // working-side model instance). We then paint the line numbers in
  // the main editor's gutter with the result.
  // Files outside a git repo skip head-model creation entirely so
  // their edits don't get painted as additions against a phantom base.
  const headModelsRef = useRef<Map<string, monaco.editor.ITextModel>>(new Map());
  const diffEditorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const diffSubRef = useRef<monaco.IDisposable | null>(null);
  const decorationsRef = useRef<string[]>([]);
  // Tracks which file the hidden DiffEditor is currently pointed at,
  // so async onDidUpdateDiff callbacks can ignore stale results that
  // arrive after the user has switched tabs.
  const diffActivePathRef = useRef<string | null>(null);

  const updateMeta = useCallback(
    (absPath: string, patch: Partial<FileMeta>): void => {
      setMetaMap((prev) => {
        const cur = prev[absPath] ?? EMPTY_META;
        return { ...prev, [absPath]: { ...cur, ...patch } };
      });
    },
    []
  );

  // Load any newly-opened file. Idempotent: skipped if we already
  // have a model. Cleans up models for files that were closed.
  useEffect(() => {
    let cancelled = false;
    for (const p of openFiles) {
      if (modelsRef.current.has(p)) continue;
      if (metaMap[p]?.status === 'loading' && !metaMap[p]?.error) {
        // already loading
      }
      // Mark loading immediately so the tab shows "…".
      if (!metaMap[p]) updateMeta(p, { ...EMPTY_META });
      void (async () => {
        try {
          // Web URL tabs render an <iframe src=URL>. Nothing to load
          // from disk — the iframe fetches the page itself. Just
          // flip status so the render switch picks the right branch.
          if (isWebUrlTab(p)) {
            updateMeta(p, {
              status: 'browser',
              baseline: '',
              error: null,
              dirty: false,
            });
            return;
          }

          // Browser tabs render the file in an iframe; we just need
          // the raw HTML stashed in `baseline`. No Monaco model.
          if (isBrowserTab(p)) {
            const realPath = pathOf(p);
            const res = await window.baton.call('file.read', {
              absPath: realPath,
              ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
            });
            if (cancelled) return;
            if (res.binary || res.tooLarge) {
              updateMeta(p, {
                status: res.tooLarge ? 'tooLarge' : 'binary',
                size: res.size,
                mtimeMs: res.mtimeMs,
                error: null,
                dirty: false,
                baseline: '',
              });
              return;
            }
            updateMeta(p, {
              status: 'browser',
              baseline: res.content,
              mtimeMs: res.mtimeMs,
              size: res.size,
              error: null,
              dirty: false,
              binary: false,
              tooLarge: false,
              imageSrc: null,
            });
            return;
          }

          // Diff tabs (id starts with "diff://") render Monaco's
          // DiffEditor — we fetch HEAD + working sides from git.
          if (isDiffTab(p)) {
            const realPath = pathOf(p);
            const res = await window.baton.call('file.readGitDiff', {
              absPath: realPath,
              ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
            });
            if (cancelled) return;
            updateMeta(p, {
              status: 'diff',
              error: null,
              dirty: false,
              baseline: '',
              imageSrc: null,
              diffHead: res.head,
              diffWorking: res.working,
              diffState: res.state,
              mtimeMs: res.mtimeMs,
              binary: false,
              tooLarge: false,
              size: res.working.length,
            });
            return;
          }

          // Images bypass the text-read path entirely: we fetch them
          // as base64 and render with <img> (PRD F6.2).
          if (isImage(p)) {
            const res = await window.baton.call('file.readBinary', {
              absPath: p,
              ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
            });
            if (cancelled) return;
            if (res.tooLarge) {
              updateMeta(p, {
                size: res.size,
                mtimeMs: res.mtimeMs,
                status: 'tooLarge',
                error: null,
                dirty: false,
                baseline: '',
                imageSrc: null,
              });
              return;
            }
            updateMeta(p, {
              size: res.size,
              mtimeMs: res.mtimeMs,
              status: 'image',
              error: null,
              dirty: false,
              baseline: '',
              imageSrc: `data:${res.mimeType};base64,${res.data}`,
              binary: false,
              tooLarge: false,
            });
            return;
          }

          const res = await window.baton.call('file.read', {
            absPath: p,
            ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
          });
          if (cancelled) return;
          if (res.binary || res.tooLarge) {
            updateMeta(p, {
              binary: res.binary,
              tooLarge: res.tooLarge,
              size: res.size,
              mtimeMs: res.mtimeMs,
              status: res.tooLarge ? 'tooLarge' : 'binary',
              error: null,
              dirty: false,
              baseline: '',
              imageSrc: null,
            });
            return;
          }
          const model = monaco.editor.createModel(
            res.content,
            languageFor(p),
            monaco.Uri.file(p)
          );
          modelsRef.current.set(p, model);

          // Best-effort: fetch HEAD in parallel so the dirty-diff
          // gutter can show changes vs. the last commit. Outside a git
          // repo we skip entirely so live edits don't render as a sea
          // of "added" markers against a phantom base.
          void window.baton.call('file.readGitDiff', {
            absPath: p,
            ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
          }).then((g) => {
            if (cancelled) return;
            if (!g.inRepo) return;
            const existing = headModelsRef.current.get(p);
            if (existing) {
              try { existing.dispose(); } catch { /* ignore */ }
            }
            const headModel = monaco.editor.createModel(g.head, languageFor(p));
            headModelsRef.current.set(p, headModel);
            // If this file is what the user is currently looking at,
            // rebind the hidden diff editor so decorations appear
            // without waiting for the next tab switch.
            rebindDiffEditorRef.current?.();
          }).catch(() => { /* best-effort */ });
          // Track dirty per-file by comparing live value to baseline.
          // First edit on a preview tab also promotes it to sticky
          // (PRD F6.5).
          const sub = model.onDidChangeContent(() => {
            const cur = metaMapRef.current[p];
            if (!cur) return;
            const dirty = model.getValue() !== cur.baseline;
            if (dirty !== cur.dirty) updateMeta(p, { dirty });
            if (dirty) promoteToSticky(p);
          });
          subsRef.current.set(p, sub);
          updateMeta(p, {
            baseline: res.content,
            mtimeMs: res.mtimeMs,
            binary: false,
            tooLarge: false,
            size: res.size,
            status: 'ready',
            error: null,
            dirty: false,
          });
        } catch (err) {
          if (cancelled) return;
          updateMeta(p, {
            status: 'error',
            error: String(err),
            dirty: false,
          });
        }
      })();
    }

    // Dispose models + subs only for files that are no longer open
    // in ANY session. A session switch alone keeps the model alive so
    // the editor renders instantly when the user comes back.
    for (const [p, model] of modelsRef.current) {
      if (!allOpenUnion.has(p)) {
        try { model.dispose(); } catch { /* ignore */ }
        modelsRef.current.delete(p);
      }
    }
    for (const [p, sub] of subsRef.current) {
      if (!allOpenUnion.has(p)) {
        try { sub.dispose(); } catch { /* ignore */ }
        subsRef.current.delete(p);
      }
    }
    // Same cleanup for head-side models. Clear the diff editor first
    // if it's currently pointed at one of the to-be-disposed models,
    // otherwise Monaco throws when the model goes away under it.
    for (const [p, model] of headModelsRef.current) {
      if (!allOpenUnion.has(p)) {
        if (diffActivePathRef.current === p) {
          try { diffEditorRef.current?.setModel(null); } catch { /* ignore */ }
          diffActivePathRef.current = null;
        }
        try { model.dispose(); } catch { /* ignore */ }
        headModelsRef.current.delete(p);
      }
    }

    return () => { cancelled = true; };
    // metaMap intentionally left out — we don't want to re-run for
    // every dirty-bit change. We DO want to re-run when openFiles
    // changes (new file added) or the union shrinks (file truly closed).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openFiles, allOpenUnion, updateMeta]);

  // Mirror metaMap into a ref so the onDidChangeContent callback
  // always sees the latest baseline + dirty state without re-binding.
  const metaMapRef = useRef(metaMap);
  metaMapRef.current = metaMap;

  // When the active tab changes, swap the editor's model.
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !activeFilePath) return;
    const model = modelsRef.current.get(activeFilePath);
    if (model) ed.setModel(model);
  }, [activeFilePath, metaMap[activeFilePath ?? '']?.status]);

  // Rebind the hidden DiffEditor to the active file's head+working
  // model pair. Stored in a ref so the file-load IPC callback (which
  // creates the head model asynchronously) can trigger a rebind once
  // the model lands, without depending on activeFilePath in its scope.
  const rebindDiffEditorRef = useRef<(() => void) | null>(null);
  const rebindDiffEditor = useCallback((): void => {
    const de = diffEditorRef.current;
    if (!de) return;
    // Diff tabs already use their own DiffEditor — don't double-paint.
    const path = activeFilePath && !isDiffTab(activeFilePath) ? activeFilePath : null;
    if (!path) {
      try { de.setModel(null); } catch { /* ignore */ }
      diffActivePathRef.current = null;
      const ed = editorRef.current;
      if (ed) decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const working = modelsRef.current.get(path);
    const head = headModelsRef.current.get(path);
    if (!working || !head) {
      // No head model means we're outside a git repo OR the head fetch
      // is still in flight. Either way, clear any stale decorations.
      try { de.setModel(null); } catch { /* ignore */ }
      diffActivePathRef.current = null;
      const ed = editorRef.current;
      if (ed) decorationsRef.current = ed.deltaDecorations(decorationsRef.current, []);
      return;
    }
    diffActivePathRef.current = path;
    try { de.setModel({ original: head, modified: working }); } catch { /* ignore */ }
  }, [activeFilePath]);
  rebindDiffEditorRef.current = rebindDiffEditor;
  useEffect(() => { rebindDiffEditor(); }, [rebindDiffEditor]);

  // Translate Monaco's ILineChange[] into linesDecorations on the
  // main editor's gutter. Mirrors VS Code's SCM dirty-diff bars:
  //   added     — modified-side range, no original lines
  //   modified  — modified-side range, with original lines
  //   deleted   — a marker on the line where the deletion happened
  const applyGutterDecorations = useCallback((): void => {
    const ed = editorRef.current;
    const de = diffEditorRef.current;
    if (!ed || !de) return;
    // Only paint when the diff editor is computing for the file the
    // user is currently looking at. Otherwise a late onDidUpdateDiff
    // would paint stale results onto the new tab's model.
    if (diffActivePathRef.current !== activeFilePath) return;
    const changes = de.getLineChanges() ?? [];
    const next: monaco.editor.IModelDeltaDecoration[] = [];
    for (const c of changes) {
      const isPureAdd = c.originalEndLineNumber === 0;
      const isPureDel = c.modifiedEndLineNumber === 0;
      if (isPureDel) {
        // Deletion has no modified-side lines to attach to. Anchor on
        // the line below the deletion (Monaco reports the line ABOVE
        // which the deleted block sat as `modifiedStartLineNumber`).
        const anchor = Math.max(1, c.modifiedStartLineNumber);
        next.push({
          range: new monaco.Range(anchor, 1, anchor, 1),
          options: { linesDecorationsClassName: 'git-gutter git-gutter-deleted' },
        });
        continue;
      }
      const cls = isPureAdd ? 'git-gutter git-gutter-added' : 'git-gutter git-gutter-modified';
      const startLine = c.modifiedStartLineNumber;
      const endLine = c.modifiedEndLineNumber;
      for (let l = startLine; l <= endLine; l++) {
        next.push({
          range: new monaco.Range(l, 1, l, 1),
          options: { linesDecorationsClassName: cls },
        });
      }
    }
    decorationsRef.current = ed.deltaDecorations(decorationsRef.current, next);
  }, [activeFilePath]);
  const applyGutterDecorationsRef = useRef<() => void>(applyGutterDecorations);
  applyGutterDecorationsRef.current = applyGutterDecorations;

  // Consume a pending "go to line N" set by the Search panel. We
  // wait until the target file's model is in place — that's when
  // revealLineInCenter can compute a layout.
  const pendingGoto = useAppStore((s) => s.pendingGoto);
  const consumePendingGoto = useAppStore((s) => s.consumePendingGoto);
  useEffect(() => {
    if (!pendingGoto) return;
    if (pendingGoto.absPath !== activeFilePath) return;
    if (metaMap[activeFilePath]?.status !== 'ready') return;
    const ed = editorRef.current;
    const model = modelsRef.current.get(pendingGoto.absPath);
    if (!ed || !model) return;
    try {
      ed.setModel(model);
      const pos = { lineNumber: pendingGoto.line, column: Math.max(1, pendingGoto.col) };
      ed.revealLineInCenter(pos.lineNumber);
      ed.setPosition(pos);
      ed.focus();
    } catch { /* best-effort */ }
    consumePendingGoto(pendingGoto.nonce);
    // activeMeta isn't a stable dep — we lock onto its status by reading
    // it inline above, and re-run when the goto target or active tab
    // shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingGoto?.nonce, activeFilePath, metaMap[activeFilePath ?? '']?.status]);

  const activeMeta: FileMeta =
    (activeFilePath ? metaMap[activeFilePath] : undefined) ?? EMPTY_META;

  // Save the currently active file.
  const [saveBusy, setSaveBusy] = useState(false);
  const save = useCallback(async (): Promise<void> => {
    if (saveBusy || !activeFilePath) return;
    const meta = metaMapRef.current[activeFilePath];
    const model = modelsRef.current.get(activeFilePath);
    if (!meta || !model || !meta.dirty) return;
    setSaveBusy(true);
    try {
      const content = model.getValue();
      const res = await window.baton.call('file.write', {
        absPath: activeFilePath,
        content,
        knownMtimeMs: meta.mtimeMs,
        ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
      });
      if (res.stale) {
        const ok = window.confirm(
          'The file changed on disk after you opened it. Overwrite?'
        );
        if (!ok) return;
        const forced = await window.baton.call('file.write', {
          absPath: activeFilePath,
          content,
          knownMtimeMs: meta.mtimeMs,
          force: true,
          ...(selectedSessionId ? { sessionId: selectedSessionId } : {}),
        });
        updateMeta(activeFilePath, {
          mtimeMs: forced.mtimeMs,
          baseline: content,
          dirty: false,
        });
        return;
      }
      updateMeta(activeFilePath, {
        mtimeMs: res.mtimeMs,
        baseline: content,
        dirty: false,
      });
    } catch (err) {
      alert(`Save failed: ${String(err)}`);
    } finally {
      setSaveBusy(false);
    }
  }, [activeFilePath, saveBusy, updateMeta]);

  // Bind Cmd+S to the editor instance whenever the save closure
  // changes (active file, etc.). Monaco's addCommand is idempotent
  // per key chord — last binding wins.
  const onEditorMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
    if (activeFilePath) {
      const m = modelsRef.current.get(activeFilePath);
      if (m) editor.setModel(m);
    }
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => { void save(); }
    );

    // Lazy-create the hidden DiffEditor on first mount. It lives in an
    // offscreen 1×1 host so it doesn't paint anything, but Monaco still
    // runs its diff worker on the model pair we feed it. We read the
    // result via getLineChanges() and project it onto the visible
    // editor's gutter.
    if (!diffEditorRef.current) {
      const host = document.createElement('div');
      host.style.position = 'absolute';
      host.style.left = '-9999px';
      host.style.top = '-9999px';
      host.style.width = '1px';
      host.style.height = '1px';
      host.style.overflow = 'hidden';
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
      diffHostRef.current = host;
      const de = monaco.editor.createDiffEditor(host, {
        automaticLayout: false,
        renderSideBySide: false,
        readOnly: true,
        enableSplitViewResizing: false,
        ignoreTrimWhitespace: false,
        // Cheap mode is fine — we only consume line-level changes.
        diffWordWrap: 'off',
      });
      diffEditorRef.current = de;
      diffSubRef.current = de.onDidUpdateDiff(() => {
        applyGutterDecorationsRef.current();
      });
      // Bind for whatever's currently active.
      rebindDiffEditorRef.current?.();
    }
  }, [activeFilePath, save]);

  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => { void save(); }
    );
  }, [save]);

  // Dispose all models on unmount so we don't leak Monaco state if
  // the editor pane ever unmounts entirely.
  useEffect(() => {
    return () => {
      for (const sub of subsRef.current.values()) {
        try { sub.dispose(); } catch { /* ignore */ }
      }
      subsRef.current.clear();
      for (const model of modelsRef.current.values()) {
        try { model.dispose(); } catch { /* ignore */ }
      }
      modelsRef.current.clear();
      // Hidden diff editor + head-side models.
      try { diffSubRef.current?.dispose(); } catch { /* ignore */ }
      diffSubRef.current = null;
      try { diffEditorRef.current?.setModel(null); } catch { /* ignore */ }
      try { diffEditorRef.current?.dispose(); } catch { /* ignore */ }
      diffEditorRef.current = null;
      if (diffHostRef.current?.parentNode) {
        diffHostRef.current.parentNode.removeChild(diffHostRef.current);
      }
      diffHostRef.current = null;
      for (const model of headModelsRef.current.values()) {
        try { model.dispose(); } catch { /* ignore */ }
      }
      headModelsRef.current.clear();
      decorationsRef.current = [];
    };
  }, []);

  // Default to preview-mode for files that have one (markdown, json),
  // so README.md and package.json "just work" without an extra click.
  const activePath = activeFilePath && !isDiffTab(activeFilePath) ? pathOf(activeFilePath) : null;
  const activeHasPreview = activePath != null && hasPreviewMode(activePath);
  const activeIsMarkdown = activePath != null && isMarkdown(activePath);
  const activeIsJson     = activePath != null && isJson(activePath);
  const activeViewMode: 'source' | 'rendered' = activeFilePath
    ? previewModeByTab[activeFilePath] ?? (activeHasPreview ? 'rendered' : 'source')
    : 'source';
  const showMarkdownPreview =
    activeMeta.status === 'ready' && activeIsMarkdown && activeViewMode === 'rendered';
  const showJsonTree =
    activeMeta.status === 'ready' && activeIsJson && activeViewMode === 'rendered';

  const editorVisible =
    activeMeta.status === 'ready' && !showMarkdownPreview && !showJsonTree;

  return (
    <>
      <EditorTabs
        openFiles={openFiles}
        activeFilePath={activeFilePath}
        previewFilePath={previewFilePath}
        metaMap={metaMap}
        onSelect={selectTab}
        onPin={promoteToSticky}
        onClose={closeFile}
      />
      <EditorActionRow
        absPath={activeFilePath}
        dirty={activeMeta.dirty}
        saveBusy={saveBusy}
        onSave={save}
        markdownToggle={
          activeHasPreview && activeMeta.status === 'ready' && activeFilePath
            ? {
                mode: activeViewMode,
                buttonLabel: previewModeLabel(pathOf(activeFilePath), activeViewMode),
                onToggle: () => togglePreviewMode(activeFilePath),
              }
            : null
        }
      />
      <div className="editor-body">
        {activeFilePath == null ? null
          : activeMeta.status === 'loading' ? (
              <div className="empty"><p className="dim">Loading…</p></div>
          ) : activeMeta.status === 'error' ? (
              <div className="empty"><p className="dim">{activeMeta.error}</p></div>
          ) : activeMeta.status === 'diff' ? (
              <div className="editor-monaco">
                <DiffEditor
                  /* Stable per-tab key so switching diff tabs (or
                     switching sessions) remounts the editor cleanly
                     instead of swapping props in place — that swap is
                     what triggers Monaco's "TextModel got disposed
                     before DiffEditorWidget model got reset" crash. */
                  key={activeFilePath}
                  height="100%"
                  language={languageFor(pathOf(activeFilePath))}
                  original={activeMeta.diffHead ?? ''}
                  modified={activeMeta.diffWorking ?? ''}
                  theme={monacoTheme}
                  options={{
                    fontSize: 12.5,
                    readOnly: true,
                    renderSideBySide: true,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    wordWrap: 'on',
                  }}
                />
              </div>
          ) : activeMeta.status === 'browser' ? (
              <div className="html-preview">
                {activeFilePath && isWebUrlTab(activeFilePath) ? (
                  /* Navigable iframe: src=URL so relative assets and
                     in-page navigation work like a real browser tab.
                     The renderer CSP's frame-src must permit the
                     target scheme (see installCsp in main/index.ts). */
                  <iframe
                    key={activeFilePath}
                    title={pathOf(activeFilePath)}
                    src={pathOf(activeFilePath)}
                    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                  />
                ) : (
                  /* srcdoc isolates HTML in its own origin so it can't
                     reach into the renderer. Relative asset refs
                     (./style.css, images) WON'T resolve. */
                  <iframe
                    key={activeFilePath}
                    title={pathOf(activeFilePath ?? '')}
                    srcDoc={activeMeta.baseline}
                    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                  />
                )}
              </div>
          ) : activeMeta.status === 'image' && activeMeta.imageSrc ? (
              <ImageViewer
                src={activeMeta.imageSrc}
                sizeBytes={activeMeta.size}
                name={activeFilePath.split('/').pop() ?? ''}
              />
          ) : activeMeta.status === 'tooLarge' ? (
              <div className="empty">
                <p className="dim">
                  File is {Math.round(activeMeta.size / 1024)} KB — too large to edit in baton.
                </p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void window.baton.call('shell.openPath', { absPath: activeFilePath })}
                >
                  Open externally
                </button>
              </div>
          ) : activeMeta.status === 'binary' ? (
              <div className="empty">
                <p className="dim">Binary file ({Math.round(activeMeta.size / 1024)} KB).</p>
                <button
                  type="button"
                  className="btn"
                  onClick={() => void window.baton.call('shell.openPath', { absPath: activeFilePath })}
                >
                  Open externally
                </button>
              </div>
          ) : null}
        {/* Markdown preview: rendered HTML from the active model's
            live content. */}
        {showMarkdownPreview && activeFilePath ? (
          <MarkdownPreview
            source={modelsRef.current.get(activeFilePath)?.getValue() ?? ''}
          />
        ) : null}
        {/* JSON tree view: collapsible tree of the parsed value. */}
        {showJsonTree && activeFilePath ? (
          <JsonTreeView
            source={modelsRef.current.get(activeFilePath)?.getValue() ?? ''}
          />
        ) : null}
        {/* Monaco stays mounted regardless of status — we just hide it
            when the active file isn't editable. That preserves the
            per-file models for tab switching. */}
        <div className="editor-monaco" style={{ display: editorVisible ? 'flex' : 'none' }}>
          <MonacoHost onMount={onEditorMount} theme={monacoTheme} />
        </div>
      </div>
    </>
  );
}

/** Monaco's surface is mounted once. The active model is swapped on
 *  tab change. We pass an empty initial value because we immediately
 *  set the model in onMount. */
function MonacoHost({ onMount, theme }: { onMount: OnMount; theme: string }): JSX.Element {
  // We intentionally key by `theme` so swapping triggers a remount of
  // the Editor with the new theme baked in; the model is re-attached
  // by the active-tab effect. Without remounting, @monaco-editor/react
  // doesn't always honour a theme prop change after mount.
  const editor = useMemo(() => (
    <Editor
      height="100%"
      defaultLanguage="plaintext"
      defaultValue=""
      onMount={onMount}
      theme={theme}
      options={{
        fontSize: 12.5,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: 'on',
        tabSize: 2,
        renderWhitespace: 'selection',
      }}
    />
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [theme]);
  return editor;
}

interface TabsProps {
  openFiles: readonly string[];
  activeFilePath: string | null;
  previewFilePath: string | null;
  metaMap: Record<string, FileMeta>;
  onSelect: (absPath: string) => void;
  onPin: (absPath: string) => void;
  onClose: (absPath: string) => void;
}

function EditorTabs({
  openFiles, activeFilePath, previewFilePath, metaMap,
  onSelect, onPin, onClose,
}: TabsProps): JSX.Element {
  return (
    <div className="editor-tabs" role="tablist">
      {openFiles.map((p) => {
        const meta = metaMap[p];
        const active = p === activeFilePath;
        const preview = p === previewFilePath;
        const real = pathOf(p);
        const weburl = isWebUrlTab(p);
        const name = weburl ? labelForUrl(real) : (real.split('/').pop() ?? real);
        const diff = isDiffTab(p);
        const browser = isBrowserTab(p) || weburl;
        const kindNote = diff ? ' (diff)' : weburl ? ' (browser)' : isBrowserTab(p) ? ' (browser)' : '';
        return (
          <div
            key={p}
            className={`editor-tab ${active ? 'active' : ''} ${preview ? 'preview' : ''} ${diff ? 'diff' : ''} ${browser ? 'browser' : ''}`}
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(p)}
            onDoubleClick={() => onPin(p)}
            title={
              preview
                ? `${real}${kindNote}\n(preview — double-click to pin)`
                : `${real}${kindNote}`
            }
          >
            {diff ? <span className="editor-tab-icon" aria-hidden>±</span> : null}
            {browser ? <span className="editor-tab-icon" aria-hidden>🌐</span> : null}
            <span className="editor-tab-name">
              {name}{meta?.dirty ? ' •' : ''}
            </span>
            <button
              type="button"
              className="editor-tab-close"
              onClick={(e) => {
                e.stopPropagation();
                if (meta?.dirty) {
                  const ok = window.confirm(
                    `${name} has unsaved changes. Close anyway?`
                  );
                  if (!ok) return;
                }
                onClose(p);
              }}
              title="Close tab"
              aria-label="Close tab"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

function EditorActionRow({
  absPath, dirty, saveBusy, onSave, markdownToggle,
}: {
  absPath: string | null;
  dirty: boolean;
  saveBusy: boolean;
  onSave: () => void;
  markdownToggle:
    | { mode: 'source' | 'rendered'; buttonLabel: string; onToggle: () => void }
    | null;
}): JSX.Element | null {
  if (!absPath) return null;
  const real = pathOf(absPath);
  const diff = isDiffTab(absPath);
  const browser = isBrowserTab(absPath);
  const weburl = isWebUrlTab(absPath);
  const kindNote = diff ? ' · diff' : (browser || weburl) ? ' · browser' : '';
  return (
    <div className="editor-head">
      <span className="editor-file mono" title={real}>
        {real}{kindNote}
      </span>
      {markdownToggle ? (
        <button
          type="button"
          className="btn"
          onClick={markdownToggle.onToggle}
          title={
            markdownToggle.mode === 'rendered'
              ? 'Switch to source view'
              : 'Switch to preview'
          }
        >
          {markdownToggle.buttonLabel}
        </button>
      ) : null}
      {weburl ? null : <OpenInMenu absPath={real} />}
      {diff || browser || weburl ? null : (
        <button
          type="button"
          className="btn"
          onClick={() => onSave()}
          disabled={!dirty || saveBusy}
          title="Save (⌘S)"
        >
          {saveBusy ? 'Saving…' : 'Save'}
        </button>
      )}
    </div>
  );
}

/** Image preview with zoom controls (buttons + scroll-wheel) and
 *  drag-to-pan when zoomed in (PRD F6.2). Zoom resets whenever the
 *  source image changes. */
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 64;
const clampZoom = (v: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));

/** Pan offset (screen px) applied before scale, so panning speed is
 *  constant regardless of zoom. transform-origin is the canvas centre. */
interface ImageView { scale: number; x: number; y: number }
const FIT_VIEW: ImageView = { scale: 1, x: 0, y: 0 };

function ImageViewer({
  src, sizeBytes, name,
}: { src: string; sizeBytes: number; name: string }): JSX.Element {
  const [view, setView] = useState<ImageView>(FIT_VIEW);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<ImageView>(view);
  viewRef.current = view;
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  // Reset pan+zoom when a different image is opened.
  useEffect(() => { setView(FIT_VIEW); }, [src]);

  // Zoom around a screen point (clientX/Y): the pixel under the cursor
  // stays put while the rest scales toward/away from it.
  const zoomAround = useCallback((factor: number, clientX: number, clientY: number): void => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Cursor position relative to the canvas centre (the transform origin).
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    setView((v) => {
      const next = clampZoom(v.scale * factor);
      const k = next / v.scale;
      return { scale: next, x: cx - k * (cx - v.x), y: cy - k * (cy - v.y) };
    });
  }, []);

  // Zoom around the canvas centre (for the +/− buttons).
  const zoomCentre = useCallback((factor: number): void => {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    zoomAround(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }, [zoomAround]);

  // Native, non-passive wheel listener so we can preventDefault and stop
  // the scroll from bubbling to the surrounding editor body.
  // Ctrl/⌘ + wheel zooms toward the cursor; plain wheel pans (handy for
  // scrolling through a long image). Trackpad pinch also arrives as a
  // ctrlKey wheel event, so it zooms too.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        zoomAround(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX, e.clientY);
      } else {
        setView((v) => ({ ...v, x: v.x - e.deltaX, y: v.y - e.deltaY }));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAround]);

  const onMouseDown = useCallback((e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    dragRef.current = { px: e.clientX, py: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
    canvasRef.current?.classList.add('grabbing');
  }, []);
  const onMouseMove = useCallback((e: React.MouseEvent): void => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) }));
  }, []);
  const endDrag = useCallback((): void => {
    dragRef.current = null;
    canvasRef.current?.classList.remove('grabbing');
  }, []);

  // Double-click toggles between fit and a 2× zoom centred on the cursor.
  const onDoubleClick = useCallback((e: React.MouseEvent): void => {
    if (viewRef.current.scale !== 1 || viewRef.current.x !== 0 || viewRef.current.y !== 0) {
      setView(FIT_VIEW);
    } else {
      zoomAround(2, e.clientX, e.clientY);
    }
  }, [zoomAround]);

  const atFit = view.scale === 1 && view.x === 0 && view.y === 0;

  return (
    <div className="image-viewer">
      <div
        ref={canvasRef}
        className="image-canvas"
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        onDoubleClick={onDoubleClick}
      >
        <img
          src={src}
          alt={name}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
      <div className="image-meta dim">
        <span>{(sizeBytes / 1024).toFixed(1)} KB · {name}</span>
        <span className="image-zoom">
          <button
            type="button"
            className="image-zoom-btn"
            title="Zoom out"
            aria-label="Zoom out"
            disabled={view.scale <= ZOOM_MIN}
            onClick={() => zoomCentre(1 / 1.25)}
          >−</button>
          <button
            type="button"
            className="image-zoom-level"
            title="Reset to fit"
            aria-label="Reset to fit"
            disabled={atFit}
            onClick={() => setView(FIT_VIEW)}
          >{Math.round(view.scale * 100)}%</button>
          <button
            type="button"
            className="image-zoom-btn"
            title="Zoom in"
            aria-label="Zoom in"
            disabled={view.scale >= ZOOM_MAX}
            onClick={() => zoomCentre(1.25)}
          >+</button>
        </span>
      </div>
    </div>
  );
}

/** Render markdown source as HTML inside a styled scroll container.
 *  Synchronously parses on every render — marked is fast enough for
 *  typical READMEs that this isn't worth memoising yet. */
function MarkdownPreview({ source }: { source: string }): JSX.Element {
  // `marked.parse` returns `string | Promise<string>` in its type even
  // though in sync mode (no async options) it's always a string. Cast
  // through unknown so React's children don't complain.
  const html = marked.parse(source) as unknown as string;
  return (
    <div className="md-preview">
      <div
        className="md-content"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** Tiny dropdown that hands the active file off to a real IDE.
 *  PRD F6.6 — escape hatch for the cases Monaco can't cover. */
function OpenInMenu({ absPath }: { absPath: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

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

  async function openIn(editor: 'vscode' | 'cursor' | 'zed'): Promise<void> {
    setOpen(false);
    setBusy(true);
    try {
      const res = await window.baton.call('editor.openIn', { editor, absPath });
      if (!res.ok) {
        alert(
          `Could not open in ${editor}: ${res.error ?? 'unknown error'}\n\n` +
          `Make sure the app is installed and its URL handler / CLI is registered.`
        );
      }
    } catch (err) {
      alert(`Open-in failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="open-in-menu" ref={ref}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((v) => !v)}
        disabled={busy}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Open this file in an external IDE"
      >
        Open in… ▾
      </button>
      {open ? (
        <div className="open-in-pop" role="menu">
          <button className="open-in-item" role="menuitem" onClick={() => void openIn('vscode')}>VS Code</button>
          <button className="open-in-item" role="menuitem" onClick={() => void openIn('cursor')}>Cursor</button>
          <button className="open-in-item" role="menuitem" onClick={() => void openIn('zed')}>Zed</button>
        </div>
      ) : null}
    </div>
  );
}
