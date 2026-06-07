import { Component, type ReactNode } from 'react';
import { useAppStore } from '../store.js';

/**
 * Wraps the editor zone so a Monaco crash (notably DiffEditor's
 * "TextModel got disposed before DiffEditorWidget model got reset"
 * unmount race in @monaco-editor/react) can't take down the rest of
 * the UI — without this, the entire render tree blanks out and even
 * the terminal slot stops drawing on session switch.
 *
 * On error: show a small recovery card with a "Close all tabs"
 * button. Closing all tabs unmounts the editor zone entirely, which
 * naturally clears the boundary.
 */
interface Props { children: ReactNode }
interface State { error: Error | null }

export class EditorErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // eslint-disable-next-line no-console
    console.error('[EditorErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <EditorCrashCard error={this.state.error} onReset={() => this.setState({ error: null })} />;
    }
    return this.props.children;
  }
}

function EditorCrashCard({ error, onReset }: { error: Error; onReset: () => void }): JSX.Element {
  // closeAllForSession isn't a single store action; do it by reading
  // the slot and calling closeFile for each entry. Simpler than
  // adding a dedicated action just for this recovery path.
  const closeFile = useAppStore((s) => s.closeFile);
  const openFiles = useAppStore((s) => {
    const sid = s.selectedSessionId;
    return sid ? s.editorBySession[sid]?.openFiles ?? [] : [];
  });

  function closeAll(): void {
    for (const p of [...openFiles]) closeFile(p);
    onReset();
  }

  return (
    <div className="editor-crash">
      <h3>Editor crashed</h3>
      <p className="dim">
        Monaco threw while updating. The rest of the app is still
        working — close the open tabs to recover the editor zone.
      </p>
      <pre className="editor-crash-msg">{error.message}</pre>
      <div className="editor-crash-actions">
        <button type="button" className="btn primary" onClick={closeAll}>
          Close all tabs
        </button>
        <button type="button" className="btn" onClick={onReset}>
          Try again
        </button>
      </div>
    </div>
  );
}
