import { useEffect, useRef, useState } from 'react';

interface Props {
  title: string;
  /** Initial value of the input. Selected on open. */
  initialValue: string;
  /** Label above the input. */
  label?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Called when the user presses Enter or clicks Confirm with a
   *  non-empty (trimmed) value that differs from `initialValue`.
   *  Receives the new trimmed value. */
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/** Generic single-input modal. Replacement for window.prompt(), which
 *  Electron's renderer doesn't support. */
export function PromptDialog({
  title, initialValue, label, placeholder,
  confirmLabel = 'OK',
  onConfirm, onCancel,
}: Props): JSX.Element {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Focus + select the existing text on open so the user can either
    // start typing fresh or arrow-edit in place. Run once on mount only:
    // re-running would re-select the text mid-edit (callers pass a fresh
    // onCancel identity every render, so this must not depend on it).
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.select();
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function submit(): void {
    const trimmed = value.trim();
    if (!trimmed || trimmed === initialValue) {
      onCancel();
      return;
    }
    onConfirm(trimmed);
  }

  return (
    <div className="dialog-overlay" onMouseDown={onCancel}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-head">
          <h3>{title}</h3>
        </div>
        <div className="dialog-body">
          <label className="dialog-field">
            <span>{label ?? 'Name'}</span>
            <input
              ref={inputRef}
              type="text"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
              }}
              spellCheck={false}
              autoComplete="off"
            />
          </label>
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={submit}
            disabled={!value.trim() || value.trim() === initialValue}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
